// A pending turn must not outlive the run that created it.
//
// Task 6bdbcde7 - "En output följer hela tiden med och hamnar sist". His screenshots show
// the session's FIRST reply re-appended below the newest turn, again and again, while the
// transcript file on disk contains that text exactly ONCE (entry 34 of 411) - so the
// duplicate is built by the renderer's merge, not by the file.
//
// Two facts combine into the bug:
//   - mergeReloadedTurns matches a pending turn against only the last RELOAD_MATCH_WINDOW
//     turns of the file, so once the conversation grows past that window an early pending
//     turn is permanently unmatchable and is re-appended at the tail on every reload;
//   - the only other thing that emptied the buffer was a hand-written delete in each
//     terminal branch of the "done" handler - a rule enforced at N call sites, which the
//     N+1th path silently opts out of. This symptom has been fixed that way three times.
//
// The fix under test is a real lifetime: expirePendingTurnsFromEarlierRuns, called from
// the single choke point every new run must pass through (sendFromPane).
//
// Run:  node scripts/e2e/test-pending-turn-lifetime.mjs
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
const grab = (name) => {
  const at = rSrc.indexOf(`function ${name}(`);
  if (at < 0) {
    throw new Error(`renderer.js no longer defines ${name}`);
  }
  return rSrc.slice(at, rSrc.indexOf("\n}", at) + 2);
};

// The real functions, over a real module-scope buffer - not a paraphrase of them.
const env = new Function(`
  const RELOAD_MATCH_WINDOW = 60;
  const PENDING_PER_SESSION_CAP = 20;
  const turnKey = (t) => \`\${t?.role}|\${t?.kind}|\${String(t?.text ?? "")}\`;
  const pendingTurnsBySession = new Map();
  ${grab("rememberPendingTurn")}
  ${grab("expirePendingTurnsFromEarlierRuns")}
  ${grab("mergeReloadedTurns")}
  return { rememberPendingTurn, expirePendingTurnsFromEarlierRuns, mergeReloadedTurns, pendingTurnsBySession };
`)();
const { rememberPendingTurn, expirePendingTurnsFromEarlierRuns, mergeReloadedTurns, pendingTurnsBySession } = env;

const SID = "session-1";
const reply = (text) => ({ role: "assistant", kind: "text", text });
const tool = (n) => ({ role: "assistant", kind: "tool_use", toolName: "PowerShell", toolInput: `cmd ${n}` });

// --- the bug, reproduced ------------------------------------------------------
// The first reply of a long session: streamed (so pending), and present in the file.
pendingTurnsBySession.clear();
const first = reply("Jag hittade dina tre tasks i Jot (Helm-listan).");
const pane = { sessionId: SID, turns: [first] };
rememberPendingTurn(SID, first);

// The file has grown well past the tail window - his real case was entry 34 of 411.
const longFile = [first, ...Array.from({ length: 120 }, (_, i) => tool(i))];
let merged = mergeReloadedTurns(pane.turns, longFile, SID);
ok(
  merged.length === longFile.length + 1 && merged[merged.length - 1] === first,
  "REPRODUCED: the first reply is re-appended at the tail even though the file already contains it - it is outside the 60-turn match window"
);
ok(
  (pendingTurnsBySession.get(SID) || []).length === 1,
  "and it stays in the buffer, so every later reload does it again - this is the 'follows along and lands last' he reported"
);
// Twice more, to show it is permanent rather than self-correcting.
merged = mergeReloadedTurns(merged, longFile, SID);
merged = mergeReloadedTurns(merged, longFile, SID);
ok(
  merged.filter((t) => t === first).length === 2,
  "it never self-corrects: the file's own copy plus the stray one, on every single reload"
);

// --- the fix ------------------------------------------------------------------
pendingTurnsBySession.clear();
const first2 = reply("Jag hittade dina tre tasks i Jot (Helm-listan).");
const pane2 = { sessionId: SID, turns: [first2] };
rememberPendingTurn(SID, first2);
expirePendingTurnsFromEarlierRuns(pane2); // <- what sendFromPane now does
ok(pendingTurnsBySession.has(SID) === false, "starting a new run empties the session's pending buffer");
ok(first2.pending === undefined, "and clears the flag on the pane's own turns, which the merge reads from the other side");
const afterFix = mergeReloadedTurns(pane2.turns, [first2, ...Array.from({ length: 120 }, (_, i) => tool(i))], SID);
ok(afterFix.length === 121 && afterFix[afterFix.length - 1] !== first2, "so the stray copy is gone: the file's own copy is the only one left");

// --- the fix must NOT eat the thing the buffer exists for ---------------------
// A prompt sent seconds ago that the file has not written yet must survive a reload.
pendingTurnsBySession.clear();
const sent = { role: "user", kind: "text", text: "jag har lagt 3 tasks i jot", pending: true };
const pane3 = { sessionId: SID, turns: [reply("earlier")] };
expirePendingTurnsFromEarlierRuns(pane3); // the new run starts...
pane3.turns.push(sent); // ...and THEN the prompt is pushed, as sendFromPane does
rememberPendingTurn(SID, sent);
const behind = mergeReloadedTurns(pane3.turns, [reply("earlier")], SID);
ok(
  behind[behind.length - 1] === sent,
  "the just-sent prompt still survives a reload that lands before the file catches up - the whole reason the buffer exists (task 20009fdc)"
);
// And it is dropped the moment the file does catch up, as before.
const caughtUp = mergeReloadedTurns(behind, [reply("earlier"), { ...sent, pending: undefined }], SID);
ok(caughtUp.length === 2 && pendingTurnsBySession.has(SID) === false, "and is pruned once the file contains it, so the buffer returns to empty");

// A rewind still wins: turns cut away came from a file, were never pending, stay gone.
pendingTurnsBySession.clear();
const pane4 = { sessionId: SID, turns: [reply("a"), reply("b"), reply("c")] };
const rewound = mergeReloadedTurns(pane4.turns, [reply("a")], SID);
ok(rewound.length === 1, "a rewind is still not undone by the merge - nothing here was pending");

// --- it is wired at the ONE place every run passes through --------------------
const send = grab("sendFromPane");
ok(/expirePendingTurnsFromEarlierRuns\(pane\);/.test(send), "sendFromPane expires earlier runs' pending turns");
ok(
  send.indexOf("expirePendingTurnsFromEarlierRuns(pane)") < send.indexOf("const sentTurn ="),
  "BEFORE the new prompt is pushed - the other order would expire the turn it just created"
);
ok(
  (rSrc.match(/expirePendingTurnsFromEarlierRuns\(/g) || []).length === 2,
  "exactly one call site plus the definition: the point of the fix is that it is not a rule spread over N branches"
);
ok(/sendFromPane\(index, pane\.els\);/.test(grab("fireQueuedPromptIfAny")), "a queued prompt goes through the same choke point rather than launching around it");

process.exit(exit);
