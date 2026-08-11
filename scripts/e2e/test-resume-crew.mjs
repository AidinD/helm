// E2E: a SECOND MATE resuming its OWN crew (helm_resume_crew). Aidin flagged that
// the second mate owning the autopilots couldn't resume them itself - only the
// human (card button) or a first mate ("fortsätt") could. This adds a narrow,
// second-mate-scoped resume and this test pins its two properties:
//   1. It SELECTS exactly the resumable runs THIS second mate dispatched - not
//      another second mate's runs, not its own non-resumable ones.
//   2. The tier boundary holds both ways: a FIRST mate can't call resume_crew, and
//      a second mate still can't call the fleet-wide resume_fleet.
//
// Deterministic without real claude: seeded runs have no worktree on disk, so each
// is SELECTED (counted in `total`) but not relaunched (`resumed` stays 0) - which
// is exactly what proves the selection logic (mirrors test-fortsatt-cascade).
//
// Run:  node scripts/e2e/test-resume-crew.mjs
import { launch } from "./harness.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[resume-crew-e2e]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-resumecrew-"));
const metaHome = path.join(tmp, "meta-home");
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

const SM_ID = "sm_ownhash1234";
const OTHER_SM = "sm_otherhash99";
let app;
let secondMate;
let firstMateSeat;
try {
  process.env.HELM_META_HOME_OVERRIDE = metaHome;
  process.env.HELM_GOAL_RUN_HISTORY_PATH = historyPath;
  const bindingsPath = path.join(tmp, "second-mates.json");
  process.env.HELM_SECOND_MATES_PATH = bindingsPath;
  // The app only PROCESSES a dispatch whose dispatcher it OWNS (own first mates +
  // the keys of second-mates.json) - a foreign one is left in the queue for its
  // owning instance. In production the auto/manual path writes this binding via
  // proposeSecondMate; here we seed it so our second mate's resume-crew request is
  // claimed rather than skipped as foreign (which would leave it "pending").
  fs.writeFileSync(bindingsPath, JSON.stringify({ [SM_ID]: { firstMateId: "auto", projectPath: "P", createdAt: 0 } }), "utf8");
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  // Let the dispatch-queue watcher come up before we write a request (the app
  // sweeps once at startup + on fs.watch + a 5s poll; firing too early can leave
  // the request unprocessed until the poll, past this MCP call's ack window).
  await app.eval("new Promise(r => setTimeout(r, 1500))");

  // Two resumable runs dispatched by OUR second mate, one by ANOTHER second mate,
  // one of ours that is NOT resumable. Only our two resumable ones should select.
  fs.writeFileSync(
    historyPath,
    JSON.stringify([
      { goalRunId: "mine-1", dispatchedBy: SM_ID, tier: "crew", projectPath: "P", status: "running", resumable: true, baseCommit: "abc", worktreePath: path.join(tmp, "wt1") },
      { goalRunId: "mine-2", dispatchedBy: SM_ID, tier: "crew", projectPath: "P", status: "running", resumable: true, baseCommit: "abc", worktreePath: path.join(tmp, "wt2") },
      { goalRunId: "other-sm", dispatchedBy: OTHER_SM, tier: "crew", projectPath: "P", status: "running", resumable: true, baseCommit: "abc", worktreePath: path.join(tmp, "wt3") },
      { goalRunId: "mine-not-resumable", dispatchedBy: SM_ID, tier: "crew", projectPath: "P", status: "done", resumable: false, baseCommit: "abc", worktreePath: path.join(tmp, "wt4") },
    ]),
    "utf8"
  );

  // A SECOND-MATE seat (the caller identity the app builds for a second mate).
  secondMate = makeMcpClient({
    HELM_META_HOME: metaHome,
    HELM_MATE_ID: SM_ID,
    HELM_CALLER_TIER: "second-mate",
    HELM_WIDTH_CAP: "3",
    HELM_PROJECTS: JSON.stringify([]),
  });
  await secondMate.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {} });

  const res = await secondMate.callTool("helm_resume_crew", {});
  log("resume_crew:", JSON.stringify(res));
  assert(res && res.ok === true, "helm_resume_crew is accepted for a second mate");
  assert(res.total === 2, `it SELECTS exactly this second mate's two resumable runs (not the other SM's, not the non-resumable) - got total ${res.total}`);
  assert(res.resumed === 0, `with no worktree on disk, selected runs don't fully relaunch - got resumed ${res.resumed}`);

  // A second mate still cannot fire the FLEET-wide resume (that stays first-mate).
  const fleetFromSm = await secondMate.callTool("helm_resume_fleet", {});
  assert(/only a first mate/i.test(fleetFromSm?.error || ""), `a second mate is refused helm_resume_fleet (got ${JSON.stringify(fleetFromSm)})`);

  // And a FIRST mate cannot fire resume_crew (its tool is resume_fleet).
  firstMateSeat = makeMcpClient({
    HELM_META_HOME: metaHome,
    HELM_MATE_ID: "mate_first",
    HELM_CALLER_TIER: "first-mate",
    HELM_WIDTH_CAP: "3",
    HELM_PROJECTS: JSON.stringify([]),
  });
  await firstMateSeat.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
  const crewFromFm = await firstMateSeat.callTool("helm_resume_crew", {});
  assert(/only a second mate/i.test(crewFromFm?.error || ""), `a first mate is refused helm_resume_crew (got ${JSON.stringify(crewFromFm)})`);

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: a second mate resumes only its own resumable crew; the tier boundary holds both ways." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.stack || err.message);
} finally {
  if (secondMate) secondMate.kill();
  if (firstMateSeat) firstMateSeat.kill();
  if (app) {
    const k = await app.close();
    log("cleanup app:", k || "(nothing)");
  }
  delete process.env.HELM_META_HOME_OVERRIDE;
  delete process.env.HELM_GOAL_RUN_HISTORY_PATH;
  delete process.env.HELM_SECOND_MATES_PATH;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
process.exit(exitCode);
