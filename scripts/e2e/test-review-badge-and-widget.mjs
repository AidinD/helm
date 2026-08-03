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
ok(/window\.helm\.listReviews\(\)/.test(paint), "the badge can fetch its own tally");
ok(/tally = null/.test(paint), "taking one when the page already has it, so opening review costs no extra read");
ok(/catch/.test(paint), "and a failed read leaves the existing count alone rather than clearing it");

const startupTail = rSrc.slice(rSrc.indexOf("setInterval(renderScheduledPromptBar"));
ok(/void paintReviewBadge\(\);/.test(startupTail), "it is painted at startup, before any page visit");
ok(/setInterval\(\(\) => \{\s*void paintReviewBadge\(\);/.test(startupTail), "and kept current on a tick");

// The page must still paint it, or a stamp would not clear the badge until the tick.
ok(/paintReviewBadge\(tally\);/.test(rSrc), "renderReviewPage still paints it with the tally it already has");
// And the old inline block must be gone, not merely bypassed.
ok(
  !/const n = tally\.judgment \+ tally\.unrecorded/.test(rSrc),
  "the old inline count inside renderReviewPage is deleted, not left behind as dead code"
);

// --- the widget --------------------------------------------------------------
ok(/review: \{ label: "Review", span: 4/.test(rSrc), "the Review widget is in the catalog, so it can be added");
ok(/review: widgetBodyReview,/.test(rSrc), "and wired to a body");
const widget = grab("paintReviewWidget");
ok(/window\.helm\.listReviews\(\)/.test(widget), "it fetches its own tally rather than riding the dashboard bundle");
ok(/navigateToPage\("review"\)/.test(widget), "it navigates to the review page - the 'snabb navigering' half of the ask");
ok(/reviewAttentionCount\(tally\)/.test(widget), "and uses the SAME count as the badge, so the two cannot disagree");
ok(/if \(n === 0\) \{\s*continue;/.test(widget), "zero-value bands are skipped - a row of zeroes is noise");

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
