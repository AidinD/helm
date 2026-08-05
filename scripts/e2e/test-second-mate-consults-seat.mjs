// E2E (LIVE): can a real second-mate session, launched by the app, actually
// consult an advisory seat?
//
// Aidin, 2026-08-04: "jag skulle vilja att en 2nd mate ska kunna invoka en agent
// med en persona. Så 2nd mate ska själv kunna be en architect granska jobb."
//
// The unit test (test-persona-advisory-seats.mjs) can only see that main.js
// contains the line that attaches the seats. That is a source-level claim about a
// launch flag, and a launch flag that never reaches the process looks identical in
// the source to one that does - the reason this file exists. Here the app builds
// the launch itself, a real session runs, and the transcript says whether a seat
// was reached.
//
// It also re-checks the containment where it actually matters: after a real
// consult inside a real project root, the project must be byte-identical.
//
// One cheap claude turn (haiku) plus the seat's own.
//
// Run:  node scripts/e2e/test-second-mate-consults-seat.mjs
import { launch } from "./harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[seat-consult-e2e]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function findTranscript(cliSessionId) {
  const root = path.join(os.homedir(), ".claude", "projects");
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else if (e.name === `${cliSessionId}.jsonl`) {
        return p;
      }
    }
  }
  return null;
}

// Every sub-agent call in the transcript, with the seat it addressed. A "Task"
// or "Agent" tool_use IS the consult (see src/lib/subAgents.js, which reads the
// same shape to show sub-agents in the Fleet).
function consults(transcriptText) {
  const found = [];
  for (const line of transcriptText.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(t);
    } catch {
      continue;
    }
    for (const b of entry?.message?.content || []) {
      if (b?.type === "tool_use" && /^(Task|Agent)$/i.test(b.name || "")) {
        found.push(String(b.input?.subagent_type || b.input?.agent || "(unnamed)"));
      }
    }
  }
  return found;
}

// What the seat actually answered. Read from the tool_result that closes the
// sub-agent call, which is the seat's OWN words - not the caller's paraphrase of
// them, and not a renderer field (the first version of this test asserted on
// state.sessions' lastAssistantText, which is empty on this path: an assertion
// pointed at the wrong surface fails exactly like a broken feature).
function seatAnswer(transcriptText) {
  const agentCallIds = new Set();
  const answers = [];
  // A BACKGROUND sub-agent returns launch metadata instead of a verdict - the
  // answer arrives on a later turn that a one-shot `-p` session never has
  // (measured 2026-08-04: one run collected 1120 chars of "async agent launched
  // successfully" and no judgment at all). So metadata has to be stripped before
  // judging the answer, or an empty consult passes a length assertion.
  //
  // Strip it PER ITEM, not from the joined text: a synchronous result arrives as
  // TWO items - the seat's answer, then an `agentId:` footer for continuing the
  // conversation. Testing the join dropped the real answer along with the footer
  // and reported "no answer" for a consult that had worked, twice.
  const isMetadataItem = (s) => /^\s*(async agent launched|agentId:)/i.test(s) || /^\s*<usage>/i.test(s);
  for (const line of transcriptText.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(t);
    } catch {
      continue;
    }
    for (const b of entry?.message?.content || []) {
      if (b?.type === "tool_use" && /^(Task|Agent)$/i.test(b.name || "") && b.id) {
        agentCallIds.add(b.id);
      }
      if (b?.type === "tool_result" && agentCallIds.has(b.tool_use_id)) {
        const c = b.content;
        const items = typeof c === "string" ? [c] : Array.isArray(c) ? c.map((x) => x?.text || "") : [];
        const verdict = items.filter((s) => s && !isMetadataItem(s)).join("\n");
        if (verdict) {
          answers.push(verdict);
        }
      }
    }
  }
  return answers.join("\n");
}

// A snapshot of every file, so "the seat changed nothing" is a comparison rather
// than an impression.
function snapshot(dir) {
  const out = {};
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") {
        continue;
      }
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else {
        out[path.relative(dir, p)] = fs.readFileSync(p, "utf8");
      }
    }
  }
  return out;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-seatconsult-"));
const metaHome = path.join(tmp, "meta-home");
const projectDir = path.join(tmp, "some-project");
fs.mkdirSync(metaHome, { recursive: true });
fs.mkdirSync(projectDir, { recursive: true });
// Something with an obvious flaw, so the seat has a real thing to say and the
// consult is not answerable from the prompt alone.
fs.writeFileSync(
  path.join(projectDir, "PLAN.md"),
  "# Plan\n\nStore every user's password in plain text in users.json so login stays simple.\nWe will add encryption later if anyone complains.\n",
  "utf8"
);

