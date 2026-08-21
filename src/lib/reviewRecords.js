import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseAcceptanceCriteria, acceptanceCoverage, acceptanceProblems } from "./acceptance.js";
import { normalizeIntent, intentSourceNote, intentDrift, parseIntent, clampIntentText, hasEmptyIntentLine, hasOrphanedIntentContinuation, INTENT_MAX_CHARS } from "./intent.js";
import { writeJsonAtomicSync } from "./atomicWrite.js";

// Review records (task ce2d19ab).
//
// The bottleneck is not producing work, it is reviewing it - 8 items sat in
// review while the board also carried a card asking for a review flow. What made
// them expensive was that they all looked equally heavy: nothing said which ones
// were settled and which ones actually needed the captain's judgment, and nothing said
// how to check.
//
// So a record per task, written at handoff time, carrying the two things prose
// cannot be parsed for:
//
//   - `verdict`   - "stamp" (verified end to end, read the evidence and move on)
//                   vs "judgment" (a real decision only he can make)
//   - `testSteps` - numbered, checkable steps with an expected result
//
// And the field that keeps it honest: `notVerified`. A record that only lists
// what passed is a sales pitch. Today's worst near-miss was a feature whose tests
// all passed while the feature was broken, because the tests exercised the layer
// that had already been reasoned about - so what was NOT checked is the useful
// half.
//
// Jot stays the source of truth for STATUS (a task is in review because the board
// says so). The record only carries the evidence, so the two cannot disagree
// about what is under review.

const DIR = path.join(".helm", "reviews");

export function reviewsDir(metaHome) {
  return path.join(metaHome, DIR);
}

/**
 * A cheap fingerprint of everything the review queue is derived from, EXCEPT git.
 *
 * The review queue is expensive to build - about 2.2 seconds of blocked main process on
 * the captain's real board, measured 2026-08-12 - and it was being rebuilt once a minute by a
 * badge, because the cache guarding it was keyed on AGE (20s) while the badge ticked
 * every 60s, so every single tick missed. An age gate answers "how old is this?" when the
 * question that decides correctness is "has anything it was computed FROM changed?".
 *
 * These are those inputs: Jot's todos.json decides what is in review, the review-records
 * folder carries the evidence. Two stat() calls, so this is safe to run on every tick -
 * about 0.1ms against the 2.2 seconds it guards.
 *
 * The folder is stat'ed rather than walked, and that rests on ONE property: records are
 * written atomically (writeJsonAtomicSync = write a temp file, then rename it into place),
 * and a rename changes the directory's mtime while an in-place rewrite does NOT. Verified
 * on Windows 2026-08-12, both ways. If a record were ever written with a plain
 * writeFileSync the fingerprint would stop noticing edits and the badge would quietly
 * freeze - so test-review-queue-cache-inputs pins it by writing a record the way the app
 * does and asserting the fingerprint moves. Walking the folder instead would cost 20ms
 * per tick on his Dropbox-backed meta-home, measured, for a property the write path
 * already guarantees.
 *
 * git state is deliberately NOT covered. A new commit can change a row's hasCommits, and
 * no cheap stat says so; the surface where that must be current (the Review page) forces
 * a fresh build instead of consulting this. Claiming to cover git here would turn a known
 * limit into a silent wrong answer.
 *
 * Returns null when NEITHER input can be read, which callers must treat as "cannot tell"
 * and rebuild - never as "unchanged", which would pin a stale queue forever.
 *
 * @param {string} metaHome
 * @param {string} todosPath
 * @returns {string|null}
 */
export function reviewQueueInputsFingerprint(metaHome, todosPath) {
  const parts = [];
  let readable = 0;
  try {
    const st = fs.statSync(todosPath);
    parts.push(`${todosPath}:${st.mtimeMs}:${st.size}`);
    readable++;
  } catch {
    parts.push(`${todosPath}:-`);
  }
  // The record files themselves, NOT just the directory they sit in.
  //
  // Statting the directory was cheaper and wrong: on NTFS a directory's mtime and size only
  // move when an entry is ADDED or REMOVED, so editing an existing record - stamping a check
  // run, changing a verdict, acknowledging an item - left the fingerprint identical.
  // Measured 2026-08-16: writing new content into an existing file changed neither the
  // directory's mtime nor its size, while creating one changed both. And because a matching
  // fingerprint short-circuits before the age ceiling, the cached queue was then returned
  // with no expiry at all, so the Review badge could sit on a stale number indefinitely -
  // in a file whose own comment says stale review state is exactly what must not be quietly
  // out of date.
  //
  // The cost is one stat per record instead of one for the directory. That is tens of stats
  // on a 60-second tick, against the ~2 seconds of git work this cache exists to avoid.
  const dir = reviewsDir(metaHome);
  try {
    const names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
    let stamp = `${dir}:${names.length}`;
    for (const n of names) {
      const st = fs.statSync(path.join(dir, n));
      stamp += `|${n}:${st.mtimeMs}:${st.size}`;
    }
    parts.push(stamp);
    readable++;
  } catch {
    parts.push(`${dir}:-`);
  }
  return readable === 0 ? null : parts.join("|");
}

/** Jot ids are uuids; keep the filename to that shape so nothing can escape. */
function safeId(taskId) {
  const id = String(taskId || "").trim().toLowerCase();
  return /^[a-f0-9-]{8,64}$/.test(id) ? id : null;
}

export function reviewRecordPath(metaHome, taskId) {
  const id = safeId(taskId);
  return id ? path.join(reviewsDir(metaHome), `${id}.json`) : null;
}

export const REVIEW_VERDICTS = ["stamp", "judgment"];

// Criticality drives what evidence is REQUIRED, not just how carefully to work
// (the captain 2026-07-27): "störst effort borde ligga på systemkritiska moment. security
// issues borde t.ex aldrig slinka igenom, medans en front end bugg är mer
// acceptabelt."
//
// Uniform rigour is what makes "I don't review code anymore" unsafe: it spends the
// same shallow pass on an auth path as on a misaligned pixel. The gradient is what
// lets him stop reading diffs while keeping the veto where being wrong is expensive.
export const CRITICALITY_TIERS = {
  critical: {
    label: "Critical",
    what: "security, auth, data loss or corruption, money, irreversible or outward-facing actions (release, publish, delete, spend)",
    // The author's own passing tests are not evidence at this tier. Something from
    // OUTSIDE the author has to have looked - that is the whole finding from
    // 2026-07-26/27, where green self-written tests sat on top of broken features.
    requiresIndependentReview: true,
    requiresChecks: true,
  },
  core: {
    label: "Core",
    what: "state, persistence, or behaviour other work depends on",
    requiresIndependentReview: false,
    requiresChecks: true,
  },
  cosmetic: {
    label: "Cosmetic",
    what: "visual or front-end only; a bug here is recoverable and finding it later is acceptable",
    requiresIndependentReview: false,
    requiresChecks: false,
  },
};
export const CRITICALITY_LEVELS = Object.keys(CRITICALITY_TIERS);

/**
 * Limits that keep a record readable, measured from the 93 records that existed on
 * 2026-08-20 rather than picked by feel.
 *
 * What the measurement said: the median summary was 393 characters - a paragraph, not
 * a sentence - with a longest of 2104. Median visible line was 115 characters in the
 * evidence and 180 in the gaps. The habit was consistently two to four times too long,
 * and the cost is on record: the captain approved ten records in a row without reading any of
 * them and said the text was why.
 *
 * A `detail` is deliberately UNCAPPED. The point is not less information - it is that
 * the long half belongs behind the expander instead of in the line. Every limit here is
 * on what the reader sees before clicking anything.
 */
export const READABILITY_LIMITS = Object.freeze({
  summary: 240,
  intent: INTENT_MAX_CHARS,
  visibleLine: 120,
  step: 120,
  expect: 120,
  evidenceItems: 5,
  gapItems: 5,
  stepItems: 6,
});

/**
 * Ways a record fails to say WHAT WAS ASKED FOR. Enforced on write only, alongside
 * readability and for the same reason: 78 of 96 existing records carry no intent, and
 * marking them all invalid would be the noise this whole effort is undoing.
 *
 * Graded by what being wrong costs, like everything else here:
 *   core / critical - refused. These are the tiers where "correct, but not what was
 *                     asked" is expensive, and where a reviewer needs the question.
 *   cosmetic        - allowed, and surfaced by recordCaveats instead. Cosmetic buys
 *                     speed; it does not buy silence.
 *
 * An intent that is only my paraphrase (`source: "assistant"`) still passes. Refusing it
 * would be a gate nobody can clear: the captain does not hand-write a sentence per task, and a
 * gate that cannot be cleared gets worked around rather than satisfied. What is required
 * is that the ask was written down before the work and can be read back and corrected;
 * whose words they are is reported, not gated.
 */
