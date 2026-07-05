// Spike: unit-level proof of the Point 12 Phase-0 escalation detection in
// goalOrchestrator.js, exercised deterministically (no claude calls). Feeds
// synthetic iteration records straight into `detectEscalationSignal` and its
// four sub-detectors to prove each Tier-1 signal fires under the exact
// conditions the detector code checks for, plus a clean run that fires none.
//
// All four detectors are pure functions of the records passed in - no git
// repo, no filesystem, no subprocess - so this spike needs none of that
// scratch-repo machinery either.
import { detectEscalationSignal, detectNoNetProgress } from "../src/lib/goalOrchestrator.js";

function log(msg) {
  console.log(`[spike] ${msg}`);
}
function assert(cond, msg) {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
  log(`OK - ${msg}`);
}

// Default escalationConfig fields (mirrors the module's own defaults):
//   ambiguityKeywords: ["unclear", "ambiguous", "could not determine", "needs a decision"]
//   maxCostPerIterationUsd: 2
//   noProgressStreak: 2
//   repeatedVerifyFailureThreshold: 2 (this module reads it as 2 too when omitted)
const DEFAULT_CONFIG = {};

try {
  // --- Signal (a): repeated_verify_failure ---
  // detectRepeatedVerifyFailure filters iterations with verified===false AND a
  // truthy verifyOutput, takes the last `minRepeats` (default 2), and fires
  // when their verifyFailureSignature() results are all identical. The
  // signature strips digits and keeps only the first 5 non-blank trimmed
  // lines, so two outputs need matching non-numeric text on those lines.
  {
    const verifyOutput = "FAIL: src/foo.test.js\nExpected 1 to equal 2\nat line 42";
    const iterations = [
      { iteration: 1, phase: "implement", ok: true, result: { success: true }, verified: false, verifyOutput },
      { iteration: 2, phase: "implement", ok: true, result: { success: true }, verified: false, verifyOutput },
    ];
    const latestRecord = iterations[iterations.length - 1];
    const signal = detectEscalationSignal(iterations, latestRecord, DEFAULT_CONFIG);
    assert(signal !== null, "repeated_verify_failure: two identical-signature verify failures fire a signal");
    assert(
      signal.signal === "repeated_verify_failure",
      `repeated_verify_failure: signal name is correct (got "${signal?.signal}")`
    );
  }

  // Negative control: verify failures with DIFFERENT signatures must not fire.
  {
    const iterations = [
      { iteration: 1, phase: "implement", ok: true, result: { success: true }, verified: false, verifyOutput: "FAIL: src/foo.test.js\nExpected 1 to equal 2" },
      { iteration: 2, phase: "implement", ok: true, result: { success: true }, verified: false, verifyOutput: "FAIL: src/bar.test.js\nTypeError: cannot read x" },
    ];
    const latestRecord = iterations[iterations.length - 1];
    const signal = detectEscalationSignal(iterations, latestRecord, DEFAULT_CONFIG);
    assert(
      signal === null,
      "repeated_verify_failure: two DIFFERENT-signature verify failures do not fire (negative control)"
    );
  }

  // --- Signal (b): ambiguity_reported ---
  // detectAmbiguitySignal checks the LATEST record's result.summary +
  // keyLearnings (joined, lowercased) against the configured keyword list.
  {
    const iterations = [
      {
        iteration: 1,
        phase: "implement",
        ok: true,
        result: {
          success: true,
          summary: "Investigated the auth flow but the requirement is ambiguous and needs a decision from a human.",
          keyChanges: [],
          keyLearnings: [],
        },
        producedChanges: false,
      },
    ];
    const latestRecord = iterations[0];
    const signal = detectEscalationSignal(iterations, latestRecord, DEFAULT_CONFIG);
    assert(signal !== null, "ambiguity_reported: a summary containing an ambiguity keyword fires a signal");
    assert(
      signal.signal === "ambiguity_reported",
      `ambiguity_reported: signal name is correct (got "${signal?.signal}")`
    );
  }

  // Also confirm keyLearnings (not just summary) is checked.
  {
    const iterations = [
      {
        iteration: 1,
        phase: "implement",
        ok: true,
        result: {
          success: true,
          summary: "Refactored the pricing module.",
          keyChanges: ["Extracted PricingService"],
          keyLearnings: ["Could not determine which currency format the client expects."],
        },
        producedChanges: true,
      },
    ];
    const latestRecord = iterations[0];
    const signal = detectEscalationSignal(iterations, latestRecord, DEFAULT_CONFIG);
    assert(
      signal !== null && signal.signal === "ambiguity_reported",
      "ambiguity_reported: an ambiguity phrase inside keyLearnings also fires (not just summary)"
    );
  }

  // --- Signal (c): cost_soft_cap ---
  // detectCostSoftCap fires when the LATEST record's costUsd is strictly
  // greater than the configured maxCostPerIterationUsd (default 2).
  {
    const iterations = [
      {
        iteration: 1,
        phase: "implement",
        ok: true,
        result: { success: true, summary: "Did a big refactor.", keyChanges: [], keyLearnings: [] },
        producedChanges: true,
        costUsd: 5.42,
      },
    ];
    const latestRecord = iterations[0];
    const signal = detectEscalationSignal(iterations, latestRecord, DEFAULT_CONFIG);
    assert(signal !== null, "cost_soft_cap: costUsd above the $2 default cap fires a signal");
    assert(signal.signal === "cost_soft_cap", `cost_soft_cap: signal name is correct (got "${signal?.signal}")`);
  }

  // Negative control: cost at or below the cap must not fire.
  {
    const iterations = [
      {
        iteration: 1,
        phase: "implement",
        ok: true,
        result: { success: true, summary: "Small fix.", keyChanges: [], keyLearnings: [] },
        producedChanges: true,
        costUsd: 2,
      },
    ];
    const latestRecord = iterations[0];
    const signal = detectEscalationSignal(iterations, latestRecord, DEFAULT_CONFIG);
    assert(signal === null, "cost_soft_cap: costUsd exactly at the cap does not fire (strictly-greater check)");
  }

  // --- Signal (d): no_net_progress ---
  // detectNoNetProgress (called internally by detectEscalationSignal via
  // noProgressStreak, default 2) filters iterations with ok===true,
  // result.success !== false, AND phase === "implement", takes the last
  // `streak`, and fires when ALL of them have producedChanges === false.
  {
    const implNoOp = (n) => ({
      iteration: n,
      phase: "implement",
      ok: true,
      result: { success: true, summary: `Iteration ${n}: reviewed code, nothing to change.`, keyChanges: [], keyLearnings: [] },
      producedChanges: false,
      costUsd: 0.05,
    });
    const iterations = [implNoOp(1), implNoOp(2)];
    const latestRecord = iterations[iterations.length - 1];
    const signal = detectEscalationSignal(iterations, latestRecord, DEFAULT_CONFIG);
    assert(signal !== null, "no_net_progress: two consecutive no-op implement successes fire a signal");
    assert(signal.signal === "no_net_progress", `no_net_progress: signal name is correct (got "${signal?.signal}")`);

    // Cross-check directly against detectNoNetProgress itself (also exported)
    // to confirm detectEscalationSignal is genuinely delegating to it, not
    // just coincidentally returning the same shape.
    assert(
      typeof detectNoNetProgress(iterations, 2) === "string",
      "no_net_progress: detectNoNetProgress itself also reports the same streak as a string detail"
    );
  }

  // Negative control: research-phase no-op iterations must NOT count toward
  // no_net_progress (only "implement" phase is counted).
  {
    const researchNoOp = (n) => ({
      iteration: n,
      phase: "research",
      ok: true,
      result: { success: true, summary: `Iteration ${n}: researched the codebase.`, keyChanges: [], keyLearnings: [] },
      producedChanges: false,
      costUsd: 0.05,
    });
    const iterations = [researchNoOp(1), researchNoOp(2)];
    const latestRecord = iterations[iterations.length - 1];
    const signal = detectEscalationSignal(iterations, latestRecord, DEFAULT_CONFIG);
    assert(
      signal === null,
      "no_net_progress: research-phase no-op iterations do not count (implement-only), no false escalation"
    );
  }

  // --- Clean run: no signal should fire ---
  // Successful, productive, cheap implement iterations with no ambiguity
  // language and no verify failures - detectEscalationSignal must return null.
  {
    const cleanIteration = (n) => ({
      iteration: n,
      phase: "implement",
      ok: true,
      result: {
        success: true,
        summary: `Iteration ${n}: implemented the next small step from the plan.`,
        keyChanges: [`Added feature piece ${n}`],
        keyLearnings: [`Module ${n} follows the existing pattern.`],
      },
      committed: true,
      producedChanges: true,
      verified: true,
      costUsd: 0.35,
      fillPct: 0.12,
      totalTokens: 12000,
    });
    const iterations = [cleanIteration(1), cleanIteration(2), cleanIteration(3)];
    const latestRecord = iterations[iterations.length - 1];
    const signal = detectEscalationSignal(iterations, latestRecord, DEFAULT_CONFIG);
    assert(signal === null, "clean run: successful, productive, cheap iterations produce no escalation (returns null)");
  }

  log("ALL CHECKS PASSED");
} catch (err) {
  console.error(`[spike] ${err.message}`);
  process.exitCode = 1;
}
