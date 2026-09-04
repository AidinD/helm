// A broken install must SAY it is broken, not just fail to open a window.
//
// THE FAILURE THIS REPLACES
// Helm reaches `keel` from three places, and one of them - src/lib/atomicWrite.js - is what
// almost every module in the app writes through. keel is a `file:` path to a sibling
// repository, and npm links a missing `file:` dependency to a dangling symlink and exits 0. So
// an install can report complete success and leave an app that cannot start.
//
// What that looked like: main.js threw while its own imports were being resolved, before one
// line of it ran. No window, no dialog, no notification. Clicking the icon did nothing at all,
// which is the least diagnosable failure a desktop app has. A first-time user hit this shape
// with a different dependency and had no way to find out why (card 6c84414b).
//
// WHAT IS ASSERTED, and why it is the stderr rather than the dialog. A native error box cannot
// be read back by a test without driving the OS, and a check that cannot see its subject is
// worth nothing - so boot.mjs writes the same fact to stderr first, unconditionally, and that
// is what this reads. It is also the form a launcher, a terminal or a harness actually gets.
//
// THE INSTALL IS REALLY BROKEN, not simulated: keel is moved aside on disk, the app is started
// for real, and it is put back in a finally. Stubbing the import would test the message and not
// the failure, and the failure is the whole subject.
//
// STARTS-APP: spawns the Electron binary directly, because the harness attaches to an app that
// came up and this check needs one that cannot. Declared rather than inferred - see
// pure-checks/test-lane-folders-tell-the-truth.mjs for why the guard reads a line instead of
// guessing from the source.
//
// Run:  node scripts/app-checks/test-boot-says-why.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const keel = path.join(repo, "node_modules", "keel");
// Parked NEXT TO IT, not in the temp directory: the repo lives on one drive and the temp
// directory on another, and rename cannot cross a device boundary (EXDEV). A copy-and-delete
// would work and is worse - it duplicates a whole package to prove a point about a symlink.
const parked = path.join(repo, "node_modules", `.keel-parked-${process.pid}`);

let failures = 0;
function ok(condition, what) {
  console.log(`${condition ? "OK  " : "FAIL"} - ${what}`);
  if (!condition) {
    failures += 1;
  }
}

// The Electron binary, the same way the harness finds it - a check that silently used a
// different one would prove nothing about the app that ships.
const pathFile = path.join(repo, "node_modules", "electron", "path.txt");
const electron = fs.existsSync(pathFile)
  ? path.join(repo, "node_modules", "electron", "dist", fs.readFileSync(pathFile, "utf8").trim())
  : null;

if (!electron || !fs.existsSync(electron)) {
  console.log("SKIPPED - the Electron binary is not installed here, so the app cannot be started to observe its failure.");
  process.exit(0);
}

let movedAside = false;
try {
  ok(fs.existsSync(keel), "keel is installed to begin with, so moving it aside actually breaks something");
  fs.renameSync(keel, parked);
  movedAside = true;

  const startedAt = Date.now();
  const run = spawnSync(electron, [repo], {
    cwd: repo,
    encoding: "utf8",
    timeout: 60000,
    windowsHide: true,
    env: { ...process.env, HELM_E2E_HIDDEN: "1", ELECTRON_ENABLE_LOGGING: "1" },
  });
  const said = `${run.stdout || ""}${run.stderr || ""}`;

  const tookMs = Date.now() - startedAt;
  ok(run.status === 1, `it exits with a code rather than being killed - a null status means it never ended (status ${run.status})`);
  // PROMPTLY, and this is not a performance assertion. The first version showed a native error
  // box, which blocks the message loop, so a run with nobody to click it sat for the full sixty
  // seconds of this check's timeout and returned no exit status at all. A hang wearing an error
  // message is worse than the silent failure the wrapper exists to replace. The dialog is now
  // shown only to a person; anything unattended gets stderr and an exit.
  ok(tookMs < 15000, `and it ends promptly instead of waiting on a dialog nobody can dismiss (${tookMs}ms)`);
  ok(/\[boot\]/.test(said), "the boot wrapper reports, rather than the process dying silently");
  ok(/could not start/i.test(said), "and says the app could not start, in those words");
  ok(/keel/.test(said), "and NAMES the missing package, which is the one fact that makes it fixable");
  ok(
    /sibling repository|npm install/i.test(said),
    "and says what to do about it, not only what is wrong"
  );
  // The specific instruction matters: for a `file:` sibling, "run npm install" alone is wrong
  // advice - the install will succeed again and change nothing.
  ok(
    /AidinD\/keel/.test(said),
    "and points at the repository to clone, since npm install cannot fix a missing sibling and will report success anyway"
  );

  if (failures > 0) {
    console.log("");
    console.log("what it actually said:");
    console.log(said.split("\n").slice(0, 12).join("\n"));
  }
} catch (err) {
  failures += 1;
  console.log(`FAIL - the check itself threw: ${err.message}`);
} finally {
  if (movedAside && fs.existsSync(parked)) {
    fs.rmSync(keel, { recursive: true, force: true });
    fs.renameSync(parked, keel);
  }
  // Never leave the tree broken, whatever happened above - every other check needs keel.
  const back = fs.existsSync(path.join(keel, "package.json"));
  console.log(`${back ? "OK  " : "FAIL"} - keel is back where it belongs`);
  if (!back) {
    failures += 1;
  }
}

console.log("");
if (failures > 0) {
  console.log(`VERIFY FAILED: ${failures} problem(s)`);
  process.exit(1);
}
console.log("VERIFY OK - a missing sibling produces a named, actionable failure instead of a window that never opens");
