// Helm can tell a tier guard that RUNS from one that crashes on startup.
//
// THE FAILURE THIS CLOSES (2026-09-08, measured against the installed app, not inferred).
// main.js decided the guard was attached by asking whether the hook's own filename
// existed. It did. Behind it, tierGuard.js imported a personas.js that extraResources
// never shipped, so the CLI spawned the hook under plain node and got
// ERR_MODULE_NOT_FOUND - exit 1, empty stdout, which to the harness is a hook that
// crashed, and a crashed PreToolUse hook denies nothing. Six days of installed builds
// from v0.2.268 had a first mate with no write guard, and every layer of the app went on
// describing those sessions as supervised.
//
// The packaging bug is fixed elsewhere. This is the other half: the app must not be able
// to be wrong about this again, and it must not be made right by a longer list of files -
// a list one entry short is exactly the bug. So the check is behavioural: START THE THING.
//
// WHAT "STARTABLE" MEANS HERE, and why it is not exit 0. The probe hands the hook a call
// the policy must refuse and requires the refusal back. Exit 0 alone would be passed by a
// hook that loads and answers nothing, and answering nothing is how this protocol spells
// ALLOW - i.e. by a guard that is running and inert. Both halves are given a control
// below, because a check with only the passing case cannot tell "it works" from "it never
// looks".
//
// Pure - no app, no model, no build. The negative controls are real broken hooks on disk,
// one of them a byte-for-byte reconstruction of the shipped failure.
// Run:  node scripts/pure-checks/test-tier-guard-can-start.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { probeTierGuard, hookCommand, headline, PROBE_CALL, PROBE_TIMEOUT_MS, TierGuardUnavailableError } from "../../src/lib/tierGuardProbe.js";
import { decideToolCall, turnCounterPath, TIER_FIRST_MATE, TIER_SECOND_MATE, TIER_CREW, TIER_ASSISTANT } from "../../src/lib/tierGuard.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REAL_HOOK = path.join(repo, "src", "hooks", "tierGuardHook.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-guard-start-"));
const probe = (script, env, bin = process.execPath) => probeTierGuard({ bin, script, env });

// --- 1. the positive control: the guard this repo ships does start -----------------
{
  const res = probe(REAL_HOOK);
  ok(res.startable, `the hook in src/ starts and refuses the probe call (${res.detail})`);
}

