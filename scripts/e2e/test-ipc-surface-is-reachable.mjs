// Every IPC capability is reachable, or it is classified on purpose.
//
// An IPC capability is spelled in three places that must agree: the preload bridges a NAME to
// a CHANNEL, main handles the channel, the renderer calls the name. Direction 2 of the
// reliability block is about concepts spelled more than once, and this is the widest instance
// of it in the app - 131 bridges, 133 handlers.
//
// The cost of them disagreeing is not theoretical. Non-repo "domain" projects had lost their
// only control weeks before anyone noticed: the handler, the bridge and the implementation all
// still existed, so every file described a feature that could not be used. The linter found it
// by accident. Nothing was looking.
//
// ## Why a classification rather than "every bridge must be called"
//
// Because that is false, and a check that asserts it would be deleted within a week. Some
// bridges are diagnostics only tests need. Some were superseded when the UI chose a different
// mechanism and the old one was left standing. Those are fine - what is NOT fine is not
// knowing which.
//
// So the classification below must be TOTAL: every unreached bridge is named with a kind and a
// reason, and an unnamed one fails. That is the same shape that worked for the goal loop's stop
// reasons - the default is a question, not a behaviour. A seventh orphan cannot appear quietly.
//
// Names cannot outlive facts either: a bridge listed here that the renderer DOES call fails
// too, so the list cannot rot into a page of stale exemptions.
//
// ## The detector self-checks, because two of them were broken before this one
//
// The first attempt stripped block comments with a regex; a `/*` inside a string opened a
// comment that swallowed 67,000 characters, and four bridges that ARE called were reported as
// orphans. The second built its word-boundary regex inside a shell one-liner, lost the
// backslashes a layer at a time, matched nothing, and reported all 131 as orphans. A confident
// list from a broken detector is worse than no list, so this one proves it can find four names
// known to be called before it reports anything.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails += 1;
  }
};

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(repo, rel), "utf8");

// Comments dropped LINE BY LINE. No block-comment regex - see the header.
const isCommentLine = (line) => {
  const t = line.trim();
  return t === "" || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
};
const codeOf = (rel) => read(rel).split("\n").filter((l) => !isCommentLine(l)).join("\n");

const rendererCode = codeOf("src/renderer/renderer.js");
const preload = read("src/preload.cjs");
const main = read("src/main.js");
const mentions = (haystack, name) => new RegExp(`\\b${name}\\b`).test(haystack);

// --- the detector proves itself first ------------------------------------------------------
const KNOWN_CALLED = ["setReviewStatus", "sendReviewBack", "getReviewDiff", "presentReview", "listReviews"];
const missed = KNOWN_CALLED.filter((n) => !mentions(rendererCode, n));
ok(
  missed.length === 0,
  missed.length === 0
    ? `the detector finds all ${KNOWN_CALLED.length} names known to be called from real code`
    : `THE DETECTOR IS BROKEN and everything below is worthless: ${missed.join(", ")} are called from real code and it cannot see them`
);
if (missed.length) {
  console.log("");
  console.log(`VERIFY FAILED: ${fails} assertion(s)`);
  process.exit(1);
}

/**
 * Every bridge the renderer does not call, named with WHY.
 *
 * kinds:
 *   seam         a diagnostic the app itself has no use for; tests drive it. Legitimate.
 *   superseded   the app does this another way now, and the replacement is named. The bridge
 *                is dead weight, and saying so is the point - it is a candidate for removal
 *                rather than a mystery.
 *   internal     main calls the underlying function itself; the bridge was never the path.
 *   missing      nothing reaches it and nothing replaced it. A control that is gone or was
 *                never built. This kind is a DECISION owed, not a state to settle into.
 */
const CLASSIFIED = {
  getHeavyWorkerStatus: {
    kind: "seam",
    why: "whether the off-main-process worker is alive. Three checks assert the fallback path; the app has no reason to show it.",
  },
  renameSecondMate: {
    kind: "superseded",
    why: "the Fleet renames the second mate's SESSION title instead (renameSessionTo, the same display-only override the sidebar uses), which is what was actually asked for. This bridge renames the mate RECORD and nothing wants that.",
  },
  pruneStaleArchivedFleetNodes: {
    kind: "internal",
    why: "main prunes on its own schedule; the bridge exists so a check can force it rather than wait.",
  },
  resumeFleet: {
    kind: "internal",
    why: "the dispatch MCP server drives this, not the window - a mate resumes its own fleet, and there is no button for it by design.",
  },
  addJotSubtask: {
    kind: "missing",
    why: "the handler exists and was hardened on 2026-09-02, and nothing in the app can reach it. Adding a subtask to a board card is possible from a session through the board's own MCP server but not from Helm. Either build the control or drop the bridge and the handler together.",
  },
  unbindReviewCommits: {
    kind: "missing",
    why: "BINDING commits to a review card has a control; unbinding does not, so a wrong binding cannot be undone in the app. Binding is fallible, which makes this the half worth building rather than removing - the opposite call from the domain feature.",
  },
};

