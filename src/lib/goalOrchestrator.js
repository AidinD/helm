import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveClaudeBinary } from "./launcher.js";
import { createWorktree, removeWorktree } from "./worktree.js";
import { buildRepoMap } from "./repoMap.js";

/**
 * Fas 3 Point 11 v1 — a real goal orchestrator, adapted (not copied) from
 * gnhf's source-verified architecture (see PLAN.md's Phase 4 gnhf entry and
 * DECISIONS.md's 2026-07-03 source-read entries). Confirmed shape reused
 * here on purpose, not reinvented:
 *
 *   - A FRESH `claude -p` subprocess per iteration, no `--resume` — this is
 *     gnhf's actual verified architecture for the CLI-agent family, not an
 *     assumption. Continuity comes from a notes.md file the orchestrator
 *     itself writes, never from conversation memory.
 *   - One git commit per successful iteration, message built from that
 *     iteration's own structured JSON output (not a separate LLM call).
 *   - `git reset --hard` + `git clean -fd` on a failed iteration, mirroring
 *     gnhf's verified rollback behavior.
 *   - All work happens in an isolated worktree (`worktree.js`, already built
 *     and spike-verified) — never the primary checkout.
 *
 * Per the human-gating principle (PLAN.md Phase 3, "human gating scaled to
 * blast radius") and matching the `ship-review` skill's own "stop before
 * push" stance: this module NEVER pushes, merges back to the primary
 * checkout, or opens a PR. It leaves a worktree + branch + commits + notes.md
 * for a human (or a future dispatched review pass) to look at.
 *
 * v1 scope, deliberately small: no dispatch UI, no coach/escalation layer,
 * no dependency-install into the worktree (same gap worktree.js's own
 * createWorktree already documents and defers). Reuses launcher.js's
 * resolveClaudeBinary + spawn conventions rather than reinventing subprocess
 * plumbing, and judge.js/orchestratorHelper.js's cost-optimized structured-
 * output recipe (--output-format json + --json-schema) for each iteration's
 * result, rather than parsing free text.
 *
 * RPI phasing (added after v1, per PLAN.md's practitioner-research section /
 * Dex Horthy's 12-Factor Agents, and DECISIONS.md's 2026-07-04 entry): rather
 * than every iteration running the same "work on the smallest next step"
 * prompt, a goal run now moves through three phases in order — `research`
 * (read-only investigation, findings written to notes.md), `plan` (a durable
 * `.maestro-goal/plan.md` artifact, no code edits), then `implement` (today's
 * pre-existing behavior, gated on plan.md existing, iterating until done or
 * maxIterations). The phase is persisted to `.maestro-goal/phase.json` so it
 * survives the same fresh-subprocess-per-iteration model notes.md already
 * survives, and is included on every iteration record so a future UI layer
 * can display it and gate an "approve plan before implement" human checkpoint
 * — that approval UI is a deferred follow-up, NOT built by this change; today
 * the phase auto-advances the moment a phase-completing iteration succeeds.
 *
 * Repo-map priming (praktiker mechanism #5, PLAN.md/DECISIONS.md's
 * Paul Gauthier/aider entry): every iteration is a fresh, context-blind
 * subprocess that otherwise has to re-discover the repo's shape from scratch
 * via Read/Grep before it can even start reasoning about the goal. `repoMap.js`
 * builds a compact, budget-capped signature map of the project once per
 * `runGoal` call (right after the worktree is created - the repo's overall
 * shape does not change meaningfully iteration-to-iteration within one goal
 * run, so recomputing it every iteration would just be wasted work) and it is
 * prepended to every iteration's prompt via `repoMapContent` below.
 */

const NOTES_DIR = ".maestro-goal";
const NOTES_FILENAME = "notes.md";
const PHASE_FILENAME = "phase.json";
const PLAN_FILENAME = "plan.md";
const DEFAULT_MAX_ITERATIONS = 5;

// RPI phasing (Dex Horthy, 12-Factor Agents — see PLAN.md's practitioner-
// research section and DECISIONS.md's 2026-07-04 entry): instead of every
// iteration running the same undifferentiated "work on the smallest next
// step" prompt, the first iteration researches, the second plans (writing a
// durable plan.md artifact), and only then does the loop switch to the
// existing implement behavior for the remaining iterations. The plan
// artifact is itself file-memory, readable by later iterations AND by a
// future UI layer without re-deriving it from notes.md prose.
const PHASE_ORDER = ["research", "plan", "implement"];