export function reviewRecordIntentProblems(rec) {
  if (!rec || typeof rec !== "object") {
    return [];
  }
  const criticality = String(rec.criticality || "").toLowerCase();
  if (criticality !== "core" && criticality !== "critical") {
    return [];
  }
  const intent = normalizeIntent(rec.intent);
  if (!intent) {
    return [
      `a ${criticality} record must carry the intent - the ask it was written against - as intent: { text, source }. Put the same sentence on an "INTENT:" line in the Jot task so it can be corrected before the next round`,
    ];
  }
  return [];
}

/** The line a reader sees before expanding anything. */
function visibleLine(item) {
  return String((typeof item === "string" ? item : item?.claim) || "");
}

/**
 * Is this record readable? SEPARATE from reviewRecordProblems on purpose.
 *
 * Correctness rules are retroactive - a critical item with nothing independent behind
 * it was always inadmissible and should render as incomplete however old it is.
 * Readability rules are not: applying them backwards would mark about ninety existing
 * records incomplete in one go, which is noise, and noise is the thing being fixed.
 * So this gate runs on WRITE only, and the rendering path never calls it.
 *
 * Every message says what to DO, not just what is wrong. A limit that only says "too
 * long" invites deleting the honest half; naming the {claim, detail} split says where
 * the honest half goes instead.
 */
export function reviewRecordReadability(rec) {
  const problems = [];
  if (!rec || typeof rec !== "object") {
    return [];
  }
  const L = READABILITY_LIMITS;
  const summary = String(rec.summary || "");
  if (summary.length > L.summary) {
    problems.push(
      `summary is ${summary.length} characters (limit ${L.summary}) - say what changed in one or two short sentences and move the rest into an evidence entry's detail`
    );
  }
  // The intent shares the summary's limit because the card shows them as two rows, read
  // as a pair. Whichever one runs long is the one that turns the card back into homework.
  const intentText = normalizeIntent(rec.intent)?.text || "";
  if (intentText.length > L.intent) {
    problems.push(
      `intent is ${intentText.length} characters (limit ${L.intent}) - state the ask in one or two sentences; the reasoning behind it belongs in the task, not on the card`
    );
  }
  for (const [field, items, cap] of [
    ["evidence", rec.evidence, L.evidenceItems],
    ["notVerified", rec.notVerified, L.gapItems],
  ]) {
    if (!Array.isArray(items)) {
      continue;
    }
    if (items.length > cap) {
      problems.push(`${field} has ${items.length} entries (limit ${cap}) - merge the ones that make the same point`);
    }
    items.forEach((item, i) => {
      const line = visibleLine(item);
      if (line.length > L.visibleLine) {
        problems.push(
          `${field}[${i}] shows ${line.length} characters before anything is clicked (limit ${L.visibleLine}) - split it into { claim, detail }: the claim is the line, the detail goes behind "explain" and has no limit`
        );
      }
    });
  }
  if (Array.isArray(rec.testSteps)) {
    if (rec.testSteps.length > L.stepItems) {
      problems.push(`testSteps has ${rec.testSteps.length} steps (limit ${L.stepItems}) - a checklist longer than that does not get ticked`);
    }
    rec.testSteps.forEach((s, i) => {
      if (String(s?.step || "").length > L.step) {
        problems.push(`testSteps[${i}].step is ${String(s.step).length} characters (limit ${L.step}) - one action per step`);
      }
      if (String(s?.expect || "").length > L.expect) {
        problems.push(`testSteps[${i}].expect is ${String(s.expect).length} characters (limit ${L.expect}) - one thing to look for`);
      }
    });
  }
  return problems;
}

/**
 * What is wrong with a record, as a list of human-readable problems. Empty means
 * complete. Used both to refuse a bad write and to mark a rendered record as
 * incomplete rather than silently showing a hollow card.
 *
 * Readability is NOT checked here - see reviewRecordReadability for why.
 */