/** Handlers with no bridge. Reached from somewhere other than the window, or reached by nobody. */
const UNBRIDGED_OK = {
  "secondMates:propose": "the dispatch MCP server calls it - a second mate proposes itself, which no window does.",
  "orchestration:resumeCrew": "same, the MCP surface. A crew resume is a mate's decision, not a click.",
};

const bridge = new Map();
for (const m of preload.matchAll(/(\w+)\s*:\s*\([^)]*\)\s*=>\s*ipcRenderer\.(invoke|send)\(\s*"([^"]+)"/g)) {
  bridge.set(m[1], m[3]);
}
const handled = new Set();
for (const m of main.matchAll(/ipcMain\.(handle|on)\(\s*"([^"]+)"/g)) {
  handled.add(m[2]);
}
ok(bridge.size > 100, `the preload was parsed (${bridge.size} bridges)`);
ok(handled.size > 100, `and main was parsed (${handled.size} handlers)`);

// --- a bridge with no handler can only ever reject ----------------------------------------
const unhandled = [...bridge].filter(([, ch]) => !handled.has(ch));
ok(
  unhandled.length === 0,
  unhandled.length === 0
    ? "every bridge has a handler, so no call can only ever reject"
    : `these bridges have no handler in main: ${unhandled.map(([n, c]) => `${n} -> ${c}`).join(", ")}`
);

// --- TOTAL: every unreached bridge is classified ------------------------------------------
const unreached = [...bridge].map(([name]) => name).filter((name) => !mentions(rendererCode, name));
const unclassified = unreached.filter((name) => !CLASSIFIED[name]);
ok(
  unclassified.length === 0,
  unclassified.length === 0
    ? `all ${unreached.length} bridges the renderer does not call are classified`
    : `these bridges are unreachable from the app and NOTHING says why: ${unclassified.join(", ")}. Classify each as seam, superseded, internal or missing - and if it is "missing", that is a decision owed, not a label.`
);

// --- and no name outlives its fact --------------------------------------------------------
const stale = Object.keys(CLASSIFIED).filter((name) => mentions(rendererCode, name));
ok(
  stale.length === 0,
  stale.length === 0
    ? "and nothing is classified as unreachable that the app actually calls"
    : `these are listed as unreachable but the renderer calls them: ${stale.join(", ")} - remove them from the list rather than leaving it to rot`
);

// Every entry says which kind it is, and says something. A one-word reason is how a
// classification becomes a formality.
for (const [name, entry] of Object.entries(CLASSIFIED)) {
  ok(
    ["seam", "superseded", "internal", "missing"].includes(entry.kind),
    `${name} carries a known kind (${entry.kind})`
  );
  ok((entry.why || "").length > 40, `${name} says why in a sentence rather than a word`);
}

// --- handlers with no bridge are classified the same way ----------------------------------
const bridgedChannels = new Set(bridge.values());
const unbridged = [...handled].filter((ch) => !bridgedChannels.has(ch));
const unbridgedUnknown = unbridged.filter((ch) => !UNBRIDGED_OK[ch]);
ok(
  unbridgedUnknown.length === 0,
  unbridgedUnknown.length === 0
    ? `all ${unbridged.length} handlers with no bridge are accounted for`
    : `these handlers are reachable from nowhere and nothing says why: ${unbridgedUnknown.join(", ")}`
);
const staleUnbridged = Object.keys(UNBRIDGED_OK).filter((ch) => bridgedChannels.has(ch));
ok(
  staleUnbridged.length === 0,
  staleUnbridged.length === 0
    ? "and nothing is listed as unbridged that now has a bridge"
    : `now bridged, so remove from the list: ${staleUnbridged.join(", ")}`
);

// --- the decisions owed are reported, every run -------------------------------------------
// Printed rather than asserted: a "missing" control is a decision for a person, and failing
// the suite until somebody makes it would only teach people to delete the check. But it is
// said out loud on every run, because the whole defect this file exists for was a lost control
// that nobody was reminded about.
const owed = Object.entries(CLASSIFIED).filter(([, e]) => e.kind === "missing");
console.log("");
console.log(`      ${owed.length} control(s) unreachable with nothing having replaced them - build or remove, but decide:`);
for (const [name, entry] of owed) {
  console.log(`        ${name}: ${entry.why}`);
}

console.log("");
console.log(
  fails === 0
    ? `VERIFY OK: ${bridge.size} bridges, ${handled.size} handlers, every gap between them named on purpose.`
    : `VERIFY FAILED: ${fails} assertion(s)`
);
process.exit(fails === 0 ? 0 : 1);
