// E2E: the FULL first-mate dispatch loop, end to end, against a real launched
// Maestro - a first-mate MCP client calls maestro_dispatch, the app's watcher
// launches a real dispatched run in an isolated worktree, and the compact
// report comes back via maestro_collect_reports.
//
// Isolation: MAESTRO_META_HOME_OVERRIDE points BOTH the launched app's dispatch
// watcher AND our MCP-server child at a throwaway temp meta-home, so a
// separately-running dev instance (which watches the REAL meta-home) never
// races for this test's request. The dispatch target is a throwaway git repo;
// the run uses haiku + a trivial goal to stay cheap.
//
// Run:  node scripts/e2e/test-dispatch-loop.mjs
import { launch } from "./harness.mjs";
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[dispatch-loop-e2e]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "..");
const stamp = String(Date.now());
const tmpBase = path.join(os.tmpdir(), "maestro-dispatch-e2e-" + stamp);
const metaHome = path.join(tmpBase, "meta-home");
const scratchRepo = path.join(tmpBase, "scratch-repo");

// --- tiny MCP stdio client ---------------------------------------------------
function makeMcpClient(env) {
  const serverPath = path.join(REPO_ROOT, "src", "mcp", "maestroDispatchServer.js");
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
let mcp;
try {
  // Build the isolated temp meta-home + a real throwaway git repo.
  fs.mkdirSync(metaHome, { recursive: true });
  fs.mkdirSync(scratchRepo, { recursive: true });
  execSync("git init", { cwd: scratchRepo });
  execSync('git config user.email "e2e@test.local"', { cwd: scratchRepo });
  execSync('git config user.name "E2E"', { cwd: scratchRepo });
  fs.writeFileSync(path.join(scratchRepo, "README.md"), "# scratch\n");
  execSync("git add -A", { cwd: scratchRepo });
  execSync('git commit -m "init"', { cwd: scratchRepo });

  // Point the launched app's dispatch watcher at the temp meta-home.
  process.env.MAESTRO_META_HOME_OVERRIDE = metaHome;
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // A first-mate MCP client aimed at the SAME temp meta-home + the scratch repo.
  mcp = makeMcpClient({
    MAESTRO_META_HOME: metaHome,
    MAESTRO_MATE_ID: "mate-e2e",
    MAESTRO_WIDTH_CAP: "3",
    MAESTRO_PROJECTS: JSON.stringify([{ name: "scratch", path: scratchRepo }]),
  });
  await mcp.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {} });

  // list_projects sees the scratch repo.
  const projs = await mcp.callTool("maestro_list_projects", {});
  assert(Array.isArray(projs.projects) && projs.projects.some((p) => p.name === "scratch"), "maestro_list_projects returns the scratch project");

  // Dispatch a real (cheap) run. Use the absolute-path ESCAPE HATCH: the app
  // re-validates the project against its OWN knownProjects() (it doesn't trust
  // the MCP server's claimed enum - defense in depth), and this test's scratch
  // repo isn't one of the app's registered projects, so a bare name would be
  // (correctly) rejected. An explicit absolute repo path is the sanctioned way
  // to dispatch to an arbitrary repo.
  const disp = await mcp.callTool("maestro_dispatch", {
    project: scratchRepo,
    goal: "Create a file named HELLO.txt containing exactly the word hello.",
    model: "haiku",
    effort: "low",
    maxIterations: 4,
  });
  log("dispatch result:", JSON.stringify(disp));
  assert(disp.status === "started" && disp.goalRunId, "maestro_dispatch is accepted and returns a goalRunId (app watcher launched the run)");
  const dispatchId = disp.dispatchId;

  // Poll for the report to come back (a real run - give it time).
  let report = null;
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const col = await mcp.callTool("maestro_collect_reports", { dispatchIds: [dispatchId] });
    if (col.reports && col.reports.length > 0) {
      report = col.reports[0];
      break;
    }
    await wait(4000);
  }
  assert(report != null, "a report came back via maestro_collect_reports (report-back works)");
  if (report) {
    log("report:", JSON.stringify(report));
    assert(report.dispatchId === dispatchId, "the report is for our dispatch");
    assert(report.project === scratchRepo && /HELLO\.txt/.test(report.goal), "the report echoes the dispatched project + goal");
    assert(["done", "escalated", "error"].includes(report.status), "the report has a terminal status (loop completed): " + report.status);
    if (report.status === "done") {
      assert(report.changed && typeof report.changed.commitCount === "number", "a done report carries the commit/worktree info");
    }
  }

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  log(exitCode === 0 ? "VERIFY OK: full dispatch loop works (dispatch -> run -> report-back)." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  if (mcp) mcp.kill();
  if (app) {
    const k = await app.close();
    log("cleanup app:", k || "(nothing)");
  }
  // Best-effort worktree + temp cleanup (scratch repo has no node_modules, so
  // no junction to worry about; still prefer git worktree prune over rm-through).
  try {
    execSync("git worktree prune", { cwd: scratchRepo });
  } catch {}
  try {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  } catch (e) {
    log("temp cleanup note:", e.message);
  }
  delete process.env.MAESTRO_META_HOME_OVERRIDE;
}
process.exit(exitCode);
