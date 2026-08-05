// Guard: a check that reaches a real model must DECLARE itself, so an ordinary run of
// the suite never draws quota by surprise.
//
// the captain, 2026-08-05: "testsviten körs inte av ai eller hur, det är skript så den använder
// inte massa tokens?" The honest answer at the time was no - eleven app checks drove real
// models with no gate at all, and one of them had slipped into the FAST lane, so even
// `npm run test:fast` made a model call. His follow-up is the reason this file exists:
// "notera det också så att framtida tester inte kringgår det".
//
// Documentation would not have held. The rule is enforced instead: every check whose
// source reaches the CLI or starts a session must call requireLive() from live-gate.mjs,
// and this test names the ones that do not. A check that legitimately only STUBS the CLI
// declares that with a LIVE-EXEMPT line, so the exemption is visible and reviewable
// rather than silent.
//
// Run:  node scripts/e2e/test-live-checks-declared.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

/**
 * Source with comments and string literals removed.
 *
 * Both matter. A comment that MENTIONS startSession must not be read as a call (the
 * runner's own live/fast split was originally derived from a plain grep, and that is how
 * three free checks were miscounted as expensive). And a string literal can carry the
 * name too - test-nav-shape looks for source text, for instance.
 */
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

// What "reaches a real model" looks like. Deliberately about the ACT, not about a
// filename or a comment: starting a session, or spawning the CLI binary.
// Each entry was derived from a check that ACTUALLY spends tokens, not guessed: the last
// three were added because the first version of this guard was blind to them while they
// sat gated in front of it. A detector that cannot see a shape is a hole the next test
// walks through, so the shapes are listed rather than assumed.
const REACHES_MODEL = [
  { re: /\bstartSession\s*\(/, what: "starts a session (startSession)" },
  { re: /\bresolveClaudeBinary\s*\(/, what: "resolves the claude binary" },
  { re: /\bspawn\s*\(\s*CLAUDE\b/, what: "spawns the CLAUDE binary" },
  { re: /claude\.(exe|cmd)\b/, what: "names the claude executable" },
  { re: /\brunGoal\s*\(|\bsummarizeSession\s*\(/, what: "runs a goal / a summarize call" },
  { re: /\bsendFromPane\s*\(/, what: "sends a real turn through the composer (sendFromPane)" },
  { re: /\btriageAutoTask\s*\(|\bjudgeModelFit\s*\(/, what: "calls a helper that asks a model (triage / model-fit judge)" },
  { re: /\bsummarizeForHandoff\s*\(|\bsummarizeAndCarryOver\s*\(/, what: "asks for a summary" },
];

/**
 * One check's standing: free (never reaches a model), declared (gated), exempt (says why
 * it only stubs), or undeclared (the failure this file exists for).
 *
 * Separate from the file loop so the classification itself can be tested against
 * fabricated sources at the bottom - "0 undeclared" is also what a broken regex prints.
 */
function classify(raw) {
  // Comments are stripped so a comment MENTIONING startSession is not read as a call.
  const withoutComments = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  // Quoted strings are stripped, template literals are NOT, and the difference is the
  // whole rule: an app.eval body - where these checks really call startSession - is
  // written in backticks, while a check that SEARCHES main.js's source for a call name
  // passes it as a plain quoted string. Keeping both flagged test-auto-triage-backoff,
  // which only does `tick.indexOf("await triageAutoTask(")` and spends nothing.
  const scanned = withoutComments.replace(/"(?:[^"\\\n]|\\.)*"/g, '""').replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
  const hits = REACHES_MODEL.filter((r) => r.re.test(scanned));
  if (hits.length === 0) {
    return { state: "free" };
  }
  const why = hits.map((h) => h.what).join(", ");
  // A CALL on its own line. Matching the bare name anywhere would let a file claim to be
  // gated by mentioning requireLive in a comment or a string - which is precisely the
  // bypass this guard exists to prevent.
  if (/^\s*requireLive\s*\(/m.test(withoutComments)) {
    return { state: "declared", why };
  }
  // An exemption must say why, in the file, in one line: "// LIVE-EXEMPT: <reason>".
  const exemption = (raw.match(/\/\/\s*LIVE-EXEMPT:\s*(.+)/) || [])[1] || null;
  if (exemption && exemption.trim().length >= 20) {
    return { state: "exempt", why, exemption: exemption.trim() };
  }
  return { state: "undeclared", why, hasWeakExemption: !!exemption };
}

const files = fs
  .readdirSync(dir)
  .filter((f) => f.startsWith("test-") && f.endsWith(".mjs"))
  .sort();

const undeclared = [];
const declared = [];
const exempt = [];

for (const file of files) {
  const verdict = classify(fs.readFileSync(path.join(dir, file), "utf8"));
  if (verdict.state === "declared") {
    declared.push(file);
  } else if (verdict.state === "exempt") {
    exempt.push({ file, why: verdict.exemption });
  } else if (verdict.state === "undeclared") {
    undeclared.push({ file, why: verdict.why, hasWeakExemption: verdict.hasWeakExemption });
  }
}

console.log(`scanned ${files.length} checks: ${declared.length} declared live, ${exempt.length} exempt, ${undeclared.length} undeclared`);

ok(
  undeclared.length === 0,
  undeclared.length === 0
    ? "every check that reaches a real model calls requireLive() - a default run cannot spend tokens by surprise"
    : `these reach a real model without requireLive(): ${undeclared.map((u) => `${u.file} (${u.why})`).join("; ")}`
);
for (const u of undeclared) {
  console.log(
    `      ${u.file}: ${u.why}.` +
      (u.hasWeakExemption
        ? " Its LIVE-EXEMPT line is too short to be a reason - say why it does not really reach a model."
        : ' Add `import { requireLive } from "./live-gate.mjs";` + requireLive("<what it does>"), or a `// LIVE-EXEMPT: <reason>` line if it only stubs the CLI.')
  );
}

// The gate has to come BEFORE the expensive part, or it saves nothing: a check that
// launches Electron and writes fixtures first has already paid for most of the run.
const tooLate = [];
for (const file of declared) {
  const lines = fs.readFileSync(path.join(dir, file), "utf8").split("\n");
  const gate = lines.findIndex((l) => /requireLive\s*\(/.test(l) && !/^\s*import/.test(l));
  const cost = lines.findIndex((l) => /harness\.mjs|\blaunch\s*\(\s*\)|spawn\s*\(\s*CLAUDE\b/.test(l));
  if (gate !== -1 && cost !== -1 && cost < gate) {
    tooLate.push(`${file} (gate on line ${gate + 1}, expensive work on line ${cost + 1})`);
  }
}
ok(tooLate.length === 0, tooLate.length === 0 ? "and each gate sits above the expensive work" : `gate placed too late: ${tooLate.join("; ")}`);

// Every exemption is listed, so a stub that quietly became a real call is visible in the
// output of an ordinary run rather than only to whoever wrote it.
for (const e of exempt) {
  console.log(`      exempt: ${e.file} - ${e.why}`);
}

// A sanity check on the guard itself: it must find the ones we know about. Without this,
// a broken regex would report "0 undeclared" and read as a pass - the same
// assertion-that-cannot-fail this suite has been bitten by before.
ok(declared.length >= 15, `the scan actually finds the live checks (${declared.length} found)`);
ok(
  declared.includes("test-first-mate-real-session.mjs") && declared.includes("test-persona-agent-containment.mjs"),
  "including the two that spawn the CLI directly"
);

// --- the guard's own logic, against fabricated sources -----------------------
// Without this the whole file rests on "0 undeclared", which a broken regex also
// produces. Two synthetic checks: one that would spend tokens with no gate must be
// caught, one that is gated must not.
// Single-quoted JS strings, so the samples can contain the BACKTICKS a real check uses
// for its app.eval body - which is the distinction classify() turns on.
const EVAL_CALL = 'await app.eval(`window.helm.startSession({ prompt: "hi" })`);\n';
const ungatedSample = 'import { launch } from "./harness.mjs";\nconst app = await launch();\n' + EVAL_CALL;
const gatedSample = 'import { requireLive } from "./live-gate.mjs";\nrequireLive("starts a real session");\n' + ungatedSample;
const commentOnlySample = "// this check never calls startSession(, it only reads the source\nconst src = String(fn);\n";
const sourceScanSample = 'const at = src.indexOf("await startSession(");\n';
ok(classify(ungatedSample).state === "undeclared", "a check that starts a session with no gate is caught");
ok(classify(gatedSample).state === "declared", "a gated one is not");
ok(classify(commentOnlySample).state === "free", "and a COMMENT mentioning startSession is not mistaken for a call");
ok(classify(sourceScanSample).state === "free", "nor is a check that SEARCHES source text for the call by name");
ok(
  classify("// LIVE-EXEMPT: short\nspawn(CLAUDE, args);\n").state === "undeclared",
  "an exemption too short to be a reason does not count as one"
);
ok(
  classify("// LIVE-EXEMPT: it hands a fabricated path to an injected fake spawn, nothing is started\nspawn(CLAUDE, args);\n").state === "exempt",
  "and one that gives a real reason does"
);

console.log(
  exit === 0
    ? "VERIFY OK: no check can reach a real model without declaring it, and every gate is above the work it guards."
    : "VERIFY FAILED."
);
process.exit(exit);