// Generous — an iteration is a real coding turn (may run builds/tests/lint
// itself), not a cheap classifier call. Bounds a hung subprocess (e.g. an
// auth prompt with no TTY to answer it) so a stuck child can't wedge the
// whole goal run forever.
const ITERATION_TIMEOUT_MS = 15 * 60_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

// A verification command is expected to be a normal build/test/lint run, not
// a long-running server — generous but bounded so a hung command (e.g. a test
// runner that starts a watcher instead of exiting) can't wedge the iteration
// loop forever.
const VERIFY_TIMEOUT_MS = 10 * 60_000;
const VERIFY_OUTPUT_TAIL_CHARS = 4000;

const ITERATION_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    success: { type: "boolean" },
    summary: { type: "string" },
    keyChanges: { type: "array", items: { type: "string" } },
    keyLearnings: { type: "array", items: { type: "string" } },
  },
  required: ["success", "summary", "keyChanges", "keyLearnings"],
});

const COMMON_ITERATION_RULES = [
  "You are one iteration of a fresh-context autonomous coding agent working",
  "toward a larger goal, one small step at a time. You have NO memory of",
  "previous iterations except the notes.md content included in your prompt —",
  "treat that as the complete record of what's already been done and learned.",
  "",
  "Rules that apply to every iteration regardless of phase:",
  "- Do NOT run `git commit` yourself. The orchestrator commits your changes",
  "  after this call returns, using your own summary as the commit message.",
  "- Stop any background processes/servers you started before finishing —",
  "  nothing should be left running after your turn ends.",
  "- Set success:false if you could not make real, safe progress this",
  "  iteration (e.g. the step turned out to be ambiguous, blocked, or you hit",
  "  an error you couldn't resolve). The orchestrator will discard ALL file",
  "  changes from a success:false iteration, so do not set success:true unless",
  "  the working tree is actually in a good, coherent state.",
  "- Respond only in the requested JSON schema. summary is ONE sentence",
  "  describing what this iteration actually did (used verbatim as the git",
  "  commit message). keyChanges is a short list of concrete changes made.",
  "  keyLearnings is a short list of anything future iterations should know",
  "  (dead ends, gotchas, decisions made) — this is the ONLY way that",
  "  knowledge survives into the next iteration.",
].join("\n");

// RPI phasing (PLAN.md's practitioner-research section, Dex Horthy /
// 12-Factor Agents): each phase gets its own narrow system prompt instead of
// one undifferentiated "work on the smallest next step" prompt for every
// iteration. `implement` is today's pre-existing behavior, unchanged in
// substance — `research` and `plan` are new, deliberately restricted phases
// that run before it.
const PHASE_PROMPTS = {
  research: [
    COMMON_ITERATION_RULES,
    "",
    "This iteration's phase is RESEARCH.",
    "",
    "Rules specific to this phase:",
    "1. Investigate the codebase and any other available context needed to",
    "   understand how to achieve the overall goal. Read files, search for",
    "   relevant code, run read-only inspection commands as needed.",
    "2. Do NOT edit, create, or delete any file except notes.md, and do NOT",
    "   run any command that changes the working tree (no code edits, no",
    "   `git` mutations, no installs). This phase is read-only by design —",
    "   the orchestrator does not verify tree cleanliness for this phase, so",
    "   the instruction alone is the only guard.",
    "3. Before finishing, write your findings to the continuity notes file at",
    "   `.maestro-goal/notes.md` (append, do not overwrite): what the",
    "   relevant code/architecture looks like, constraints discovered, open",
    "   questions, and a recommended approach. This is the ONLY deliverable",
    "   of this phase — the next phase (plan) will read it instead of",
    "   re-researching from scratch.",
    "4. Set success:true once you've written useful findings to notes.md,",
    "   even though no other file changed — a research iteration with no code",
    "   diff is expected and is not itself a failure.",
  ].join("\n"),

  plan: [
    COMMON_ITERATION_RULES,
    "",
    "This iteration's phase is PLAN.",
    "",
    "Rules specific to this phase:",
    "1. Using the goal and the research notes below, write a concrete,",
    "   actionable implementation plan to `.maestro-goal/plan.md`. Create the",
    "   file if it does not exist, or replace it if it does — plan.md always",
    "   reflects the current, single best plan, not a history of revisions.",
    "2. The plan should break the goal into a sequence of small, concrete",
    "   implementation steps an `implement`-phase iteration (which only ever",
    "   works on one smallest-next-step at a time, with no memory beyond",
    "   notes.md and this plan) can follow one at a time.",
    "3. Do NOT make any other code changes this iteration. This phase's only",
    "   deliverable is `.maestro-goal/plan.md` itself.",
    "4. Set success:true once `.maestro-goal/plan.md` has been written with a",
    "   real plan — that alone is a complete, successful iteration for this",
    "   phase.",
  ].join("\n"),

  implement: [
    COMMON_ITERATION_RULES,
    "",
    "This iteration's phase is IMPLEMENT.",
    "",
    "Rules specific to this phase:",
    "1. A plan already exists at `.maestro-goal/plan.md` (included below).",
    "   Work on the SMALLEST next logical step from that plan, not the whole",
    "   goal at once. Leave the rest for future iterations.",
    "2. Run any relevant build/test/lint yourself and fix what you find before",
    "   finishing — don't leave broken code for the next iteration to inherit.",
  ].join("\n"),
};