export function reviewRecordProblems(rec) {
  const problems = [];
  if (!rec || typeof rec !== "object") {
    return ["not an object"];
  }
  if (!safeId(rec.taskId)) {
    problems.push("taskId is missing or not a Jot id");
  }
  if (!rec.summary || !String(rec.summary).trim()) {
    problems.push("summary is empty - the reader needs to know what changed");
  }
  if (!REVIEW_VERDICTS.includes(rec.verdict)) {
    problems.push(`verdict must be one of ${REVIEW_VERDICTS.join(" | ")}`);
  }
  if (!Array.isArray(rec.testSteps) || rec.testSteps.length === 0) {
    // The whole point is that he can check it, so this is not optional even for
    // a stamp - a stamp with no way to confirm it is just an assertion.
    problems.push("testSteps is empty - a claim with no way to check it is an assertion");
  } else if (rec.testSteps.some((s) => !s || !String(s.step || "").trim() || !String(s.expect || "").trim())) {
    problems.push("every test step needs both a step and an expected result");
  }
  if (rec.verdict === "judgment" && (!rec.ask || !String(rec.ask).trim())) {
    problems.push("a judgment item must state the ask - what decision is needed");
  }
  if (!Array.isArray(rec.evidence)) {
    problems.push("evidence must be an array (use [] if genuinely none)");
  }
  if (!Array.isArray(rec.notVerified)) {
    problems.push("notVerified must be an array - state the gaps, use [] only if there truly are none");
  }
  if (rec.checks !== undefined) {
    if (!Array.isArray(rec.checks)) {
      problems.push("checks must be an array");
    } else if (rec.checks.some((c) => !c || !String(c.label || "").trim() || !String(c.cmd || "").trim())) {
      problems.push("every check needs a label and a cmd");
    } else {
      const dupes = duplicateCheckLabels(rec);
      if (dupes.length > 0) {
        // Runs are keyed by label, so duplicates cannot be scored separately - the
        // second stamp overwrites the first and a failing check disappears.
        problems.push(`check labels must be unique - "${dupes[0]}" appears more than once, so their runs would overwrite each other`);
      }
    }
  }
  // A declared check needs somewhere to RUN. reviews:runChecks resolves it as
  // `check.cwd || rec.projectPath` and refuses to guess when both are missing - which
  // is right, because a check run in the wrong place fails for the wrong reason. But
  // nothing stopped a record being WRITTEN without either, so the refusal only ever
  // surfaced later, as a review row whose checks failed for a reason that looked like
  // the code (the captain, 2026-08-04: "End to end test failar på denna i review" - it was
  // my record, not his app). The condition below is deliberately the same expression
  // the runner uses, so the two cannot disagree about whether a check is runnable.
  // A check runs through `spawn(cmd, { shell: true })`, which on Windows is
  // cmd.exe. `VAR=1 node foo.mjs` is Unix shell syntax; cmd.exe reads the whole
  // `VAR=1` as the name of a program to run and fails with "not recognized as an
  // internal or external command". The check then shows up red for a reason that
  // has nothing to do with the work it was supposed to vouch for.
  //
  // Refused at WRITE time rather than left to fail at run time, for the same
  // reason as the missing-cwd rule above: the captain met this as "ett test failar" on a
  // card whose code was fine, and the only way to find out why was to read the
  // tail of a shell error. Pass the flag the script itself supports, or set the
  // variable inside the command (`cmd /c "set VAR=1 && node ..."`).
  if (Array.isArray(rec.checks)) {
    const unixEnvPrefix = rec.checks.filter((c) => /^\s*[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+\S/.test(String(c?.cmd || "")));
    if (unixEnvPrefix.length > 0) {
      const first = String(unixEnvPrefix[0].cmd).trim().split(/\s+/)[0];
      problems.push(
        `check "${unixEnvPrefix[0].label}" starts with the Unix env-var prefix \`${first}\` - checks run through cmd.exe on Windows, which reads that as a program name and fails before your test starts. Use a flag the script accepts, or set the variable inside the command.`
      );
    }
  }
  if (Array.isArray(rec.checks) && rec.checks.length > 0) {
    const homeless = rec.checks.filter((c) => !String(c?.cwd || "").trim());
    if (homeless.length > 0 && !String(rec.projectPath || "").trim()) {
      problems.push(
        `${homeless.length} check(s) have nowhere to run - set projectPath on the record, or cwd on each check. Without it the check fails for a missing directory, not for a real result.`
      );
    }
  }
  // A Windows path whose separators were eaten. Found on 4 records from 2026-08-12
  // (`D:RepoToolshelm`), which is what a JSON string like "D:\Repo\Tools\helm" collapses
  // to - `\R`, `\T` and `\h` are not valid escapes, so the backslashes are simply dropped.
  //
  // Silent and total: every surface that needs the repo (See diff, Run checks, sending an
  // independent reviewer, pinning a check to a commit) roots there, so all of them fail on
  // a directory that cannot exist, and the card reports a missing repo rather than a
  // corrupt field. Checked by SHAPE, not by existsSync: a repo that is merely moved or on
  // an unplugged drive is a different problem, and refusing the record for it would put
  // the evidence out of reach exactly when someone is trying to read it.
  for (const [field, value] of [["projectPath", rec.projectPath], ...(Array.isArray(rec.checks) ? rec.checks.map((c, i) => [`checks[${i}].cwd`, c?.cwd]) : [])]) {
    const p = String(value || "").trim();
    if (p && /^[A-Za-z]:[^\\/]/.test(p)) {
      problems.push(`${field} is "${p}" - a drive letter with no separator after it, so its backslashes were lost when the record was written. Nothing can be rooted there.`);
    }
  }
  problems.push(...criticalityProblems(rec));
  problems.push(...acceptanceRecordProblems(rec));
  return problems;
}

/**
 * The criticality gradient, enforced (the captain 2026-07-27).
 *
 * Required, with no default. A missing tier is the author declining to say how much
 * it costs to be wrong here - which is precisely the judgement the gradient exists
 * to force, so silence must not resolve to the lenient option.
 */
function criticalityProblems(rec) {
  const problems = [];
  const tier = CRITICALITY_TIERS[rec.criticality];
  if (!tier) {
    return [`criticality must be one of ${CRITICALITY_LEVELS.join(" | ")} - say how much it costs to be wrong here`];
  }
  // A tier you have to ARGUE for is much harder to under-declare than one you tick.
  // `cosmetic` is the escape hatch in the whole design - it requires no check, no
  // independent pass, and renders no gauntlet box at all - so it is the one tier that
  // has to cost the author a sentence. The sentence is also the thing the captain can
  // disagree with; "cosmetic" on its own gives him nothing to push back on.
  if (rec.criticality === "cosmetic") {
    const why = String(rec.whyNotCritical || "").trim();
    // Length, word count AND distinct words. A pure length gate accepted
    // "..............."; adding a word count still accepted "n/a n/a n/a n/a". None of
    // this checks whether the sentence is TRUE - nothing here can - it only makes a
    // placeholder cost about as much to write as the real thing, which is the whole
    // mechanism this tier relies on.
    const words = why.toLowerCase().split(/\s+/).filter((w) => /[a-z0-9]/i.test(w));
    if (why.length < 15 || words.length < 4 || new Set(words).size < 3) {
      problems.push(
        "a cosmetic item must state whyNotCritical - one line on why being wrong here is cheap. This tier requires no evidence at all, so it is the one that has to be argued for"
      );
    }
  }
  // Security and integrity are ALWAYS the captain's call, however green the checks are.
  // the captain, 2026-08-20: "ändringar som påverkar eventuell säkerhet eller integritet ska
  // vara needs you." A `stamp` means "verified end to end, read it and move on", and this
  // tier is defined as the one where being wrong is expensive or irreversible - so a
  // stamp here is the author deciding that his eyes were not needed on exactly the class
  // of change where they are. `judgment` also forces `ask`, which is what turns "a second
  // pair of eyes" into a required statement of WHICH parts rather than a hope.
  if (rec.criticality === "critical" && rec.verdict === "stamp") {
    problems.push(
      "a critical item cannot be a stamp - security, auth, data loss, money and irreversible actions always need the captain, so set verdict to judgment and state in `ask` which specific parts want a second pair of eyes"
    );
  }
  const checks = Array.isArray(rec.checks) ? rec.checks : [];
  if (tier.requiresChecks && checks.length === 0) {
    problems.push(`a ${rec.criticality} item needs at least one runnable check - "${tier.what}" cannot rest on prose alone`);
  }
  if (tier.requiresIndependentReview) {
    const ind = rec.independentReview;
    if (!ind || !String(ind.by || "").trim() || !String(ind.summary || "").trim()) {
      problems.push(
        "a critical item needs independentReview {by, summary} - at this tier the author's own passing tests are not evidence (2026-07-27: three features shipped broken under green self-written tests)"
      );
    } else if (typeof ind.findings !== "number") {
      problems.push("independentReview.findings must be a number - how many issues the independent pass raised (0 is a real answer)");
    }
    // MUTATION EVIDENCE. A green suite proves the tests pass; it does not prove they
    // would fail if the thing they guard broke. Every one of the worst misses on
    // 2026-08-03 was a guard whose removal left the suite green: two checks asserted
    // the NAMES of the functions being called and never the arguments, so swapping a
    // safety option for a forceful one, and flipping a branch delete from safe to
    // forced, were both invisible. At this tier a test nobody has tried to break is
    // an untested test.
    if (!hasMutationEvidence(rec)) {
      problems.push(
        "a critical item needs mutation evidence - break one guard on purpose, name it, and say which check went red. A guard whose removal leaves the suite green is not a guard (2026-08-03: two such survived a suite that read as thorough)"
      );
    }
  }
  return problems;
}

/**
 * True when some evidence entry describes having BROKEN something and watched a
 * check notice. Matched on the claim's own words rather than a checkbox, because a
 * boolean field would be ticked by the same optimism that writes a guard nobody
 * tried to break; a sentence has to describe a thing that actually happened.
 */
function hasMutationEvidence(rec) {
  const claims = [
    ...(Array.isArray(rec.evidence) ? rec.evidence : []).map((e) => `${e?.claim || ""} ${e?.detail || ""}`),
    String(rec.summary || ""),
  ];
  return claims.some((text) => {
    const t = text.toLowerCase();
    const brokeIt = /\bmutat|mutation|broke (it|the guard|one)|disabl|commented out|removed the guard|reverted the guard/.test(t);
    // "fail" and "red" matched anywhere, including inside a DENIAL - so a record
    // stating that breaking the guard left the suite green satisfied the gate written
    // to catch exactly that, as did an empty detail behind a boilerplate claim
    // (independent review, 2026-08-03). Three narrowings: the sentence must say a
    // check went red, must name what noticed, and must not be a denial. Deliberately
    // strict - this only gates the critical tier, where a false rejection costs a
    // rewritten sentence and a false acceptance costs the whole point of the gate.
    const noticed = /went red|turned red|\bred\b|failed|caught it|caught the|did notice|was noticed/.test(t);
    const namesWhatNoticed = /\btest|\bcheck|\bsuite|\bspec|\bassert|scripts\//.test(t);
    // Real evidence can point at what it ran. "broke one guard, a check failed" is
    // technically all the right words and tells a reader nothing they could go and
    // repeat, so it does not clear the bar for a critical claim.
    const identifiesTheCheck = /[\w-]+\.(mjs|cjs|[jt]s|py)|scripts\/|\btest-[\w-]+|npm (run )?test|\bsuite\b|\bwhole suite\b/.test(t);
    const denies =
      /\bno (mutation|test|check)|not mutat|without mutat|stayed green|remained green|still green|nothing (failed|noticed|caught|went red)|did ?n[o']?t (fail|notice|catch)|no ?(test|check)s? (failed|noticed|caught)|none (failed|noticed)/.test(
        t
      );
    // An empty sentence describes nothing, whatever words it borrows.
    const hasSubstance = t.replace(/\s+/g, " ").trim().length >= 60;
    return brokeIt && noticed && namesWhatNoticed && identifiesTheCheck && hasSubstance && !denies;
  });
}

/**
 * Acceptance criteria, enforced at the review boundary.
 *
 * Copied onto the record rather than read live from the task: a record is a snapshot
 * of a claim, and a task edited afterwards must not retroactively change what was
 * claimed. The cost is that they can drift from the task - surfaced by
 * acceptanceDrift() rather than hidden.
 *
 * Every criterion must be linked to a test step by name or number. This is the half
 * that would have caught the "Jump in" bug: the criterion was "I land in the
 * session", the test COUNTED buttons, and nothing connected the two.
 */
/**
 * Ways a record can be admissible and still be resting entirely on the author's word.
 * Not validity errors - they are true statements ABOUT the record that the reader
 * needs on screen, because their signature is an ABSENCE and an absence renders as
 * nothing at all.
 *
 * The case that prompted this: a `cosmetic` record with no checks and no acceptance
 * criteria is fully valid. gauntletStatus returns "none", so the card shows no
 * gauntlet box, no Run checks button, nothing amber - and lands under "Ready to
 * stamp". Cosmetic should buy speed, not silence.
 */
export function recordCaveats(rec) {
  const caveats = [];
  if (!rec) {
    return caveats;
  }
  const checks = Array.isArray(rec.checks) ? rec.checks : [];
  if (checks.length === 0) {
    caveats.push("No executed check at all - everything here rests on the author's word.");
  }
  // What was ASKED FOR. Its absence is the one that hides best: a record with no intent
  // reads as complete, and the question it should have been measured against simply is
  // not on the page - so a reader agrees with work that answers something else.
  const intent = normalizeIntent(rec.intent);
  if (!intent) {
    caveats.push("Nothing here says what was asked for, so nothing was reviewed against it - only against what the author says they did.");
  } else if (intent.source === "assistant") {
    caveats.push(`What was asked is stated in my words, not the captain's - ${intentSourceNote(intent.source).toLowerCase()}`);
  }
  if (!Array.isArray(rec.acceptanceCriteria)) {
    // Distinct from an empty array, which is an explicit claim that the task had none.
    // Deliberately says "criteria", not "intent": they are two things (see intent.js), and
    // this sentence used to blur them by calling the criteria a stated intent.
    caveats.push("No acceptance criteria were agreed before the work, so nothing here is checked against a criterion written in advance.");
  } else if (rec.acceptanceCriteria.length === 0) {
    caveats.push("The task had no acceptance criteria (explicitly recorded as none).");
  }
  const forced = checks.map((c) => ({ label: c?.label, why: passForcingReason(c?.cmd) })).filter((f) => f.why);
  for (const f of forced) {
    caveats.push(`Check "${f.label}" cannot fail (${f.why}) - a green result from it means nothing.`);
  }
  // ONE FILE IS NOT THE SUITE. Running a single test file proves that file passes in
  // isolation; it cannot show interference between tests, and interference is where
  // some of the nastiest bugs hide. On 2026-08-03 a new test passed on its own and
  // failed under the runner - because, run standalone, it had written to a real data
  // file instead of its temp one. The file said green; the suite said what was true.
  if (checks.length > 0 && !checks.some((c) => runsWholeSuite(c?.cmd))) {
    caveats.push(
      "No check runs the whole suite - single test files pass in isolation, so nothing here would have shown one test interfering with another."
    );
  }
  return caveats;
}

/**
 * True for a command that runs the project's whole test suite rather than one file.
 * Deliberately narrow and name-based: a broader guess would quietly accept a single
 * file whose name happens to contain "test".
 */
function runsWholeSuite(cmd) {
  const c = String(cmd || "").trim();
  // THE RUNNER FIRST. `node scripts/run-tests.mjs` names a .mjs file and IS the whole
  // suite, so the "names a specific file" rule below used to reject this repo's own
  // canonical way of running everything - the `run-tests` alternative sat behind an
  // early return that always fired first, so it was dead (independent review,
  // 2026-08-03). A caveat that cries wolf on the correct command is one people learn
  // to ignore.
  const runner = /\brun-tests(\.[cm]?js)?\b|\bnpm (run )?test\b|\byarn test\b|\bpnpm (run )?test\b|\bvitest run\b|\bjest\b|\bpytest\b|\bcargo test\b|\bdotnet test\b|\bgo test\b/.test(c);
  if (!runner) {
    return false;
  }
  // A filter argument turns the runner into a SUBSET of the suite, which is exactly
  // what this predicate exists to distinguish. `npm run test:fast -- worktree` ran 2
  // of 49 files and was accepted as the whole suite. Everything after a bare `--`, or
  // any trailing bare word after the runner, counts as a filter. Ignore flags
  // (`--fast`, `-x`) and path-shaped words, which select the runner itself.
  const withoutRunner = c.replace(/^.*?\b(run-tests(\.[cm]?js)?|test(:[a-z0-9-]+)?|vitest run|jest|pytest|cargo test|dotnet test|go test)\b/, "");
  const args = withoutRunner.split(/\s+/).filter(Boolean);
  // Anything left that is not a flag, not the `--` separator and not a
  // run-everything wildcard (`./...`) selects a subset: a name to grep test titles
  // by, or a single file. `npm run test:fast -- worktree` ran 2 of 49 files and was
  // being accepted as the whole suite.
  const filters = args.filter((a) => a !== "--" && a !== "run" && !a.startsWith("-") && !a.includes("..."));
  return filters.length === 0;
}

function acceptanceRecordProblems(rec) {
  const raw = Array.isArray(rec.acceptanceCriteria) ? rec.acceptanceCriteria : null;
  // Re-index by POSITION. A record is hand-authored, and duplicated index values let
  // one linked step satisfy several criteria at once (`[{index:1,...},{index:1,...}]`
  // with a single `ac: 1` read as fully covered). The author does not get to decide
  // the numbering that the coverage check keys on.
  const criteria = raw ? raw.map((c, i) => ({ index: i + 1, text: typeof c === "string" ? c : String(c?.text || "") })) : null;
  if (!criteria) {
    // Not every record has criteria yet (they only exist for work taken after this
    // landed), so their ABSENCE is not a refusal - but a present-and-empty array is
    // an explicit claim that the task had none, which is allowed and visible.
    return [];
  }
  const problems = [];
  const { uncovered, dangling } = acceptanceCoverage(criteria, rec.testSteps);
  for (const c of uncovered) {
    problems.push(`acceptance criterion ${c.index} has no test step covering it: "${c.text}" - link one with ac: ${c.index}`);
  }
  for (const ref of dangling) {
    problems.push(`a test step claims to cover "${ref}", which is not one of this task's acceptance criteria`);
  }
  return problems;
}

/**
 * Has the task's acceptance changed since the record snapshotted it? Reported, never
 * auto-resolved: if the criteria moved, either the work needs revisiting or the
 * record does, and only a human knows which.
 */
export function acceptanceDrift(rec, taskDescription) {
  const snapshot = Array.isArray(rec?.acceptanceCriteria) ? rec.acceptanceCriteria : [];
  const live = parseAcceptanceCriteria(taskDescription);
  const key = (list) => list.map((c) => (typeof c === "string" ? c : c.text).trim().toLowerCase()).sort().join("|");
  const drifted = key(snapshot) !== key(live);
  return { drifted, snapshot, live };
}

// --- The gauntlet (Uncle Bob, task bd5d7b4b) -------------------------------
// `evidence` is what the agent CLAIMS. `checks` are commands, and `checkRuns`
// are what actually happened when they ran - exit code, when, and the tail of
// the output. Kept as separate fields on purpose: the whole reason review is
// cheap-but-trustworthy is that some of the evidence is not the author's word.
//
// The failure this guards is real and recent: a feature shipped whose tests all
// passed while the feature was broken, because the tests exercised the layer the
// author had already reasoned about. A stored exit code cannot be talked around.

// --- Run provenance: "the app ran this" vs "someone typed this" -------------
//
// The gauntlet's whole claim is that part of the evidence is not the author's word.
// As first built, that was false: writeReviewRecord (and all its refusals) is not on
// any production path - records are authored by an agent writing JSON directly - and
// gauntletStatus trusted a `ok: true` field without ever looking at the exit code.
// So a hand-written record with
//     checks:    [{ label: "auth e2e (34 assertions)", cmd: "exit 0" }]
//     checkRuns: [{ label: "auth e2e (34 assertions)", ok: true }]
// read as "Checks passing (1/1), ready to stamp" with no command ever executed.
//
// So a check run now carries an HMAC written ONLY by the process that actually
// spawned the command. An unsigned or mis-signed run is not evidence.
//
// HONEST LIMIT, stated because this file is the thing that is supposed to be honest:
// the key sits on disk in the meta-home, so an agent with filesystem access can read
// it and forge a signature. This is tamper-EVIDENT, not tamper-proof. What it
// actually buys is the line between "the app ran this and stamped the result" and
// "the author wrote down an outcome they believed" - and the second one is the
// failure that keeps happening. A real guarantee needs the runner outside the
// author's reach (CI), which is not built.
const RUN_KEY_FILE = path.join(".helm", "run-key");

/**
 * The signing key, created on first use.
 *
 * `create` exists because VERIFYING must never mint one. Verification runs inside the
 * off-main worker (buildReviewQueue -> gauntletStatus -> verifyCheckRun), and a key
 * generated there would be a second process writing the meta-home - the one thing the
 * worker promises not to do, and a straight race with main if both find the file missing
 * at once. The loser's key wins on disk and every previously signed run then fails to
 * verify, i.e. the board silently reports verified work as unverified (found by review,
 * 2026-08-12).
 *
 * It is also just wrong on its own terms: minting a key while checking a signature
 * guarantees that signature cannot match. No key means "cannot confirm", which
 * verifyCheckRun already renders as unverified - the honest answer.
 */
function runKey(metaHome, { create = true } = {}) {
  if (!metaHome) {
    return null;
  }
  const file = path.join(metaHome, RUN_KEY_FILE);
  try {
    if (fs.existsSync(file)) {
      const key = fs.readFileSync(file, "utf8").trim();
      return key.length >= 32 ? key : null;
    }
    if (!create) {
      return null;
    }
    const key = crypto.randomBytes(32).toString("hex");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, key + "\n", { encoding: "utf8", mode: 0o600 });
    return key;
  } catch {
    return null;
  }
}

