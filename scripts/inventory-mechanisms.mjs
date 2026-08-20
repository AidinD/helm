// What has Helm's machinery ACTUALLY done, as opposed to what it has tests for?
//
// This exists because of a specific failure shape (DECISIONS.md 2026-08-18, Jot
// f95bfae5): Helm asserts things about itself that nothing verifies. Mechanisms get
// built, get tests, pass them, and are then never exercised in real operation - and
// nothing anywhere says so, because a green test reads exactly like a working
// feature. The tier guard let 80 of 90 real writer commands through while its tests
// passed. The model label was wrong for two days because the test fed in its own
// assumption. `helm_report_up`, whose own description says it is "how the chain
// closes", has been called zero times in 51 opportunities.
//
// So this reports THREE verdicts, and the third is the important one:
//
//   ok            fired in real operation, and covered by tests
//   NEVER         measurable, and the count is zero
//   UNMEASURABLE  leaves no trace on disk, so nobody can ever know
//
// An UNMEASURABLE mechanism cannot be audited, only believed. Moving a row out of
// that column - by making the mechanism record that it ran - is worth more than
// another test for it, because a test tells you the code CAN work and a trace tells
// you it DID.
//
// Reads only. Mutates nothing. Safe to run at any time, including while Helm is up.
//
// Run:  node scripts/inventory-mechanisms.mjs
//       node scripts/inventory-mechanisms.mjs --markdown
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const E2E = path.join(REPO_ROOT, "scripts", "e2e");
const HELM_HOME = process.env.HELM_HOME || path.join(os.homedir(), ".helm");

// The meta-home is where the dispatch queue and review records live. Resolved the
// same way the app does (main.js resolveMetaHome): the ~/.claude/CLAUDE.md stub
// imports the canonical rules file, and its directory IS the meta-home.
function resolveMetaHome() {
  try {
    const stub = fs.readFileSync(path.join(os.homedir(), ".claude", "CLAUDE.md"), "utf8");
    const m = stub.match(/^@(.+?CLAUDE\.md)\s*$/m);
    if (m) {
      const dir = path.dirname(m[1].trim());
      if (fs.existsSync(dir)) {
        return dir;
      }
    }
  } catch {
    /* fall through */
  }
  return os.homedir();
}
const META = process.env.HELM_META_HOME || resolveMetaHome();

const readJson = (p, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
};
const listDir = (p) => {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
};

const config = readJson(path.join(HELM_HOME, "config.json"), {});
const historyRaw = readJson(path.join(HELM_HOME, "goal-run-history.json"), []);
const runs = Array.isArray(historyRaw) ? historyRaw : historyRaw.runs || [];
const secondMates = readJson(path.join(HELM_HOME, "second-mates.json"), {});
const routines = readJson(path.join(HELM_HOME, "routines.json"), {});
const scheduled = readJson(path.join(HELM_HOME, "scheduled-prompts.json"), {});

