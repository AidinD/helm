// Which model actually ran an iteration - and the context window that comes with it.
//
// THIS TEST USED TO ENCODE THE BUG. Every case handed extractUsage() a modelUsage
// object with exactly ONE entry, which is the assumption the implementation stated
// out loud ("normally there is exactly one entry per single-turn batch call") and
// which is false. The CLI makes a small internal Haiku call alongside the real one
// and lists it FIRST. So the suite stayed green while all 22 crewline crew runs
// between 2026-08-16 and 2026-08-18 recorded "claude-haiku-4-5-20251001" for runs
// that genuinely ran Opus 4.8 at ~$20 each.
//
// The mislabel was not cosmetic: contextWindow was read from that same wrong entry
// (200 000 instead of 1 000 000), so fillPct ran 5x high and the notes-truncation
// guard fired at 80 000 tokens instead of 400 000. Twelve of the 22 runs had their
// working notes cut to the 20 000-char floor mid-job.
//
// The fixture below is a VERBATIM capture of a real `claude -p --output-format json
// --model claude-opus-4-8` response (2026-08-18), not a hand-written shape - a
// hand-written one is how the wrong assumption got in.
//
// Run:  node scripts/e2e/test-extract-resolved-model.mjs
import { extractUsage } from "../../src/lib/goalOrchestrator.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

// --- the real two-entry shape, captured live -------------------------------
const REAL_MODEL_USAGE = {
  "claude-haiku-4-5-20251001": {
    inputTokens: 521,
    outputTokens: 11,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0.000576,
    contextWindow: 200000,
    maxOutputTokens: 32000,
    canonicalModel: "claude-haiku-4-5",
    provider: "firstParty",
  },
  "claude-opus-4-8": {
    inputTokens: 2,
    outputTokens: 4,
    cacheReadInputTokens: 26132,
    cacheCreationInputTokens: 17553,
    webSearchRequests: 0,
    costUSD: 0.188706,
    contextWindow: 1000000,
    maxOutputTokens: 64000,
    canonicalModel: "claude-opus-4-8",
    provider: "firstParty",
  },
};
const parsed = {
  usage: { input_tokens: 2, output_tokens: 4, cache_creation_input_tokens: 17553, cache_read_input_tokens: 26132 },
  modelUsage: REAL_MODEL_USAGE,
};

// Note the ordering trap this asserts against: the WRONG answer is also the FIRST
// key, so an implementation that regresses to entries[0] fails here rather than
// coincidentally passing.
ok(Object.keys(REAL_MODEL_USAGE)[0] === "claude-haiku-4-5-20251001", "the fixture keeps the helper model FIRST, as the CLI really emits it");

const asked = extractUsage(parsed, { requestedModel: "claude-opus-4-8" });
ok(asked.resolvedModel === "claude-opus-4-8", `the model we asked for is the model reported (got ${asked.resolvedModel})`);
ok(asked.contextWindow === 1000000, `and its window comes with it, not the helper's (got ${asked.contextWindow})`);
ok(asked.fillPct === 43691 / 1000000, `so fill is measured against the real window (got ${asked.fillPct})`);
ok(Array.isArray(asked.modelsSeen) && asked.modelsSeen.length === 2, `every model is still visible rather than discarded (${asked.modelsSeen.join(", ")})`);

// THE CONSEQUENCE, at a token count a real crew iteration actually reaches. A few
// iterations in, cache reads alone put a run well past 100k; on the helper's window
// that is 50% - over the 40% guard, so notes.md gets cut to its 20 000-char floor -
// while on the real window it is 10% and nothing is touched. Twelve of 22 crewline
// runs were shredded this way. (The small first-turn payload above sits under the
// threshold on BOTH windows, which is why it cannot carry this assertion.)
const midRun = { input_tokens: 4000, output_tokens: 2000, cache_creation_input_tokens: 20000, cache_read_input_tokens: 74000 };
const onReal = extractUsage({ usage: midRun, modelUsage: REAL_MODEL_USAGE }, { requestedModel: "claude-opus-4-8" });
const onHelper = extractUsage({ usage: midRun, modelUsage: REAL_MODEL_USAGE }, { requestedModel: "claude-haiku-4-5-20251001" });
ok(onReal.totalTokens === 100000, `mid-run usage totals as expected (${onReal.totalTokens})`);
ok(
  onReal.fillPct < 0.4 && onHelper.fillPct >= 0.4,
  `100k tokens is ${Math.round(onReal.fillPct * 100)}% of the real window and ${Math.round(onHelper.fillPct * 100)}% of the helper's - the difference between keeping and shredding the run's own notes`
);

// --- nothing requested (auto-captain never passes --model) ------------------
const inferred = extractUsage(parsed);
ok(inferred.resolvedModel === "claude-opus-4-8", `with no requested model, the busiest entry wins, not the first (got ${inferred.resolvedModel})`);
ok(inferred.contextWindow === 1000000, "and it still carries its own window");

// Cache is what makes the real model the busiest: strip it and the helper genuinely
// did more work. Asserted so nobody "simplifies" the ranking to input+output only.
const noCache = extractUsage({
  usage: {},
  modelUsage: {
    "claude-haiku-4-5-20251001": { inputTokens: 521, outputTokens: 11, contextWindow: 200000, costUSD: 0.000576 },
    "claude-opus-4-8": { inputTokens: 2, outputTokens: 4, cacheReadInputTokens: 26132, cacheCreationInputTokens: 17553, contextWindow: 1000000, costUSD: 0.188706 },
  },
});
ok(noCache.resolvedModel === "claude-opus-4-8", "cache tokens count as work - an Opus turn is mostly cache, and ignoring it ranks the helper first again");

// --- a genuine downgrade must still be reported as what RAN ----------------
// If we ask for a model the CLI did not run, the honest answer is the one it did.
const downgraded = extractUsage(
  { usage: {}, modelUsage: { "claude-haiku-4-5-20251001": { inputTokens: 900, outputTokens: 40, contextWindow: 200000, costUSD: 0.001 } } },
  { requestedModel: "claude-opus-4-8" }
);
ok(downgraded.resolvedModel === "claude-haiku-4-5-20251001", "asking for a model the CLI never ran reports the one it DID run - the request is not evidence");
ok(downgraded.contextWindow === 200000, "with that model's window");

// --- degenerate payloads must not throw ------------------------------------
const noModelUsage = extractUsage({ usage: { input_tokens: 10, output_tokens: 5 } });
ok(noModelUsage.resolvedModel === null && noModelUsage.contextWindow === null, "no modelUsage at all -> nulls, no throw");
ok(noModelUsage.totalTokens === 15, "and totalTokens is still summed from parsed.usage");

const emptyModelUsage = extractUsage({ usage: {}, modelUsage: {} });
ok(emptyModelUsage.resolvedModel === null, "an empty modelUsage object -> null");

let threw = false;
let empty;
try {
  empty = extractUsage(undefined);
} catch {
  threw = true;
}
ok(!threw && empty?.resolvedModel === null, "extractUsage(undefined) does not throw");

console.log(
  exit === 0
    ? "VERIFY OK: extractUsage() reports the model that did the work and ITS context window, against a verbatim two-entry CLI payload."
    : "VERIFY FAILED."
);
process.exit(exit);