/**
 * The signature a genuine run carries.
 *
 * `declaredCmd` is the command as it stands in `rec.checks`, NOT what the run says it
 * ran. Runs used to be matched to checks by LABEL alone, with nothing comparing the
 * two commands - so a run stamped for `exit 0` could score a check whose displayed
 * command was a real e2e script. The field the code called "the fact" was not the
 * thing that produced the exit code. Binding the signature to the declared command
 * means a pass can only ever be claimed for the command the reader is looking at.
 */
export function signCheckRun(metaHome, taskId, run, declaredCmd = undefined, { create = true } = {}) {
  // create defaults to true so SIGNING still establishes the key on first use. Only
  // verifyCheckRun passes false - see runKey for why reading must never write.
  const key = runKey(metaHome, { create });
  if (!key) {
    return null;
  }
  const payload = JSON.stringify([
    String(taskId || ""),
    String(run?.label || ""),
    // Falls back to the run's own cmd only when no declared command was supplied, so
    // existing callers keep working; every real caller passes the declared one.
    String(declaredCmd !== undefined ? declaredCmd || "" : run?.cmd || ""),
    typeof run?.exitCode === "number" ? run.exitCode : null,
    typeof run?.ranAt === "number" ? run.ranAt : null,
    // The commit it ran against, so an old pass cannot be re-pinned to new code.
    run?.head || null,
  ]);
  return crypto.createHmac("sha256", key).update(payload).digest("hex");
}

