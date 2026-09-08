// LIVE-EXEMPT: it does start a session, but HELM_CLAUDE_BIN points the launcher at a wrapper
// around fixtures/fake-claude, so no model is reached and nothing is spent. Belt and braces on
// purpose - the refusal under test happens BEFORE the binary is spawned, so a working app
// reaches no CLI at all, and the stub is there for the run where the refusal has regressed.
//
// A first mate whose guard cannot START does not launch - in the real app, end to end.
//
// THE FAILURE THIS IS THE OTHER HALF OF (2026-09-08). tierGuard.js imported a personas.js
// that build.extraResources never shipped, so in every installed build from v0.2.268 the
// CLI spawned the hook, plain node died with ERR_MODULE_NOT_FOUND, and the harness saw a
// crashed hook - which denies nothing. main.js believed the guard was attached the whole
// time, because it decided that by asking whether the hook's own filename existed, and it
// did. Six days of first mates that everything downstream described as supervised.
//
// The packaging bug is fixed and a pure check now resolves the hook's import graph at
// build time. This check asks the question the app has to answer at RUN time: put a guard
// on disk that cannot start, and see what the app does with a tier that is not allowed to
// write files. It must refuse the launch and say why - not log into a console nobody reads
// and start the session anyway.
//
// COSTS NOTHING. The refusal happens before the CLI is spawned, so no model is reached and
// no tokens are spent. That is also the strongest evidence that the refusal is real: a turn
// that never started cannot have written anything.
//
// The positive control - that the guard this repo ships DOES start - is in
// pure-checks/test-tier-guard-can-start.mjs, which starts it. Without that half, "refused"
// here would be indistinguishable from an app that refuses every launch.
//
// Run:  node scripts/app-checks/test-tier-guard-must-start-to-launch.mjs
import { launch } from "../checks-lib/harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

let exitCode = 0;
const log = (...a) => console.log("[tier-guard-must-start]", ...a);
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-guard-start-e2e-"));
const metaHome = path.join(tmp, "meta-home");
fs.mkdirSync(metaHome, { recursive: true });
// A project root for the second-mate half. Rooted in a project, not the meta home - that
// is what a second mate IS in this model.
const projectDir = path.join(tmp, "a-project");
fs.mkdirSync(projectDir, { recursive: true });

// A hook that is PRESENT and cannot run. Same shape as the shipped bug: the entry point is
// exactly where main.js looks for it, and it dies before reaching any policy. Written as an
// import of a module that is not there so the failure is the real one (ERR_MODULE_NOT_FOUND,
// exit 1, empty stdout) rather than a hand-rolled process.exit(1).
const brokenHook = path.join(tmp, "brokenTierGuardHook.mjs");
fs.writeFileSync(brokenHook, 'import "./a-module-that-was-never-shipped.js";\n', "utf8");

