// A transcript reload may add, never delete.
//
// Task 20009fdc: "jag skriver en prompt och sedan går jag till en annan session. När jag
// kommer tillbaka ser jag att min prompt försvunnit från flödet ibland men ai har
// registrerat den."
//
// The mechanism, found in the code rather than guessed at: a sent prompt is pushed onto
// pane.turns IN MEMORY and only reaches the transcript file when the CLI writes it.
// Reloading did `pane.turns = turns` - a blunt replacement - so a reload landing in the
// window before the file caught up erased the prompt from view while the run carried on
// with it. That is both halves of his report: "sometimes", and "the AI got it".
//
// Reproducing the real race would need a live run and a lucky moment. The RACE is not the
// interesting part though - the destructive replacement is, and that is deterministic: hand
// the merge a file that is missing the tail and see whether the tail survives. So this
// drives the real function with the exact shapes the file can come back in.
//
// Run:  node scripts/e2e/test-reload-keeps-sent-prompt.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let exit = 0;
let app = null;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-reload-"));
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9499";
const { launch } = await import("./harness.mjs");

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const res = await app.eval(`(() => {
    const u = (t) => ({ role: "user", kind: "text", text: t });
    const a = (t) => ({ role: "assistant", kind: "text", text: t });
    // pending marks a turn this app pushed that the transcript file has not got yet - the
    // real flag, set by sendFromPane and by the streaming handler.
    const pu = (t) => ({ role: "user", kind: "text", text: t, pending: true });
    const pa = (t) => ({ role: "assistant", kind: "text", text: t, pending: true });
    const texts = (rows) => rows.map((r) => r.text);

    // The reported case: settled turns on file, and a prompt sent seconds ago that the file
    // has not got yet.
    const settled = [u("hello"), a("hi"), u("do the thing"), a("done")];
    const onScreen = [...settled, pu("and now this one")];

    // A run mid-flight: the prompt AND the first streamed reply are ahead of the file.
    const midFlight = [...settled, pu("another prompt"), pa("working on it")];

    return {
      lagging: texts(mergeReloadedTurns(onScreen, settled)),
      midFlight: texts(mergeReloadedTurns(midFlight, settled)),
      caughtUp: texts(mergeReloadedTurns(onScreen, [...settled, u("and now this one")])),
      grownOnFile: texts(mergeReloadedTurns(onScreen, [...settled, u("and now this one"), a("a reply")])),
      // THE REPORTED PATH, which the first version of this fix did not actually cover:
      // opening another session and coming back replaces the pane object entirely
      // (freshPane), so the pane arrives with NO turns and nothing to merge against. Only a
      // buffer kept per SESSION survives that round trip.
      acrossPaneRebuild: (() => {
        const sid = "sess-across";
        rememberPendingTurn(sid, pu("sent just before switching away"));
        return texts(mergeReloadedTurns([], settled, sid));
      })(),
      // And once the file catches up, the buffer lets go rather than becoming a second
      // transcript that shows the turn forever.
      bufferReleases: (() => {
        const sid = "sess-release";
        const sent = pu("will land in the file");
        rememberPendingTurn(sid, sent);
        const first = mergeReloadedTurns([], settled, sid);
        const second = mergeReloadedTurns([], [...settled, u("will land in the file")], sid);
        const third = mergeReloadedTurns([], [...settled, u("will land in the file")], sid);
        return { first: texts(first).length, second: texts(second), third: texts(third) };
      })(),
      // A rewind/fork legitimately SHORTENS the transcript. Nothing of it is pending, so the
      // cut turns must stay gone.
      rewound: texts(mergeReloadedTurns(settled, [u("hello"), a("hi")], "sess-rewind")),
      emptyBefore: texts(mergeReloadedTurns([], settled)),
      // An empty file with a pending prompt on screen: the prompt must live. A fresh
      // session's first send is exactly this shape - there is no file content yet at all.
      emptyFileWithPending: texts(mergeReloadedTurns([pu("first ever prompt")], [])),
      // An empty file with nothing pending is a genuinely empty transcript, and the screen
      // should follow it rather than keep showing turns that are no longer anywhere.
      emptyFileNothingPending: texts(mergeReloadedTurns(settled, [])),
      nulls: [
        Array.isArray(mergeReloadedTurns(null, settled)),
        Array.isArray(mergeReloadedTurns(onScreen, null)),
        Array.isArray(mergeReloadedTurns(null, null)),
      ],
      // The turn must survive as the SAME object, so nothing else that holds a reference
      // to it (the incremental renderer's identity check) is disturbed.
      identity: (() => {
        const sent = pu("keep me");
        const merged = mergeReloadedTurns([...settled, sent], settled);
        return merged[merged.length - 1] === sent;
      })(),
      // An AUTHORITATIVE reload (a turn that finished with a genuine result) trusts the
      // file completely and drops the streamed pending copies - the fix for the duplicate
      // output at the end of a conversation (bug b608c99b). The failing shape: a tool-heavy
      // turn writes >60 file entries after the streamed reply, so the tail-window match
      // misses it and the OLD merge re-appended the streamed copy after the file's own.
      authoritative: (() => {
        const sid = "sess-auth";
        const streamed = pa("the streamed reply");
        rememberPendingTurn(sid, streamed);
        const onScreenA = [...settled, streamed];
        const filler = Array.from({ length: 65 }, (_, i) => a("tool step " + i));
        const fileA = [...settled, a("the streamed reply"), ...filler];
        const merged = mergeReloadedTurns(onScreenA, fileA, sid, { authoritative: true });
        // A later ORDINARY reload must not resurrect it: the authoritative pass cleared
        // the per-session buffer so it cannot linger as a parallel copy.
        const followup = mergeReloadedTurns([], fileA, sid);
        return {
          dupes: merged.filter((t) => t.text === "the streamed reply").length,
          isFile: merged.length === fileA.length,
          bufferCleared: followup.length === fileA.length,
        };
      })(),
    };
  })()`);

  ok(
    res.lagging.includes("and now this one"),
    `a prompt the file has not caught up with SURVIVES the reload (${JSON.stringify(res.lagging)})`
  );
  ok(res.lagging.length === 5, `and nothing else is disturbed (${res.lagging.length} turns)`);
  ok(
    res.midFlight.join("|") === "hello|hi|do the thing|done|another prompt|working on it",
    `a mid-flight prompt AND its streamed reply both survive (${JSON.stringify(res.midFlight)})`
  );
  ok(res.caughtUp.length === 5, `once the file has it, it is not added twice (${res.caughtUp.length})`);
  ok(res.grownOnFile.length === 6, `and the file's own newer turns come through (${JSON.stringify(res.grownOnFile)})`);

  ok(
    res.acrossPaneRebuild.join("|") === "hello|hi|do the thing|done|sent just before switching away",
    `THE REPORTED PATH: the prompt survives switching away and back, where the pane itself was rebuilt (${JSON.stringify(res.acrossPaneRebuild)})`
  );
  ok(res.bufferReleases.first === 5, `it is shown while the file lacks it (${res.bufferReleases.first} turns)`);
  ok(
    res.bufferReleases.second.filter((t) => t === "will land in the file").length === 1,
    `and exactly once after the file catches up (${JSON.stringify(res.bufferReleases.second)})`
  );
  ok(
    res.bufferReleases.third.filter((t) => t === "will land in the file").length === 1,
    "the buffer let go rather than becoming a second transcript that repeats it forever"
  );
  ok(res.rewound.join("|") === "hello|hi", `a rewind stays short - the cut turns are gone on purpose (${JSON.stringify(res.rewound)})`);

  ok(res.emptyBefore.length === 4, "an empty pane takes the file as-is");
  ok(
    res.emptyFileWithPending.join("|") === "first ever prompt",
    `a first-ever prompt survives against an empty file (${JSON.stringify(res.emptyFileWithPending)})`
  );
  ok(
    res.emptyFileNothingPending.length === 0,
    `an empty file with nothing pending empties the view, rather than keeping turns that are nowhere (${JSON.stringify(res.emptyFileNothingPending)})`
  );

  // The flag has to be SET where turns are pushed, or the merge protects nothing. Checked
  // against the source because the push sites are inside event handlers this probe cannot
  // reach without a live run.
  const src = fs.readFileSync(new URL("../../src/renderer/renderer.js", import.meta.url), "utf8");
  ok(/text: prompt, pending: true/.test(src), "source: the sent prompt is pushed as pending");
  ok(/text: evt\.text, pending: true/.test(src), "source: streamed reply text is pending too");
  // Four push sites create turns locally: the sent prompt, streamed reply text, an error
  // turn and the "Stopped." turn. Every one has to be marked, or a reload can still delete
  // it - counted rather than eyeballed, because "I fixed the one he reported" is how this
  // class of bug survives.
  const marked = (src.match(/pending: true/g) || []).filter(() => true).length;
  ok(marked >= 5, `source: all four locally pushed turns are marked, plus the flag's own docs (${marked} mentions)`);
  ok(/text: "⚠ " \+ evt\.message, pending: true/.test(src), "source: an error turn is marked too");
  ok(/text: "⏹ Stopped\.", pending: true/.test(src), "source: and the stopped turn");
  ok((src.match(/rememberPendingTurn\(/g) || []).length >= 3, `source: the per-session buffer is written to, not just the pane (${(src.match(/rememberPendingTurn\(/g) || []).length} sites)`);
  ok(res.nulls.every(Boolean), "missing inputs return an array rather than throwing");
  ok(res.identity, "a kept turn stays the same object, so the incremental renderer's identity check is undisturbed");

  // The fix for the duplicate-at-conversation-end bug: an authoritative reload replaces.
  ok(res.authoritative.dupes === 1, `an authoritative reload shows the completed reply ONCE, not twice (${res.authoritative.dupes})`);
  ok(res.authoritative.isFile, "an authoritative reload takes the file as-is, even for a pending turn the tail window cannot match");
  ok(res.authoritative.bufferCleared, "and it clears the per-session buffer so a later reload cannot re-add the streamed copy");

  // Both call sites must use it. Fixing one and leaving the other is how this class of bug
  // survives its own fix - the "Show earlier messages" reload had the identical line.
  const rSrc = fs.readFileSync(new URL("../../src/renderer/renderer.js", import.meta.url), "utf8");
  const blunt = rSrc.split("\n").filter((l) => /^\s*pane\.turns = turns;/.test(l));
  ok(blunt.length === 0, `no blunt "pane.turns = turns" replacement is left anywhere (${blunt.length})`);
  // Both reload paths must still merge AND pass the session (the per-session buffer is
  // consulted). One of them now also passes { authoritative } - matched without the
  // closing paren so the extra arg does not read as a regression here.
  ok(
    (rSrc.match(/mergeReloadedTurns\(pane\.turns, turns, pane\.sessionId/g) || []).length === 2,
    `both reload paths merge and pass the session (${(rSrc.match(/mergeReloadedTurns\(pane\.turns, turns, pane\.sessionId/g) || []).length})`
  );
  // The completion path must reload AUTHORITATIVELY, or the duplicate returns.
  ok(
    /loadTranscriptInto\(index, \{ authoritative: true \}\)/.test(rSrc),
    "the done/success branch reloads authoritatively so the finished reply cannot render twice"
  );

  const errors = app.getConsoleErrors();
  ok(errors.length === 0, `no console errors (${errors.length})`);
  for (const e of errors) {
    console.log("   ", e.text.slice(0, 160));
  }
} catch (e) {
  exit = 1;
  console.error("ERR", e.stack || e.message);
} finally {
  try {
    await app?.close();
  } catch {}
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

console.log(
  exit === 0
    ? "VERIFY OK: a reload keeps a sent prompt the file has not caught up with, adds the file's newer turns, and still lets a rewind or a different session replace the view outright."
    : "VERIFY FAILED."
);
process.exit(exit);
