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
import { spawnSync } from "node:child_process";
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
  // --- 4. the tier guard's hook, for the same reason and a sharper one ------
  // The hook is NOT loaded by Electron. The claude CLI spawns it as its own process under
  // plain node, and plain node cannot read a path inside an asar archive - only Electron's
  // patched fs can. So a guard that works in every dev run would simply never start in the
  // installed app, and nothing would say so: no crash, no log, just a first mate quietly able
  // to write files again. That is worse than having no guard, because the guard is believed in.
  //
  // Two things are checked, and the second is the one that matters: that the file is on the
  // real filesystem (build.asarUnpack), and that plain node can actually EXECUTE it there.
  const unpacked = path.join(repo, "dist", "win-unpacked", "resources", "tier-guard", "hooks", "tierGuardHook.mjs");
  ok(fs.existsSync(unpacked), `the tier-guard hook ships outside the asar (${path.relative(repo, unpacked)}) - inside the archive, the node process that runs it could not open it`);
  ok(
    fs.existsSync(path.join(repo, "dist", "win-unpacked", "resources", "tier-guard", "lib", "tierGuard.js")),
    "and so does the policy it imports, at the relative path the hook's own import expects - shipping only the entry point would move the failure one import deeper"
  );
  if (fs.existsSync(unpacked)) {
    const probe = spawnSync(process.execPath, [unpacked], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "cat > x.md << 'EOF'\nhi\nEOF" } }),
      encoding: "utf8",
      env: { ...process.env, HELM_TIER: "first-mate" },
    });
    ok(
      probe.status === 0 && /"permissionDecision":"deny"/.test(probe.stdout || ""),
      `and PLAIN NODE runs it from there and gets a deny back (exit ${probe.status}, stdout ${JSON.stringify((probe.stdout || "").slice(0, 80))}) - this is the actual thing the CLI does, not a stand-in for it`
    );
  }
  // --- 5. the transcription engine, which is the whole reason it needs asking here ---
  // keel resolves the whisper payload by, among other things, walking up from its own file.
  // In a checkout that reaches the folder holding the repos; packaged it reaches
  // app.asar\node_modules\.whisper, which cannot exist. So the ONE thing dev can never show
  // is what an installed build answers - and until 2026-09-01 nobody had asked. The answer
  // then turned out to be "it works", but only because a Windows user environment variable
  // on this machine happened to point WHISPER_DIR at the payload: an ambient setting Helm
  // did not own, read, display or repair, and whose disappearance would have stopped
  // transcription silently.
  //
  // What is asserted is deliberately NOT "the engine is present". A machine without the
  // 1.5GB payload is a legitimate state and this check must pass there too. What must hold
  // in every case is that the packaged app can ANSWER - and that when the answer is no, it
  // is a sentence somebody can act on rather than a bare false.
  const voice = await app.eval(`window.helm.voiceStatus()`);
  ok(
    voice && voice.ok === true && voice.oneShot && typeof voice.oneShot.ready === "boolean",
    `the packaged app can say where its transcription engine is (${JSON.stringify(voice).slice(0, 200)})`
  );
  if (voice?.oneShot?.ready) {
    ok(
      typeof voice.oneShot.root === "string" && voice.oneShot.root.length > 0 && voice.oneShot.source !== undefined,
      `and names the folder it found it in, and which setting said so (${voice.oneShot.root}, via ${voice.oneShot.source})`
    );
  } else {
    // The failing case is the one that used to be silent, so it is the one worth checking
    // hardest: a reason, and a reason that names a path rather than saying "not installed".
    ok(
      typeof voice?.oneShot?.why === "string" && /[\\/]/.test(voice.oneShot.why),
      `and when it cannot find it, says why and where it looked (${voice?.oneShot?.why})`
    );
  }
  // The streaming engine is a separate binary and a separate answer. Reporting one for both
  // would tell somebody whose one-shot transcription works fine that voice is unavailable.
  ok(
    voice?.streaming && typeof voice.streaming.ready === "boolean",
    `and answers separately for the streaming engine (ready: ${voice?.streaming?.ready})`
  );

  // --- 6. the fallback's model cache, for the same packaged-only reason -----
  // transformers.js derives its cache directory from its own module location, which packaged
  // is inside app.asar - a file, not a directory, so mkdir there fails with ENOTDIR. The
  // redirect that fixes it rides on HELM_CONFIG_PATH, which only packagedPaths.js sets, so
  // only a packaged run proves it lands somewhere writable.
  //
  // Read out of the PACKAGED process's own answer, not recomputed here: recomputing it in
  // this test would resolve it under this process's environment, which is a checkout, and
  // would pass no matter what the installed app does.
  // Not asserted against dataDir, which was the first attempt and was wrong: the harness
  // points HELM_CONFIG_PATH at its own temp config, and the cache correctly follows the
  // config directory, so that check failed on correct code. What must hold regardless of
  // where the config lives is that the answer is somewhere OUTSIDE the application bundle -
  // transformers.js's own default is inside it - and that it can actually be created.
  const cacheDir = voice?.fallbackCacheDir;
  const appDir = path.resolve(repo, "dist", "win-unpacked");
  ok(
    typeof cacheDir === "string" && cacheDir.length > 0 && !path.resolve(cacheDir).startsWith(appDir),
    `the packaged app keeps the fallback's model cache outside its own bundle (${cacheDir}), where transformers.js would have put it`
  );
  ok(!/app\.asar/.test(String(cacheDir)), "and specifically not inside app.asar, which is a file - mkdir there fails with ENOTDIR");
  // The real failure was a mkdir, so do the mkdir. A path that merely LOOKS writable is
  // what the original code had.
  let created = false;
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    created = fs.statSync(cacheDir).isDirectory();
  } catch (err) {
    created = `${err.code}: ${err.message}`;
  }
  ok(created === true, `and the packaged process's answer is a directory that can really be created (${created})`);
} finally {
  if (app) {
    await app.close();
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
}

// --- 7. and the case that USED to be silent, which the run above never reaches ---
//
// The machine this runs on has the payload, so every assertion above took the "ready"
// branch and the "cannot find it" branch was never executed once. That branch is the
// acceptance criterion - the card asked for a packaged build that finds the engine OR says
// clearly why not - so leaving it uncovered would mean the half that matters is asserted
// only by reading it.
//
// Pointing WHISPER_DIR at a folder that does not exist reproduces a machine without the
// payload, and does it through the strictest path: an explicit setting is an answer, so
// there must be no quiet fallback to the real payload sitting right there on this disk.
{
  const missing = path.join(os.tmpdir(), `helm-no-whisper-${Date.now()}`);
  const dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "helm-packaged-nowhisper-"));
  const previous = process.env.WHISPER_DIR;
  process.env.WHISPER_DIR = missing;
  process.env.HELM_DATA_DIR = dataDir2;
  let app2 = null;
  try {
    app2 = await launch({ command: exe, args: [], appDir: path.dirname(exe) });
    await app2.waitForSelector("#pageToggle", 60000, { visible: true });
    const voice2 = await app2.eval(`window.helm.voiceStatus()`);
    ok(voice2?.oneShot?.ready === false, `with the engine folder missing, the packaged app reports it as missing (ready: ${voice2?.oneShot?.ready})`);
    ok(
      typeof voice2?.oneShot?.why === "string" && voice2.oneShot.why.includes(missing),
      `and says why, naming the folder it was pointed at (${String(voice2?.oneShot?.why).slice(0, 160)})`
    );
    ok(
      /WHISPER_DIR|whisperDir/.test(String(voice2?.oneShot?.why)),
      "and names the setting responsible, so it can be corrected rather than guessed at"
    );
    ok(
      voice2?.oneShot?.root === missing,
      `and did NOT quietly fall back to the payload that is really on this disk (${voice2?.oneShot?.root})`
    );
  } finally {
    if (app2) {
      await app2.close();
    }
    if (previous === undefined) {
      delete process.env.WHISPER_DIR;
    } else {
      process.env.WHISPER_DIR = previous;
    }
    fs.rmSync(dataDir2, { recursive: true, force: true });
  }
}

console.log(
  exit === 0
    ? "VERIFY OK: the packaged build starts, persists its state, runs its off-main worker, and its tier guard can actually be executed."
    : "VERIFY FAILED - and this is the lane where a bug reaches the captain's installed app."
);
process.exit(exit);