/**
 * Shell tricks that turn a real command into a guaranteed pass. `reviews:runChecks`
 * spawns with `shell: true`, so `node test.mjs || exit 0` exits 0 whatever the test
 * does - a GENUINE signed green. And the command was truncated in the UI, so the
 * tail that did the work was rendered off the end of the line.
 *
 * Deliberately a heuristic and deliberately non-blocking: it flags rather than
 * refuses, because a legitimate command can contain a pipe, and a check that refuses
 * to run is a check that gets deleted. The point is that the reader SEES it.
 */
const PASS_FORCING_PATTERNS = [
  { re: /\|\|/, why: "|| always-succeeds fallback" },
  { re: /;\s*(exit\s+0|true)\b/, why: "; exit 0 appended" },
  { re: /\|\s*true\b/, why: "piped to true" },
  { re: /--passWithNoTests\b/, why: "--passWithNoTests" },
  { re: /\bexit\s+0\s*$/, why: "ends in exit 0" },
];

/**
 * The commit a check run was made against, so a pass stops applying when the code
 * moves (task filed 2026-07-27).
 *
 * The hole: staleness was measured only against `contentUpdatedAt` - an internal field
 * of the record's own file. Nothing bound a record to a commit. So the ordinary second
 * lap broke it: the captain sends a task back, the next session fixes the code and moves the
 * task back to review WITHOUT rewriting the record, and the pre-fix green run still
 * vouches for it. Worse, it created a perverse incentive - any record edit correctly
 * ages out its runs, so an agent wanting green after a late fix was better off NOT
 * updating the record.
 *
 * Returns null when the project isn't a git repo or git is unavailable: unknown must
 * not masquerade as verified, so gauntletStatus treats a run with no recorded head as
 * verifiable-but-unpinned rather than fresh.
 */
