/**
 * Can this review page be judged at all, and does it say so?
 *
 * The board on 2026-08-31 had 33 tasks in review and ZERO records. Every row was a
 * task nobody could assess, and nothing on the page said that: "no record" was one
 * bucket among six, printed last, after three optional clauses. So the page reported
 * on the sliver it could assess and stayed quiet about the rest.
 *
 * Two things are pinned here. That the coverage figure is computed, and that the
 * headline changes when coverage is poor - because a number nobody reads is the same
 * as no number.
 *
 * The renderer keeps its own copy of the tally (it is a classic script and cannot
 * import this module), so the copies are checked against each other rather than
 * trusted to stay in step.
 */
import fs from "node:fs";
import { reviewQueueTally } from "../../src/lib/reviewRecords.js";

let failures = 0;
const ok = (cond, label, detail = "") => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!cond) {
    failures += 1;
  }
};

const row = (verdict, extra = {}) => ({ verdict, criticality: "cosmetic", ...extra });

// --- the figure itself -----------------------------------------------------------
{
  const empty = reviewQueueTally([]);
  ok(empty.withEvidence === 0 && empty.total === 0, "an empty queue reports 0 of 0", JSON.stringify({ w: empty.withEvidence, t: empty.total }));

  const allBlank = reviewQueueTally([row("unrecorded"), row("unrecorded"), row("unrecorded")]);
  ok(allBlank.withEvidence === 0, "a queue where nothing has a record reports zero coverage", `withEvidence=${allBlank.withEvidence}`);
  ok(allBlank.total === 3, "and still counts the rows", `total=${allBlank.total}`);

  const mixed = reviewQueueTally([row("unrecorded"), row("stamp"), row("judgment"), row("incomplete")]);
  ok(mixed.withEvidence === 3, "a record of ANY kind counts as evidence, including an inadmissible one", `withEvidence=${mixed.withEvidence}`);
  ok(mixed.unrecorded === 1, "and the blank row is still counted as blank", `unrecorded=${mixed.unrecorded}`);
}

// --- the renderer's copy has to agree ---------------------------------------------
// Both derive the same number two different ways: the library filters on the verdict,
// the renderer subtracts its own band count. Feeding both the same rows is the only
// thing that keeps a copy from drifting.
{
  const src = fs.readFileSync(new URL("../../src/renderer/renderer.js", import.meta.url), "utf8");
  ok(
    /tally\.withEvidence\s*=\s*tally\.total\s*-\s*tally\.unrecorded/.test(src),
    "the renderer computes coverage from its own tally"
  );

  const rows = [row("unrecorded"), row("unrecorded"), row("stamp")];
  const lib = reviewQueueTally(rows);
  // The renderer's arithmetic, applied by hand to the same rows.
  const rendered = rows.length - rows.filter((r) => r.verdict === "unrecorded").length;
  ok(lib.withEvidence === rendered, "the two copies agree on the same rows", `lib=${lib.withEvidence} renderer=${rendered}`);
}

// --- and the headline has to change ------------------------------------------------
{
  const src = fs.readFileSync(new URL("../../src/renderer/renderer.js", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("function reviewHeaderLine("));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);

  ok(body.includes("Nothing here can be reviewed"), "a page with no records says so outright");
  ok(/can be reviewed - the rest have no record/.test(body), "a mostly-blank page leads with how little can be judged");
  ok(
    /const bad = tally\.withEvidence === 0 \|\| tally\.withEvidence \* 2 < tally\.total/.test(body),
    "poor coverage is defined, not decided per render"
  );

  // The old behaviour, pinned as gone: the "no record" clause used to come last,
  // after three optional ones, where it read as a footnote.
  const headerRegion = src.slice(src.indexOf('h2.textContent = "Review"'), src.indexOf('h2.textContent = "Review"') + 900);
  ok(
    !/tally\.unrecorded > 0 \? ` · \$\{tally\.unrecorded\} with no record`/.test(headerRegion),
    "the old always-last 'with no record' clause is gone from the header"
  );
}

// --- the band says what the row is, not only what is missing ----------------------
{
  const src = fs.readFileSync(new URL("../../src/renderer/renderer.js", import.meta.url), "utf8");
  ok(/label: "Nothing to review"/.test(src), "a recordless row is headed 'Nothing to review'");
  ok(
    /approving it would say 'reviewed' about work nobody looked at/.test(src),
    "and the hint names the consequence of approving it anyway"
  );
}

console.log("");
if (failures > 0) {
  console.log(`VERIFY FAILED: ${failures} assertion(s)`);
  process.exit(1);
}
console.log("VERIFY OK: the page says how much of it can be judged, and leads with that when little can.");
