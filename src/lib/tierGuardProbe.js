// Does the tier guard actually START?
//
// THE FAILURE THIS EXISTS FOR (2026-09-08, measured against the installed app).
// tierGuard.js began importing ./personas.js on 2026-09-02. package.json's
// build.extraResources shipped the hook and tierGuard.js and not the third file, so in
// every installed build from v0.2.268 the CLI spawned the hook under plain node and got
//
//   ERR_MODULE_NOT_FOUND: Cannot find module '...\tier-guard\lib\personas.js'
//
// exit 1, nothing on stdout. To the harness that is a hook that crashed, and a crashed
// PreToolUse hook does not deny anything - so for six days a first mate had no write
// guard and nothing anywhere said so. main.js's attach-time check passed the entire
// time, because what it checked was that the hook's own filename existed on disk, and it
// did. The file it named was never the thing that was missing.
//
// So the question this module answers is not "is the entry point there" and not "are
// these N files there" - a list of files is exactly what failed - but the only question
// whose answer cannot be wrong by omission: RUN IT AND SEE.
//
// HOW IT ASKS. It spawns the hook the way the CLI does and hands it a call that the
// policy MUST refuse, then requires the refusal back on stdout. That is deliberately
// stronger than "exit 0":
//
//   - a hook that cannot load its imports exits non-zero with an empty stdout (the
//     2026-09-08 shape), and fails here;
//   - a hook that loads but whose policy has gone inert answers with silence, which is how
//     this protocol spells ALLOW - and it fails here too, because silence is not an answer
//     to a call that must be denied.
//
// Only a guard that started, read its payload, reached the policy module and came back
// with a real refusal passes. Everything else is reported as not startable, with the
// child's own stderr as the diagnosis - which for the incident above is the
// ERR_MODULE_NOT_FOUND line itself, i.e. the answer and not just the alarm.
//
// SIDE EFFECTS: none, by construction. The probe runs as a FIRST MATE asking to Write, and
// that tier is a flat ban - decideToolCall refuses on the tool name alone, before any path
// is looked at, any file is opened or any turn counter is touched.
import { spawnSync } from "node:child_process";

import { TIER_FIRST_MATE } from "./tierGuard.js";

/**
 * The call the guard must refuse. A tool write by a first mate: the least ambiguous deny
 * in the whole policy, and the one that reaches its verdict without touching the disk.
 */
export const PROBE_CALL = Object.freeze({
  tool_name: "Write",
  tool_input: { file_path: "helm-tier-guard-probe-never-written.txt", content: "probe" },
  session_id: "helm-tier-guard-probe",
});

/**
 * How long a hook gets to answer before it counts as not having started.
 *
 * This blocks the main process while it runs (see the caller in main.js for why it has
 * to be synchronous), so the number is a ceiling on how long Helm can freeze, not a
 * generous allowance. "Did node start and print one line" is a sub-second question;
 * five seconds is already an enormous margin, and fifteen was fifteen seconds of frozen
 * window for no extra diagnostic value (independent review, 2026-09-08).
 */
export const PROBE_TIMEOUT_MS = 5000;

/**
 * The command string the CLI will actually run, built in ONE place - and the one thing
 * about it the probe cannot answer by running the hook.
 *
 * The hook is wired as `{type: "command", command: "..."}`: a STRING the CLI hands to a
 * shell, not an argv. The probe execs the runtime directly, and it has to, because a
 * synchronous spawn through a shell cannot be bounded - `timeout` kills the shell and the
 * grandchild keeps the pipes, so spawnSync waits forever. Measured on this machine, with
 * and without redirecting the child's output to files: both hung well past a 1.5s timeout.
 * A probe that can freeze Helm's main process indefinitely is a worse bug than the one it
 * was added to catch, so exec-directly it is.
 *
 * That leaves exactly one gap between what is tested and what runs: the shell's own
 * parsing of this string. Inside double quotes cmd.exe treats `&`, `^` and `|` literally,
 * so the only characters that can reshape it are a quote and a percent sign (variable
 * expansion). Neither can appear in a Windows path, but `bin` can come from HELM_NODE_BIN
 * and `script` from HELM_TIER_GUARD_MODULE, which are just strings someone set. So they
 * are refused here rather than certified by a probe that never sees a shell.
 *
 * The OTHER direction - a runtime that a shell can run and a direct exec cannot, i.e. a
 * `.cmd`/`.bat` node shim, which fails with EINVAL on Windows - is closed at the source
 * instead: tierGuardRunner never hands back a runtime that cannot be exec'd directly.
 * Both directions found by the independent pass, 2026-09-08.
 */