function runGit(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
}

function notesPath(worktreePath) {
  return path.join(worktreePath, NOTES_DIR, NOTES_FILENAME);
}

/** Reads the current notes.md content, creating the dir/file if absent. */
function readOrCreateNotes(worktreePath) {
  const dir = path.join(worktreePath, NOTES_DIR);
  const file = notesPath(worktreePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(file)) {
    const header = `# Goal orchestrator notes\n\nThis file is the ONLY continuity mechanism between iterations — each\niteration runs in a fresh subprocess with no conversation memory. See\nDECISIONS.md / PLAN.md (Fas 3 Point 11) in the Maestro repo for why.\n`;
    fs.writeFileSync(file, header, "utf8");
    return header;
  }
  return fs.readFileSync(file, "utf8");
}

/** Appends one iteration's structured summary to notes.md. */
function appendNotes(worktreePath, iterationNumber, result) {
  const file = notesPath(worktreePath);
  const lines = [
    "",
    `## Iteration ${iterationNumber} — ${result.success ? "success" : "DISCARDED (success:false)"}`,
    "",
    `Summary: ${result.summary}`,
  ];
  if (result.keyChanges?.length) {
    lines.push("", "Key changes:", ...result.keyChanges.map((c) => `- ${c}`));
  }
  if (result.keyLearnings?.length) {
    lines.push("", "Key learnings:", ...result.keyLearnings.map((l) => `- ${l}`));
  }
  lines.push("");
  fs.appendFileSync(file, lines.join("\n"), "utf8");
}

function phasePath(worktreePath) {
  return path.join(worktreePath, NOTES_DIR, PHASE_FILENAME);
}

function planPath(worktreePath) {
  return path.join(worktreePath, NOTES_DIR, PLAN_FILENAME);
}

/**
 * Reads the persisted RPI phase, defaulting to the first phase (`research`)
 * when no phase file exists yet (a brand-new goal run). Persisting phase to
 * disk under the same `.maestro-goal/` dir as notes.md — rather than only in
 * a JS variable local to the `runGoal` loop — matters because that directory
 * is the one piece of state that survives the fresh-subprocess-per-iteration
 * model; a future caller inspecting or resuming a goal run from just the
 * worktree (e.g. after an app restart) can recover which phase it stopped in
 * the same way it recovers notes.md.
 */
function readPhase(worktreePath) {
  const file = phasePath(worktreePath);
  if (!fs.existsSync(file)) {
    return PHASE_ORDER[0];
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (PHASE_ORDER.includes(data.phase)) {
      return data.phase;
    }
  } catch {
    // Corrupt/unreadable phase file - fall back to the first phase rather
    // than throwing; a goal run should never hard-fail on bookkeeping state.
  }
  return PHASE_ORDER[0];
}

