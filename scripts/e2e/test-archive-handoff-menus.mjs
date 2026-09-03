// Class-level check: EVERY archive menu offers to save a handoff, including for a
// session with no project folder.
//
// The bug this exists to stop coming back (reported 2026-07-28, archiving a session
// with no project folder): three separate places in the renderer build an archive menu.
// Task 663ab4b6 added the topic-keyed handoff - the whole point of which is
// sessions with NO project folder - to exactly one of them. The other two kept
// `session.cwd ? [handoff item] : []`, so a folderless session was offered only
// "Archive without a handoff" and its knowledge was dropped in silence. Fixing one
// instance and assuming the class was closed, same as the eight file writers.
//
// So this test does two things a single-case test would not:
//   1. Behaviour - run the real shared builder on a folderless session.
//   2. CLASS - fail if any archive menu in the renderer is built outside the
//      shared builder, or re-introduces a cwd condition around the handoff item.
//
// The renderer is a classic script (no exports), so the builder is extracted from
// source and evaluated. That is deliberate: the assertion then runs against the
// SHIPPED text, not a copy that could drift.
//
// Run: node scripts/e2e/test-archive-handoff-menus.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererPath = path.join(here, "..", "..", "src", "renderer", "renderer.js");
const src = fs.readFileSync(rendererPath, "utf8");

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails++;
  }
};

// --- extract the shared builder from the shipped source -------------------
function extractFunction(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) {
    return null;
  }
  // Walk past the PARAMETER list first - the params are destructured, so the
  // first "{" after the name belongs to them, not to the body.
  let i = src.indexOf("(", start);
  let paren = 0;
  for (; i < src.length; i++) {
    if (src[i] === "(") {
      paren++;
    } else if (src[i] === ")") {
      paren--;
      if (paren === 0) {
        break;
      }
    }
  }
  i = src.indexOf("{", i);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") {
      depth++;
    } else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        return src.slice(start, i + 1);
      }
    }
  }
  return null;
}

const builderSrc = extractFunction("archiveMenuItems");
ok(!!builderSrc, "the shared builder archiveMenuItems() exists in the renderer");
if (!builderSrc) {
  process.exit(1);
}

const calls = [];
const archiveWithHandoff = (s) => {
  calls.push(["handoff", s.title]);
};
// archiveMenuItems now asks isNonRootedSession whether a cwd is a real project
// (his life-domain sessions are rooted AT the meta-home, so "has a cwd" was the
// wrong question - see the note in the renderer). Extract that too and give it a
// meta-home to compare against.
const nonRootedSrc = extractFunction("isNonRootedSession");
ok(!!nonRootedSrc, "isNonRootedSession exists - the label no longer just asks whether a cwd is set");
const build = new Function(
  "archiveWithHandoff",
  "state",
  `${nonRootedSrc}; ${builderSrc}; return archiveMenuItems;`
)(archiveWithHandoff, { orchestratorHome: "D:/Sync/claude-home" });

// --- 1. behaviour: the folderless session is the whole point --------------
const folderless = { title: "Trädgård och växthus (Odlingslogg)", cwd: null };
const items = build(folderless, { plainArchive: () => calls.push(["plain", folderless.title]) });
ok(items.length === 2, `a folderless session gets both options (${items.length})`);
ok(
  /save handoff/i.test(items[0].label),
  `and the FIRST one is the handoff, not just "archive" (${items[0].label})`
);
ok(
  /by topic/i.test(items[0].label),
  `worded so it says where it goes - by topic, since there is no repo to write to (${items[0].label})`
);

// Backslashes, a different case and a trailing separator on purpose: real sessions
// carry the Windows form, and the meta-home is stored forward-slashed.
const metaRooted = build({ title: "Tradgard och vaxthus", cwd: "D:\\SYNC\\claude-home\\" }, { plainArchive: () => {} });
ok(
  /by topic/.test(metaRooted[0].label),
  `a session rooted AT the meta-home is by-topic too, not HANDOFF.md (${metaRooted[0].label})`
);

