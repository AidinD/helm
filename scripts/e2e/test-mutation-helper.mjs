// The mutation helper does the three things every hand-rolled version got wrong.
//
// Mutation testing has found more real defects here than any other habit, and the 30 lines that
// do it were rewritten by hand a dozen times in one day. Three of those attempts LIED, each in
// a way that reads exactly like a working run:
//
//   a non-unique anchor mutated an unrelated call site, the guard stayed green, and a perfectly
//   good check was reported as worthless;
//   a mutant that did not parse failed every check for the wrong reason, which looks identical
//   to a guard doing its job;
//   an anchor that was not present replaced nothing, and the green run looked like a guard that
//   simply does not catch the defect.
//
// So the helper refuses all three rather than reporting them as results, and this drives it
// against a throwaway module and a throwaway check to prove it - including that a SURVIVOR is
// reported as a survivor, because that is the outcome the whole exercise exists to surface and
// the easiest one to quietly swallow.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runMutations } from "./mutate.mjs";

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails += 1;
  }
};

// A tiny world of its own: one module with a rule, and one check that covers half of it. The
// half it does not cover is what a survivor must be reported for.
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "helm-mutate-"));
fs.mkdirSync(path.join(repo, "lib"), { recursive: true });
fs.mkdirSync(path.join(repo, "checks"), { recursive: true });

fs.writeFileSync(
  path.join(repo, "lib", "rule.mjs"),
  `export function classify(n) {
  if (n < 0) {
    return "negative";
  }
  if (n === 0) {
    return "zero";
  }
  return "positive";
}
`
);

// Covers negative and positive. Says NOTHING about zero - deliberately.
fs.writeFileSync(
  path.join(repo, "checks", "covered.mjs"),
  `import { classify } from "../lib/rule.mjs";
let bad = 0;
const ok = (c, m) => { console.log((c ? "OK   - " : "FAIL - ") + m); if (!c) { bad += 1; } };
ok(classify(-1) === "negative", "a negative number");
ok(classify(7) === "positive", "a positive number");
console.log(bad === 0 ? "VERIFY OK" : "VERIFY FAILED");
process.exit(bad === 0 ? 0 : 1);
`
);

const before = fs.readFileSync(path.join(repo, "lib", "rule.mjs"), "utf8");

const result = runMutations({
  repo,
  checks: ["checks/covered.mjs"],
  mutations: [
    { label: "negative branch removed - covered", file: "lib/rule.mjs", from: '    return "negative";', to: '    return "positive";' },
    { label: "zero branch removed - NOT covered", file: "lib/rule.mjs", from: '    return "zero";', to: '    return "positive";' },
    { label: "anchor appears twice", file: "lib/rule.mjs", from: "  }\n", to: "  }\n" },
    { label: "anchor is absent", file: "lib/rule.mjs", from: "return 'nothing like this';", to: "x" },
    { label: "mutant does not parse", file: "lib/rule.mjs", from: "export function classify(n) {", to: "export function classify(n) {{{" },
  ],
});

const labelled = (list) => list.map((x) => (x.mutation ? x.mutation.label : x.label));

// --- a mutation the checks catch is KILLED ------------------------------------------------
ok(labelled(result.killed).includes("negative branch removed - covered"), `a covered defect is killed (${labelled(result.killed).join("; ") || "none"})`);

// --- one they do not catch is SURVIVED, and that is the finding ---------------------------
ok(
  labelled(result.survived).includes("zero branch removed - NOT covered"),
  `an uncovered defect SURVIVES and is reported as such (${labelled(result.survived).join("; ") || "none"})`
);
ok(result.survived.length === 1, `and only that one (${result.survived.length})`);

// --- the three ways a hand-rolled run lies are refused, not reported as results -----------
const refusals = new Map(result.refused.map((r) => [r.mutation.label, r.why]));
ok(refusals.has("anchor appears twice"), "a non-unique anchor is REFUSED rather than silently mutating the first match");
ok(/appears \d+ times/.test(refusals.get("anchor appears twice") || ""), `and says how many times it appears (${(refusals.get("anchor appears twice") || "").slice(0, 70)})`);
ok(refusals.has("anchor is absent"), "an anchor that is not there is REFUSED rather than counting as a survivor");
ok(refusals.has("mutant does not parse"), "a mutant that does not parse is REFUSED rather than counting as killed");
ok(
  !labelled(result.killed).includes("mutant does not parse"),
  "so a syntax error cannot be mistaken for a guard doing its job - which is the one that looks most like success"
);

// --- a non-JavaScript file is mutable too --------------------------------------------------
// The parse gate runs `node --check`, which cannot read YAML - so the first version refused a
// perfectly valid mutation of a workflow file with an unknown-extension error. Refusing a
// VALID mutation is the same class of lie as accepting a broken one: the run reports nothing
// while looking like it reported something. Found by using the helper on real work, and the
// case belongs here so the narrowing cannot be undone silently.
{
  fs.writeFileSync(path.join(repo, "config.yml"), "mode: strict\n");
  fs.writeFileSync(
    path.join(repo, "checks", "yaml.mjs"),
    `import fs from "node:fs";
const body = fs.readFileSync(new URL("../config.yml", import.meta.url), "utf8");
const strict = /mode: strict/.test(body);
console.log((strict ? "OK   - " : "FAIL - ") + "the config is strict");
console.log(strict ? "VERIFY OK" : "VERIFY FAILED");
process.exit(strict ? 0 : 1);
`
  );
  const yamlRun = runMutations({
    repo,
    checks: ["checks/yaml.mjs"],
    mutations: [{ label: "the yaml setting is flipped", file: "config.yml", from: "mode: strict", to: "mode: loose" }],
  });
  ok(yamlRun.killed.length === 1, `a YAML mutation is run rather than refused (killed ${yamlRun.killed.length}, refused ${yamlRun.refused.length})`);
  ok(
    yamlRun.refused.length === 0,
    `and not turned away for having an extension node cannot parse (${(yamlRun.refused[0] || {}).why || "none"})`
  );
  ok(fs.readFileSync(path.join(repo, "config.yml"), "utf8") === "mode: strict\n", "and it is restored like any other file");
}

// --- and the file is put back, whatever happened ------------------------------------------
const after = fs.readFileSync(path.join(repo, "lib", "rule.mjs"), "utf8");
ok(after === before, "every mutated file is restored byte-identically afterwards");

fs.rmSync(repo, { recursive: true, force: true });

console.log("");
console.log(
  fails === 0
    ? "VERIFY OK: killed, survived and the three lying cases are told apart, and the source is restored."
    : `VERIFY FAILED: ${fails} assertion(s)`
);
process.exit(fails === 0 ? 0 : 1);