export function currentHead(projectPath) {
  if (!projectPath) {
    return null;
  }
  try {
    const sha = execFileSync("git", ["-C", projectPath, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      return null;
    }
    // Uncommitted work means the sha does not describe what actually ran, so it is
    // recorded as dirty rather than silently treated as a clean pin.
    const dirty = execFileSync("git", ["-C", projectPath, "status", "--porcelain"], { encoding: "utf8", windowsHide: true }).trim().length > 0;
    return { sha, dirty };
  } catch {
    return null;
  }
}

// Which files, if they change, could plausibly change what a check does. Everything
// else - documentation, notes, this file's own decision log - cannot.
//
// Why this exists: pinning a check to a commit made ANY commit invalidate every check,
// including one that only edited a markdown file. That is safe in the sense that it
// errs towards "not verified", but during an active session it left the whole board
// reading stale, and a warning you always see stops being a warning at all.
const DOC_FILE = /\.(md|markdown|txt)$/i;

/**
 * Did anything that is not documentation change between two commits?
 *
 * Returns true when it cannot tell (missing commits, no git, a rewritten history), so
 * the unknown case still counts as "the code may have moved" - a false stale is
 * annoying, a false fresh is the failure this whole mechanism exists to prevent.
 */
export function codeChangedBetween(projectPath, fromSha, toSha) {
  if (!projectPath || !fromSha || !toSha) {
    return true;
  }
  if (fromSha === toSha) {
    return false;
  }
  try {
    const out = execFileSync("git", ["-C", projectPath, "diff", "--name-only", `${fromSha}`, `${toSha}`], {
      encoding: "utf8",
      windowsHide: true,
    });
    const files = out.split(/\r?\n/).map((f) => f.trim()).filter(Boolean);
    if (files.length === 0) {
      // Different shas, no differing files: a commit that changed nothing tracked
      // (an empty or metadata-only commit). Nothing a check could notice.
      return false;
    }
    return files.some((f) => !DOC_FILE.test(f));
  } catch {
    return true;
  }
}

/** Why this command cannot be trusted to fail, or null. */
export function passForcingReason(cmd) {
  const s = String(cmd || "");
  for (const { re, why } of PASS_FORCING_PATTERNS) {
    if (re.test(s)) {
      return why;
    }
  }
  return null;
}

/** Did this run actually come from the app, for the command as declared? */
export function verifyCheckRun(metaHome, taskId, run, declaredCmd = undefined) {
  if (!run || typeof run.sig !== "string") {
    return false;
  }
  // create:false - verifying a signature must never generate the key it is checking against.
  const expected = signCheckRun(metaHome, taskId, run, declaredCmd, { create: false });
  if (!expected || expected.length !== run.sig.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(run.sig));
}

/**
 * Stamp the outcome of one executed check onto a record.
 *
 * The run is bound to the DECLARED check: the label must match one of `rec.checks`,
 * and the signature covers that check's command. A stamp for a label the record
 * doesn't declare is refused outright, so a run cannot be parked under a name the
 * reader never sees.
 */
export function recordCheckRun(metaHome, taskId, run, { now = Date.now(), pinnedHead = null } = {}) {
  const rec = readReviewRecord(metaHome, taskId);
  if (!rec) {
    return { ok: false, error: "No review record for that task." };
  }
  if (!run || !String(run.label || "").trim()) {
    return { ok: false, error: "A check run needs the label it ran for." };
  }
  const declared = (Array.isArray(rec.checks) ? rec.checks : []).find((c) => String(c?.label || "") === String(run.label));
  if (!declared) {
    return { ok: false, error: `This record declares no check labelled "${run.label}" - a run must belong to a declared check.` };
  }
  const runs = Array.isArray(rec.checkRuns) ? rec.checkRuns.filter((r) => r.label !== run.label) : [];
  // pinnedHead lets a caller that ran the check in an ISOLATED worktree (the captain,
  // task 76790f23: "Bind varje review till en commit") stamp the commit it
  // actually verified against, instead of re-querying the live project
  // directory here - which would report `dirty: true` from whatever unrelated
  // work is sitting uncommitted in the main tree at this exact moment,
  // regardless of how cleanly the check itself ran. Falls back to the old
  // live-directory query for a caller that ran the check in place (no worktree
  // available, e.g. projectPath isn't a git repo).
  const head = pinnedHead || currentHead(declared.cwd || rec.projectPath);
  const stamped = {
    label: String(run.label),
    // What was DECLARED, not what the caller says it ran. Storing the caller's
    // version would put a second, unverified "cmd" on screen next to the real one.
    cmd: declared.cmd ? String(declared.cmd) : null,
    exitCode: typeof run.exitCode === "number" ? run.exitCode : null,
    ranAt: now,
    // The commit this ran against. Covered by the signature, so it cannot be edited
    // afterwards to make an old pass look current.
    head: head ? head.sha : null,
    headDirty: head ? head.dirty : null,
  };
  runs.push({
    ...stamped,
    // Kept for readability, but gauntletStatus derives pass/fail from exitCode and
    // ignores this - a boolean is trivially wrong in a hand-written record, and it
    // was trusted for exactly that reason before.
    ok: run.exitCode === 0,
    sig: signCheckRun(metaHome, taskId, stamped, declared.cmd),
    tail: run.tail ? String(run.tail).slice(-1200) : null,
  });
  // isRunStamp: recording an outcome must not move the staleness baseline.
  return writeReviewRecord(metaHome, { ...rec, checkRuns: runs }, { now, isRunStamp: true });
}

/**
 * How the gauntlet stands for a record: has every declared check been run since
 * the record was last written, and did they pass?
 *
 * A run from BEFORE the record's last update is treated as stale, not as a pass -
 * otherwise a green tick from an older version of the work keeps vouching for
 * code that has since changed.
 */
export function gauntletStatus(rec, metaHome = null, { head = undefined, codeChanged = () => true } = {}) {
  const checks = Array.isArray(rec?.checks) ? rec.checks : [];
  if (checks.length === 0) {
    return { declared: 0, passed: 0, failed: 0, stale: 0, unrun: 0, unverified: 0, unusable: 0, state: "none", perCheck: [] };
  }
  const runs = Array.isArray(rec.checkRuns) ? rec.checkRuns : [];
  const updatedAt = typeof rec.contentUpdatedAt === "number" ? rec.contentUpdatedAt : typeof rec.updatedAt === "number" ? rec.updatedAt : 0;
  let passed = 0;
  let failed = 0;
  let stale = 0;
  let unrun = 0;
  let unverified = 0;
  let unusable = 0;
  // Two checks sharing a label collapse to one run (runs are keyed by label), so the
  // second stamp silently overwrote the first: a suite with a failing check and a
  // passing one under the same name read as 2/2 passing. Refuse to score duplicates.
  const seenLabels = new Set();
  // Per-check state is returned, not just tallied, so no OTHER surface has to derive
  // it a second time. The renderer did, with a different rule (`runInfo.ok`), which
  // meant a forged run drew a GREEN dot reading "exit 0" while the header said
  // incomplete - the detail contradicting the summary, in the unsafe direction.
  const perCheck = [];
  for (const c of checks) {
    const label = String(c?.label || "");
    const run = runs.find((r) => r.label === label) || null;
    const forced = passForcingReason(c?.cmd);
    let state;
    // WHY it is stale, not just that it is. Four quite different situations collapsed into
    // one "stale", and the card printed a single explanation for all of them - so a run that
    // went green on an UNCOMMITTED tree was reported as "ran before the last change", which
    // is simply not what happened (the captain, task d6b33767). A reason the reader cannot act on
    // is worse than no reason, because it sends them looking in the wrong place.
    let staleReason = null;
    if (seenLabels.has(label)) {
      // Duplicate labels cannot be scored apart: runs are keyed by label, so the
      // second stamp overwrites the first and a failure disappears.
      state = "unverified";
    } else if (forced) {
      // A command that cannot fail is not a check, so it cannot be a pass - however
      // green it went and however genuinely the app ran it.
      //
      // This was DETECTED and then ignored: passForced was carried on perCheck for the
      // renderer while `state` came purely from the exit code, so `node test.mjs ||
      // exit 0` read "Checks passing (1/1)", landed under "Ready to stamp", counted
      // zero in tally.unconfirmed, raised no badge, and signed off on ONE CLICK. It is
      // the exact attack the pattern list was written for, and it needed no forgery.
      state = "unusable";
    } else if (!c?.cmd || !String(c.cmd).trim()) {
      // No declared command to verify against. verifyCheckRun's fallback would
      // otherwise sign against run.cmd - a field in the file the author writes - so
      // deleting checks[].cmd turned a stale/forged run back into a pass.
      state = "unusable";
    } else if (!run) {
      state = "unrun";
    } else if (typeof run.ranAt !== "number" || typeof run.exitCode !== "number" || !verifyCheckRun(metaHome, rec.taskId, run, c?.cmd)) {
      // Provenance BEFORE outcome. A run the app did not stamp is not a result at
      // all - pass or fail - so it can neither vouch for the work nor condemn it.
      // Verified against the DECLARED command, so a run signed for a different
      // command cannot score the check the reader is looking at.
      state = "unverified";
    } else if (run.ranAt < updatedAt) {
      state = "stale";
      staleReason = "ran before the record was last changed";
    } else if (run.headDirty === true) {
      // The pass was earned on an uncommitted tree, so the recorded sha does not
      // describe what actually ran and nothing can tell whether the code has moved
      // since. This was recorded and then never read: "fix it, don't commit, re-run
      // nothing" kept an old green.
      state = "stale";
      staleReason = "ran on uncommitted changes";
    } else if (head !== undefined && head !== null && run.head && run.head !== head && codeChanged(run.head, head)) {
      // Ran against a different commit. The code moved after the pass, which is the
      // ordinary second-lap case: sent back, fixed, returned to review, old green
      // still on the card.
      state = "stale";
      staleReason = "the code changed after it ran";
    } else if (head !== undefined && head !== null && !run.head) {
      // The current commit is known but the run recorded none, so it cannot be
      // compared. A record could otherwise DECLINE pinning (put cwd on the check and
      // omit projectPath) and thereby never go stale - the same hole the pin closes,
      // reached from the other side.
      state = "stale";
      staleReason = "no commit was recorded for the run";
    } else if (run.exitCode === 0) {
      // Derived from the exit code, never from run.ok - a boolean in a file the
      // author writes is worth nothing, and it was trusted for exactly that reason.
      state = "passed";
    } else {
      state = "failed";
    }
    seenLabels.add(label);
    perCheck.push({
      label,
      cmd: c?.cmd || null,
      // A command that cannot fail is not a check, however green it goes.
      passForced: forced,
      state,
      staleReason,
      exitCode: run && typeof run.exitCode === "number" ? run.exitCode : null,
      ranAt: run && typeof run.ranAt === "number" ? run.ranAt : null,
      tail: run?.tail || null,
    });
    if (state === "unverified") {
      unverified += 1;
    } else if (state === "unusable") {
      unusable += 1;
    } else if (state === "unrun") {
      unrun += 1;
    } else if (state === "stale") {
      stale += 1;
    } else if (state === "passed") {
      passed += 1;
    } else {
      failed += 1;
    }
  }
  // "passing" requires every declared check to be a verified, fresh, zero-exit run of a
  // command that could actually have failed. Anything else is not a pass, and each
  // reason is counted separately so none can hide inside another.
  const state = failed > 0 ? "failing" : unrun + stale + unverified + unusable > 0 ? "incomplete" : "passing";
  return { declared: checks.length, passed, failed, stale, unrun, unverified, unusable, state, perCheck };
}

/**
 * Which band a queue row belongs in - the ONE definition, used both to sort the queue
 * and to group the page. It was previously three-way here and five-way in the
 * renderer, and the mismatch fragmented the page's headings while throwing away this
 * side's ordering.
 *
 * Ordered by how much attention the row needs, not by how it was produced:
 *
 *   judgment    - needs a decision only he can make.
 *   incomplete  - a record EXISTS, so something claims to be reviewed, but the claim
 *                 is inadmissible. Above stamps deliberately: it is the more alarming
 *                 case even though fixing it is the author's job, not his.
 *   unconfirmed - the record says done, but its own declared checks have not passed.
 *   stamp       - the evidence holds up; read it and move on.
 *   unrecorded  - in review with nothing written down at all.
 */
export const BAND_ORDER = { judgment: 0, incomplete: 1, unconfirmed: 2, stamp: 3, unrecorded: 4 };

export function reviewBand(row) {
  // Only DECLARED checks count: a cosmetic item legitimately declares none, and
  // demanding a green gauntlet from it would make the gradient meaningless the other
  // way round.
  if (row?.verdict === "stamp" && (row.gauntlet?.declared || 0) > 0 && row.gauntlet.state !== "passing") {
    return "unconfirmed";
  }
  return row?.verdict || "unrecorded";
}

/**
 * What the TASK failed to state, phrased for the review card. Uses the same rules as
 * the take-time nudge, which otherwise had no production surface at all - it was
 * exported, tested, and called from nowhere.
 */
function taskAcceptanceCaveats(description) {
  const problems = acceptanceProblems(description || "");
  const caveats = problems.map((p) =>
    /no acceptance criteria/.test(p)
      ? "The task itself never stated acceptance criteria, so there was no agreed definition of done to check against."
      : `The task's own acceptance criteria are weak: ${p}`
  );
  // A blank `INTENT:` on the task is worse than none at all: it looks like the ask was
  // recorded, so nobody goes looking for it. Distinguished from silence for the same
  // reason acceptance.js distinguishes an empty `AC:` - someone gesturing at the idea
  // without stating it is the failure being prevented, not evidence against it.
  if (hasEmptyIntentLine(description || "")) {
    caveats.push('The task has an "INTENT:" line that states nothing, so it looks like the ask was written down when it was not.');
  }
  // A wrapped intent loses its second half silently, which is worse than an empty one:
  // the ask reads as complete and is not.
  if (hasOrphanedIntentContinuation(description || "")) {
    caveats.push(
      'The task\'s "INTENT:" line looks like it continues onto the next line without the prefix, so only the first half of the ask was read.'
    );
  }
  return caveats;
}

/** Duplicate check labels are unscoreable, so they are a record-level defect. */
function duplicateCheckLabels(rec) {
  const seen = new Set();
  const dupes = new Set();
  for (const c of Array.isArray(rec?.checks) ? rec.checks : []) {
    const label = String(c?.label || "").trim();
    if (seen.has(label)) {
      dupes.add(label);
    }
    seen.add(label);
  }
  return [...dupes];
}

export function readReviewRecord(metaHome, taskId) {
  const file = reviewRecordPath(metaHome, taskId);
  if (!file || !fs.existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function listReviewRecords(metaHome) {
  const dir = reviewsDir(metaHome);
  if (!fs.existsSync(dir)) {
    return [];
  }
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Build the review record an autopilot run leaves behind when it moves a task to
 * review, so the card is not a blank "no record" dead end (the captain, 2026-08-12). It is
 * deliberately a `judgment`, never a stamp: autonomous output is the machine's own
 * claim, not a verified result, so it still needs the human's decision - but now the
 * card shows what happened and can offer the diff / a reviewer. The check is the run's
 * own verify gate when it had one, else a commits-present check (honest about the
 * absence); `notVerified` states plainly that nothing here is verified. Kept pure and
 * exported so its VALIDITY (it must pass reviewRecordProblems, or writeReviewRecord
 * refuses it and the card stays blank) is directly testable.
 */
export function buildAutoReviewRecord({ taskId, projectPath, outcome, where, branch, worktreePath, commits, lastSummary = null, verifyCommand = null, stoppedReason = null, goal = null, title = null }) {
  const runCwd = worktreePath || projectPath;
  return {
    taskId,
    // The ask, for free and for real. An autopilot's goal is written BEFORE the run and
    // is the literal instruction it worked from - so unlike a hand-written intent, this
    // one cannot be a rationalisation of what the work turned out to be. Trimmed to the
    // card's limit rather than dropped: a goal too long to show is still the ask.
    //
    // The card title is the fallback, NOT a refusal. This record is `core`, and a core
    // record with no intent is refused - which here would mean no record at all, and a
    // blank card is the exact dead end this whole function exists to prevent. So a run
    // whose goal did not survive falls back to the board's own words for the task, marked
    // `assistant` because a title is a weaker statement of the ask than a goal and must
    // not be presented as an equal one. Nothing is ever invented: with neither, the
    // record carries no intent and is refused, which is then a wiring bug worth failing on.
    intent: goal
      ? { text: clampIntentText(goal), source: "goal" }
      : title
        ? { text: clampIntentText(title), source: "assistant" }
        : null,
    summary: `Autopilot run - ${outcome}. ${lastSummary ? `${lastSummary} ` : ""}The work is ${where}.`,
    verdict: "judgment",
    ask: "An autopilot produced this autonomously and did NOT verify it end to end. Review the worktree/branch, then decide: merge, send back, or discard.",
    criticality: "core",
    projectPath,
    testSteps: [
      { step: `Check out branch ${branch || "(the run's branch)"} (worktree: ${worktreePath || projectPath}).`, expect: "The autopilot's commits are present." },
      { step: "Verify the task's own acceptance by hand, or run the project's tests.", expect: "The task's stated outcome actually holds." },
    ],
    checks: [
      verifyCommand
        ? { label: "the run's own verify gate", cmd: verifyCommand, cwd: runCwd }
        : { label: "commits present on the branch (no verify gate was configured)", cmd: `git log --oneline -${commits}`, cwd: runCwd },
    ],
    evidence: [`${outcome}. ${where}.`, `Stopped because: ${stoppedReason || "unknown"}.`],
    notVerified: [
      // Claim short, the honest long half behind "explain" - the same shape every
      // hand-written record is now held to, applied to the one the app writes itself.
      // It was 129 characters on one line and would have been refused by its own gate.
      {
        claim: "An autopilot wrote this on its own. Nobody has checked it.",
        detail:
          "The summary above is the machine's own account of what it did, not a verified result. It was not run end to end, and no test confirmed the outcome it claims.",
      },
      "The work lives in an isolated worktree/branch and is NOT merged.",
      "No human or independent reviewer has looked at it yet - use 'Independent reviewer' on the card for that.",
    ],
  };
}

/**
 * True when `next` differs from `existing` in NOTHING but its check runs.
 *
 * This is what makes the gate bypass for a check stamp safe to grant: it is decided
 * from the two records, not from the caller's promise about which kind of write this
 * is. A caller that also edits the summary, the verdict, the evidence or the intent
 * is writing content, whatever flag it passes, and goes through every gate.
 *
 * Timestamps are excluded because a write always moves them, and `title` is compared
 * like any other field - anything not listed here is content.
 */
function onlyCheckRunsChanged(existing, next) {
  const strip = (r) => {
    const { checkRuns, createdAt, updatedAt, contentUpdatedAt, ...rest } = r || {};
    // Stable key order, so a record whose fields were rebuilt in a different order by
    // an object spread does not read as edited.
    return JSON.stringify(rest, Object.keys(rest).sort());
  };
  return strip(existing) === strip(next);
}

/**
 * Write (replace) the record for a task. Refuses an incomplete record rather
 * than storing something that renders as a hollow card - the failure this whole
 * feature exists to prevent is a review item that looks reviewed and is not.
 * Atomic temp+rename.
 */
export function writeReviewRecord(metaHome, rec, { now = Date.now(), isRunStamp = false } = {}) {
  const file = reviewRecordPath(metaHome, rec.taskId);
  const existing = readReviewRecord(metaHome, rec.taskId);

  // EVIDENCE IS NEVER REFUSED FOR BEING UGLY.
  //
  // The gates below judge what an AUTHOR wrote. A check stamp is the opposite thing:
  // the app itself recording that a command really ran and what it exited with - the
  // one piece of a record that is not the author's word, and the whole reason the
  // gauntlet is worth anything.
  //
  // Measured 2026-08-21, the day after the readability limits landed: 89 of 96 existing
  // records failed them, 93 declared a check, and recordCheckRun re-writes the WHOLE
  // record through this function. So "Run checks" ran the command and then silently
  // dropped the result on 89 records - a check that really passed reading as never run,
  // which is the exact failure this file's own comments call out twice. Proven by
  // stamping a passing check on a copy of a real record: refused, checkRuns empty after.
  //
  // So a pure evidence stamp skips both gates. The permission is not the caller's flag
  // alone - a flag is a convention, and this one would silently become a way to write
  // any content past the gates. It is granted only when the content really is unchanged
  // from what is already on disk, so the bypass can carry evidence and nothing else.
  const stampOnly = isRunStamp && existing !== null && onlyCheckRunsChanged(existing, rec);
  if (!stampOnly) {
    const problems = reviewRecordProblems(rec);
    if (problems.length > 0) {
      return { ok: false, error: `Incomplete review record: ${problems.join("; ")}`, problems };
    }
    // Readability is enforced at the WRITE, not at the render - the limits would otherwise
    // mark ninety existing records incomplete at once, and noise is what they exist to
    // fix. Refusing here is the point: left as a convention, this was followed for exactly
    // one record before the habit came back.
    const unreadable = reviewRecordReadability(rec);
    if (unreadable.length > 0) {
      return { ok: false, error: `Review record is too long to be read: ${unreadable.join("; ")}`, problems: unreadable };
    }
    // The ask behind the work, required before it can be handed over. Enforced here for
    // the same reason as readability: it must not mark ninety existing records invalid.
    const intentGaps = reviewRecordIntentProblems(rec);
    if (intentGaps.length > 0) {
      return { ok: false, error: `Review record does not say what was asked for: ${intentGaps.join("; ")}`, problems: intentGaps };
    }
  }
  const body = {
    ...rec,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    // Staleness is measured against when the CLAIM last changed, not against the
    // last write - because stamping a check run is itself a write. With one
    // baseline for both, running N checks made the first N-1 read as stale (each
    // later stamp moved the baseline past the earlier runs), so a multi-check
    // gauntlet could never reach "passing" however green the checks were.
    //
    // Only recordCheckRun passes isRunStamp, and it is an explicit ARGUMENT rather
    // than a field on the record: if preserving it were data-driven, an ordinary
    // edit that spread the previous record would silently carry the old baseline
    // forward too, and a green tick would keep vouching for changed work - the
    // exact failure the staleness rule exists to prevent.
    contentUpdatedAt: isRunStamp && typeof existing?.contentUpdatedAt === "number" ? existing.contentUpdatedAt : now,
  };
  try {
    // Shared atomic write with the Dropbox-lock retry (task efcaf486). This one matters
    // most of the seven: a record IS the evidence, and a stamp lost to a sync lock is a
    // check that really ran and then reads as "never run" - the mechanism whose whole
    // purpose is to be trustworthy, quietly losing its own proof.
    const res = writeJsonAtomicSync(file, body);
    if (!res.ok) {
      return { ok: false, error: res.error };
    }
    return { ok: true, path: file, record: body };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function removeReviewRecord(metaHome, taskId) {
  const file = reviewRecordPath(metaHome, taskId);
  if (!file || !fs.existsSync(file)) {
    return false;
  }
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Join the board's review items with their records - the shape the review page
 * renders. Jot decides WHAT is under review; a record only adds evidence.
 *
 * Ordering is the point of the page: judgment items first (they are the only ones
 * that actually need him), then stamps, then anything with no record at all -
 * which is surfaced rather than hidden, because a task in review with no record
 * is a gap in MY process, and hiding it would let it pass as reviewed.
 */
export function buildReviewQueue(reviewTasks, records, metaHome = null) {
  // One git call per distinct project, not per row.
  const headCache = new Map();
  const headFor = (projectPath) => {
    if (!projectPath) {
      return null;
    }
    if (!headCache.has(projectPath)) {
      const h = currentHead(projectPath);
      headCache.set(projectPath, h ? h.sha : null);
    }
    return headCache.get(projectPath);
  };
  const codeChangedCache = new Map();
  const codeChangedFor = (projectPath, from, to) => {
    const key = `${projectPath}|${from}|${to}`;
    if (!codeChangedCache.has(key)) {
      codeChangedCache.set(key, codeChangedBetween(projectPath, from, to));
    }
    return codeChangedCache.get(key);
  };
  // Resolve a (possibly short) commit-ish to its full 40-char sha, so a record's
  // stored short sha ("f261da8") can be compared against a check run's full head.
  // Cached, and null when it can't be resolved (commit gone after a rebase, etc).
  const resolveShaCache = new Map();
  const resolveShaFor = (projectPath, shaish) => {
    if (!projectPath || !shaish) {
      return null;
    }
    const key = `${projectPath}|${shaish}`;
    if (!resolveShaCache.has(key)) {
      let full = null;
      try {
        const out = execFileSync("git", ["-C", projectPath, "rev-parse", `${shaish}^{commit}`], {
          encoding: "utf8",
          windowsHide: true,
          // Swallow git's stderr: an unreachable pinned commit (rebased/squashed
          // away - the exact fallback case) otherwise prints "fatal: ambiguous
          // argument" to the main process on every queue build (review, 2026-08-09).
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        full = /^[0-9a-f]{40}$/.test(out) ? out : null;
      } catch {
        full = null;
      }
      resolveShaCache.set(key, full);
    }
    return resolveShaCache.get(key);
  };
  // The commit a record is pinned to - the LAST entry of rec.commits, matching
  // what reviews:runChecks checks the isolated worktree out at. This, not the live
  // project HEAD, is the staleness baseline: a check runs against the record's own
  // commit, so measuring "did the code change after it ran" against live HEAD marked
  // every freshly-run check stale the moment any later commit landed - which is
  // exactly what happens during an active session (task 5143316e: "det står stale -
  // the code changed after it ran när jag försöker köra e2e tester").
  const boundShaFull = (rec) => {
    const boundSha = (rec.commits || []).map((c) => (typeof c === "string" ? c : c?.sha)).filter(Boolean).at(-1);
    return boundSha ? resolveShaFor(rec.projectPath, boundSha) : null;
  };
  const byId = new Map((records || []).map((r) => [String(r.taskId).toLowerCase(), r]));
  const rows = (reviewTasks || []).map((t) => {
    const rec = byId.get(String(t.id).toLowerCase()) || null;
    const problems = rec ? reviewRecordProblems(rec) : ["no review record was written for this task"];
    // "incomplete" and "unrecorded" are deliberately DIFFERENT verdicts. Both used
    // to read as "unrecorded", which hid the more alarming case: a record exists,
    // so somebody claimed this was reviewed, but the claim is inadmissible (e.g. a
    // critical item with nothing independent behind it). Nobody-wrote-one and
    // somebody-wrote-a-bad-one need different reactions.
    const verdict = problems.length === 0 ? rec.verdict : rec ? "incomplete" : "unrecorded";
    return {
      taskId: t.id,
      title: t.title || t.text || "(untitled)",
      // The task's own prose, carried through so a brief can be written in the language
      // the captain actually wrote the task in (task 7bd1e2df). Title alone is often too short
      // a sample to tell Swedish from English.
      description: t.description || null,
      category: t.category || null,
      priority: typeof t.priority === "number" ? t.priority : null,
      // Subtasks are in the queue now, so a row needs to say what it belongs to.
      parentTitle: t.parentTitle || null,
      // Carried through so the page can group an epic's subtasks under it and offer a
      // project filter. Both are ids, not names: two epics can share a title and two
      // boards can share a category name.
      parentId: t.parentId || null,
      categoryId: t.categoryId || null,
      // Work/private classification from the owning Jot category, for the Review
      // page's domain filter (task 0ca1f3d3). null = unclassified (shown in all modes).
      domain: t.domain === "work" || t.domain === "private" ? t.domain : null,
      // Jot's explicit per-board folder binding (Category.repoPath), threaded so the
      // review payload can prefer it over the fuzzy category-name-to-cwd guess that only
      // resolved for helm (task 75a01d5d). null when the board declares no binding.
      categoryRepoPath: t.categoryRepoPath || null,
      record: rec,
      incomplete: problems.length > 0,
      problems,
      verdict,
      criticality: rec?.criticality || null,
      whyNotCritical: rec?.whyNotCritical || null,
      // True statements about the record whose signature is an ABSENCE, so the page
      // can show them instead of rendering nothing at all.
      // Record-side absences, plus what the TASK itself failed to state. The two are
      // different: the record can carry criteria the task never had (that is drift),
      // and the task can state vague ones nobody could fail (that is this).
      caveats: [...(rec ? recordCaveats(rec) : []), ...taskAcceptanceCaveats(t.description)],
      // Did the task's acceptance criteria move after the record snapshotted them?
      drift: rec ? acceptanceDrift(rec, t.description || "") : { drifted: false, snapshot: [], live: [] },
      // WHAT WAS ASKED FOR - the row's own copy, so the card can show it above what was
      // done without reaching back into the record's shape. Falls back to the task's live
      // `INTENT:` line when the record carries none, which is the common case for anything
      // written before this existed: the ask is then at least on screen, marked as coming
      // from the task rather than from a snapshot taken at handoff.
      intent: (() => {
        const snap = normalizeIntent(rec?.intent);
        if (snap) {
          return snap;
        }
        const live = parseIntent(t.description || "");
        return live ? { text: live, source: "assistant", fromTask: true } : null;
      })(),
      // Did the ask itself move after the record snapshotted it? Usually this means the captain
      // corrected it, which is the most useful thing the page can tell him.
      intentDrift: rec ? intentDrift(rec, t.description || "") : { drifted: false, snapshot: "", live: "" },
      gauntlet: rec
        ? gauntletStatus(rec, metaHome, {
            // Staleness baseline is the record's OWN pinned commit (what the checks
            // ran against), not the live project HEAD - or every run reads stale as
            // soon as any later, unrelated commit lands (task 5143316e). Falls back
            // to live HEAD only when the record pins no resolvable commit, matching
            // reviews:runChecks' own fallback.
            head: boundShaFull(rec) || headFor((rec.checks || [])[0]?.cwd || rec.projectPath),
            // A commit that only touched documentation cannot have changed what a
            // check does, so it must not stale one. Cached per commit pair: without
            // it this would be a git call per check per render.
            codeChanged: (from, to) => codeChangedFor((rec.checks || [])[0]?.cwd || rec.projectPath, from, to),
          })
        : { declared: 0, state: "none" },
    };
  });
  // Sorted by BAND, using the same function the page groups by - see reviewBand.
  // Previously the queue sorted by its own three-way band while the renderer grouped
  // by a hardcoded five-way list, so the two disagreed: the same heading could be
  // emitted twice with other rows in between, and the "critical items first"
  // promotion was silently discarded by the page.
  //
  // Within a band: criticality, then board priority.
  const critRank = { critical: 0, core: 1, cosmetic: 2 };
  // Stamped on the row so the page groups by exactly what the queue sorted by.
  for (const row of rows) {
    row.band = reviewBand(row);
  }
  return rows.sort((a, b) => {
    const d = BAND_ORDER[a.band] - BAND_ORDER[b.band];
    if (d !== 0) {
      return d;
    }
    const c = (critRank[a.criticality] ?? 3) - (critRank[b.criticality] ?? 3);
    return c !== 0 ? c : (a.priority ?? 99) - (b.priority ?? 99);
  });
}

/** Counts for the page header, so the shape of the queue reads at a glance. */
export function reviewQueueTally(rows) {
  // A stamp whose DECLARED checks have not passed is counted apart from a real stamp.
  // Otherwise the header says "N ready to stamp" while the section below it says
  // "Claimed, not confirmed" about the same item - and the header is the line that
  // gets skimmed. Items declaring no checks (legitimately, at cosmetic tier) are
  // still stamps.
  // Uses reviewBand, so the header cannot disagree with the sections below it.
  const inBand = (name) => (r) => reviewBand(r) === name;
  return {
    total: rows.length,
    judgment: rows.filter((r) => r.verdict === "judgment").length,
    stamp: rows.filter(inBand("stamp")).length,
    unconfirmed: rows.filter(inBand("unconfirmed")).length,
    unrecorded: rows.filter((r) => r.verdict === "unrecorded").length,
    // A record that exists but is inadmissible - counted apart from "nobody wrote
    // one", because it needs a different reaction.
    incomplete: rows.filter((r) => r.verdict === "incomplete").length,
    critical: rows.filter((r) => r.criticality === "critical").length,
  };
}