// WAS THE CLI SPAWNED AT ALL, AND WITH WHAT? The question "did a session appear in the
// list" cannot answer the first half: a stub session has no transcript on disk, so it never
// reaches state.sessions, and a zero there is a zero whether the launch was refused or went
// ahead. Measured for real against the control below, which is what it is for.
//
// So the launcher is pointed at a stub that records its own argv and then delegates to
// fixtures/fake-claude. The recording is both measurements at once: the file exists if and
// only if something got as far as running the binary, and its contents say whether the
// launch carried a `--settings` with the guard's hook in it.
const argvLog = path.join(tmp, "cli-argv.jsonl");
const recorder = path.join(tmp, "recorder.mjs");
fs.writeFileSync(
  recorder,
  [
    'import fs from "node:fs";',
    `fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
    `await import(${JSON.stringify(pathToFileURL(path.join(here, "..", "checks-lib", "fixtures", "fake-claude.mjs")).href)});`,
    "",
  ].join("\n"),
  "utf8"
);
const stubCli = path.join(tmp, "stub-claude.cmd");
fs.writeFileSync(stubCli, ["@echo off", `node "${recorder}" %*`, ""].join("\r\n"), "utf8");

/** Every command line the launcher has handed the CLI so far. */
const launches = () =>
  fs.existsSync(argvLog)
    ? fs
        .readFileSync(argvLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

let app;
try {
  process.env.HELM_META_HOME_OVERRIDE = metaHome;
  process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
  process.env.HELM_TIER_GUARD_MODULE = brokenHook;
  process.env.HELM_CLAUDE_BIN = stubCli;
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // A meta-home session is a first mate only when it is BOUND to one - deciding by cwd
  // alone was itself a bug. So bind a real mate, the same way test-first-mate-guards does.
  const mateId = await app.eval(`window.helm.listMates().then(r => ((r.active || [])[0] || {}).mateId || null)`);
  assert(!!mateId, `there is a first mate to launch as (${mateId})`);

  const startArgs = `{
    cwd: ${JSON.stringify(metaHome)},
    prompt: "This turn must never reach a model.",
    model: "claude-haiku-4-5-20251001",
    effort: "low",
    mateId: ${JSON.stringify(mateId)}
  }`;
  const started = await app.eval(`window.helm.startSession(${startArgs})`);
  log("startSession:", JSON.stringify(started));

  assert(started?.ok === false, "the launch is REFUSED, not attempted with a guard that is not there");
  assert(
    started?.tierGuardUnavailable === true,
    "and refused for THIS reason - a bare ok:false would also be produced by a busy session or a missing binary, which would let this check pass on the wrong failure"
  );
  assert(/tier guard could not start/i.test(started?.error || ""), `the captain is told what happened, in the pane, at the moment they tried (${(started?.error || "").split("\n")[0]})`);
  assert(/a-module-that-was-never-shipped/.test(started?.error || ""), "and the message carries the child's own diagnosis, so it names the thing to fix rather than only the fact of failure");
  assert(!started?.launchId, "no launch id came back, so nothing downstream can believe a turn is running");

  // The pipe all the way to something a human sees. console.error was the ONLY alarm this
  // had before, and in a packaged Electron app nobody ever reads it - which is how six days
  // went by. Sticky notice, so it is still on screen whenever the captain next looks.
  await wait(500);
  const notice = await app.eval(`[...document.querySelectorAll(".notice .notice-text")].map((n) => n.textContent).join(" || ")`);
  log("notices:", notice);
  assert(/tier guard didn't start/i.test(notice), "a notice says so in the UI, not only in a console log");
  assert(/first-mate/.test(notice), "and names the tier that will not launch");
  assert(/a-module-that-was-never-shipped/.test(notice), "and names the thing to fix, which is the difference between an alarm and an answer");
  // Measured by SHAPE, not by length: the character count moved with the depth of the
  // machine's temp directory, so a deeper one would have turned this red for no
  // behavioural reason (independent review, 2026-09-08).
  assert(
    !/\bat \w+ \(node:/.test(notice) && notice.split("\n").length <= 2,
    `and does it in one line rather than pasting a V8 stack into the corner of the UI (${notice.split("\n").length} lines) - unreadable is its own way of not being read`
  );

  // A refused launch must let go of everything it took. THE TURN LOCK IS ONLY TAKEN FOR A
  // RESUME, which is why this passes a resumeSessionId: without one, main.js never reaches
  // sessionTurnLocks at all and the assertion measures nothing. It measured nothing until
  // the independent pass deleted all three release statements from the catch and both
  // checks stayed green (2026-09-08).
  const RESUMED = "a-session-that-must-not-stay-locked";
  const resumeArgs = `{
    cwd: ${JSON.stringify(metaHome)},
    prompt: "This turn must never reach a model either.",
    model: "claude-haiku-4-5-20251001",
    effort: "low",
    mateId: ${JSON.stringify(mateId)},
    resumeSessionId: ${JSON.stringify(RESUMED)}
  }`;
  const firstResume = await app.eval(`window.helm.startSession(${resumeArgs})`);
  assert(firstResume?.tierGuardUnavailable === true, `a RESUMED first-mate turn is refused the same way (${JSON.stringify(firstResume).slice(0, 90)})`);
  const secondResume = await app.eval(`window.helm.startSession(${resumeArgs})`);
  assert(
    secondResume?.tierGuardUnavailable === true && secondResume?.busy !== true,
    `and the same session can be tried again - the refusal released its turn lock instead of wedging that session as busy for the app's lifetime (${JSON.stringify(secondResume).slice(0, 120)})`
  );
  const stillLive = await app.eval(`window.helm.getSessions().then(() => (window.state?.sessions || []).length >= 0)`);
  assert(stillLive === true, "and the app is still answering after two refused launches");

  // And nothing was spawned: the refusal happens before the launcher reaches the binary.
  await wait(1500);
  assert(launches().length === 0, `the CLI was never spawned (${launches().length} launches) - so no turn ran, and no tokens could have been spent`);

  // THE CONTROL, because that absence has two explanations and only one of them is the
  // claim: a refusal that worked, and a marker that never gets written no matter what. So
  // the same app, the same broken hook, the same directory and the same stub CLI are asked
  // for a launch that is NOT tiered - a meta-home session with no mate bound is deliberately
  // not a first mate, so the guard is not consulted for it at all.
  //
  // The first version of this check asked "did a session appear in state.sessions" instead,
  // and this control is what exposed it: a stub session has no transcript on disk and never
  // reaches that list, so the answer was zero either way and the assertion above it was
  // measuring nothing.
  const control = await app.eval(`window.helm.startSession({
    cwd: ${JSON.stringify(metaHome)},
    prompt: "control launch",
    model: "claude-haiku-4-5-20251001",
    effort: "low"
  })`);
  assert(control?.ok === true, `an UNTIERED session in the same directory still launches (${JSON.stringify(control)}) - the refusal is about the tier, not about this app being unable to start anything`);
  let seen = 0;
  for (let i = 0; i < 20 && seen === 0; i++) {
    await wait(500);
    seen = launches().length;
  }
  assert(seen > 0, "and it DOES reach the CLI - so the absence above is a refusal, not a recording that never happens");

  // --- THE FAIL-OPEN HALF, which nothing covered ------------------------------------
  // Same app, same broken hook. A second mate has a write BUDGET rather than a ban, so the
  // deliberate choice is that it keeps launching and says so - and until now only the
  // blocked branch had ever been exercised, so a probe stuck at "false" would have
  // disarmed crew and second-mate guarding invisibly (independent review, 2026-09-08).
  //
  // WHAT THE RECORDER CANNOT SEE, so nobody rebuilds it expecting more. A TIERED launch
  // carries its seat's whole manual inline - 16KB for a first mate, 18KB for a fresh
  // second mate - and the stub here is a .cmd, which the launcher spawns through a shell
  // (it only skips the shell for a real .exe), where cmd.exe's 8191-character limit
  // applies. Measured: a fresh second mate dies synchronously with ENAMETOOLONG, and a
  // first mate returns ok:true and then fails asynchronously with nothing recorded. The
  // real claude.exe has four times the room and is spawned with no shell, so this is a
  // property of the stub and not of Helm. So `ok:true` - a launch id came back, the guard
  // did not block it - is what the fail-open branch is asserted on, and the CLI's own
  // argv is only readable for the UNTIERED control above.
  const secondMate = await app.eval(`window.helm.startSession({
    cwd: ${JSON.stringify(projectDir)},
    prompt: "second mate turn",
    model: "claude-haiku-4-5-20251001",
    effort: "low",
    secondMateId: "sm_0123456789ab",
    resumeSessionId: "a-second-mate-session"
  })`);
  assert(
    secondMate?.ok === true && !!secondMate?.launchId,
    `a SECOND MATE still launches with the same dead guard (${JSON.stringify(secondMate).slice(0, 120)}) - it may write anyway, so refusing it would cost a day's work to enforce a limit whose absence costs one uncounted edit`
  );
  assert(secondMate?.tierGuardUnavailable !== true, "and specifically is not refused for the reason the first mate was - that is the whole fail-open/fail-closed split, exercised rather than described");
  await wait(500);
  const openNotice = await app.eval(`[...document.querySelectorAll(".notice .notice-text")].map((n) => n.textContent).join(" || ")`);
  assert(
    /second-mate sessions are running WITHOUT it/.test(openNotice),
    `and the captain is told it is running unguarded, in the words the fail-open branch actually produces (${openNotice.slice(0, 200)})`
  );

  // --- AND THE OTHER WORLD: a guard that DOES start is still attached ---------------
  // Everything above is about the failure. On its own it is satisfied by a probe wedged at
  // "false", which would refuse every first mate and disarm every second mate while all of
  // these assertions stayed green - an invisible regression in the exact thing this change
  // exists to make visible (independent review, 2026-09-08). So a second app, with the
  // REAL hook, has to show a first mate launching with the guard on the command line.
  await app.close();
  app = null;
  delete process.env.HELM_TIER_GUARD_MODULE; // back to the hook this repo actually ships
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  const realMateId = await app.eval(`window.helm.listMates().then(r => ((r.active || [])[0] || {}).mateId || null)`);
  const good = await app.eval(`window.helm.startSession({
    cwd: ${JSON.stringify(metaHome)},
    prompt: "a guarded turn",
    model: "claude-haiku-4-5-20251001",
    effort: "low",
    mateId: ${JSON.stringify(realMateId)}
  })`);
  assert(good?.ok === true && good?.tierGuardUnavailable !== true, `with the real hook the same first mate DOES launch (${JSON.stringify(good)}) - a probe wedged at "false" fails HERE and nowhere else in this file`);
  await wait(1500);
  const noticesNow = await app.eval(`[...document.querySelectorAll(".notice .notice-text")].map((n) => n.textContent).join(" || ")`);
  assert(!/tier guard didn't start/i.test(noticesNow), `and nothing complains about a guard that did not start, because this one did (${noticesNow.slice(0, 120) || "no notices"})`);
  // What is NOT asserted here, deliberately: that the --settings the launch carries really
  // contains the PreToolUse hook. The stub CLI cannot receive a tiered command line at all
  // (see above), so its argv is unreadable for exactly the launches worth reading. That
  // half lives in test-tier-guard-wiring-and-migration.mjs (the launcher passes --settings,
  // with the catch-all matcher) and in test-packaged-build.mjs (the shipped hook, run for
  // real out of the packaged layout, through this same probe).
} finally {
  if (app) {
    await app.close();
  }
  delete process.env.HELM_TIER_GUARD_MODULE;
  delete process.env.HELM_CLAUDE_BIN;
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(exitCode === 0 ? "VERIFY OK: a tier that may not write files does not launch without a guard that starts, and the captain is told." : "VERIFY FAILED.");
process.exit(exitCode);
