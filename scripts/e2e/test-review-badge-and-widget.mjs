// The review count exists BEFORE you open the review page, and there is a widget for it.
//
// Two tasks, one root: the badge was written by the last statement of renderReviewPage,
// so the number only appeared after you had already followed the nudge it was supposed
// to give you (task 3a124c13 - "siffran över review syns inte förrän man öppnar
// review"). An attention signal that requires you to look first is not one.
//
// And task 06c79d8a: a Review widget with the count and one click to the page.
//
// Run:  node scripts/e2e/test-review-badge-and-widget.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};
const here = path.dirname(fileURLToPath(import.meta.url));
const rSrc = fs.readFileSync(path.join(here, "..", "..", "src", "renderer", "renderer.js"), "utf8");
const css = fs.readFileSync(path.join(here, "..", "..", "src", "renderer", "style.css"), "utf8");
const grab = (name) => {
  const at = rSrc.indexOf(`function ${name}(`);
  if (at < 0) {
    throw new Error(`renderer.js no longer defines ${name}`);
  }
  return rSrc.slice(at, rSrc.indexOf("\n}", at) + 2);
};

// --- the count itself, over the real function -------------------------------
const count = new Function(`${grab("reviewAttentionCount")}\nreturn reviewAttentionCount;`)();
ok(count({ judgment: 2, stamp: 5 }) === 2, "ready-to-stamp items do not nag - they are settled");
ok(count({ unrecorded: 3 }) === 3, "work with no record counts");
ok(
  count({ incomplete: 1 }) === 1,
  "so does a record that EXISTS but is inadmissible - the case omitted once, which raised no badge at all"
);
ok(count({ unconfirmed: 1 }) === 1, "and one claiming done whose checks have not passed");
ok(count({ judgment: 1, unrecorded: 1, incomplete: 1, unconfirmed: 1, stamp: 9 }) === 4, "summed, stamp excluded");
ok(count({}) === 0 && count(null) === 0 && count(undefined) === 0, "an empty or missing tally is zero, not NaN");