/** Persists the current RPI phase to `.maestro-goal/phase.json`. */
function writePhase(worktreePath, phase) {
  const dir = path.join(worktreePath, NOTES_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(phasePath(worktreePath), JSON.stringify({ phase }, null, 2) + "\n", "utf8");
}

/** Returns the phase after `phase` in PHASE_ORDER, or `phase` itself if it is already the last one (implement iterates in place). */
function nextPhase(phase) {
  const idx = PHASE_ORDER.indexOf(phase);
  if (idx === -1 || idx === PHASE_ORDER.length - 1) {
    return phase;
  }
  return PHASE_ORDER[idx + 1];
}

/** Reads the current plan.md content, or null if it hasn't been written yet. */
function readPlan(worktreePath) {
  const file = planPath(worktreePath);
  if (!fs.existsSync(file)) {
    return null;
  }
  return fs.readFileSync(file, "utf8");
}

function truncate(text, max) {
  if (!text) {
    return "";
  }
  return text.length > max ? text.slice(0, max) + "…" : text;
}

/**
 * Runs one fresh `claude -p` iteration with structured JSON output. Resolves
 * to { ok:true, result:{success,summary,keyChanges,keyLearnings}, costUsd }
 * or { ok:false, error } — never throws, so the caller's loop can always
 * decide what to do next (including treating a hard process error as a
 * failed iteration to roll back).
 *
 * `phase` selects the system prompt from PHASE_PROMPTS (RPI phasing — see
 * that map's doc comment). `planContent` is included in the user prompt when
 * present (plan phase's own output, consumed by later plan/implement
 * iterations); it is null before the plan phase has run. `repoMapContent` is
 * the repo-map priming text (see module doc comment / repoMap.js), computed
 * once per `runGoal` call and passed through unchanged to every iteration;
 * it is empty for a repo-map build that failed or found nothing to map, in
 * which case that section is simply omitted from the prompt.
 */
function runIteration({ worktreePath, goal, notesContent, planContent, repoMapContent, phase, model, effort }) {
  return new Promise((resolve) => {
    const promptLines = [`Overall goal: ${goal}`, ""];
    if (repoMapContent) {
      promptLines.push(
        "Repo map (file paths with the code signatures found in them — a cheap",
        "orientation aid, not a substitute for reading a file when its actual",
        "content matters):",
        "---",
        repoMapContent,
        "---",
        ""
      );
    }
    promptLines.push(
      "Notes from previous iterations (may be empty on the first iteration):",
      "---",
      notesContent || "(no previous iterations yet)",
      "---",
      ""
    );
    if (planContent) {
      promptLines.push(
        "Current implementation plan (.maestro-goal/plan.md):",
        "---",
        planContent,
        "---",
        ""
      );
    }
    if (phase === "research") {
      promptLines.push("Research the codebase and write your findings to notes.md as instructed.");
    } else if (phase === "plan") {
      promptLines.push("Write the implementation plan to .maestro-goal/plan.md as instructed.");
    } else {
      promptLines.push("Work on the smallest next logical step toward the overall goal above.");
    }
    const prompt = promptLines.join("\n");

    const systemPrompt = PHASE_PROMPTS[phase] || PHASE_PROMPTS.implement;

    const args = [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--json-schema",
      ITERATION_SCHEMA,
      "--system-prompt",
      systemPrompt,
      // Without an explicit permission mode, a real goal that edits files /
      // runs a build / touches git hits a permission prompt the headless
      // child has no TTY to answer, so it hangs until ITERATION_TIMEOUT_MS,
      // fails, and after two such iterations the whole run aborts for zero
      // progress (review finding: the feature is dead-on-arrival for real
      // goals without this; the trivial spike only squeaked by). Bypassing is
      // SAFE precisely because every iteration runs inside the isolated,
      // never-pushed worktree - that isolation is what earns the bypass. (If
      // a tighter posture is wanted, "acceptEdits" is the alternative, but it
      // can still stall on non-edit tool prompts.)
      "--permission-mode",
      "bypassPermissions",
    ];
    if (model) {
      args.push("--model", model);
    }
    if (effort) {
      args.push("--effort", effort);
    }

    const claudePath = resolveClaudeBinary();
    let child;
    try {
      child = spawn(claudePath, args, {
        cwd: worktreePath,
        shell: !claudePath.toLowerCase().endsWith(".exe"),
        env: process.env,
      });
    } catch (err) {
      resolve({ ok: false, error: `Failed to spawn claude: ${err.message}` });
      return;
    }

    let out = "";
    let stderrText = "";
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      resolve(value);
    };

    const timeoutId = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: `Iteration timed out after ${ITERATION_TIMEOUT_MS}ms` });
    }, ITERATION_TIMEOUT_MS);

    child.stdout.on("data", (d) => {
      if (out.length < MAX_OUTPUT_BYTES) {
        out += d.toString("utf8");
      }
    });
    child.stderr.on("data", (d) => {
      if (stderrText.length < 4000) {
        stderrText = (stderrText + d.toString("utf8")).slice(0, 4000);
      }
    });
    child.on("error", (err) => finish({ ok: false, error: err.message }));
    child.on("close", (code) => {
      let parsed;
      try {
        parsed = JSON.parse(out);
      } catch {
        finish({
          ok: false,
          error: `Could not parse iteration output as JSON (exit code ${code}). stderr: ${truncate(stderrText, 500)}`,
        });
        return;
      }
      const result = parsed.structured_output;
      if (
        !result ||
        typeof result.success !== "boolean" ||
        typeof result.summary !== "string" ||
        !Array.isArray(result.keyChanges) ||
        !Array.isArray(result.keyLearnings)
      ) {
        finish({ ok: false, error: "Iteration response did not match the expected schema." });
        return;
      }
      finish({ ok: true, result, costUsd: parsed.total_cost_usd || 0 });
    });
  });
}

