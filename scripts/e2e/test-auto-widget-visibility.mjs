// Regression guard: an auto-captain run must actually SHOW UP in the Auto
// widget.
//
// The bug, twice reported by Aidin on the same feature: the run started, the
// board moved to in-progress, the card got its stripe - and the Auto widget
// stayed empty ("den hamnar fortfarande inte i auto captenens widget",
// 2026-08-03). Nothing was broken in the data. The widget filtered on
// `sm.isSessionNode && sm.startedBy === "auto"`, and BOTH halves had quietly
// stopped being true:
//
//   * `isSessionNode` is only set on a SYNTHETIC node derived from the session
//     list. The auto-captain now registers its run as a real second mate before
//     starting it (so the run is named after the project instead of the prompt's
//     first line), and a registered node is not synthetic - so the renderer
//     skipped the synthetic branch entirely.
//   * `startedBy` lives on the SESSION, never on a second mate. A registered
//     node has no such field at all.
//
// So the fix that made the run well-named is the same fix that made it
// invisible, and the filter that was supposed to find it could not match either
// way. This test runs the real predicates and the real augmentation against a
// registered auto run, rather than trusting that the source reads plausibly.
//
// Run:  node scripts/e2e/test-auto-widget-visibility.mjs
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const RENDERER = path.join(REPO_ROOT, "src", "renderer", "renderer.js");

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const src = fs.readFileSync(RENDERER, "utf8");

// A source check that matches raw text passes on a commented-out line - the
// atomicWrite guard's old bug, hit again on the auto-captain's own finish
// handler. Strip comments before asserting on code.
const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
const code = stripComments(src);

function extractFunction(source, name) {
  const sig = `function ${name}(`;
  const start = source.indexOf(sig);
  if (start === -1) {
    return null;
  }
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") {
      depth++;
    } else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  return null;
}

const fnNames = ["isLiveWorkNode", "isAutoStartedNode", "augmentSecondMatesWithSessions"];
const bodies = {};
for (const n of fnNames) {
  bodies[n] = extractFunction(src, n);
  ok(!!bodies[n], `renderer.js still defines ${n}`);
}
if (exit !== 0) {
  console.log("VERIFY FAILED (missing functions - the rest cannot run).");
  process.exit(exit);
}

// --- run the real code ------------------------------------------------------
// augmentSecondMatesWithSessions reads the module-level `state` and calls two
// helpers; everything else it needs is in the extracted text. Stub only those.
const AUTO_SESSION = "479686e6-auto";
const HAND_SESSION = "aaaa1111-hand";
const makeHarness = (sessions) =>
  new Function(
    "sessionsFixture",
    `
    const state = { sessions: sessionsFixture };
    const isHiddenFromHelm = () => false;
    // Mirrors the real one: a session resolves to a REGISTERED second mate, which
    // is exactly why the synthetic-node branch is skipped for the auto run.
    const registered = sessionsFixture.__registered || [];
    const secondMateForSession = (sess) =>
      registered.find((r) => r.sessionId === (sess.cliSessionId || sess.sessionId)) || null;
    ${bodies.isLiveWorkNode}
    ${bodies.isAutoStartedNode}
    ${bodies.augmentSecondMatesWithSessions}
    return { augmentSecondMatesWithSessions, isLiveWorkNode, isAutoStartedNode };
    `
  )(sessions);

const sessions = [
  {
    sessionId: AUTO_SESSION,
    cliSessionId: AUTO_SESSION,
    cwd: "D:\\Repo\\Tools\\helm",
    title: "Task from the board: add a --version flag",
    startedBy: "auto",
    isArchived: false,
    lastActivityAt: 2,
  },
  {
    sessionId: HAND_SESSION,
    cliSessionId: HAND_SESSION,
    cwd: "D:\\Repo\\Tools\\jot",
    title: "something I started myself",
    startedBy: null,
    isArchived: false,
    lastActivityAt: 1,
  },
];
// The registered auto run, exactly as it looks in second-mates.json after a real
// dispatch (verified against Aidin's own data, sm_7ed4d0140b11).
const registeredAuto = {
  secondMateId: "sm_7ed4d0140b11",
  firstMateId: "direct",
  projectPath: "D:\\Repo\\Tools\\helm",
  name: "helm",
  sessionId: AUTO_SESSION,
  status: "created",
  crew: [],
};
sessions.__registered = [registeredAuto];

