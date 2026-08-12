// DUAL-MODE: a relay and a jump-in must resolve to ONE session, and never run at once.
//
// From the "Helm flow review" list of honest remaining gaps (task 2ef31b5c). Every other item
// on that list shipped; these three never became tests. This is the one that can corrupt data:
// if a relay turn and a jump-in both run against the same second mate, two `claude --resume`
// processes write the same transcript file, and a transcript is not something you can repair
// afterwards.
//
// The guard exists - runRelayTurn takes a lock keyed on the bound session id, and also on
// "sm:<id>" for a mate with no session yet, so a fresh relay that mints its session mid-turn
// still blocks a concurrent jump-in (both noted as ship-review findings when they were
// written). Nothing ever proved it.
//
// It runs for free: HELM_CLAUDE_BIN points the launcher at a stub that emits the stream-json
// shape and holds the turn open. No model, no tokens.
//
// It launches the app, so it runs in the SLOW lane.
// Run:  node scripts/e2e/test-relay-jumpin-one-session.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-dualmode-"));
const metaHome = path.join(tmp, "meta-home");
const project = path.join(tmp, "proj");
fs.mkdirSync(path.join(metaHome, ".helm-dispatch", "requests"), { recursive: true });
fs.mkdirSync(project, { recursive: true });

const MATE_ID = "mate_dualmode";
const SESSION_ID = "dualmode-session-1";

process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
process.env.HELM_SECOND_MATES_PATH = path.join(tmp, "second-mates.json");
process.env.HELM_GOAL_RUN_HISTORY_PATH = path.join(tmp, "goal-run-history.json");
process.env.HELM_META_HOME_OVERRIDE = metaHome;
process.env.HELM_E2E_PORT = "9375";
// The stub, and a turn long enough to observe the lock it holds.
process.env.HELM_CLAUDE_BIN = path.join(here, "fixtures", "fake-claude.cmd");
process.env.FAKE_CLAUDE_HOLD_MS = "6000";

const { secondMateId } = await import("../../src/lib/secondMates.js");
const { launch } = await import("./harness.mjs");

const SM_ID = secondMateId(MATE_ID, project);

fs.writeFileSync(process.env.HELM_CONFIG_PATH, JSON.stringify({}), "utf8");
// A first mate to be the relay's parent - a relay only makes sense mate -> second mate.
fs.writeFileSync(
  process.env.HELM_MATES_PATH,
  JSON.stringify([{ mateId: MATE_ID, slot: 0, name: "Dualmode", root: metaHome, status: "active", createdAt: Date.now(), sessionId: "mate-session" }]),
  "utf8"
);
// The second mate, already bound to a session - so relay and jump-in have the same target.
fs.writeFileSync(
  process.env.HELM_SECOND_MATES_PATH,
  JSON.stringify({ [SM_ID]: { firstMateId: MATE_ID, projectPath: project, name: "proj", status: "created", sessionId: SESSION_ID } }),
  "utf8"
);
fs.writeFileSync(process.env.HELM_GOAL_RUN_HISTORY_PATH, "[]", "utf8");

let app = null;
try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // --- both paths agree on WHICH session -------------------------------------
  const target = await app.eval(`window.helm.listSecondMates().then(r => {
    const sm = (r.secondMates || []).find(s => s.secondMateId === ${JSON.stringify(SM_ID)});
    return sm ? { id: sm.secondMateId, sessionId: sm.sessionId || null } : null;
  })`);
  ok(target && target.sessionId === SESSION_ID, `the second mate resolves to one bound session (${JSON.stringify(target)}) - this is the id BOTH a relay and a jump-in must land on`);

  // --- start a relay, which takes the lock -----------------------------------
  const reqDir = path.join(metaHome, ".helm-dispatch", "requests");
  const dispatchId = `e2e-dual-${Date.now()}`;
  fs.writeFileSync(
    path.join(reqDir, `${dispatchId}.json`),
    JSON.stringify({ dispatchId, kind: "relay", project, message: "hello from the first mate", dispatchedBy: MATE_ID, callerTier: "first-mate", at: Date.now() }),
    "utf8"
  );

  // Wait for the app's watcher to pick it up and the turn to be running.
  let running = false;
  for (let i = 0; i < 60; i++) {
    running = await app.eval(`window.helm.getSessions().then(r => (r.sessions||[]).some(s => (s.cliSessionId === ${JSON.stringify(SESSION_ID)} || s.sessionId === ${JSON.stringify(SESSION_ID)}) && s.status === "active"))`);
    if (running) {
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  ok(running, "the relay turn is running against that session");

  // --- THE GUARD: a jump-in must be refused while it runs --------------------
  const jump = await app.eval(`window.helm.startSession({
    cwd: ${JSON.stringify(project.replace(/\\/g, "/"))},
    prompt: "a jump-in landing on the same session",
    resumeSessionId: ${JSON.stringify(SESSION_ID)}
  })`);
  ok(
    jump && jump.ok === false,
    `a jump-in on that session is REFUSED while the relay holds it (${JSON.stringify(jump).slice(0, 160)}) - if it were allowed, two claude --resume processes would write the same transcript, and a corrupted transcript cannot be repaired`
  );
  ok(/busy|turn/i.test(String(jump?.error || "")), `and the refusal says why (${jump?.error || "no reason given"})`);

  // --- and it is a LOCK, not a permanent block -------------------------------
  let freed = null;
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 250));
    freed = await app.eval(`window.helm.startSession({
      cwd: ${JSON.stringify(project.replace(/\\/g, "/"))},
      prompt: "after the relay finished",
      resumeSessionId: ${JSON.stringify(SESSION_ID)}
    })`);
    if (freed?.ok) {
      break;
    }
  }
  ok(freed?.ok === true, `once the relay's turn ends the same session accepts a jump-in again (${JSON.stringify(freed).slice(0, 120)}) - the guard is a lock, not a dead end`);

  // --- RELAY DELIVERY, the second gap on the same list ------------------------
  // "Själva mekanismen finns (runRelayTurn), men att meddelandet kommer FRAM är inte
  // verifierat." The app acknowledges a dispatch it has actually taken, so an ack for this
  // request is the delivery receipt: the first mate's message reached its second mate and a
  // turn ran on it. Read from disk rather than from the app, so it is the same evidence the
  // dispatching first mate would see.
  const ackDir = path.join(metaHome, ".helm-dispatch", "acks");
  let ack = null;
  for (let i = 0; i < 40; i++) {
    try {
      const hit = fs.readdirSync(ackDir).find((f) => f.includes(dispatchId));
      if (hit) {
        ack = JSON.parse(fs.readFileSync(path.join(ackDir, hit), "utf8"));
        break;
      }
    } catch {
      // the dir appears when the first ack is written
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  ok(!!ack, `the relay was acknowledged back to the first mate (${ack ? JSON.stringify(ack).slice(0, 140) : "no ack file appeared"}) - the message reached the second mate rather than being queued and forgotten`);
} finally {
  if (app) {
    await app.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(
  exit === 0
    ? "VERIFY OK: a relay and a jump-in resolve to one session, and cannot run against it at the same time."
    : "VERIFY FAILED."
);
process.exit(exit);
