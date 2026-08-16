// Three things the captain asked for on 2026-08-14, each pinned by the property that was
// actually missing rather than by the code that implements it.
//
// 1. task 8180e733 - "kan vi lägga en markör över autopilot också som visar hur många jobb
//    som körs nu", with a screenshot of the Review badge as the reference.
// 2. task 28db596e - "autopilots (crewmates) rapporterar inte tillbaka till 2nd mate
//    ordentligt."
// 3. task d555679c - "jag vill inte carry over för jag vill starta en ny topic men jag vill
//    fortfarande behålla det vi pratat om den här sessionen."
//
// The second and third share a shape worth naming, because it is the third time this week it
// has bitten: a signal attached to CREATION in a system whose objects are mostly RESUMED. The
// crew nudge fired only when a second mate had no session yet, and the first-mate manual only
// on a fresh turn. Both looked correct in every test that created something.
//
// Source-level, because these are renderer wiring in a 20k-line file and the app lane cannot
// reach a context menu's construction. That is a real limit and it is stated on the review
// record rather than papered over: this proves the wiring exists, not that it renders.
//
// Run:  node scripts/e2e/test-crew-visibility-and-retire-split.mjs
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

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const renderer = fs.readFileSync(path.join(repo, "src", "renderer", "renderer.js"), "utf8");
// Comments stripped here too. The JS scan already did this; HTML and CSS did not, so
// commenting the badge markup out left its assertions green (found by review, 2026-08-16).
const html = fs.readFileSync(path.join(repo, "src", "renderer", "index.html"), "utf8").replace(/<!--[\s\S]*?-->/g, "");
const css = fs.readFileSync(path.join(repo, "src", "renderer", "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

// Comments are stripped before the source assertions below. Without this, commenting a
// guarded line out leaves every check green - the first entry on the ship-review failure
// list, and this file is almost entirely source-scanning.
const code = renderer.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// --- 1. the Autopilot count ------------------------------------------------
ok(/id="autopilotBadge"/.test(html), "the Autopilot tab has a badge element");
ok(/attention-badge running/.test(html), "and it carries the running variant");
ok(
  /\.attention-badge\.running\s*\{[^}]*--active/.test(css),
  "which is coloured --active, NOT the amber --waiting the review badge uses - 'work is running' and 'you are needed' must not look identical in the same row of tabs"
);
ok(/function paintAutopilotBadge\(\)/.test(code), "there is a painter for it");
ok(
  (code.match(/paintAutopilotBadge\(\)/g) || []).length >= 4,
  `it is painted from more than one place (${(code.match(/paintAutopilotBadge\(\)/g) || []).length} call sites) - a badge painted only by the Autopilot page repeats the exact bug the review badge already had, where the number appeared only after you opened the page it was meant to send you to`
);
const painter = code.slice(code.indexOf("function paintAutopilotBadge()"), code.indexOf("function paintAutopilotBadge()") + 900);
ok(
  /crewLiveRun/.test(painter) && /crewRunning/.test(painter),
  "and it counts through the SAME live view every crew row uses (crewLiveRun + crewRunning), so the tab cannot disagree with the rows underneath it"
);

// --- 2. finished crew reaches its second mate on a RESUME -------------------
const jump = code.slice(code.indexOf("async function jumpIntoSecondMate"), code.indexOf("async function jumpIntoSecondMate") + 3000);
const resumeBranch = jump.slice(0, jump.indexOf("} else {"));
ok(
  /pendingSecondMateReviewNudge\(sm\)/.test(resumeBranch),
  "the crew nudge is built on the RESUME branch - seeding it only where a session is created made it fire exactly once per second mate, on the very first jump-in, and stay silent for every one after"
);
ok(
  /queuedPromptBySession\.set\(/.test(resumeBranch),
  "and it is seeded as a draft rather than sent - an auto-sent turn would spend Opus on a decision the captain has not made"
);
ok(
  /!queuedPromptBySession\.get\(/.test(resumeBranch),
  "and only when the composer is empty, so a half-typed message is never overwritten by a nudge"
);

// --- 3. keeping the notes is separate from carrying them over ---------------
const menu = code.slice(code.indexOf("function offerRetireChoice"), code.indexOf("function offerRetireChoice") + 1200);
const labels = [...menu.matchAll(/label:\s*"([^"]+)"/g)].map((m) => m[1]);
ok(labels.length === 3, `the retire menu offers three options, not two (${labels.join(" | ")}) - keeping this session's knowledge and carrying it into the next one are separate wishes, and bundling them left the common case with no button at all`);
ok(
  menu.includes("carryOver: false"),
  "and the middle one retires WITHOUT carry-over while still writing the durable document"
);

const carry = code.slice(code.indexOf("async function retireMateWithCarryOver"), code.indexOf("async function retireMateWithCarryOver") + 3500);
ok(/\{\s*carryOver\s*=\s*true\s*\}/.test(carry), "carryOver defaults to true, so the existing menu entry and the persona-switch caller are unchanged");
const saveIdx = carry.indexOf("saveHandoffResolvingTopic");
const retireIdx = carry.indexOf("window.helm.retireMate(");
ok(saveIdx > 0 && retireIdx > saveIdx, "the durable document is written BEFORE the retire call, so it does not depend on the carry-over decision");
ok(
  /retireMate\(mate\.mateId,\s*carryOver \? handoff : null/.test(carry),
  "and carryOver gates ONLY the one-shot message to the successor - if it gated the summary instead, 'keep notes' would keep nothing"
);

console.log(
  exit === 0
    ? "VERIFY OK: the Autopilot count is live and distinct, finished crew reaches a resumed second mate, and keeping notes no longer forces a carry-over."
    : "VERIFY FAILED."
);
process.exit(exit);