const { augmentSecondMatesWithSessions, isLiveWorkNode, isAutoStartedNode } = makeHarness(sessions);
const nodes = augmentSecondMatesWithSessions([registeredAuto], []);

const auto = nodes.find((n) => n.secondMateId === "sm_7ed4d0140b11");
ok(!!auto, "the registered auto run survives the augmentation");
ok(auto.startedBy === "auto", `who started it is carried over from the session (got ${JSON.stringify(auto.startedBy)})`);
ok(auto.name === "helm", "and it keeps the project name, not the prompt's first line");

// THE actual reported symptom, as a check.
const autoColumn = nodes.filter((s) => isLiveWorkNode(s) && isAutoStartedNode(s));
ok(autoColumn.length === 1, `the Auto widget's filter finds the run (found ${autoColumn.length})`);

// The old filter, kept as a witness: it must NOT find it, or this test proves nothing.
const oldFilter = nodes.filter((s) => s.isSessionNode && s.startedBy === "auto");
ok(oldFilter.length === 0, "and the old isSessionNode-based filter genuinely could not - so this test has teeth");

// The hand-started session still becomes a synthetic Direct node, and is NOT
// claimed by the Auto column.
const handNode = nodes.find((n) => n.sessionId === HAND_SESSION);
ok(!!handNode && handNode.isSessionNode === true, "a session with no registered mate still becomes a Direct session node");
ok(!isAutoStartedNode(handNode), "work the captain started is not labelled auto");

const directColumn = nodes.filter((s) => s.firstMateId === "direct" && isLiveWorkNode(s) && !isAutoStartedNode(s));
ok(
  directColumn.length === 1 && directColumn[0].sessionId === HAND_SESSION,
  "Direct shows the captain's own work only - an auto run is not 'work you drive yourself'"
);

// A node with neither a session nor the synthetic flag (a proposed second mate)
// is not live work and must not be rendered as jump-in-able session.
ok(!isLiveWorkNode({ secondMateId: "sm_x", status: "proposed" }), "a proposal with no session is not live work");
// startedBy must never be invented for a node with no session behind it.
const { augmentSecondMatesWithSessions: aug2 } = makeHarness([]);
const orphan = aug2([{ secondMateId: "sm_y", firstMateId: "direct", name: "y", sessionId: "gone", crew: [] }], []);
ok(orphan[0].startedBy === undefined, "a node whose session is gone gets no invented startedBy");

// --- the call sites actually use the predicates -----------------------------
// Behaviour above proves the predicates are right; these prove the three places
// that had the bug are wired to them, since those live inside DOM builders this
// file cannot execute.
ok(
  /const autoSms = \(data\.secondMates \|\| \[\]\)\.filter\(\(s\) => isLiveWorkNode\(s\) && isAutoStartedNode\(s\)\)/.test(code),
  "the Auto widget filters through the predicates"
);
ok(
  (code.match(/isLiveWorkNode\(s\) && !isAutoStartedNode\(s\)/g) || []).length === 2,
  "both Direct surfaces (the Fleet column and the Captain widget) exclude auto runs"
);
ok(!/s\.isSessionNode && s\.startedBy === "auto"/.test(code), "the broken filter is gone, not merely bypassed");
ok(
  /\.filter\(\(sm\) => isLiveWorkNode\(sm\) && sm\.sessionId && \(sm\.crew \|\| \[\]\)\.length === 0\)/.test(code),
  "a registered run also gets its live sub-agents, so it doesn't read 'crew idle' while working"
);

// The Auto widget must not wear the captain's wording now that it has content.
ok(/fleetDirectCardEl\(autoSms, \{ as: "auto" \}\)/.test(code), "the Auto widget asks for the auto-labelled card");
ok(/isAuto \? "Auto-captain" : "Captain"/.test(code), "which is titled Auto-captain, not Captain");
ok(/if \(!isAuto\) \{\s*top\.append\(startBtn\);/.test(code), "and offers no '+ Session' button in the column nothing is started by hand in");

console.log(
  exit === 0
    ? "VERIFY OK: a registered auto-captain run is visible in the Auto widget, carries who started it, and is not double-listed as the captain's own work."
    : "VERIFY FAILED."
);
process.exit(exit);
