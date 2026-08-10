import { requireLive } from "./live-gate.mjs";
requireLive("runs a real first mate end to end against the CLI");

// E2E (M3, the crux): a REAL claude first-mate session - launched with the same
// --mcp-config + --allowedTools the app now attaches to a first mate - actually
// CALLS helm_dispatch, and the app's watcher launches the run + writes a
// report. This is the path the review flagged as unverified (the other loop test
// drives the MCP server with a hand-rolled client; this uses a real claude
// session, so it proves the permission gate is actually cleared). Cheap-ish:
// haiku mate + haiku dispatched run, trivial goal. Real launched Helm.
//
// Run:  node scripts/e2e/test-first-mate-real-session.mjs
import { launch } from "./harness.mjs";
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[first-mate-real-session-e2e]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const CLAUDE = "C:/Users/aidin/.local/bin/claude.exe";
const REPO = "D:/Repo/Tools/helm";
const SERVER = path.join(REPO, "src", "mcp", "helmDispatchServer.js");
const SERVER_NAME = "helm-dispatch";
const ALLOWED = ["helm_dispatch", "helm_collect_reports", "helm_list_projects"].map((t) => `mcp__${SERVER_NAME}__${t}`);
const stamp = String(Date.now());
const tmp = path.join(os.tmpdir(), "fm-real-" + stamp);
const metaHome = path.join(tmp, "meta-home");
const scratch = path.join(tmp, "scratch");
const reportsDir = path.join(metaHome, ".helm-dispatch", "reports");

let app;
try {
  fs.mkdirSync(metaHome, { recursive: true });
  fs.mkdirSync(scratch, { recursive: true });
  execSync("git init", { cwd: scratch });
  execSync('git config user.email "e2e@test.local"', { cwd: scratch });
  execSync('git config user.name "E2E"', { cwd: scratch });
  fs.writeFileSync(path.join(scratch, "README.md"), "# scratch\n");
  execSync("git add -A", { cwd: scratch });
  execSync('git commit -m "init"', { cwd: scratch });

  // App watches the temp meta-home (isolated from any dev instance).
  process.env.HELM_META_HOME_OVERRIDE = metaHome;
  // Register the dispatching mate as OWNED by this instance, in an ISOLATED mate store.
  // The dispatch watcher skips any request whose dispatchedBy is not one of its own mates
  // (isForeignDispatch - the 2026-07-12 guard so two Helm instances sharing a meta-home
  // don't double-run the same dispatch). A REAL first mate is always in the mate store;
  // this synthetic "mate-real" (HELM_MATE_ID below) must be too, or the dispatched run is
  // left in the queue and NEVER reports back - which is exactly how this test silently
  // regressed once that guard landed. HELM_MATES_PATH isolates it so the test neither
  // reads nor mutates the real dev mates.json.
  const matesPath = path.join(tmp, "mates.json");
  fs.writeFileSync(
    matesPath,
    JSON.stringify({ mates: [{ mateId: "mate-real", slot: 0, name: "Real Mate", root: metaHome, status: "active", persona: null, createdAt: 1, retiredAt: null }] }),
    "utf8"
  );
  process.env.HELM_MATES_PATH = matesPath;
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // The exact mcp-config shape the app builds for a first mate, + the same
  // allowedTools it now attaches.
  const mcpConfig = JSON.stringify({
    mcpServers: {
      [SERVER_NAME]: {
        command: "node",
        args: [SERVER],
        env: {
          HELM_META_HOME: metaHome,
          HELM_MATE_ID: "mate-real",
          HELM_PROJECTS: JSON.stringify([{ name: "scratch", path: scratch }]),
          HELM_WIDTH_CAP: "3",
        },
      },
    },
  });

  // A REAL claude first-mate session. It must clear the permission gate to call
  // the tool (without --allowedTools this returns TOOL-BLOCKED, verified).
  const prompt =
    `Use the helm_dispatch tool to dispatch ONE run with these exact arguments: ` +
    `project="${scratch}", goal="Create a file named HELLO.txt containing exactly the word hello", model="haiku", maxIterations=3. ` +
    `After the tool returns, reply with ONLY the dispatchId. If you cannot call the tool, reply exactly: TOOL-BLOCKED.`;

  const args = ["-p", prompt, "--model", "claude-haiku-4-5-20251001", "--mcp-config", mcpConfig, "--allowedTools", ...ALLOWED];
  const mate = spawn(CLAUDE, args, { cwd: metaHome, stdio: ["ignore", "pipe", "pipe"], env: process.env });
  let mateOut = "";
  mate.stdout.on("data", (c) => (mateOut += c.toString("utf8")));
  mate.stderr.on("data", (c) => (mateOut += c.toString("utf8")));
  const mateDone = new Promise((r) => {
    const to = setTimeout(() => { mate.kill(); r(); }, 120000);
    mate.on("exit", () => { clearTimeout(to); r(); });
  });
  await mateDone;
  log("mate reply (tail):", mateOut.trim().slice(-160).replace(/\s+/g, " "));
  assert(!/TOOL-BLOCKED/.test(mateOut), "the real first-mate session was NOT permission-blocked from calling the dispatch tool");

  // The mate replies with ONLY the dispatchId. Poll for THIS dispatch's report
  // specifically (reports/<dispatchId>.json), never files[0]: the goal-run
  // history is a global file, so a prior run's interrupted record could seed an
  // unrelated reconciled report into any meta-home - reading the first file
  // would race onto that stale report instead of this run's real one.
  const dispatchId = (mateOut.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0];
  assert(!!dispatchId, "the mate replied with a dispatchId (a UUID)");
  const reportFile = dispatchId ? path.join(reportsDir, `${dispatchId}.json`) : null;
  let report = null;
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    if (reportFile && fs.existsSync(reportFile)) {
      report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
      break;
    }
    await wait(4000);
  }
  assert(report != null, "the dispatched run (from a REAL first-mate session) reported back");
  if (report) {
    log("report:", JSON.stringify({ status: report.status, dispatchedBy: report.dispatchedBy, reconciled: report.reconciled, project: report.project, commits: report.changed?.commitCount, needs: report.needsCaptain }));
    assert(report.dispatchedBy === "mate-real", "the report is attributed to the real mate");
    assert(["done", "escalated", "error"].includes(report.status), "the dispatched run reached a terminal status");
  }

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  log(exitCode === 0 ? "VERIFY OK: a real first-mate session dispatches through the permission gate, run reports back." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  if (app) {
    const k = await app.close();
    log("cleanup app:", k || "(nothing)");
  }
  try { execSync("git worktree prune", { cwd: scratch }); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  delete process.env.HELM_META_HOME_OVERRIDE;
  delete process.env.HELM_MATES_PATH;
}
process.exit(exitCode);