/**
 * Runs the independent verification command in the worktree, so an
 * iteration's own self-reported success:true is never the only signal an
 * iteration is accepted on (PLAN.md Point 11 hardening — the documented gap
 * that this whole change closes). Resolves to
 * { ok:true, output } if the command exits 0, or
 * { ok:false, output } if it exits non-zero, times out, or fails to spawn —
 * never throws, so the caller's loop can always treat a bad result as a
 * failed iteration. `output` is the combined stdout+stderr tail, used both
 * for the notes.md feedback and the iteration record.
 *
 * Run with `shell: true` since verifyCommand is a plain shell command string
 * (e.g. "npm test"), matching worktree.js's own npm-via-shell convention on
 * Windows.
 */
function runVerifyCommand(worktreePath, verifyCommand) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(verifyCommand, {
        cwd: worktreePath,
        shell: true,
        windowsHide: true,
        env: process.env,
      });
    } catch (err) {
      resolve({ ok: false, output: `Failed to spawn verify command: ${err.message}` });
      return;
    }

    let out = "";
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      resolve(value);
    };

    const timeoutId = setTimeout(() => {
      child.kill();
      finish({
        ok: false,
        output: truncate(out, VERIFY_OUTPUT_TAIL_CHARS) + `\n[verify command timed out after ${VERIFY_TIMEOUT_MS}ms]`,
      });
    }, VERIFY_TIMEOUT_MS);

    child.stdout?.on("data", (d) => {
      out += d.toString("utf8");
    });
    child.stderr?.on("data", (d) => {
      out += d.toString("utf8");
    });
    child.on("error", (err) => {
      finish({ ok: false, output: `Verify command failed to run: ${err.message}` });
    });
    child.on("close", (code) => {
      // Keep only the tail — a failing test suite can print megabytes, and
      // only the last part (the actual failure) is useful feedback for the
      // next fresh-context iteration.
      const tail = out.length > VERIFY_OUTPUT_TAIL_CHARS ? out.slice(-VERIFY_OUTPUT_TAIL_CHARS) : out;
      finish({ ok: code === 0, output: tail });
    });
  });
}

/**
 * Discards all uncommitted changes in the worktree — used after a failed
 * (success:false) or hard-error iteration, mirroring gnhf's verified
 * failure-rollback behavior. Best-effort with a clear log on failure rather
 * than throwing: a reset failing is rare and recoverable by inspection, and
 * shouldn't crash the whole goal run.
 */
function discardWorktreeChanges(worktreePath) {
  try {
    runGit(worktreePath, ["reset", "--hard"]);
    runGit(worktreePath, ["clean", "-fd"]);
    return true;
  } catch (err) {
    console.error(`[goalOrchestrator] Failed to reset/clean worktree ${worktreePath}: ${err.message}`);
    return false;
  }
}

/**
 * Commits all current changes in the worktree with a message built from the
 * iteration's own summary — reuses the same JSON output already produced,
 * not a separate LLM call (mirrors gnhf). Returns true if a commit actually
 * landed, false if there was nothing to commit or the commit itself failed
 * (e.g. a hook blocked it) — this is a different, rarer failure mode than a
 * bad iteration, so it is logged clearly but does NOT trigger a reset/clean;
 * the (uncommitted but presumably good) changes are simply left in place for
 * a human to inspect.
 */
