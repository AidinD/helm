// A card the auto-captain looked at and declined must not vanish into silence.
//
// the captain ran "Run one pass" and nothing happened (2026-08-03). Three separate defects
// stacked up behind that one word "nothing":
//
//  1. holdBack wrote the "already judged, do not judge again" memory BEFORE checking
//     whether the tag and the explanation had actually reached the card. When that
//     board write failed - a locked file, the exact case fixed in @jot/core the same
//     day - the card became permanently invisible to auto with nothing on it saying
//     why. His card had the memory set, no tag, and no note.
//  2. The memory is keyed on the card's WORDING, so taking the
//     "needs-clarification" tag off - the obvious "look at this again" gesture - did
//     nothing at all.
//  3. Nothing in the UI said a card had been set aside. The only output of a pass
//     that examined a card and decided against it was an empty widget.
//
// Run:  node scripts/e2e/test-auto-setaside-visible.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { staleTriageEntries, taskFingerprint, NEEDS_CLARIFICATION_TAG, planAutoTick } from "../../src/lib/autoCaptain.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};
const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => fs.readFileSync(path.join(here, "..", "..", "src", rel), "utf8");
const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

const TAGS = [
  { id: "t-auto", name: "auto" },
  { id: "t-clar", name: NEEDS_CLARIFICATION_TAG },
];
const card = (over = {}) => ({
  id: "card-1",
  text: "run a random e2e test",
  description: "any test in the repo will do",
  status: "open",
  tags: ["t-auto"],
  categoryId: "cat-1",
  ...over,
});

// ===========================================================================
// 1. Removing the tag makes auto look at the card again
// ===========================================================================
console.log("\n-- taking the tag off means 'look again' --");
{
  const setAside = card({ tags: ["t-auto", "t-clar"] });
  const fp = taskFingerprint(setAside);
  const triaged = { "card-1": fp };

  ok(
    staleTriageEntries({ tags: TAGS, todos: [setAside] }, triaged).length === 0,
    "a card still wearing needs-clarification keeps its memory - no model call per tick"
  );
  // And the memory really is doing its job while the tag is on.
  const held = planAutoTick({ tags: TAGS, todos: [setAside], categories: [] }, { triaged });
  ok(held.act.length === 0, "so it is not re-judged");
  ok(
    held.skipped.length === 1 && /set aside/.test(held.skipped[0].reason),
    `and it is reported as skipped WITH a reason: ${JSON.stringify(held.skipped[0]?.reason)}`
  );

  // The gesture: the tag comes off.
  const cleared = card({ tags: ["t-auto"] });
  const stale = staleTriageEntries({ tags: TAGS, todos: [cleared] }, triaged);
  ok(stale.length === 1 && stale[0] === "card-1", `removing the tag forgets the memory (${JSON.stringify(stale)})`);

  // ...and the card is then genuinely eligible again, with the SAME wording. This is
  // the assertion that matters: forgetting the memory has to change the outcome, not
  // just the bookkeeping.
  const after = { ...triaged };
  for (const id of stale) {
    delete after[id];
  }
  const replanned = planAutoTick({ tags: TAGS, todos: [cleared], categories: [] }, { triaged: after });
  ok(replanned.act.length === 1, "and the card is picked up again on the next pass, unedited");

  ok(
    staleTriageEntries({ tags: TAGS, todos: [] }, triaged).length === 1,
    "a memory for a deleted card is forgotten too, rather than living in the config forever"
  );
  ok(staleTriageEntries({ tags: TAGS, todos: [card({ tags: ["t-auto", "t-clar"] })] }, {}).length === 0, "no memories, nothing to forget");
  ok(staleTriageEntries({}, { "x": "y" }).length === 1, "an unreadable board forgets rather than suppressing forever");
}

// ===========================================================================
// 2. The memory is only written when the card actually got the explanation
// ===========================================================================
console.log("\n-- a failed board write must not suppress the card --");
{
  // holdBack lives in main.js (it needs the Jot writer), so this asserts the ORDER
  // in the real source: the failure path must return BEFORE rememberTriaged.
  const mainSrc = stripComments(src("main.js"));
  const start = mainSrc.indexOf("function holdBack(");
  const body = mainSrc.slice(start, mainSrc.indexOf("\n}", start));
  const failAt = body.indexOf("return false");
  const rememberAt = body.indexOf("rememberTriaged(");
  ok(start >= 0 && failAt >= 0 && rememberAt >= 0, "holdBack has both a failure path and the memory write");
  ok(
    failAt < rememberAt,
    `the failure path returns BEFORE the memory is written (fail@${failAt} < remember@${rememberAt})`
  );
  ok(
    !/rememberTriaged\([^)]*\);\s*if \(!res\.ok\)/.test(body),
    "and the old order - remember first, then look at whether the write worked - is gone"
  );
}

// ===========================================================================
// 3. The widget says what was looked at and not started
// ===========================================================================
console.log("\n-- the pass is visible in the widget --");
{
  const mainSrc = stripComments(src("main.js"));
  ok(/setAside: skipped\.slice\(/.test(mainSrc), "the pass records WHICH cards it declined, not just how many");
  ok(/reason: s\.reason/.test(mainSrc), "with the reason each one was declined");

  const rSrc = stripComments(src("renderer/renderer.js"));
  ok(/frag\.append\(autoSetAsideEl\(\)\)/.test(rSrc), "the Auto widget renders them");
  const bodyStart = rSrc.indexOf("function widgetBodyAuto(");
  const emptyAt = rSrc.indexOf("widgetEmpty(", bodyStart);
  const setAsideAt = rSrc.indexOf("autoSetAsideEl()", bodyStart);
  ok(
    setAsideAt < emptyAt,
    "BEFORE the empty state, so 'nothing started yet' can never be the whole story on a pass that declined something"
  );
  ok(/void paintAutoSetAside\(\);/.test(rSrc), "and a manual pass repaints the list rather than only showing a toast");
  ok(
    /lastTick\?\.setAside/.test(rSrc),
    "reading it from the pass's own record"
  );

  // Every class it uses must exist in the stylesheet, and every colour token must be
  // one the app really defines - I first wrote this against --text-muted and
  // --text-secondary, neither of which exists here, which would have rendered the
  // rows in the default colour.
  const css = src("renderer/style.css");
  for (const cls of ["wd-auto-setaside", "wd-auto-setaside-head", "wd-auto-setaside-row", "wd-auto-setaside-title", "wd-auto-setaside-why"]) {
    ok(css.includes(`.${cls}`), `.${cls} is styled`);
  }
  const block = css.slice(css.indexOf(".wd-auto-setaside {"));
  const tokens = [...new Set([...block.slice(0, 1400).matchAll(/var\((--[a-z-]+)\)/g)].map((m) => m[1]))];
  const undefinedTokens = tokens.filter((t) => !new RegExp(`\\${t}\\s*:`).test(css));
  ok(undefinedTokens.length === 0, `every colour token it uses is defined${undefinedTokens.length ? `: MISSING ${undefinedTokens.join(", ")}` : ` (${tokens.join(", ")})`}`);
}

console.log(
  exit === 0
    ? "\nVERIFY OK: a set-aside card is reported with its reason, un-suppressed when its tag comes off, and never suppressed by a hold-back whose explanation failed to land."
    : "\nVERIFY FAILED."
);
process.exit(exit);
