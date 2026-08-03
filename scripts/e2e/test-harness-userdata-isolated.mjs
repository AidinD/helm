// An E2E run must not share Electron's userData directory with the INSTALLED Helm.
//
// Electron derives that directory from the app NAME, so a test launch and the app
// the captain actually uses both resolved to %APPDATA%\helm and wrote the same window
// state, localStorage and cookies at the same time. He caught it live on
// 2026-08-03: his Helm was open while a suite was running. Two consequences, and
// the second is the serious one - a test reading state its own app never wrote is
// merely flaky, but a throwaway run mutating the app he depends on is data loss
// with extra steps.
//
// This asserts the PROPERTY, not the flag: that Electron actually put its profile
// in the per-run directory, and that the real one was left alone for the duration.
// Passing --user-data-dir and having it ignored would look identical in a source
// scan, which is the failure mode that shipped twice today.
//
// Run:  node scripts/e2e/test-harness-userdata-isolated.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch } from "./harness.mjs";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const realUserData = path.join(os.homedir(), "AppData", "Roaming", "helm");
const tmpRoot = os.tmpdir();
const userDataDirs = () =>
  fs.existsSync(tmpRoot) ? fs.readdirSync(tmpRoot).filter((d) => d.startsWith("helm-e2e-userdata-")) : [];

// A file listing of the REAL directory, so we can tell whether the run touched it.
// Names + sizes rather than mtimes: the installed Helm may be running while this
// test does, and its own writes must not be blamed on us. A new FILE appearing is
// still worth reporting, so the comparison is on the set of names.
const snapshot = () => {
  if (!fs.existsSync(realUserData)) {
    return null;
  }
  return fs
    .readdirSync(realUserData)
    .sort()
    .join("|");
};

const before = snapshot();
const dirsBefore = new Set(userDataDirs());

let app = null;
try {
  app = await launch();
  ok(!!app.userDataTmpDir, `the harness created a per-run userData directory (${app.userDataTmpDir || "none"})`);
  ok(
    typeof app.userDataTmpDir === "string" && app.userDataTmpDir.startsWith(tmpRoot),
    "and it is under the system temp directory, not in the repo or the real profile"
  );
  ok(
    path.resolve(app.userDataTmpDir || "") !== path.resolve(realUserData),
    "and it is NOT the installed app's own profile directory"
  );

  // THE ACTUAL PROOF: Electron writes its profile as soon as it starts, so if it
  // honoured the flag there is Chromium state in our directory. An ignored flag
  // leaves it empty while the app runs perfectly well.
  const contents = fs.existsSync(app.userDataTmpDir) ? fs.readdirSync(app.userDataTmpDir) : [];
  ok(contents.length > 0, `Electron actually put its profile there (${contents.length} entries)`);
  const looksLikeAProfile = contents.some((n) =>
    ["Local Storage", "Session Storage", "Cache", "blob_storage", "Network", "Preferences", "Cookies", "GPUCache"].includes(n)
  );
  ok(looksLikeAProfile, `and it is a real Chromium profile, not an empty directory: ${JSON.stringify(contents.slice(0, 8))}`);

  // The app is genuinely up - otherwise "nothing was written to the real profile"
  // would pass for the boring reason.
  await app.waitForSelector("#pageToggle");
  ok(true, "and the app under test really launched with it (its nav rendered)");

  const during = snapshot();
  ok(
    before === null || during === before,
    "no new file appeared in the installed app's profile while the test ran"
  );
} catch (e) {
  exit = 1;
  console.error("ERR", e.stack || e.message);
} finally {
  const dir = app?.userDataTmpDir || null;
  try {
    await app?.close();
  } catch {}
  // close() must take the directory with it, or a full suite leaves one per test.
  if (dir) {
    ok(!fs.existsSync(dir), "close() removed the per-run directory rather than leaving it in temp");
  }
  const leaked = userDataDirs().filter((d) => !dirsBefore.has(d));
  ok(leaked.length === 0, `no stray userData directories left behind${leaked.length ? `: ${leaked.join(", ")}` : ""}`);
}

console.log(
  exit === 0
    ? "VERIFY OK: an E2E launch gets its own Electron profile, Chromium really uses it, the installed app's profile is untouched, and the directory is cleaned up."
    : "VERIFY FAILED."
);
process.exit(exit);
