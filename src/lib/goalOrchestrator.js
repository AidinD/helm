import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveClaudeBinary } from "./launcher.js";
import { createWorktree, removeWorktree } from "./worktree.js";

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
 */

const NOTES_DIR = ".maestro-goal";
const NOTES_FILENAME = "notes.md";
const DEFAULT_MAX_ITERATIONS = 5;

// Generous — an iteration is a real coding turn (may run builds/tests/lint
// itself), not a cheap classifier call. Bounds a hung subprocess (e.g. an
// auth prompt with no TTY to answer it) so a stuck child can't wedge the
// whole goal run forever.
const ITERATION_TIMEOUT_MS = 15 * 60_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

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

const ITERATION_SYSTEM_PROMPT = [
  "You are one iteration of a fresh-context autonomous coding agent working",
  "toward a larger goal, one small step at a time. You have NO memory of",
  "previous iterations except the notes.md content included in your prompt —",
  "treat that as the complete record of what's already been done and learned.",
  "",
  "Rules for this iteration:",
  "1. Work on the SMALLEST next logical step toward the goal, not the whole",
  "   goal at once. Leave the rest for future iterations.",
  "2. Run any relevant build/test/lint yourself and fix what you find before",
  "   finishing — don't leave broken code for the next iteration to inherit.",
  "3. Do NOT run `git commit` yourself. The orchestrator commits your changes",
  "   after this call returns, using your own summary as the commit message.",
  "4. Stop any background processes/servers you started before finishing —",
  "   nothing should be left running after your turn ends.",
  "5. Set success:false if you could not make real, safe progress this",
  "   iteration (e.g. the step turned out to be ambiguous, blocked, or you",
  "   hit an error you couldn't resolve). The orchestrator will discard ALL",
  "   file changes from a success:false iteration, so do not set success:true",
  "   unless the working tree is actually in a good, coherent state.",
  "6. Respond only in the requested JSON schema. summary is ONE sentence",
  "   describing what this iteration actually did (used verbatim as the git",
  "   commit message). keyChanges is a short list of concrete changes made.",
  "   keyLearnings is a short list of anything future iterations should know",
  "   (dead ends, gotchas, decisions made) — this is the ONLY way that",
  "   knowledge survives into the next iteration.",
].join("\n");

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
 */
function runIteration({ worktreePath, goal, notesContent, model, effort }) {
  return new Promise((resolve) => {
    const prompt = [
      `Overall goal: ${goal}`,
      "",
      "Notes from previous iterations (may be empty on the first iteration):",
      "---",
      notesContent || "(no previous iterations yet)",
      "---",
      "",
      "Work on the smallest next logical step toward the overall goal above.",
    ].join("\n");

    const args = [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--json-schema",
      ITERATION_SCHEMA,
      "--system-prompt",
      ITERATION_SYSTEM_PROMPT,
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
 * @param {(iterationRecord: object) => void} [opts.onIteration] - optional
 *   callback fired after each iteration with its result, for a future UI/CLI
 *   caller to show live progress. Never awaited, never allowed to throw the
 *   loop off course.
 * @param {{ cancelled: boolean }} [opts.cancelToken] - optional simple
 *   cancellation flag. Checked between iterations (never mid-iteration — an
 *   in-flight subprocess always runs to completion or its own timeout); once
 *   `cancelToken.cancelled` is true, no further iterations start.
 * @returns {Promise<{ worktreePath: string, branchName: string, notes: string,
 *   commitCount: number, iterations: object[], stoppedReason: string }>}
 */
export async function runGoal({
  projectPath,
  goal,
  maxIterations = DEFAULT_MAX_ITERATIONS,
  model,
  effort,
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

  const iterations = [];
  let consecutiveFailures = 0;
  let stoppedReason = "max_iterations_reached";

  for (let i = 1; i <= maxIterations; i++) {
    if (cancelToken?.cancelled) {
      stoppedReason = "cancelled";
      break;
    }

    const notesContent = readOrCreateNotes(worktreePath);
    const outcome = await runIteration({ worktreePath, goal, notesContent, model, effort });

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
      record = { iteration: i, ok: false, error: outcome.error, committed: false };
      consecutiveFailures += 1;
    } else if (outcome.result.success === false) {
      discardWorktreeChanges(worktreePath);
      appendNotes(worktreePath, i, outcome.result);
      record = {
        iteration: i,
        ok: true,
        result: outcome.result,
        committed: false,
        costUsd: outcome.costUsd,
      };
      consecutiveFailures += 1;
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
        ok: true,
        result: outcome.result,
        committed,
        costUsd: outcome.costUsd,
      };
      consecutiveFailures = 0;
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
    commitCount,
    iterations,
    stoppedReason,
    cleanedUp,
  };
}