let app;
try {
  process.env.HELM_META_HOME_OVERRIDE = metaHome;
  process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
  process.env.HELM_SECOND_MATES_PATH = path.join(tmp, "second-mates.json");
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const beforeFiles = snapshot(projectDir);
  const before = new Set(
    await app.eval(`(state.sessions || []).filter((s) => s.cliSessionId || s.sessionId).map((s) => s.cliSessionId || s.sessionId)`)
  );

  // The instruction is explicit about USING the seat: this test is about whether
  // the capability is reachable, not about whether a haiku session would think of
  // it unprompted (that judgment lives in the manual, which is unit-tested).
  await app.eval(`window.helm.startSession({
    cwd: ${JSON.stringify(projectDir)},
    secondMateId: "sm_test_consult",
    prompt: "Consult the architect subagent about PLAN.md in this directory - ask it whether the plan is sound. Run it synchronously (run_in_background: false) and wait for its answer. Then reply with its verdict in one sentence. Do not edit any files yourself.",
    // Sonnet, not Haiku. This test asks whether --agents reaches the process and whether the seat
    // can be reached BY NAME - not whether a cheap model bothers to follow an instruction. On
    // Haiku/low it passed four times standalone and then reached no sub-agent at all inside the
    // full sweep, which made a capability check flaky on model whim. A real second mate runs on the
    // capable model anyway, so this now matches the tier it is testing.
    model: "claude-sonnet-5",
    effort: "low"
  })`);

  let smId = null;
  for (let i = 0; i < 80; i++) {
    await wait(3000);
    const ids = await app.eval(`(() => {
      const norm = (p) => (p || "").replace(/[\\\\/]+$/,"").toLowerCase();
      return (state.sessions || [])
        .filter((x) => (x.cliSessionId || x.sessionId) && norm(x.cwd) === norm(${JSON.stringify(projectDir)}) && x.status !== "active")
        .map((x) => x.cliSessionId || x.sessionId);
    })()`);
    const fresh = ids.find((id) => !before.has(id));
    if (fresh) {
      smId = fresh;
      break;
    }
  }
  assert(!!smId, `the second-mate session completed (${smId})`);

  const tx = smId ? findTranscript(smId) : null;
  assert(!!tx, "its transcript was found");

  // The session being marked finished does not mean the CLI has flushed its last
  // lines. Measured: a read at that instant saw the Agent tool_use but not yet the
  // tool_result carrying the seat's answer, and the test reported "no answer" for a
  // consult that had in fact worked - a race that reads exactly like a broken
  // feature. Wait for the answer to land, and only then judge it.
  let text = "";
  for (let i = 0; i < 20; i++) {
    text = tx ? fs.readFileSync(tx, "utf8") : "";
    if (seatAnswer(text).trim()) {
      break;
    }
    await wait(1000);
  }
  const seats = tx ? consults(text) : [];

  assert(seats.length > 0, `it reached a sub-agent at all - so --agents survived the trip from main.js to the process (${seats.join(", ") || "none"})`);
  assert(
    seats.some((s) => /architect/i.test(s)),
    `and specifically the architect SEAT, addressed by its persona key (${seats.join(", ") || "none"})`
  );

  // What the seat is for: a judgment the caller did not have. A plan this bad
  // should not come back approved, and the seat should have READ the file rather
  // than answering from the one-line brief it was handed.
  const answer = tx ? seatAnswer(text) : "";
  assert(
    answer.trim().length > 0,
    `the seat's answer came back IN THIS TURN - a synchronous consult, not a backgrounded one whose verdict nobody sees (${answer.length} chars)`
  );
  assert(
    /insecure|plain ?text|unsound|not sound|vulnerab|risk|flaw|reject|weak|hash/i.test(answer),
    `and it is critical rather than agreeable (${JSON.stringify(answer.replace(/\s+/g, " ").slice(0, 200))})`
  );
  assert(
    /PLAN\.md|users\.json|password/i.test(answer),
    "and it engaged with the actual file, not just the question"
  );

  // The containment, in the place it matters: a real project root, after a real
  // consult. A seat that "advises" and edits is not an advisory seat.
  const afterFiles = snapshot(projectDir);
  const changed = Object.keys(afterFiles).filter((f) => afterFiles[f] !== beforeFiles[f]);
  const added = Object.keys(afterFiles).filter((f) => !(f in beforeFiles));
  assert(changed.length === 0, `the consult changed no file in the project (${changed.join(", ") || "none changed"})`);
  assert(added.length === 0, `and created none (${added.join(", ") || "none added"})`);

  log(
    exitCode === 0
      ? "VERIFY OK: a real second mate reached the architect seat by name, got a critical verdict back, and the project was untouched."
      : "VERIFY FAILED: root-cause whether the seats reached the launch (main.js) or the seat was never called."
  );
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.stack || err.message);
} finally {
  if (app) {
    const k = await app.close();
    log("cleanup app:", k || "(nothing)");
  }
  delete process.env.HELM_META_HOME_OVERRIDE;
  delete process.env.HELM_MATES_PATH;
  delete process.env.HELM_SECOND_MATES_PATH;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
process.exit(exitCode);
