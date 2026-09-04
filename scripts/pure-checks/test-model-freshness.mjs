// Unit test for src/lib/modelFreshness.js: the strategy for noticing a new
// Claude model release (Jot card "Behöver strategi för när ny version av
// claude släpps"). Pure node, no Electron, no real claude.exe - a synthetic
// buffer of the exact noise shapes seen in the real binary plus a couple of
// genuinely newer ids, so the two halves (noise filtering, "is it actually
// newer") are each provably correct rather than "looked fine on my machine".
//
// Run: node scripts/e2e/test-model-freshness.mjs
import { extractModelIds, findNewerModelIds } from "../../src/lib/modelFreshness.js";

let code = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    code = 1;
  }
};

// Real strings pulled from claude.exe (see DECISIONS.md 2026-08-09) plus
// deliberately adjacent bytes on each side, so the lookaround boundaries are
// actually exercised, not just matching in isolation.
const haystack = [
  '"claude-opus-4-8"',
  '"claude-opus-5"',
  '"claude-opus-4-6-fast"',
  '"claude-opus-4-6-v1"',
  '"claude-fable-5.md"',
  '"claude-fable-5-mythos-5"',
  '"claude-sonnet-4.6"',
  '"claude-sonnet-4-6"',
  '"claude-haiku-4-5-20251001-v1"',
  '"claude-haiku-4-5-20251001"',
  "not-a-claude-opus-5-either",
].join("\x00");

const found = extractModelIds(haystack);

ok(found.includes("claude-opus-4-8"), "extracts a plain family-major-minor id");
ok(found.includes("claude-opus-5"), "extracts a plain family-major id");
ok(found.includes("claude-sonnet-4-6"), "extracts the hyphenated id even next to its dotted-typo twin");
ok(found.includes("claude-haiku-4-5-20251001"), "extracts a dated id on its own");
ok(!found.includes("claude-opus-4-6-fast"), "rejects a -fast suffixed pin");
ok(!found.includes("claude-opus-4-6-v1"), "rejects a -v1 suffixed pin");
ok(!found.some((id) => id.includes(".md")), "rejects a .md-suffixed string constant");
ok(!found.some((id) => id.includes("mythos")), "rejects trailing non-numeric garbage");
ok(!found.includes("claude-sonnet-4.6"), "rejects the dotted-typo alias (not a valid hyphen-numeric id)");
ok(!found.includes("claude-haiku-4-5-20251001-v1"), "rejects a -v1 suffix on a dated id");

const known = ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001", "claude-fable-5"];

const newer = findNewerModelIds(["claude-opus-4-8", "claude-opus-5", "claude-sonnet-4-6", "claude-opus-4-1"], known);
ok(newer.includes("claude-opus-5"), "flags a version above the tracked max for its family");
ok(!newer.includes("claude-opus-4-8"), "does not flag an id that equals the tracked max");
ok(!newer.includes("claude-sonnet-4-6"), "does not flag an id that equals the tracked max (other family)");
ok(!newer.includes("claude-opus-4-1"), "does not flag a legacy back-compat alias below the tracked max");

const dated = findNewerModelIds(["claude-opus-4-5-20251101"], ["claude-opus-4-5"]);
ok(dated.length === 0, "a dated snapshot of an already-known version does not count as newer");

const newFamily = findNewerModelIds(["claude-fable-6"], known);
ok(newFamily.includes("claude-fable-6"), "flags a genuinely new version in an already-tracked family");

process.exit(code);