export function hookCommand(bin, script) {
  for (const [what, value] of [["runtime", bin], ["hook script", script]]) {
    if (/["%]/.test(String(value))) {
      throw new Error(
        `the tier guard's ${what} path contains a quote or a percent sign (${value}), which the shell that runs the hook would reparse. ` +
          "Move it somewhere with an ordinary path."
      );
    }
  }
  return `"${bin}" "${script}"`;
}

/**
 * Thrown when a tier whose policy is a flat ban is asked to launch without a guard that
 * starts. Carried as an exception rather than as a flag on the returned config, on
 * purpose: a caller that forgets to look at a flag launches unguarded, and a caller that
 * forgets to catch this does not launch at all. The safe direction is the one you get by
 * forgetting.
 */
export class TierGuardUnavailableError extends Error {
  constructor(tier, detail) {
    super(
      `The tier guard could not start, and a ${tier} does not write files - so this session was not launched. ` +
        `Fix the guard and try again; there is no supervised way to run this tier without it.\n\n${detail}`
    );
    this.name = "TierGuardUnavailableError";
    this.tierGuardUnavailable = true;
    this.tier = tier;
    this.detail = detail;
  }
}

/**
 * Start the hook once and require a real refusal back.
 *
 * @param {object} opts
 * @param {string} opts.bin        the runtime to run the hook with (a node, or Helm's own
 *                                 Electron with ELECTRON_RUN_AS_NODE set in `env`)
 * @param {string} opts.script     path to tierGuardHook.mjs
 * @param {object} [opts.env]      extra environment the runner needs
 * @param {number} [opts.timeoutMs]
 * @returns {{startable: boolean, detail: string}}
 */
export function probeTierGuard({ bin, script, env = {}, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  if (!bin || !script) {
    return { startable: false, detail: `nothing to run: bin=${bin || "(none)"} script=${script || "(none)"}` };
  }

  // Build the child's environment EXPLICITLY rather than letting it inherit Helm's.
  //
  // Helm can itself be running inside a tiered session (a crew iteration that starts the
  // app, which is how the E2E harness works), and then HELM_TIER, HELM_META_HOME and
  // HELM_TIER_SESSION are already set in this process - the probe would be asking about
  // whatever tier its parent happens to be, and writing that parent's turn counter.
  //
  // HELM_TIER_OVERRIDE is deleted for a sharper reason: with the hatch open the hook allows
  // everything and says so, which is correct behaviour and would read here as a guard that
  // cannot start. The probe asks whether the machinery works, not whether the captain has
  // deliberately switched it off - two different facts, and the hatch already announces
  // itself on every single call.
  const childEnv = { ...process.env, ...env, HELM_TIER: TIER_FIRST_MATE };
  delete childEnv.HELM_TIER_OVERRIDE;
  delete childEnv.HELM_TIER_SESSION;
  delete childEnv.HELM_META_HOME;
  delete childEnv.HELM_TIER_BUDGET;

  // Exec'd, not shelled - see hookCommand for why a shelled spawnSync cannot be bounded,
  // and what is done about the one thing this therefore does not test.
  let res;
  try {
    hookCommand(bin, script); // refuses a path the shell would reparse, before running anything
    res = spawnSync(bin, [script], {
      input: JSON.stringify(PROBE_CALL),
      encoding: "utf8",
      timeout: timeoutMs,
      env: childEnv,
      windowsHide: true,
    });
  } catch (err) {
    return { startable: false, detail: `the runtime could not be spawned at all: ${err?.message || err}` };
  }

  const stderr = excerpt(res.stderr);
  if (res.error) {
    const why = res.error.code === "ETIMEDOUT" ? `it did not answer within ${timeoutMs}ms` : res.error.message;
    return { startable: false, detail: `${why}${stderr ? `\n${stderr}` : ""}` };
  }
  if (res.status !== 0) {
    // The 2026-09-08 shape lands here, and the child's stderr IS the diagnosis.
    return {
      startable: false,
      detail:
        `it exited ${res.status}${res.signal ? ` (${res.signal})` : ""} instead of 0 - to the CLI that is a hook that ` +
        `crashed, and a crashed hook denies nothing.${stderr ? `\n${stderr}` : ""}`,
    };
  }

  const stdout = (res.stdout || "").trim();
  if (!stdout) {
    return {
      startable: false,
      detail:
        `it started and exited 0 but printed nothing, which in this protocol means ALLOW - and the probe call ` +
        `(a ${TIER_FIRST_MATE} calling ${PROBE_CALL.tool_name}) is one the policy must refuse.${stderr ? `\n${stderr}` : ""}`,
    };
  }

  let decision;
  try {
    decision = JSON.parse(stdout)?.hookSpecificOutput?.permissionDecision;
  } catch {
    return { startable: false, detail: `it answered with something that is not the JSON the CLI reads: ${excerpt(stdout)}` };
  }
  if (decision !== "deny") {
    return { startable: false, detail: `it answered "${decision}" to a call the policy must deny, so the policy that ran is not this one.` };
  }

  return {
    startable: true,
    detail: `refused a ${TIER_FIRST_MATE}'s ${PROBE_CALL.tool_name}, so the hook, its imports and the policy all loaded.`,
  };
}

/**
 * The one line worth putting in front of a human.
 *
 * `detail` is a diagnosis and belongs in a log; pasted into a notice it is twenty lines of
 * V8 stack in the corner of the UI, which is its own way of not being read. A crashed node
 * process states its problem on the line that starts with an Error class - "Error
 * [ERR_MODULE_NOT_FOUND]: Cannot find module ...\lib\personas.js" - and everything above
 * and below it is frames. So that line is what a notice shows, with the rest still one
 * console entry away.
 */
export function headline(detail) {
  const lines = String(detail || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.find((l) => /^[A-Za-z]*Error\b/.test(l)) || lines[0] || "no detail";
}

/**
 * Enough of a stream to diagnose from, not enough to fill a notice. From the FRONT: a
 * process that died on startup says why near the top and spends the rest on a stack, and
 * it was that part ("Cannot find module ... /lib/personas.js") that named the whole
 * 2026-09-08 bug. Keeping the tail instead would have thrown it away and kept the frames.
 */
function excerpt(text, limit = 600) {
  const trimmed = (text || "").trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}...` : trimmed;
}
