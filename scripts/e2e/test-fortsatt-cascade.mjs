// E2E: the "fortsätt" cascade (durability crux). A first mate's helm_resume_fleet
// - what the captain's "continue"/"fortsätt" maps to - must cascade to resumeFleet
// and SELECT exactly the resumable runs owned by that mate's tree (its own crew
// + its second mates' crew), skipping other mates' runs and non-resumable ones.
//
// Deterministic without launching real claude: the seeded runs have no worktree
// on disk, so each is SELECTED (counted in `total`) but not fully relaunched
// (`resumed` stays 0) - which is exactly what proves the cascade's selection
// logic. (Full relaunch of a real worktree is covered by resumeGoalRunById's own
// gating tests + test-dispatch-loop's real run.)
//
// Run:  node scripts/e2e/test-fortsatt-cascade.mjs
import { launch } from "./harness.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[fortsatt-e2e]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-fortsatt-"));
const metaHome = path.join(tmp, "meta-home");
const matesPath = path.join(tmp, "mates.json");
const historyPath = path.join(tmp, "goal-run-history.json");
fs.mkdirSync(metaHome, { recursive: true });

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
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch {}
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
try {
  process.env.HELM_META_HOME_OVERRIDE = metaHome;
  process.env.HELM_MATES_PATH = matesPath;
  process.env.HELM_GOAL_RUN_HISTORY_PATH = historyPath;
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // Read one of the app's owned first mates.
  let ownedMateId = null;
  for (let i = 0; i < 40 && !ownedMateId; i++) {
    try {
      const state = JSON.parse(fs.readFileSync(matesPath, "utf8"));
      ownedMateId = (state.mates || []).find((m) => m.status === "active")?.mateId || (state.mates || [])[0]?.mateId || null;
    } catch {}
    if (!ownedMateId) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  assert(!!ownedMateId, `found an owned first mate (${ownedMateId})`);

  // Seed history: two resumable runs owned by our mate, one owned by ANOTHER
  // mate, one owned-but-not-resumable. Only the first two should be selected.
  // No worktree on disk -> selected but not fully relaunched.
  fs.writeFileSync(
    historyPath,
    JSON.stringify([
      { goalRunId: "own-1", dispatchedBy: ownedMateId, projectPath: "P", status: "running", resumable: true, baseCommit: "abc", worktreePath: path.join(tmp, "wt1") },
      { goalRunId: "own-2", dispatchedBy: ownedMateId, projectPath: "P", status: "running", resumable: true, baseCommit: "abc", worktreePath: path.join(tmp, "wt2") },
      { goalRunId: "other", dispatchedBy: "mate_someone_else", projectPath: "P", status: "running", resumable: true, baseCommit: "abc", worktreePath: path.join(tmp, "wt3") },
      { goalRunId: "not-resumable", dispatchedBy: ownedMateId, projectPath: "P", status: "done", resumable: false, baseCommit: "abc", worktreePath: path.join(tmp, "wt4") },
    ]),
    "utf8"
  );

  mate = makeMcpClient({
    HELM_META_HOME: metaHome,
    HELM_MATE_ID: ownedMateId,
    HELM_WIDTH_CAP: "3",
    HELM_PROJECTS: JSON.stringify([]),
  });
  await mate.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {} });

  const res = await mate.callTool("helm_resume_fleet", {});
  log("resume_fleet:", JSON.stringify(res));
  assert(res && res.ok === true, "helm_resume_fleet is accepted");
  assert(res.total === 2, `the cascade SELECTS exactly this mate's two resumable runs (not the other mate's, not the non-resumable) - got total ${res.total}`);
  assert(res.resumed === 0, `with no worktree on disk, selected runs don't fully relaunch - got resumed ${res.resumed}`);

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: fortsätt cascades to the owning mate's resumable runs only." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.stack || err.message);
} finally {
  if (mate) mate.kill();
  if (app) {
    const k = await app.close();
    log("cleanup app:", k || "(nothing)");
  }
  delete process.env.HELM_META_HOME_OVERRIDE;
  delete process.env.HELM_MATES_PATH;
  delete process.env.HELM_GOAL_RUN_HISTORY_PATH;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
process.exit(exitCode);