const rooted = build({ title: "helm", cwd: "D:/Repo/Tools/helm" }, { plainArchive: () => {} });
ok(rooted.length === 2, "a rooted session also gets both options");
ok(/HANDOFF\.md/.test(rooted[0].label), `and names its file instead (${rooted[0].label})`);
ok(
  items.length === rooted.length,
  "the COUNT is identical either way - cwd changes the destination, never whether the option exists"
);

// --- 2. behaviour: `after` must run on BOTH branches ----------------------
// The Fleet button passes `after` to drop its node. If it only ran on one
// branch the node would linger after the other, which is how the original
// inline versions diverged in the first place.
let afterRuns = 0;
const withAfter = build(folderless, {
  plainArchive: async () => {},
  after: async () => {
    afterRuns++;
  },
});
await withAfter[0].onClick();
ok(afterRuns === 1, `after() runs on the handoff branch (${afterRuns})`);
await withAfter[1].onClick();
ok(afterRuns === 2, `after() runs on the plain branch too (${afterRuns})`);

// --- 3. behaviour: the labels carry the session name when asked -----------
const named = build(folderless, { plainArchive: () => {}, nameInLabel: true });
ok(
  named.every((it) => it.label.includes("Trädgård och växthus (Odlingslogg)")),
  `nameInLabel puts the title on both entries (${named.map((i) => i.label).join(" | ")})`
);

// --- 4. THE CLASS CHECK ---------------------------------------------------
// Any archive menu built inline would need its own "without a handoff" label.
// Exactly one may exist, and it must live inside the shared builder.
// Scan CODE only. The comments above the builder quote the old menu wording to
// explain the bug, and a naive scan would read that prose as a second menu.
// Whole-line comments only - stripping trailing "//" would corrupt string
// literals containing "://".
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");

const labelHits = [...code.matchAll(/label:.*without a handoff/g)];
const inlineLabels = [...code.matchAll(/`Archive.*without a handoff`|"Archive.*without a handoff"/g)];
ok(
  labelHits.length === 1,
  `only ONE place builds an "archive without a handoff" menu entry (found ${labelHits.length})`
);
ok(
  builderSrc.includes("without a handoff"),
  "and that place is the shared builder"
);
ok(
  inlineLabels.every((m) => builderSrc.includes(m[0])),
  "no archive label string is written outside the builder"
);

// The specific regression: a cwd condition deciding WHETHER the handoff is offered.
const cwdGate = [...code.matchAll(/\.cwd\s*(\?|&&)[^\n]*[Hh]andoff/g)].map((m) => m[0]);
// The gate that must never come back is one deciding WHETHER a handoff is offered.
// Deciding the LABEL from the destination is fine and is what these two are.
const ALLOWED_LABEL_GATES = [/\?\s*"by topic"\s*:\s*"to HANDOFF\.md"/, /isNonRootedSession\(/];
const badGate = cwdGate.filter((t) => !ALLOWED_LABEL_GATES.some((re) => re.test(t)));
ok(
  badGate.length === 0,
  `no archive path gates the handoff OPTION on having a project folder (${JSON.stringify(badGate)})`
);

// And every menu that archives goes through the builder: archiveWithHandoff must
// have exactly one caller, inside it.
const handoffCalls = [...code.matchAll(/archiveWithHandoff\(/g)];
ok(
  handoffCalls.length === 2,
  `archiveWithHandoff is declared once and called once - from the builder (${handoffCalls.length} mentions)`
);
ok(
  (builderSrc.match(/archiveWithHandoff\(/g) || []).length === 1,
  "the one call site is inside the shared builder"
);

console.log(
  fails === 0
    ? "\nVERIFY OK: every archive path offers a handoff, folder or no folder - and a new inline menu would fail this test."
    : `\nVERIFY FAILED (${fails})`
);
process.exit(fails === 0 ? 0 : 1);