function commitIteration(worktreePath, iterationNumber, summary) {
  try {
    const status = execFileSync("git", ["-C", worktreePath, "status", "--porcelain"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (status.trim().length === 0) {
      console.error(`[goalOrchestrator] Iteration ${iterationNumber} reported success but left no changes to commit.`);
      return false;
    }
    runGit(worktreePath, ["add", "-A"]);
    const message = `[goal-orchestrator] iteration ${iterationNumber}: ${truncate(summary, 500)}`;
    runGit(worktreePath, ["commit", "-m", message]);
    return true;
  } catch (err) {
    console.error(
      `[goalOrchestrator] Commit failed for iteration ${iterationNumber} (left uncommitted for review): ${err.message}`
    );
    return false;
  }
}

function countCommitsOnBranch(worktreePath, baseCommit) {
  // Count commits the goal actually added, i.e. everything on HEAD since the
  // exact commit the worktree branched from (captured at creation). The old
  // `main..branch` form miscounted on any repo whose default branch isn't
  // literally "main" (it would throw and fall back to counting the WHOLE
  // history), and even on a "main" repo it was wrong when the primary checkout
  // was on a feature branch at spawn time (the worktree forks from HEAD, not
  // main). Counting `<baseCommit>..HEAD` is correct regardless (review finding).
  if (!baseCommit) {
    return 0;
  }
  try {
    const out = runGit(worktreePath, ["rev-list", "--count", `${baseCommit}..HEAD`]).trim();
    return parseInt(out, 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Runs a goal to (partial or full) completion via fresh-subprocess
 * iterations in an isolated worktree. Never pushes, never merges back to the
 * primary checkout, never opens a PR — see module doc comment.
 *
 * @param {object} opts
 * @param {string} opts.projectPath - absolute path to the source repo.
 * @param {string} opts.goal - the goal description, included in every
 *   iteration's prompt.
 * @param {number} [opts.maxIterations] - hard cap, defaults to 5 (v1 is
 *   intentionally small-scale, not a production-scale feature).
 * @param {string} [opts.model] - model passed to every iteration.
 * @param {string} [opts.effort] - effort passed to every iteration.
 * @param {string} [opts.verifyCommand] - optional independent verification
 *   gate (e.g. "npm test" or "npm run build"), run as a shell command with
 *   the worktree as cwd. Closes the "trusts the agent's own self-reported
 *   success" gap (PLAN.md Point 11 hardening): when set, an IMPLEMENT-phase
 *   iteration that reports success:true is only ACCEPTED (notes appended as
 *   success, committed) if this command then also exits 0 in the worktree.
 *   If it exits non-zero or times out, the iteration is treated exactly like
 *   any other failure — discarded via the same reset --hard/clean -fd
 *   rollback, with the command's output tail recorded in notes.md so the next
 *   fresh-context iteration knows what actually broke. Does NOT apply to
 *   research/plan-phase iterations (they don't produce code to verify).
 *   Defaults to undefined, which keeps the pre-existing behavior unchanged
 *   (no gate).
 * @param {(iterationRecord: object) => void} [opts.onIteration] - optional
 *   callback fired after each iteration with its result, for a future UI/CLI
 *   caller to show live progress. Never awaited, never allowed to throw the
 *   loop off course.
 * @param {{ cancelled: boolean }} [opts.cancelToken] - optional simple
 *   cancellation flag. Checked between iterations (never mid-iteration — an
 *   in-flight subprocess always runs to completion or its own timeout); once
 *   `cancelToken.cancelled` is true, no further iterations start.
 * @returns {Promise<{ worktreePath: string, branchName: string, notes: string,
 *   phase: string, plan: (string|null), commitCount: number,
 *   iterations: object[], stoppedReason: string }>} `iterations` records each
 *   carry a `phase` field (`"research"`, `"plan"`, or `"implement"`) alongside
 *   the pre-existing `ok`/`result`/`committed`/`verified` fields.
 */
export async function runGoal({
  projectPath,
  goal,
  maxIterations = DEFAULT_MAX_ITERATIONS,
  model,
  effort,
  verifyCommand,
  onIteration,
  cancelToken,
}) {
  if (!projectPath || !goal) {
    throw new Error("runGoal requires both projectPath and goal.");
  }

  // `deps: "junction"` so an iteration can actually run builds/tests in the
  // worktree (this is the whole point of Point 11 hardening - a goal that
  // can't run its own tests can't self-verify). Junction, not a full
  // install: it's near-instant and Maestro is a single JS/Electron app with
  // one Node/Electron ABI, so sharing the main repo's node_modules across
  // worktrees is safe here (see worktree.js's provisionDeps doc comment for
  // when that would NOT hold). A failed provisioning still leaves a usable
  // worktree (createWorktree's own fail-safe) - the first iteration would
  // just see a missing node_modules and can `npm install` itself, same as
  // before this change.
  const { worktreePath, branchName } = createWorktree(projectPath, {
    id: `goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    branchName: `maestro/goal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    deps: "junction",
  });
  // The exact commit this worktree forked from — the baseline for counting
  // how many commits the goal itself added (see countCommitsOnBranch). Captured
  // now, before any iteration commits land.
  let baseCommit = null;
  try {
    baseCommit = runGit(worktreePath, ["rev-parse", "HEAD"]).trim();
  } catch {
    baseCommit = null;
  }

  // Repo-map priming (see module doc comment / repoMap.js): built ONCE here,
  // right after the worktree exists, and reused unchanged by every iteration
  // below. A goal run's iterations all operate on the same repo whose overall
  // shape does not meaningfully shift turn-to-turn, so recomputing this per
  // iteration would just re-pay the same `git ls-files` + regex-scan cost for
  // no benefit - unlike notes.md/plan.md, which genuinely change every
  // iteration and so are correctly re-read each time below. Best-effort: a
  // repo-map build failure (e.g. `git ls-files` fails for some reason) must
  // never abort an otherwise-runnable goal, so it degrades to an empty map
  // (silently omitted from the prompt by `runIteration`) rather than throwing.
  let repoMapContent = "";
  try {
    const repoMap = await buildRepoMap(worktreePath);
    repoMapContent = repoMap.map;
  } catch (err) {
    console.error(`[goalOrchestrator] Repo-map build failed for ${worktreePath}: ${err.message}`);
  }

  const iterations = [];
  let consecutiveFailures = 0;
  let stoppedReason = "max_iterations_reached";
  // RPI phase, persisted to phase.json so it survives the fresh-subprocess-
  // per-iteration model the same way notes.md does. A brand-new worktree has
  // no phase.json yet, so this starts at PHASE_ORDER[0] ("research").
  let phase = readPhase(worktreePath);
  writePhase(worktreePath, phase);

  for (let i = 1; i <= maxIterations; i++) {
    if (cancelToken?.cancelled) {
      stoppedReason = "cancelled";
      break;
    }

    const notesContent = readOrCreateNotes(worktreePath);
    let planContent = readPlan(worktreePath);

    // Gate: implement must not run without a plan. This should not normally
    // trigger (implement only follows a successful plan-phase iteration that
    // itself required writing plan.md to notes/records), but it is a cheap,
    // self-healing safety net against a phase.json/plan.md mismatch - e.g. a
    // resumed run whose plan-phase iteration was hard-failed and rolled back
    // after phase.json had already been advanced, or plan.md being manually
    // removed from the worktree between iterations.
    if (phase === "implement" && !planContent) {
      phase = "plan";
      writePhase(worktreePath, phase);
    }

    const outcome = await runIteration({
      worktreePath,
      goal,
      notesContent,
      planContent,
      repoMapContent,
      phase,
      model,
      effort,
    });

    // The verification gate only makes sense once there is code to verify —
    // research/plan iterations deliberately make no code changes, so gating
    // them on `verifyCommand` would just fail a build/test run against an
    // unchanged tree for no reason. Only implement-phase iterations run it.
    const verifyGateApplies = Boolean(verifyCommand) && phase === "implement";
    const iterationPhase = phase;

    let record;
    if (!outcome.ok) {
      // Hard process error (timeout, spawn failure, bad JSON, schema
      // mismatch) — treat exactly like success:false: discard whatever the
      // process may have left behind and keep going.
      discardWorktreeChanges(worktreePath);
      const syntheticResult = {
        success: false,
        summary: `Iteration failed with a process error: ${outcome.error}`,
        keyChanges: [],
        keyLearnings: [`Iteration ${i} hard-failed: ${outcome.error}`],
      };
      appendNotes(worktreePath, i, syntheticResult);
      record = { iteration: i, phase: iterationPhase, ok: false, error: outcome.error, committed: false };
      consecutiveFailures += 1;
    } else if (outcome.result.success === false) {
      discardWorktreeChanges(worktreePath);
      appendNotes(worktreePath, i, outcome.result);
      record = {
        iteration: i,
        phase: iterationPhase,
        ok: true,
        result: outcome.result,
        committed: false,
        costUsd: outcome.costUsd,
      };
      consecutiveFailures += 1;
    } else if (verifyGateApplies) {
      // Independent verification gate (PLAN.md Point 11 hardening): the
      // agent's own success:true is necessary but not sufficient. Run the
      // configured command in the worktree BEFORE appending notes or
      // committing anything, so a failing verification is indistinguishable
      // from any other failed iteration downstream — same rollback, same
      // consecutive-failure counting, same stop conditions.
      const verifyOutcome = await runVerifyCommand(worktreePath, verifyCommand);
      if (verifyOutcome.ok) {
        // Verified green — accept exactly like the no-gate path below.
        appendNotes(worktreePath, i, outcome.result);
        const committed = commitIteration(worktreePath, i, outcome.result.summary);
        record = {
          iteration: i,
          phase: iterationPhase,
          ok: true,
          result: outcome.result,
          committed,
          verified: true,
          costUsd: outcome.costUsd,
        };
        consecutiveFailures = 0;
        phase = nextPhase(phase);
        writePhase(worktreePath, phase);
      } else {
        // Verification failed — treat exactly like a success:false iteration:
        // roll back through the existing discard path (no new destructive
        // command, no state left outside the worktree) and record the
        // failure reason so the next fresh-context iteration actually knows
        // what to fix, closing the loop this whole change exists for.
        discardWorktreeChanges(worktreePath);
        const verifyFailureResult = {
          success: false,
          summary: `${outcome.result.summary} (rejected: independent verification failed)`,
          keyChanges: [],
          keyLearnings: [
            `Iteration ${i} reported success but failed independent verification (\`${verifyCommand}\`).`,
            `Verification output tail:\n${verifyOutcome.output || "(no output captured)"}`,
          ],
        };
        appendNotes(worktreePath, i, verifyFailureResult);
        record = {
          iteration: i,
          phase: iterationPhase,
          ok: true,
          result: outcome.result,
          committed: false,
          verified: false,
          verifyOutput: verifyOutcome.output,
          costUsd: outcome.costUsd,
        };
        consecutiveFailures += 1;
      }
    } else {
      // Notes MUST be appended BEFORE committing (not after) — the commit is
      // meant to capture the complete state of this iteration, notes.md
      // included, in one atomic unit. Appending after would leave notes.md's
      // own update perpetually one iteration behind every commit and the
      // worktree dirty after a "successful" run.
      appendNotes(worktreePath, i, outcome.result);
      const committed = commitIteration(worktreePath, i, outcome.result.summary);
      record = {
        iteration: i,
        phase: iterationPhase,
        ok: true,
        result: outcome.result,
        committed,
        costUsd: outcome.costUsd,
      };
      consecutiveFailures = 0;
      // Advance research -> plan -> implement on a successful phase-completing
      // iteration, instead of looping the same phase maxIterations times.
      // `nextPhase` is a no-op once already at "implement" (the last phase),
      // so implement iterations keep re-running implement until done or
      // maxIterations, matching the pre-RPI behavior for that phase.
      phase = nextPhase(phase);
      writePhase(worktreePath, phase);
    }

    iterations.push(record);
    if (onIteration) {
      try {
        onIteration(record);
      } catch {
        // never let a caller's callback break the loop
      }
    }

    if (consecutiveFailures >= 2) {
      stoppedReason = "two_consecutive_failures";
      break;
    }
    if (i === maxIterations) {
      stoppedReason = "max_iterations_reached";
    }
  }

  const finalNotes = readOrCreateNotes(worktreePath);
  const finalPlan = readPlan(worktreePath);
  const commitCount = countCommitsOnBranch(worktreePath, baseCommit);

  // Auto-clean up a run that produced NOTHING to review (zero commits) - a
  // bad-path fast-fail, an all-failed run, or a cancel before any commit.
  // Otherwise every such run would leave a stale `<repo>-worktrees/goal-*`
  // dir + `maestro/goal-*` branch in the user's real repo forever, and a
  // cancelled run would leave a dirty worktree with no cleanup path (review
  // finding). Discard any uncommitted leftovers first (handles the dirty-
  // cancel case), then remove the worktree and delete its now-unused branch.
  // Runs WITH commits are deliberately kept - the whole point is to leave that
  // work in the isolated worktree for the human to review/merge. Best-effort:
  // a cleanup failure must never turn a finished run into a thrown error.
  let cleanedUp = false;
  if (commitCount === 0) {
    try {
      discardWorktreeChanges(worktreePath);
      removeWorktree(projectPath, worktreePath, { force: true });
      try {
        runGit(projectPath, ["branch", "-D", branchName]);
      } catch {
        // branch may not exist / already gone - fine
      }
      cleanedUp = true;
    } catch {
      // leave it in place rather than fail the run; the path is still returned
    }
  }

  return {
    worktreePath,
    branchName,
    notes: finalNotes,
    // The final RPI phase reached and the current plan.md content (null if
    // the run stopped before the plan phase ever wrote one) - observable so
    // a future UI can show "which phase did this run end in" and, later,
    // gate an "approve plan before implement" human checkpoint on it. That
    // approval UI is a deferred follow-up; this only makes the data visible.
    phase,
    plan: finalPlan,
    commitCount,
    iterations,
    stoppedReason,
    cleanedUp,
  };
}