// --- 2. the 2026-09-08 shape, rebuilt ----------------------------------------------
// The hook and the policy module, laid out exactly as extraResources laid them out, with
// the one file tierGuard.js imports left behind. This is the state that shipped, and the
// check exists to be red in it.
{
  const shipped = path.join(tmp, "as-shipped");
  fs.mkdirSync(path.join(shipped, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(shipped, "lib"), { recursive: true });
  fs.copyFileSync(REAL_HOOK, path.join(shipped, "hooks", "tierGuardHook.mjs"));
  fs.copyFileSync(path.join(repo, "src", "lib", "tierGuard.js"), path.join(shipped, "lib", "tierGuard.js"));
  // personas.js deliberately not copied. That is the whole bug.

  const missingFile = path.join(shipped, "lib", "personas.js");
  ok(!fs.existsSync(missingFile), "the reconstruction really is missing the file the policy imports");
  const entry = path.join(shipped, "hooks", "tierGuardHook.mjs");
  ok(fs.existsSync(entry), "and the ENTRY POINT is present - which is all the old existsSync check ever asked, and why it stayed green");

  const res = probe(entry);
  ok(!res.startable, "a hook whose import graph is incomplete is reported as not startable");
  ok(/personas\.js/.test(res.detail), "and the diagnosis names the file that is actually missing");

  // What a human is shown. The detail is a diagnosis and belongs in a log; the notice gets
  // the line that names the problem, or the alarm arrives as twenty lines of V8 stack in
  // the corner of the UI and is skipped for being unreadable.
  const line = headline(res.detail);
  ok(/personas\.js/.test(line) && !/\bat \w+ \(node:/.test(line), `the headline is the error itself, not a frame from its stack (${line})`);
  ok(headline("") === "no detail" && headline("only one line") === "only one line", "and it degrades to something sayable when there is no stack to read");
}

// --- 3. the other half: running is not the same as guarding -------------------------
// A check that only asked for exit 0 would pass both of these, and both are a session
// that writes whatever it likes.
{
  const inert = path.join(tmp, "inert.mjs");
  fs.writeFileSync(inert, "process.exit(0);\n", "utf8");
  const res = probe(inert);
  ok(!res.startable, "a hook that exits 0 and says nothing FAILS - silence is this protocol's ALLOW, and the probe call must be denied");

  const permissive = path.join(tmp, "permissive.mjs");
  fs.writeFileSync(
    permissive,
    'process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } }));\n',
    "utf8"
  );
  const allowed = probe(permissive);
  ok(!allowed.startable, "and so does one that answers a well-formed ALLOW to a call the policy bans");

  const garbage = path.join(tmp, "garbage.mjs");
  fs.writeFileSync(garbage, 'process.stdout.write("not json");\n', "utf8");
  ok(!probe(garbage).startable, "and one that answers something the CLI could not read as a decision");

  // ANYTHING THAT IS NOT A DENY, not just an explicit allow. The three cases above all
  // survived a mutation of `decision !== "deny"` into `decision === "allow"` (independent
  // review, 2026-09-08), because none of them produce a verdict that is neither - and a
  // hook answering "ask", or a well-formed envelope with no decision in it at all, would
  // then have certified as a working guard.
  for (const [name, body] of [
    ["ask", '{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } }'],
    ["no decision at all", '{ hookSpecificOutput: { hookEventName: "PreToolUse" } }'],
    ["an empty envelope", "{}"],
  ]) {
    const f = path.join(tmp, `verdict-${name.replace(/\W+/g, "-")}.mjs`);
    fs.writeFileSync(f, `process.stdout.write(JSON.stringify(${body}));\n`, "utf8");
    ok(!probe(f).startable, `and one that answers ${name} - only a real refusal counts, because only a refusal proves the policy ran`);
  }
}

// --- 3b. the failure the probe itself can hit: no answer at all ----------------------
// res.error - a spawn that fails, or a hook that never returns. Untested until the
// independent pass mutated that branch to `startable: true` and BOTH checks stayed green
// (2026-09-08), which is the exact shape of a future "be lenient about transient hiccups"
// edit quietly re-opening the hole.
//
// It is also the assertion that pins the probe to exec-ing rather than shelling. A
// spawnSync through a shell CANNOT be bounded - the timeout kills the shell and the
// grandchild keeps the pipes - so this hangs forever if anyone reintroduces `shell: true`,
// which is how it was found. A check that hangs is a bad check; this one hangs only on a
// change that could freeze Helm's own main process, so it is the right thing to hang on.
{
  const hangs = path.join(tmp, "hangs.mjs");
  fs.writeFileSync(hangs, "setInterval(() => {}, 1000);\n", "utf8");
  const started = Date.now();
  const res = probeTierGuard({ bin: process.execPath, script: hangs, timeoutMs: 1500 });
  const took = Date.now() - started;
  ok(!res.startable, "a hook that never answers is not startable");
  ok(/did not answer within/.test(res.detail), `and says so as a timeout rather than as a mystery (${res.detail})`);
  ok(took < 10000, `and the timeout REALLY bounds it (${took}ms) - the probe blocks Helm's main process while it runs, so an unbounded one freezes the app`);
  ok(PROBE_TIMEOUT_MS <= 5000, `the real ceiling stays small (${PROBE_TIMEOUT_MS}ms) for the same reason`);
}

// --- 3c. the gap between what is probed and what the CLI runs ------------------------
// The hook is wired as a `type: "command"` STRING the CLI hands to a shell; the probe
// execs. Two divergences, both found by the independent pass on 2026-09-08 and both
// closed away from the probe, because the probe itself has to exec (see 3b).
{
  ok(hookCommand("C:\\n\\node.exe", "C:\\h\\hook.mjs") === '"C:\\n\\node.exe" "C:\\h\\hook.mjs"', "hookCommand quotes both halves, so a path with a space survives the shell");
  // Inside double quotes cmd leaves & ^ | alone; a quote and a percent sign are the two
  // that reshape the line, and both reach here from environment variables.
  for (const bad of ['C:\\a"b\\node.exe', "C:\\%PATH%\\node.exe"]) {
    let threw = false;
    try {
      hookCommand(bad, "C:\\h\\hook.mjs");
    } catch {
      threw = true;
    }
    ok(threw, `a runtime path the shell would reparse (${bad}) is refused rather than certified by a probe that never sees a shell`);
  }

  // THE OTHER DIRECTION, closed in tierGuardRunner instead: a .cmd/.bat node shim runs
  // fine through the CLI's shell and cannot be exec'd at all, so the probe must never be
  // handed one - otherwise every first mate on a machine with a shimmed node stops
  // launching. The control first, or the rule below is a rule about nothing.
  if (process.platform === "win32") {
    const shim = path.join(tmp, "node-shim.cmd");
    fs.writeFileSync(shim, ["@echo off", `"${process.execPath}" %*`, ""].join("\r\n"), "utf8");
    const direct = spawnSync(shim, [REAL_HOOK], { input: "{}", encoding: "utf8" });
    ok(direct.error?.code === "EINVAL", `a .cmd runtime really cannot be exec'd directly (${direct.error?.code || "it could"}) - the control for the two lines below`);
    ok(!probe(REAL_HOOK, {}, shim).startable, "so handing one to the probe reads as 'did not start', which is why it must not be handed one");

    const mainSrc = fs.readFileSync(path.join(repo, "src", "main.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, "");
    ok(
      /DIRECTLY_EXECUTABLE/.test(mainSrc) && /\.\(exe\|com\)\$/.test(mainSrc),
      "and tierGuardRunner only accepts a directly executable runtime, falling back to the app's own binary rather than reporting a shim as a dead guard"
    );
  }
}

// --- 4. nothing to run at all --------------------------------------------------------
{
  ok(!probe(path.join(tmp, "no-such-hook.mjs")).startable, "a hook that is not on disk is not startable (the case the old check DID cover, still covered)");
  ok(!probeTierGuard({ bin: null, script: REAL_HOOK }).startable, "and neither is a real hook with no runtime to run it with");
}

// --- 5. the probe must not answer a question about its PARENT ------------------------
// Helm can itself be running inside a tiered session - the E2E harness starts the app
// from a crew iteration - so HELM_TIER and friends can already be in this process. If the
// probe inherited them it would be asking about that tier, and writing that tier's turn
// counter.
{
  const counterHome = path.join(tmp, "meta-home");
  const saved = { ...process.env };
  process.env.HELM_TIER = TIER_CREW;
  process.env.HELM_META_HOME = counterHome;
  process.env.HELM_TIER_SESSION = "someone-elses-session";
  process.env.HELM_TIER_BUDGET = "99";
  try {
    ok(probe(REAL_HOOK).startable, `a parent HELM_TIER of "${TIER_CREW}" does not change the answer - crew may write, and the probe would have read as broken`);
    ok(!fs.existsSync(counterHome), "and the probe wrote no turn counter anywhere - it asks a question that needs no disk");

    // With the escape hatch open the hook allows everything and says so on stderr. That is
    // correct behaviour, deliberately switched on, and it must not read as a guard that
    // cannot start - the hatch already announces itself on every call it passes.
    process.env.HELM_TIER_OVERRIDE = "1";
    ok(probe(REAL_HOOK).startable, "and an open HELM_TIER_OVERRIDE does not either: the probe asks whether the machinery works, not whether it is switched on");
  } finally {
    for (const k of ["HELM_TIER", "HELM_META_HOME", "HELM_TIER_SESSION", "HELM_TIER_BUDGET", "HELM_TIER_OVERRIDE"]) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  }
  ok(!fs.existsSync(turnCounterPath(counterHome, "someone-elses-session")), "no counter for the parent session survives any of that");
}

// --- 6. the probe call is one the policy genuinely refuses ---------------------------
// If a later edit made this call allowable, every probe above would pass on a dead guard
// and nothing would say so. Asserted against the policy itself rather than assumed.
{
  const verdict = decideToolCall({ tier: TIER_FIRST_MATE, tool: PROBE_CALL.tool_name, input: PROBE_CALL.tool_input });
  ok(verdict.decision === "deny", `the policy refuses the probe call outright (${verdict.decision}) - the probe is only meaningful while it does`);
}

// --- 7. what a failed probe DOES, per tier ------------------------------------------
// The doctrine: a tier whose policy is a flat ban has nothing else supervising it, so a
// guard that cannot start means it does not launch. A tier that may write anyway keeps
// launching, loudly, because refusing it would cost a day's work to enforce a limit whose
// absence costs an uncounted edit. That is the same split the hook already makes one layer
// down when its classifier throws.
//
// The behavioural half is asserted against the policy, because that is where main.js asks
// the question - it holds no list of "strict tiers" to drift.
{
  // The same expression main.js uses. Asked as a POSITIVE - "does the policy say this tier
  // writes" - and that detail is the whole assertion, not a style choice. The first version
  // tested for a deny, and decideToolCall's fall-through ALLOWS an unrecognised tier, so a
  // tier wired into a launch before its policy branch existed would have gone through
  // unguarded: the exact omission this design claims to have closed (independent review,
  // 2026-09-08).
  const mayLaunchUnguarded = (tier) => {
    const v = decideToolCall({ tier, tool: "Write", input: { file_path: "not-an-artifact.txt" }, writesThisTurn: 0 });
    return v.decision === "allow" && v.isWrite === true;
  };
  ok(!mayLaunchUnguarded(TIER_FIRST_MATE), "a first mate is a flat ban, so a dead guard must block its launch");
  ok(!mayLaunchUnguarded(TIER_ASSISTANT), "and so is the assistant seat - the tier that was already on the open side once by omission");
  ok(mayLaunchUnguarded(TIER_SECOND_MATE), "a second mate has a budget, not a ban, so it launches without one");
  ok(mayLaunchUnguarded(TIER_CREW), "and crew writes in its worktree by design");
  for (const unknown of ["third-mate", "quartermaster", "", null]) {
    ok(!mayLaunchUnguarded(unknown), `a tier the policy does not recognise (${JSON.stringify(unknown)}) lands on the REFUSED side, not the open one`);
  }

  const err = new TierGuardUnavailableError(TIER_FIRST_MATE, "the reason it did not start");
  ok(err.tierGuardUnavailable === true, "the refusal travels as a tagged exception, so a call site that forgets to handle it does not launch rather than launching unguarded");
  ok(err.message.includes("the reason it did not start"), "and carries the diagnosis into the message the captain reads");
}

// --- 8. and main.js actually wires it that way ---------------------------------------
// Source, and said out loud: main.js needs Electron to import. The half that can be run is
// run above; this half checks that the app reaches for it.
{
  // COMMENTS STRIPPED FIRST. Without it these assertions match commented-out code, which
  // is not a hypothetical: the independent pass commented the throw out, replaced it with
  // `return {}`, and this section stayed green while a first mate launched unguarded
  // (2026-09-08). Same strip() the sibling wiring check has used since it was written.
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, "");
  const mainSrc = strip(fs.readFileSync(path.join(repo, "src", "main.js"), "utf8"));
  ok(/probeTierGuard\(\{ bin:/.test(mainSrc), "main.js CALLS the probe - matching the bare name would also match the import line and nothing else");
  ok(
    !/fs\.existsSync\(hookScript\)/.test(mainSrc),
    "and no longer decides the guard is attached because the hook's own filename exists - the check that was green through the whole outage"
  );
  ok(/throw new TierGuardUnavailableError/.test(mainSrc), "a tier that cannot be supervised is refused, not launched");
  ok(
    /tierMayLaunchUnguarded/.test(mainSrc) && /decideToolCall\(/.test(mainSrc),
    "and which tiers those are is ASKED of the policy, not listed in main.js - a hand-kept list of tiers is the same failure as a hand-kept list of files"
  );
  ok(
    /const command = hookCommand\(/.test(mainSrc),
    "the launch config emits the SAME command string the probe ran - a probe that certified a different string certified nothing"
  );
  ok(/tierGuard:problem/.test(mainSrc), "the failure reaches the renderer, not only console.error which nobody reads in a packaged app");
  const preload = strip(fs.readFileSync(path.join(repo, "src", "preload.cjs"), "utf8"));
  const renderer = strip(fs.readFileSync(path.join(repo, "src", "renderer", "renderer.js"), "utf8"));
  ok(/tierGuard:problem/.test(preload) && /onTierGuardProblem/.test(renderer), "and the channel is bridged and listened to, or it is a send into nothing");
  ok(
    /sessions are running WITHOUT it/.test(renderer),
    "and the renderer has a sentence for the FAIL-OPEN case too - a tier that keeps launching without a guard has to say so, and the branch is exercised end to end in the app check"
  );

  // THE CALL-SITE CLASS. The throw is only safe because every site that could receive one
  // catches it, and today that holds partly by luck: crew and second mate pass literal
  // tiers that may write, so they never see it. That is an invariant nothing asserted
  // (independent review, 2026-09-08), and the DECISIONS entry explicitly expects new tiers.
  const sites = [...mainSrc.matchAll(/tierGuardLaunchConfig\((\w+|TIER_\w+)/g)].map((m) => m[1]);
  ok(sites.length >= 3, `every tierGuardLaunchConfig call site is accounted for (${sites.length} found: ${sites.join(", ")})`);
  const literalTiers = { TIER_CREW, TIER_SECOND_MATE, TIER_FIRST_MATE, TIER_ASSISTANT };
  for (const site of sites) {
    if (site in literalTiers) {
      ok(
        mayLaunchUnguardedFor(literalTiers[site]),
        `the site launching a literal ${site} passes a tier that can never throw - if that stops being true, that call site must catch TierGuardUnavailableError like session:start does`
      );
    } else {
      ok(
        /if \(err\?\.tierGuardUnavailable\)/.test(mainSrc),
        `the site launching a variable tier (${site}) is covered by a catch that handles tierGuardUnavailable`
      );
    }
  }
}

/** The same question main.js asks, hoisted so section 8 can reuse it. */
function mayLaunchUnguardedFor(tier) {
  const v = decideToolCall({ tier, tool: "Write", input: { file_path: "not-an-artifact.txt" }, writesThisTurn: 0 });
  return v.decision === "allow" && v.isWrite === true;
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(exit === 0 ? "VERIFY OK: a guard that cannot start is detected by starting it, and a tier that cannot be supervised does not launch." : "VERIFY FAILED.");
process.exit(exit);
