import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseAcceptanceCriteria, acceptanceCoverage, acceptanceProblems } from "./acceptance.js";
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
 * What is wrong with a record, as a list of human-readable problems. Empty means
 * complete. Used both to refuse a bad write and to mark a rendered record as
 * incomplete rather than silently showing a hollow card.
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
    const noticed = /\bred\b|fail|caught|notice/.test(t);
    return brokeIt && noticed;
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
  if (!Array.isArray(rec.acceptanceCriteria)) {
    // Distinct from an empty array, which is an explicit claim that the task had none.
    caveats.push("No acceptance criteria were agreed before the work, so nothing here is checked against a stated intent.");
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
  if (/\.mjs\b|\.js\b|\.ts\b/.test(c)) {
    return false; // names a specific file
  }
  return /\bnpm (run )?test\b|\brun-tests(\.mjs)?\b|\bnpm run test:fast\b|\byarn test\b|\bpnpm test\b/.test(c);
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

function runKey(metaHome) {
  if (!metaHome) {
    return null;
  }
  const file = path.join(metaHome, RUN_KEY_FILE);
  try {
    if (fs.existsSync(file)) {
      const key = fs.readFileSync(file, "utf8").trim();
      return key.length >= 32 ? key : null;
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
export function signCheckRun(metaHome, taskId, run, declaredCmd = undefined) {
  const key = runKey(metaHome);
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
  const expected = signCheckRun(metaHome, taskId, run, declaredCmd);
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
export function recordCheckRun(metaHome, taskId, run, { now = Date.now() } = {}) {
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
  // Same resolution order the runner uses (check.cwd || rec.projectPath), so a record
  // cannot dodge pinning by putting cwd on the check.
  const head = currentHead(declared.cwd || rec.projectPath);
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
    } else if (run.headDirty === true) {
      // The pass was earned on an uncommitted tree, so the recorded sha does not
      // describe what actually ran and nothing can tell whether the code has moved
      // since. This was recorded and then never read: "fix it, don't commit, re-run
      // nothing" kept an old green.
      state = "stale";
    } else if (head !== undefined && head !== null && run.head && run.head !== head && codeChanged(run.head, head)) {
      // Ran against a different commit. The code moved after the pass, which is the
      // ordinary second-lap case: sent back, fixed, returned to review, old green
      // still on the card.
      state = "stale";
    } else if (head !== undefined && head !== null && !run.head) {
      // The current commit is known but the run recorded none, so it cannot be
      // compared. A record could otherwise DECLINE pinning (put cwd on the check and
      // omit projectPath) and thereby never go stale - the same hole the pin closes,
      // reached from the other side.
      state = "stale";
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
  return problems.map((p) =>
    /no acceptance criteria/.test(p)
      ? "The task itself never stated acceptance criteria, so there was no agreed definition of done to check against."
      : `The task's own acceptance criteria are weak: ${p}`
  );
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
 * Write (replace) the record for a task. Refuses an incomplete record rather
 * than storing something that renders as a hollow card - the failure this whole
 * feature exists to prevent is a review item that looks reviewed and is not.
 * Atomic temp+rename.
 */
export function writeReviewRecord(metaHome, rec, { now = Date.now(), isRunStamp = false } = {}) {
  const problems = reviewRecordProblems(rec);
  if (problems.length > 0) {
    return { ok: false, error: `Incomplete review record: ${problems.join("; ")}`, problems };
  }
  const file = reviewRecordPath(metaHome, rec.taskId);
  const existing = readReviewRecord(metaHome, rec.taskId);
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
      category: t.category || null,
      priority: typeof t.priority === "number" ? t.priority : null,
      // Subtasks are in the queue now, so a row needs to say what it belongs to.
      parentTitle: t.parentTitle || null,
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
      gauntlet: rec
        ? gauntletStatus(rec, metaHome, {
            head: headFor((rec.checks || [])[0]?.cwd || rec.projectPath),
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
