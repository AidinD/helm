// Acceptance criteria captured BEFORE the work (Flow task bd5d7b4b).
//
// The gap this closes, in one example: a "Jump in" button shipped that did nothing
// visible, and the test that was supposed to cover it COUNTED the buttons. The test
// was green because it asserted that the code did what its author wrote - not that
// the user lands in the session. A single line written in advance ("I click Jump in
// and end up in that project's session") would have forced the click.
//
// So: test steps written at handoff time describe the implementation. The same
// sentence written when the task is TAKEN constrains it. Same words, opposite
// direction, and only one of them catches a wrong-intent bug.
//
// WHERE THEY LIVE: as `AC:` lines in the Jot task's own description. Deliberately
// not a new field on todos.json and not a separate file:
//   - Jot is a shipped public app; Helm must not bolt private schema onto its data.
//   - Aidin has to be able to CORRECT a criterion before the work starts, which
//     means it has to be visible where he already looks at the task.
//   - One home, so criteria and task can't drift apart (blast radius).
// The `AC:` prefix is parsed strictly, the way a git trailer is - not prose.

const AC_LINE = /^\s*AC\s*:\s*(.+?)\s*$/i;

/**
 * Pull the acceptance criteria out of a Jot task description.
 *
 * @param {string} description
 * @returns {{index: number, text: string}[]} in written order, duplicates collapsed
 */
export function parseAcceptanceCriteria(description) {
  if (!description || typeof description !== "string") {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const line of description.split(/\r?\n/)) {
    const m = line.match(AC_LINE);
    if (!m) {
      continue;
    }
    const text = m[1].trim();
    // An empty "AC:" is someone gesturing at the idea without stating it - which is
    // exactly the thing this is meant to prevent, so it does not count as a
    // criterion. It is reported by acceptanceProblems instead.
    if (!text || seen.has(text.toLowerCase())) {
      continue;
    }
    seen.add(text.toLowerCase());
    out.push({ index: out.length + 1, text });
  }
  return out;
}

/** True if the description contains an AC line that states nothing. */
export function hasEmptyAcceptanceLine(description) {
  if (!description || typeof description !== "string") {
    return false;
  }
  return description.split(/\r?\n/).some((l) => /^\s*AC\s*:\s*$/i.test(l));
}

/** Render criteria back into the `AC:` lines to append to a task description. */
export function formatAcceptanceCriteria(criteria) {
  return (criteria || [])
    .map((c) => `AC: ${typeof c === "string" ? c : c.text}`)
    .filter((l) => l !== "AC: ")
    .join("\n");
}

/**
 * Which criteria a set of test steps actually covers.
 *
 * Coverage is by EXPLICIT LINK (`step.ac` naming the criterion), never by counting.
 * Counting is gameable - five vague steps would "cover" five criteria while
 * checking none of them - and the whole point is that the check is not the author's
 * word for it.
 *
 * A step may cover more than one criterion (`ac` as an array), and a criterion may
 * be covered by more than one step.
 *
 * @param {{index: number, text: string}[]} criteria
 * @param {{step?: string, expect?: string, ac?: string|number|(string|number)[]}[]} testSteps
 */
export function acceptanceCoverage(criteria, testSteps) {
  const list = Array.isArray(criteria) ? criteria : [];
  const steps = Array.isArray(testSteps) ? testSteps : [];
  const claimed = new Set();
  for (const s of steps) {
    for (const ref of normalizeRefs(s?.ac)) {
      claimed.add(ref);
    }
  }
  const covered = [];
  const uncovered = [];
  for (const c of list) {
    const byIndex = claimed.has(String(c.index));
    const byText = claimed.has(c.text.toLowerCase());
    (byIndex || byText ? covered : uncovered).push(c);
  }
  // A step pointing at a criterion that does not exist is a real error, not noise:
  // it means the record thinks it is covering something the task never asked for.
  const known = new Set(list.flatMap((c) => [String(c.index), c.text.toLowerCase()]));
  const dangling = [...claimed].filter((r) => !known.has(r));
  return { covered, uncovered, dangling };
}

function normalizeRefs(ac) {
  if (ac === undefined || ac === null) {
    return [];
  }
  const arr = Array.isArray(ac) ? ac : [ac];
  return arr
    .map((v) => (typeof v === "number" ? String(v) : String(v || "").trim().toLowerCase()))
    .filter(Boolean);
}

/**
 * What is wrong with a task's acceptance criteria, as human-readable problems.
 * Used to nudge at take-time, NOT to refuse - a task can legitimately be picked up
 * before its criteria are agreed. The refusal belongs at the review boundary
 * (reviewRecordProblems), where the claim is being made.
 */
export function acceptanceProblems(description) {
  const problems = [];
  const criteria = parseAcceptanceCriteria(description);
  if (criteria.length === 0) {
    problems.push("no acceptance criteria - add at least one `AC: <observable outcome>` line before starting");
  }
  if (hasEmptyAcceptanceLine(description)) {
    problems.push("an `AC:` line states nothing - a gesture at a criterion is not a criterion");
  }
  for (const c of criteria) {
    // The failure mode being designed against: "works correctly", "is robust",
    // "looks good" - unfalsifiable, so it can never fail, so it constrains nothing.
    if (c.text.split(/\s+/).length < 3) {
      problems.push(`AC ${c.index} is too short to be observable: "${c.text}"`);
    }
  }
  return problems;
}