const dispatchDir = path.join(META, ".helm-dispatch");
const reports = listDir(path.join(dispatchDir, "reports")).map((f) => readJson(path.join(dispatchDir, "reports", f), {}));
const acks = listDir(path.join(dispatchDir, "acks"));
const reviews = listDir(path.join(META, ".helm", "reviews"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => readJson(path.join(META, ".helm", "reviews", f), {}));
const handoffs = listDir(path.join(META, ".helm", "handoffs"));

// --- test coverage ---------------------------------------------------------
// A test "covers" a mechanism when a token appears in its FILENAME or its SOURCE.
// Tokens are deliberately identifier-shaped rather than words: matching the word
// "error" scored 198 files, which is noise dressed as coverage.
const testFiles = listDir(E2E).filter((f) => f.startsWith("test-") && f.endsWith(".mjs"));
const sourceCache = new Map();
function testSource(file) {
  if (!sourceCache.has(file)) {
    try {
      sourceCache.set(file, fs.readFileSync(path.join(E2E, file), "utf8"));
    } catch {
      sourceCache.set(file, "");
    }
  }
  return sourceCache.get(file);
}
function coveringTests(tokens) {
  const re = new RegExp("(" + tokens.join("|") + ")");
  return testFiles.filter((f) => re.test(f) || re.test(testSource(f)));
}

const count = (arr, fn) =>
  arr.filter((x) => {
    try {
      return fn(x);
    } catch {
      return false;
    }
  }).length;
const stoppedReason = (r) => r?.stoppedReason ?? r?.result?.stoppedReason ?? null;

// --- the mechanisms --------------------------------------------------------
const rows = [];
/**
 * @param {string} area      grouping label
 * @param {string} name      what the mechanism does, in the reader's terms
 * @param {number|null} fired  how many times it is known to have happened
 * @param {number|null} of     out of how many opportunities (null = no denominator)
 * @param {string[]} tokens   identifiers a covering test would contain
 * @param {string} [note]     why the number is what it is
 * @param {boolean} [unmeasurable] true when nothing on disk could ever answer this
 */
const add = (area, name, fired, of, tokens, note = "", unmeasurable = false) =>
  rows.push({ area, name, fired, of, tests: coveringTests(tokens).length, note, unmeasurable });

add("crew pipeline", "a run is dispatched", acks.length, acks.length, ["helm_dispatch", "dispatch-loop"]);
add("crew pipeline", "its report is written to the inbox", reports.length, reports.length, ["writeReport"]);
add(
  "crew pipeline",
  "helm_report_up: a second mate rolls up to its first mate",
  count(reports, (r) => r.kind === "report-up"),
  reports.length,
  ["report_up", "report-up"],
  'its own description calls this "how the chain closes"'
);
add(
  "crew pipeline",
  "helm_collect_reports: somebody READS the inbox",
  null,
  null,
  ["collect_reports"],
  "reports carry no read/collected marker, so this cannot be answered from disk",
  true
);
add("crew pipeline", "crew wakes its own mate", 0, reports.length, ["nudge"], "not built: waking is two human clicks");

for (const reason of [
  "no_op_convergence",
  "max_iterations_reached",
  "two_consecutive_failures",
  "escalated",
  "quota_exhausted",
  "cancelled",
]) {
  add("goal loop", `stopped for: ${reason}`, count(runs, (r) => stoppedReason(r) === reason), runs.length, [reason]);
}
add("goal loop", "no stopped-reason recorded at all", count(runs, (r) => !stoppedReason(r)), runs.length, ["stoppedReason"], "older records");
add("goal loop", "the verifyCommand gate was used", count(runs, (r) => r.verifyCommand), runs.length, ["verifyCommand"]);
add("goal loop", "an escalation carried a detail", count(runs, (r) => r.escalation), runs.length, ["escalationConfig", "detectEscalationSignal"]);

add(
  "tiers",
  "the tier guard DENIED something",
  null,
  null,
  ["tierGuard", "tier-guard"],
  "a denial is returned to the harness and discarded - nothing is counted or logged",
  true
);
add("tiers", "runs labelled tier=crew", count(runs, (r) => r.tier === "crew"), runs.length, ["tier:"]);
add("tiers", "runs labelled tier=second-mate", count(runs, (r) => r.tier === "second-mate"), runs.length, ["tier:"]);
add("tiers", "second mates registered", Object.keys(secondMates).length, Object.keys(secondMates).length, ["secondMateId"]);

add("review surface", "a review record was written", reviews.length, reviews.length, ["writeReviewRecord", "reviewRecords"]);
add(
  "review surface",
  "record whose checks HELM ITSELF saw pass",
  count(reviews, (r) => Array.isArray(r.checkRuns) && r.checkRuns.length > 0),
  reviews.length,
  ["checkRuns", "verifyCheckRun"],
  "a signed run, not a claim in prose"
);
add("review surface", "record with an independent review", count(reviews, (r) => r.independentReview), reviews.length, ["independentReview"]);
add(
  "review surface",
  "commit review acknowledged",
  Object.keys(config.commitReviewAcks || {}).length,
  Object.keys(config.commitReviewWatermarks || {}).length,
  ["commitReview"]
);

add("continuity", "a handoff document was written", handoffs.length, handoffs.length, ["handoff"]);
add(
  "continuity",
  "auto-compact SUCCEEDED",
  null,
  null,
  ["autoCompact", "compactSession"],
  "sessionCompactions is an in-memory Map - it dies with the app",
  true
);
add(
  "continuity",
  "auto-compact FAILED",
  null,
  null,
  ["autoCompact"],
  "a failure is recorded nowhere at all, so the loop cannot learn",
  true
);
add("continuity", "a run started by the auto-captain", count(runs, (r) => r.startedBy === "auto"), runs.length, ["startedBy"]);
add("continuity", "scheduled prompts exist", Array.isArray(scheduled) ? scheduled.length : Object.keys(scheduled).length, null, ["scheduled-prompt"]);
add("continuity", "routines used", Array.isArray(routines) ? routines.length : Object.keys(routines).length, null, ["routine"]);

add("quota", "a quota window was recorded", Object.keys(config.quotaWindows || {}).length, null, ["quotaWindow"]);
add(
  "quota",
  "a run died of quota exhaustion",
  count(runs, (r) => stoppedReason(r) === "quota_exhausted" || /quota|rate.?limit|usage limit/i.test(String(r.error || ""))),
  runs.length,
  ["quota_exhausted"],
  "Aidin's own notes record autopilots dying of this"
);

// --- report ---------------------------------------------------------------
function verdict(r) {
  if (r.unmeasurable) {
    return "UNMEASURABLE";
  }
  if (r.fired === 0) {
    return r.tests > 0 ? "NEVER (but tested)" : "NEVER (untested)";
  }
  if (r.tests === 0) {
    return "ran, untested";
  }
  return "ok";
}
const ranColumn = (r) => (r.unmeasurable ? "-" : r.of ? `${r.fired} / ${r.of}` : String(r.fired));
const areas = [...new Set(rows.map((r) => r.area))];
const markdown = process.argv.includes("--markdown");

if (markdown) {
  console.log("| mechanism | ran | tests | verdict |");
  console.log("|---|---|---|---|");
  for (const a of areas) {
    console.log(`| **${a}** | | | |`);
    for (const r of rows.filter((x) => x.area === a)) {
      console.log(`| ${r.name}${r.note ? ` <br><sub>${r.note}</sub>` : ""} | ${ranColumn(r)} | ${r.tests} | ${verdict(r)} |`);
    }
  }
} else {
  console.log("MECHANISM INVENTORY");
  console.log(`  helm home: ${HELM_HOME}`);
  console.log(`  meta home: ${META}`);
  console.log("=".repeat(100));
  for (const a of areas) {
    console.log(`\n[${a}]`);
    for (const r of rows.filter((x) => x.area === a)) {
      console.log("  " + r.name.padEnd(52) + ranColumn(r).padStart(11) + String(r.tests).padStart(7) + "   " + verdict(r));
      if (r.note) {
        console.log("      " + r.note);
      }
    }
  }
}

const never = rows.filter((r) => !r.unmeasurable && r.fired === 0);
const unmeasurable = rows.filter((r) => r.unmeasurable);
const lines = [
  "",
  "=".repeat(100),
  `${rows.length} mechanisms measured. ${never.length} have NEVER run. ${unmeasurable.length} cannot be measured at all.`,
  "",
  "Never run:",
  ...never.map((r) => `  - ${r.name}${r.tests ? ` (${r.tests} passing tests)` : " (untested)"}`),
  "",
  "Unmeasurable - leaves no trace:",
  ...unmeasurable.map((r) => `  - ${r.name}: ${r.note}`),
];
console.log(lines.join("\n"));

// Non-zero when something has tests but has never run: that combination is the
// specific thing this script exists to surface, so a caller can gate on it.
const testedButNeverRun = never.filter((r) => r.tests > 0).length;
process.exitCode = testedButNeverRun > 0 ? 2 : 0;
