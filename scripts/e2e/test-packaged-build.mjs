// The first check that runs the thing that actually gets INSTALLED.
//
// Every other app test launches Helm from source. Nothing ran the packaged build, and the
// gap was not theoretical: queueing a prompt failed ONLY in the installed app, because its
// store resolved inside the read-only asar bundle (task 7d9d2188). That class - a misspelled
// filename, a file electron-builder excludes, a data dir that cannot be written - passes
// every source-level check and ships broken. test-packaged-store-paths greps the source for
// the redirect; a grep cannot tell you the file is actually in the bundle.
//
// Three things, chosen because each one can ONLY fail here:
//   1. the packaged app starts at all (the asar entry point resolves),
//   2. a store WRITE survives, through the packaged redirect (the 7d9d2188 bug),
//   3. the off-main worker comes up - an ESM entry point loaded from inside an asar archive
//      is the one part of the 2026-08-12 performance work that dev cannot prove. Its fallback
//      means Helm still WORKS if it fails, just at the old speed, so nothing else would ever
//      have told us.
//
// SAFETY: it drives a temp HELM_DATA_DIR, so it cannot touch the real ~/.helm that the
// installed app uses. Cleanup matches the unique debug port, so it cannot reach the captain's own
// running Helm either.
//
// It launches the app, so it runs in the SLOW lane.
// Run:  npm run dist   (once, to produce dist/win-unpacked)
//       node scripts/e2e/test-packaged-build.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const exe = path.join(repo, "dist", "win-unpacked", "Helm.exe");

if (!fs.existsSync(exe)) {
  // A skip, not a failure: the artifact is a build output, and failing the suite because
  // nobody has run a build yet would train everyone to ignore this file. It says exactly how
  // to make it runnable.
  console.log(`SKIP - no packaged build at ${path.relative(repo, exe)}. Run \`npm run dist\` first; this check then runs against it.`);
  process.exit(0);
}

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

// Its own data dir. packagedPaths.js redirects every store to HELM_DATA_DIR when packaged,
// so this one variable isolates the whole app from the real ~/.helm.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-packaged-"));
process.env.HELM_DATA_DIR = dataDir;
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9371";
// Deliberately NOT set: HELM_CONFIG_PATH and friends. Leaving them unset is the point - it
// makes the packaged redirect itself the thing under test, rather than bypassing it.
delete process.env.HELM_CONFIG_PATH;

const { launch } = await import("./harness.mjs");

let app = null;
try {
  app = await launch({ command: exe, args: [], appDir: path.dirname(exe) });
  await app.waitForSelector("#pageToggle", 60000, { visible: true });
  ok(true, "the packaged app starts and renders its window - the asar entry point resolves");

  const version = await app.eval(`window.helm.getVersion()`);
  ok(/^v?\d+\.\d+\.\d+/.test(String(version)), `and reports a real version (${version})`);

  // --- 2. a store write must SURVIVE ----------------------------------------
  // The 7d9d2188 shape: writes silently failed in the installed app because the store
  // resolved inside the read-only bundle. Read it back through a fresh IPC call rather than
  // trusting the write's own return value.
  // The SCHEDULED-PROMPT queue specifically, because that is the store the original bug was
  // in: queueing a prompt worked in dev and failed in the installed app with "Could not write
  // the scheduled-prompt queue", because packagedPaths.js had no redirect for it. Config
  // would not do - the harness sets HELM_CONFIG_PATH itself, so a config write proves the
  // harness's isolation rather than the packaged redirect. Nothing sets
  // HELM_SCHEDULED_PROMPTS_PATH, so this store can only land where packagedPaths sends it.
  const marker = `e2e-packaged-${Date.now()}`;
  const added = await app.eval(`window.helm.addScheduledPrompt({
    prompt: ${JSON.stringify(marker)},
    cwd: ${JSON.stringify(repo.replace(/\\/g, "/"))},
    when: Date.now() + 3600000
  })`);
  ok(added && added.ok !== false, `the scheduled-prompt queue accepts a write (${JSON.stringify(added).slice(0, 120)})`);
  const listed = await app.eval(`window.helm.listScheduledPrompts().then(r => JSON.stringify(r).includes(${JSON.stringify(marker)}))`);
  ok(listed === true, "and it reads back through the app");
  const queueFile = path.join(dataDir, "scheduled-prompts.json");
  ok(
    fs.existsSync(queueFile) && fs.readFileSync(queueFile, "utf8").includes(marker),
    `and it really landed on disk in HELM_DATA_DIR (${path.basename(queueFile)}) - this is the exact store whose missing redirect broke the installed app in task 7d9d2188, and only a packaged run can catch it`
  );

  // --- 3. the off-main worker, which ONLY this check can prove --------------
  // Ask for a heavy job FIRST. The worker is spawned lazily on the first one, so reading the
  // status before that reports alive:false for the dull reason that nothing has needed it yet
  // - indistinguishable, at a glance, from the failure this is looking for. The giveaway is
  // restarts:0 and lastError:null; a real failure carries both.
  const sessions = await app.eval(`window.helm.getSessions().then(r => ({ n: (r.sessions||[]).length, err: r.error || null }))`);
  ok(!sessions.err, `the work the worker carries comes back (${sessions.n} sessions, error: ${sessions.err || "none"})`);
  const status = await app.eval(`window.helm.getHeavyWorkerStatus()`);
  ok(
    status.alive === true,
    `and the off-main worker really came up INSIDE the packaged build (${JSON.stringify(status)}) - an ESM entry point loaded from an asar archive is the one part of the performance work dev cannot verify, and its fallback would have hidden a failure behind "just slower"`
  );
} finally {
  if (app) {
    await app.close();
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(
  exit === 0
    ? "VERIFY OK: the packaged build starts, persists its state, and runs its off-main worker."
    : "VERIFY FAILED - and this is the lane where a bug reaches the captain's installed app."
);
process.exit(exit);
