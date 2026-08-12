// Goal card: "Jag skulle vilja kunna se vilken model autopiloten använder, syns
// ingenstans" - the CLI's batch JSON response already tells us the real resolved
// model (a key of parsed.modelUsage), extractUsage() just discarded it. This
// asserts the new `resolvedModel` field on extractUsage()'s return value.
//
// Pure-function test, no subprocess - mirrors test-crew-strict-mcp.mjs's convention.
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

// Normal shape: one model entry, with usage + contextWindow.
const withModel = extractUsage({
  usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  modelUsage: { "claude-haiku-4-5": { contextWindow: 200000 } },
});
ok(withModel.resolvedModel === "claude-haiku-4-5", `resolvedModel is the modelUsage key (got ${withModel.resolvedModel})`);
ok(withModel.contextWindow === 200000, "contextWindow is still read correctly alongside resolvedModel");
ok(withModel.totalTokens === 150, "totalTokens is still summed correctly");
ok(withModel.fillPct === 150 / 200000, "fillPct is still derived correctly");

// No modelUsage at all - must not throw, resolvedModel falls back to null.
const noModelUsage = extractUsage({ usage: { input_tokens: 10, output_tokens: 5 } });
ok(noModelUsage.resolvedModel === null, "resolvedModel is null when modelUsage is absent");
ok(noModelUsage.contextWindow === null, "contextWindow is still null when modelUsage is absent");

// modelUsage present but empty object - resolvedModel falls back to null, no throw.
const emptyModelUsage = extractUsage({ usage: {}, modelUsage: {} });
ok(emptyModelUsage.resolvedModel === null, "resolvedModel is null when modelUsage is an empty object");

// Completely empty/undefined parsed payload - must not throw.
let threw = false;
let empty;
try {
  empty = extractUsage(undefined);
} catch {
  threw = true;
}
ok(!threw, "extractUsage(undefined) does not throw");
ok(empty && empty.resolvedModel === null, "and resolves resolvedModel to null for an undefined payload");

console.log(
  exit === 0
    ? "VERIFY OK: extractUsage() now also returns the real resolved model id from parsed.modelUsage's key, defaulting to null when absent."
    : "VERIFY FAILED."
);
process.exit(exit);
