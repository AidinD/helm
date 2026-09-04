// The triage's prompt, its JSON schema and the code that reads the answer must name the SAME
// field - and a mismatch has to be caught here, because its symptom is silence.
//
// Background (independent review, 2026-08-04). The answer field was renamed `well_defined` ->
// `can_start` when the question changed. Three sites have to agree: the prompt that asks for it
// (autoCaptain.js), the schema handed to the model (orchestratorHelper.js), and the one live reader
// (orchestratorHelper.js again). The review reverted the READER alone and ran the whole suite:
// nothing failed. Behaviourally that mismatch means `structured_output.can_start` is absent, the
// call resolves null, and the tick treats every card as a FAILED triage - so the lane silently
// stops starting anything, with a doubling backoff, blaming the model call. The direction of a
// mismatch is "more restrictive", which is the opposite of what the rename was for.
//
// The tolerant parser that used to be pointed at as the safety net for this was dead code - never
// called by any production path - so this replaces it with a check on the thing that is real.
//
// Run:  node scripts/e2e/test-auto-triage-schema-parity.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TRIAGE_SYSTEM_PROMPT, TRIAGE_PROMPT_VERSION } from "../../src/lib/autoCaptain.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const helper = fs.readFileSync(path.join(repo, "src", "lib", "orchestratorHelper.js"), "utf8");

// --- the schema's own answer field, read out of the schema rather than assumed ---
const schemaBlock = helper.slice(helper.indexOf("const TRIAGE_SCHEMA"), helper.indexOf("});", helper.indexOf("const TRIAGE_SCHEMA")));
const required = [...schemaBlock.matchAll(/required: \[([^\]]+)\]/g)].map((m) => m[1])[0] || "";
const fields = required.split(",").map((s) => s.trim().replace(/["']/g, ""));
const answerField = fields.find((f) => f !== "reason");

ok(!!answerField, `the schema declares an answer field besides reason (${fields.join(", ")})`);

// --- the live reader must key on that same field --------------------------------
// Read from the source, because the function spawns a real CLI and cannot be called here. Scoped
// to triageAutoTask, not the whole file, so an unrelated mention elsewhere cannot satisfy it.
const triageFn = helper.slice(helper.indexOf("export function triageAutoTask"), helper.indexOf("\n}\n", helper.indexOf("export function triageAutoTask")));
ok(
  new RegExp(`result\\.${answerField} === "boolean"`).test(triageFn),
  `the live reader checks result.${answerField} (the field the schema requires)`
);
ok(
  new RegExp(`dispatchable: result\\.${answerField}`).test(triageFn),
  `and its verdict is built from that same field, not from another one that happens to exist`
);
// The old name must not linger anywhere in the decision path - a leftover reader keyed on it
// would make the mismatch possible again without changing the schema.
ok(!/well_defined/.test(triageFn), "and no reference to the previous field name survives in it");

// --- the prompt has to ask for it by that name ----------------------------------
ok(
  TRIAGE_SYSTEM_PROMPT.includes(`${answerField}:`),
  `the prompt asks the model for ${answerField} by name (so the schema is not silently doing the asking)`
);
ok(TRIAGE_SYSTEM_PROMPT.includes("reason:"), "and for the reason, which the schema also requires");

// The prompt used to say "reason: only when false" while the schema requires it unconditionally -
// a model obeying the prompt on a startable card would emit no reason, and a schema that enforces
// `required` would then yield no structured output at all, turning a perfectly startable card into
// a triage FAILURE with a backoff. Raised by review; asserted here so the contradiction cannot
// come back.
ok(
  !/reason: only when false/i.test(TRIAGE_SYSTEM_PROMPT),
  "the prompt does not tell the model to omit a field the schema requires"
);

// --- the version stamp, which is what makes a future rename safe ----------------
ok(typeof TRIAGE_PROMPT_VERSION === "number" && TRIAGE_PROMPT_VERSION >= 2, `the prompt carries a version (${TRIAGE_PROMPT_VERSION})`);
const mainSrc = fs.readFileSync(path.join(repo, "src", "main.js"), "utf8");
ok(/forgetTriagedOnPromptChange\(\)/.test(mainSrc), "and the tick forgets remembered verdicts when it moves");
const tick = mainSrc.slice(mainSrc.indexOf("async function autoCaptainTick"), mainSrc.indexOf("\n}\n", mainSrc.indexOf("async function autoCaptainTick")));
const resetAt = tick.indexOf("forgetTriagedOnPromptChange()");
const planAt = tick.indexOf("planAutoTick(");
ok(resetAt > 0 && planAt > 0 && resetAt < planAt, "before the pass plans anything, so the reset takes effect on THIS tick and not a minute later");

console.log(
  exit === 0
    ? `VERIFY OK: prompt, schema and reader all name "${answerField}", the prompt does not contradict the schema, and a version bump clears the verdicts the old question produced.`
    : "VERIFY FAILED - a triage field mismatch would make the auto lane silently stop starting anything."
);
process.exit(exit);