// --- the badge is no longer a side effect of rendering the page --------------
const paint = grab("paintReviewBadge");
ok(/window\.helm\.listReviews\(/.test(paint), "the badge can fetch its own tally");
ok(/tally = null/.test(paint), "taking one when the page already has it, so opening review costs no extra read");
ok(/catch/.test(paint), "and a failed read leaves the existing count alone rather than clearing it");

const startupTail = rSrc.slice(rSrc.indexOf("setInterval(renderScheduledPromptBar"));
ok(/void paintReviewBadge\(\);/.test(startupTail), "it is painted at startup, before any page visit");
ok(/setInterval\(\(\) => \{\s*void paintReviewBadge\(\);/.test(startupTail), "and kept current on a tick");
// The first paint must NOT land in the startup crush: every git call in the housekeeping
// sweep is synchronous, and a cheap IPC issued during startup measured 421ms against 3ms
// in a settled app (2026-08-03). A badge nobody is looking at yet is not worth queueing
// behind that.
ok(
  /setTimeout\(\(\) => \{\s*void paintReviewBadge\(\);\s*\}, 15 \* 1000\);/.test(startupTail),
  "the first paint is deferred out of the startup crush, not fired immediately"
);
ok(
  /maxAgeMs: 20_000/.test(paint),
  "and a count accepts a recent result rather than paying for a git spawn per project on every tick"
);

// The page must still paint it, or a stamp would not clear the badge until the tick.
ok(
  /paintReviewBadge\(reviewTallyFromRows\(visibleReviewRows\(allRows, \{ ignoreProjectFilter: true, ignoreDomainFilter: true \}\)\)\)/.test(rSrc),
  "renderReviewPage paints the badge from the same rows, minus the project chip AND the domain focus"
);
// And the old inline block must be gone, not merely bypassed.
ok(
  !/const n = tally\.judgment \+ tally\.unrecorded/.test(rSrc),
  "the old inline count inside renderReviewPage is deleted, not left behind as dead code"
);

// --- the widget --------------------------------------------------------------
ok(/review: \{ label: "Review", span: 4/.test(rSrc), "the Review widget is in the catalog, so it can be added");
ok(/review: widgetBodyReview,/.test(rSrc), "and wired to a body");
const widget = grab("paintReviewWidget");
ok(/window\.helm\.listReviews\(/.test(widget), "it fetches its own tally rather than riding the dashboard bundle");
ok(/navigateToPage\("review"\)/.test(widget), "it navigates to the review page - the 'snabb navigering' half of the ask");
ok(/reviewAttentionCount\(tally\)/.test(widget), "and uses the SAME count as the badge, so the two cannot disagree");
ok(/if \(n === 0\) \{\s*continue;/.test(widget), "zero-value bands are skipped - a row of zeroes is noise");

// --- one count, not three (task daa4245f) -----------------------------------
// "är 12 hårdkodat i review widgeten? något säger 12 men det är bara 1" - nothing was
// hardcoded and nothing was miscounted. The page recomputes its numbers from the rows it
// SHOWS (its repo filter holds back everything with no code to review), while the widget and
// the badge printed the backend's tally of the WHOLE queue. Two counts of two different
// things, presented as the same number.
const filterFns = new Function(
  `let reviewOnlyRepoRooted = true, reviewProjectFilter = null, reviewDomainFilter = "all";
   const bandOf = (r) => r.band || r.verdict;
   ${grab("visibleReviewRows")}
   ${grab("reviewTallyFromRows")}
   return {
     visibleReviewRows, reviewTallyFromRows,
     setFilter: (repo, proj) => { reviewOnlyRepoRooted = repo; reviewProjectFilter = proj; },
     setDomain: (d) => { reviewDomainFilter = d; },
   };`
)();

// His actual board: one row in a repo, eleven that are not.
const board = [
  { repoPath: "D:\\Repo\\Tools\\helm", category: "Helm", band: "judgment" },
  ...Array.from({ length: 11 }, (_, i) => ({ repoPath: null, category: `life-${i}`, band: "unrecorded" })),
];
// A second repo-rooted project, so an assertion about the PROJECT filter cannot be satisfied by
// the repo filter alone - which is why "a project filter narrows it the same way" could not fail:
// the only repo-rooted row in the board above is also the only "Helm" row.
const twoProjects = [
  { repoPath: "D:/Repo/Tools/helm", category: "Helm", band: "judgment" },
  { repoPath: "D:/Repo/Tools/jot", category: "Jot", band: "unrecorded" },
];
const shown = filterFns.visibleReviewRows(board);
ok(shown.length === 1, `the repo filter leaves exactly the row the page shows (${shown.length})`);
ok(filterFns.reviewTallyFromRows(shown).total === 1, "and the tally over those rows is 1, not 12");
ok(
  filterFns.reviewTallyFromRows(shown).judgment === 1 && filterFns.reviewTallyFromRows(shown).unrecorded === 0,
  "the bands follow the same rows, so no band can be counted from a set the page is not showing"
);
filterFns.setFilter(false, null);
ok(filterFns.visibleReviewRows(board).length === 12, "turning the filter off shows all twelve - the held-back rows are real work, not discarded");
filterFns.setFilter(true, "Helm");
ok(filterFns.visibleReviewRows(twoProjects).length === 1, "a project filter narrows it the same way for every surface - checked against a board with TWO repo-rooted projects, so the repo filter alone cannot satisfy it");
ok(filterFns.reviewTallyFromRows([]).total === 0, "an empty set tallies to zero rather than NaN");

// --- the work/private focus (task 0ca1f3d3) ---------------------------------
// Brought back on Review: the row's domain comes from its Jot category (Helm=private,
// Crewline=work). The filter shows only the chosen domain; an unclassified row (no
// domain set) is shown only under "all", never under a specific focus.
filterFns.setFilter(true, null);
const domainBoard = [
  { repoPath: "D:/r/helm", category: "Helm", band: "judgment", domain: "private" },
  { repoPath: "D:/r/crewline", category: "Crewline", band: "stamp", domain: "work" },
  { repoPath: "D:/r/reinmaker", category: "Reinmaker", band: "judgment", domain: "work" },
  { repoPath: "D:/r/x", category: "Unclassified", band: "unrecorded", domain: null },
];
filterFns.setDomain("all");
ok(filterFns.visibleReviewRows(domainBoard).length === 4, "domain 'all' shows every repo-rooted row, whatever its work/private tag");
filterFns.setDomain("work");
const workRows = filterFns.visibleReviewRows(domainBoard);
ok(workRows.length === 2 && workRows.every((r) => r.domain === "work"), `Work focus shows only work-domain rows (${workRows.length})`);
filterFns.setDomain("private");
const privRows = filterFns.visibleReviewRows(domainBoard);
ok(privRows.length === 1 && privRows[0].category === "Helm", `Private focus shows only private-domain rows (${privRows.length})`);
ok(!privRows.some((r) => r.domain === null), "an unclassified row is NOT shown under a specific focus");

// THE BADGE MUST NOT FOLLOW THE DOMAIN FOCUS (raised by independent review, 2026-08-09).
// The page's Work/Private choice is a local view; the subnav badge is a global attention
// signal. If the badge honoured the domain filter, picking "Work" would drop the private
// review items from the count and leave them uncounted until restart - the exact
// under-flagging ignoreProjectFilter exists to prevent, on a new axis. The badge path passes
// BOTH ignore flags, so it counts every repo-rooted row whatever focus is active.
filterFns.setDomain("work");
ok(
  filterFns.visibleReviewRows(domainBoard, { ignoreProjectFilter: true, ignoreDomainFilter: true }).length === 4,
  "the badge counts every repo-rooted row even while the page is focused on Work (it does not inherit the domain filter)"
);
filterFns.setDomain("private");
ok(
  filterFns.visibleReviewRows(domainBoard, { ignoreProjectFilter: true, ignoreDomainFilter: true }).length === 4,
  "and the same under a Private focus - the global signal is domain-blind"
);
filterFns.setDomain("all");

// All three surfaces must go through those two functions, or they drift apart again.
ok(/const rows = visibleReviewRows\(allRows\);/.test(rSrc), "the page filters through the shared function");
ok(/const tally = reviewTallyFromRows\(rows\);/.test(rSrc), "and tallies through the shared one");
ok(
  /res\?\.rows/.test(widget) && /visibleReviewRows\(/.test(widget) && /reviewTallyFromRows\(/.test(widget),
  "the widget counts the rows the page would show, not the whole queue"
);
ok(
  /reviewTallyFromRows\(visibleReviewRows\(res\.rows, \{ ignoreProjectFilter: true, ignoreDomainFilter: true \}\)\)/.test(paint),
  "and the badge does the same when it fetches its own"
);
// The badge must NOT follow the project chip. Making the three surfaces agree also made the subnav
// badge inherit a filter set on another page: picking one project left it counting only that one,
// with nothing on screen saying so and no reset until the app restarted. Under-flagging an attention
// signal is the failure Aidin has explicitly rejected (raised by an independent review, 2026-08-04).
filterFns.setFilter(true, "Helm");
ok(filterFns.visibleReviewRows(twoProjects).length === 1, "the PAGE narrows to the chosen project");
ok(
  filterFns.visibleReviewRows(twoProjects, { ignoreProjectFilter: true }).length === 2,
  "while the badge still counts every repo-rooted row, whatever chip is selected"
);
filterFns.setFilter(true, null);
ok(!/const tally = res\?\.tally \|\| \{\};/.test(widget), "the widget's old unfiltered tally is gone, not just bypassed");
// What the filter holds back has to be SAID. A number that quietly shrank from 12 to 1 is
// how the two surfaces came to disagree in the first place.
ok(/held back by your filter/.test(widget), "and the widget states how many rows the filter is holding back");

for (const cls of [".wd-review", ".wd-review-head", ".wd-review-sub", ".wd-review-line", ".wd-review-val"]) {
  ok(css.includes(cls), `${cls} is styled`);
}
const block = css.slice(css.indexOf(".wd-review {"), css.indexOf(".wd-quota-head.crit"));
const tokens = [...new Set([...block.matchAll(/var\((--[a-z-]+)\)/g)].map((m) => m[1]))];
ok(tokens.length > 0, `it uses the app's tokens (${tokens.join(", ")})`);
ok(
  tokens.every((t) => new RegExp(`\\${t}\\s*:`).test(css)),
  `and every one of them exists (${tokens.join(", ")})`
);

console.log(
  exit === 0
    ? "VERIFY OK: the review count is painted at startup and on a tick, the page still updates it, and the Review widget shows the same count with a way to the page."
    : "VERIFY FAILED."
);
process.exit(exit);
