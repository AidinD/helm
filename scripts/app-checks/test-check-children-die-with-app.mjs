// Quitting Helm must take any running review-gauntlet check with it.
//
// A gauntlet check is typically `node scripts/e2e/test-*.mjs`, which launches a
// whole Electron of its own. Every other long-lived child in main.js is tracked so
// `before-quit` can sweep it - liveChildren for sessions, liveGoalRuns for goal
// iterations, liveVoiceStreams for whisper - but the check children were a bare
// local in runChecks, registered nowhere. Quitting mid-run therefore orphaned a
// live E2E Helm that nothing would ever close: it went on holding a debug port,
// leaked a Chromium profile, and - being a working Helm - could run gauntlet
// checks of its own. That is the "leftover instances keep spawning further child
// Helms" half of what the captain reported on 2026-08-18.
//
// The quit here is a REAL one (the window closes, which quits the app on Windows),
// not a taskkill - a forced tree kill would take the child down regardless and
// would prove nothing about before-quit.
//
// Run:  node scripts/e2e/test-check-children-die-with-app.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

let exit = 0;
let app = null;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-checkquit-"));
const repo = path.join(tmp, "repo");
const pidFile = path.join(tmp, "check.pid");
fs.mkdirSync(repo, { recursive: true });
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
git("init", "-q", "-b", "main");
// A check that never finishes, and announces its PID so this test can watch for it.
// Committed, because checks run in a detached worktree of the record's own commit.
fs.writeFileSync(
  path.join(repo, "hang.mjs"),
  `import fs from "node:fs";\nfs.writeFileSync(process.argv[2], String(process.pid));\nsetInterval(() => {}, 1e9);\n`,
  "utf8"
);
git("add", "hang.mjs");
git("-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "-m", "add hanging check");
const boundSha = git("rev-parse", "HEAD").trim();

const metaHome = path.join(tmp, "meta-home");
fs.mkdirSync(path.join(metaHome, ".helm", "reviews"), { recursive: true });
const TASK = "bbbbbbbb-1111-2222-3333-555555555555";
fs.writeFileSync(
  path.join(metaHome, ".helm", "reviews", `${TASK}.json`),
  JSON.stringify({
    taskId: TASK,
    projectPath: repo,
    criticality: "cosmetic",
    whyNotCritical: "A throwaway fixture for a test, nothing real is at stake here.",
    verdict: "stamp",
    summary: "A fixture whose only check never finishes, so it is still running when the app quits.",
    testSteps: [{ step: "Run the check.", expect: "It hangs." }],
    evidence: [],
    notVerified: [],
    commits: [boundSha],
    checks: [{ label: "hangs forever", cmd: `node hang.mjs "${pidFile.replace(/\\/g, "\\\\")}"`, cwd: repo }],
  }),
  "utf8"
);

process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_META_HOME_OVERRIDE = metaHome;
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9588";
const { launch } = await import("../checks-lib/harness.mjs");

let checkPid = null;
try {
  app = await launch();

  // Deliberately NOT awaited: this call only settles when every check has finished,
  // and this one never does. That is the situation being tested.
  await app.eval(`(() => { window.helm.runReviewChecks(${JSON.stringify(TASK)}); return true; })()`);

  for (let i = 0; i < 120 && !fs.existsSync(pidFile); i++) {
    await delay(500);
  }
  checkPid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8").trim()) : null;
  ok(Number.isInteger(checkPid) && checkPid > 0, `the gauntlet started a check process (pid ${checkPid})`);
  ok(checkPid !== null && alive(checkPid), "and it is running while the app is up");

  // A real quit: close the window, which quits the app (window-all-closed), which
  // is what fires before-quit. The CDP connection dies with it, so the eval is not
  // expected to answer.
  try {
    await app.eval(`window.close()`);
  } catch {
    /* the page went away mid-call, which is the point */
  }

  let died = false;
  for (let i = 0; i < 40 && !died; i++) {
    await delay(250);
    died = checkPid !== null && !alive(checkPid);
  }
  ok(died, "quitting Helm takes the running check process with it, instead of orphaning it");
} catch (e) {
  exit = 1;
  console.error("ERR", e.stack || e.message);
} finally {
  // If the property is broken the check is STILL RUNNING, and a test for orphans
  // must not leave one of its own behind.
  if (checkPid && alive(checkPid)) {
    try {
      execFileSync("taskkill", ["/PID", String(checkPid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
  try {
    await app?.close();
  } catch {
    /* the app has usually already quit on its own here */
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* a detached worktree the interrupted run never removed can hold a handle */
  }
}

console.log(
  exit === 0
    ? "VERIFY OK: a review-gauntlet check that is still running when Helm quits is killed with the app, not orphaned."
    : "VERIFY FAILED."
);
process.exit(exit);
