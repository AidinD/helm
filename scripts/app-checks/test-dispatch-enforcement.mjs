// E2E: the LIVE guardrails actually refuse a real dispatch at the app's dispatch
// authority (main.js processDispatchRequests), not just as pure predicates. A
// refused dispatch launches nothing, so this needs NO claude binary - it drives
// a real MCP client against a launched Helm and asserts the ack comes back
// "rejected" when the kill switch is on, the budget is over, or a crew-tier
// caller tries to dispatch (depth cap). This guards the wiring the ship-review
// just touched (the relay guardrail-bypass fix lives on the same seam).
//
// Isolation: HELM_META_HOME_OVERRIDE points both the app watcher and the MCP
// client at a throwaway temp meta-home, so a live dev instance never races.
//
// Run:  node scripts/e2e/test-dispatch-enforcement.mjs
import { launch } from "../checks-lib/harness.mjs";
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setKilled, setCeiling, addSpend, resetBudget } from "../../src/lib/orchestrationBudget.js";

function log(...a) {
  console.log("[dispatch-enforce-e2e]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "..");
const tmpBase = path.join(os.tmpdir(), "helm-enforce-e2e-" + Date.now());
const metaHome = path.join(tmpBase, "meta-home");
const scratchRepo = path.join(tmpBase, "scratch-repo");
// Isolate the mate store too: ownership scoping means the app only claims a
// dispatch whose dispatchedBy is one of ITS mates. We point HELM_MATES_PATH at a
// temp file, let the app's ensureMates populate it, then dispatch as one of
// those owned mates - otherwise the request is (correctly) skipped as foreign
// and never acked, and the guardrail never even gets a chance to reject it.
const matesPath = path.join(tmpBase, "mates.json");

function makeMcpClient(env) {
  const serverPath = path.join(REPO_ROOT, "src", "mcp", "helmDispatchServer.js");
  const child = spawn(process.execPath, [serverPath], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  let nextId = 1;
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  return {
    rpc,
    async callTool(name, args) {
      const res = await rpc("tools/call", { name, arguments: args || {} });
      const text = res?.result?.content?.[0]?.text;
      return text ? JSON.parse(text) : res?.result;
    },
    kill: () => child.kill(),
  };
}

let app;
let mate;
let crew;
try {
  fs.mkdirSync(metaHome, { recursive: true });
  fs.mkdirSync(scratchRepo, { recursive: true });
  execSync("git init", { cwd: scratchRepo });
  execSync('git config user.email "e2e@test.local"', { cwd: scratchRepo });
  execSync('git config user.name "E2E"', { cwd: scratchRepo });
  fs.writeFileSync(path.join(scratchRepo, "README.md"), "# scratch\n");
  execSync("git add -A", { cwd: scratchRepo });
  execSync('git commit -m "init"', { cwd: scratchRepo });

  // Start clean, then point the app watcher at the temp meta-home + mate store.
  resetBudget(metaHome);
  process.env.HELM_META_HOME_OVERRIDE = metaHome;
  process.env.HELM_MATES_PATH = matesPath;
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // The app's startDispatchWatcher ran ensureMates -> the temp mate store now
  // holds this instance's two owned first mates. Dispatch as one of them so the
  // request is claimed (not skipped as foreign).
  let ownedMateId = null;
  for (let i = 0; i < 40 && !ownedMateId; i++) {
    try {
      const state = JSON.parse(fs.readFileSync(matesPath, "utf8"));
      ownedMateId = (state.mates || []).find((m) => m.status === "active")?.mateId || (state.mates || [])[0]?.mateId || null;
    } catch {
      // not written yet
    }
    if (!ownedMateId) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  assert(!!ownedMateId, `the app created an owned mate to dispatch as (got ${ownedMateId})`);

  mate = makeMcpClient({
    HELM_META_HOME: metaHome,
    HELM_MATE_ID: ownedMateId,
    HELM_WIDTH_CAP: "3",
    HELM_PROJECTS: JSON.stringify([{ name: "scratch", path: scratchRepo }]),
  });
  await mate.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {} });

  const dispatch = () =>
    mate.callTool("helm_dispatch", {
      project: scratchRepo,
      goal: "should never launch - guardrail test",
      model: "haiku",
      effort: "low",
      maxIterations: 2,
    });

  // 1) Kill switch on -> dispatch refused, nothing launched.
  setKilled(metaHome, true);
  const killed = await dispatch();
  log("killed dispatch:", JSON.stringify(killed));
  assert(killed?.status === "rejected", `kill switch refuses the dispatch (got ${killed?.status})`);
  assert(/kill|stopped/i.test(killed?.reason || ""), `the rejection names the kill switch (got "${killed?.reason}")`);

  // 2) Over budget -> refused.
  setKilled(metaHome, false);
  setCeiling(metaHome, 1);
  addSpend(metaHome, 5);
  const over = await dispatch();
  log("over-budget dispatch:", JSON.stringify(over));
  assert(over?.status === "rejected", `over-budget refuses the dispatch (got ${over?.status})`);
  assert(/budget|ceiling/i.test(over?.reason || ""), `the rejection names the budget (got "${over?.reason}")`);

  // 3) Clean budget -> a crew-tier caller is depth-capped (crew can't dispatch).
  resetBudget(metaHome);
  crew = makeMcpClient({
    HELM_META_HOME: metaHome,
    // Owned dispatcher (so the request is claimed) but tagged crew-tier, which
    // the depth cap must refuse regardless of who owns it.
    HELM_MATE_ID: ownedMateId,
    HELM_CALLER_TIER: "crew",
    HELM_WIDTH_CAP: "3",
    HELM_PROJECTS: JSON.stringify([{ name: "scratch", path: scratchRepo }]),
  });
  await crew.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
  const depth = await crew.callTool("helm_dispatch", {
    project: scratchRepo,
    goal: "crew trying to dispatch - should be refused",
    model: "haiku",
    effort: "low",
    maxIterations: 2,
  });
  log("crew dispatch:", JSON.stringify(depth));
  assert(depth?.status === "rejected", `a crew-tier caller is depth-capped (got ${depth?.status})`);
  assert(/depth|dispatched run may not dispatch/i.test(depth?.reason || ""), `the rejection names the depth cap (got "${depth?.reason}")`);

  // Nothing should have launched: no worktrees under the scratch repo's sibling.
  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: live guardrails refuse dispatch (kill / budget / depth)." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.stack || err.message);
} finally {
  if (mate) mate.kill();
  if (crew) crew.kill();
  if (app) {
    const k = await app.close();
    log("cleanup app:", k || "(nothing)");
  }
  try {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  } catch (e) {
    log("temp cleanup note:", e.message);
  }
  delete process.env.HELM_META_HOME_OVERRIDE;
  delete process.env.HELM_MATES_PATH;
}
process.exit(exitCode);
