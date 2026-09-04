// LIVE-EXEMPT: it does start a session, but HELM_CLAUDE_BIN points the launcher at
// fixtures/fake-claude, so no model is reached and nothing is spent - the reason this
// transition never had a test is that the real binary costs tokens on every suite run.
//
// RETIRE WITH CARRY-OVER: the outgoing first mate must really run its final summary turn.
//
// SIBLING, and read this before adding to either: test-retire-carryover.mjs already asserts
// the same thing against the REAL CLI. I did not find it before writing this one, which was a
// miss - the task said the transition had never been tested, and I took that at face value
// instead of looking. The two now split deliberately by cost: that one proves the real binary
// behaves and costs two live turns, so it only runs under --live and in practice never ran at
// all; this one proves the machinery around the turn and costs nothing, so it runs in every
// sweep. The names are one hyphen apart, hence the -stubbed suffix.
//
// The third and last of the "honest remaining gaps" from the Helm flow review (task 2ef31b5c),
// and the second of the two that lose data SILENTLY: if the summary is skipped, the retire
// still looks like it worked - the mate is gone, a fresh one is there - and the handoff is
// simply missing, with nothing to notice. Same class as the handoff bug the captain found.
//
// It also pins what changed on 2026-08-12: a first mate's own summary is now saved as a
// DURABLE handoff document, not only as the one-shot pendingHandoff that seeds its
// successor's composer. Its second mates have had that since task 663ab4b6; the coordinating
// mate above them did not, which is backwards - it holds the thread the others hang off, and
// its knowledge lived exactly one successor deep and then was gone.
//
// It launches the app, so it runs in the SLOW lane.
// Run:  node scripts/e2e/test-retire-carry-over.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-retire-"));
const metaHome = path.join(tmp, "meta-home");
fs.mkdirSync(metaHome, { recursive: true });

const MATE_ID = "mate_retire_e2e";
const SESSION_ID = "retire-e2e-session";

process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
process.env.HELM_SECOND_MATES_PATH = path.join(tmp, "second-mates.json");
process.env.HELM_GOAL_RUN_HISTORY_PATH = path.join(tmp, "goal-run-history.json");
process.env.HELM_META_HOME_OVERRIDE = metaHome;
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9377";
process.env.HELM_CLAUDE_BIN = path.join(here, "fixtures", "fake-claude.cmd");
process.env.FAKE_CLAUDE_HOLD_MS = "200";

fs.writeFileSync(process.env.HELM_CONFIG_PATH, JSON.stringify({}), "utf8");
fs.writeFileSync(
  process.env.HELM_MATES_PATH,
  // { mates: [...] }, NOT a bare array: readState treats a bare array as legacy data and
  // forces every entry to slot:null/status:"retired", so the seed is silently ignored and
  // the app mints fresh mates instead.
  JSON.stringify({
    mates: [
      { mateId: MATE_ID, slot: 0, name: "Retiring Mate", root: metaHome, status: "active", createdAt: Date.now(), sessionId: SESSION_ID },
    ],
  }),
  "utf8"
);
fs.writeFileSync(process.env.HELM_SECOND_MATES_PATH, "{}", "utf8");
fs.writeFileSync(process.env.HELM_GOAL_RUN_HISTORY_PATH, "[]", "utf8");

const { launch } = await import("../checks-lib/harness.mjs");

let app = null;
try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const before = await app.eval(`window.helm.listMates().then(r => (r.active||[]).map(m => ({ id: m.mateId, name: m.name, pending: !!m.pendingHandoff })))`);
  ok(before.some((m) => m.id === MATE_ID), `the mate is on the roster before the retire (${JSON.stringify(before)})`);

  // The retire itself, through the same function the menu calls.
  await app.eval(`(async () => {
    const r = await window.helm.listMates();
    const mate = (r.active || []).find(m => m.mateId === ${JSON.stringify(MATE_ID)});
    await retireMateWithCarryOver(mate, null);
    return true;
  })()`);

  // --- 1. the summary turn RAN ------------------------------------------------
  // Observable as the successor's pendingHandoff: retireMate stores the summary there, so
  // text in it can only have come from a turn that actually happened. A skipped summary
  // leaves it empty, and the retire looks identical otherwise - which is the whole hazard.
  let after = [];
  for (let i = 0; i < 40; i++) {
    after = await app.eval(`window.helm.listMates().then(r => (r.active||[]).map(m => ({ id: m.mateId, name: m.name, pending: m.pendingHandoff || null })))`);
    if (after.some((m) => m.pending)) {
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const successor = after.find((m) => m.pending);
  ok(
    !!successor,
    `the outgoing mate's final summary turn RAN and its text reached the successor (${JSON.stringify(after)}) - if it is silently skipped the retire still looks successful and the handoff is simply gone`
  );
  ok(/fake-claude reply/.test(String(successor?.pending || "")), `and the carried text is what the turn produced (${JSON.stringify(String(successor?.pending || "").slice(0, 60))})`);
  ok(!after.some((m) => m.id === MATE_ID), "the retired mate is off the active roster");

  // --- 2. and it was ALSO written as a durable document ----------------------
  const dir = path.join(metaHome, ".helm", "handoffs");
  let files = [];
  for (let i = 0; i < 40; i++) {
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      files = [];
    }
    if (files.length) {
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  ok(
    files.length > 0,
    `the first mate's own handoff is saved as a durable document too (${JSON.stringify(files)}) - its second mates have had this since task 663ab4b6; without it a first mate's knowledge lived exactly one successor deep`
  );
  const body = files.length ? fs.readFileSync(path.join(dir, files[0]), "utf8") : "";
  ok(/fake-claude reply/.test(body), "and the document holds the summary the turn produced, so it can be read back later rather than only seeding a composer once");
} finally {
  if (app) {
    await app.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(
  exit === 0
    ? "VERIFY OK: retiring with carry-over really runs its summary turn, and the first mate's own handoff survives as a document."
    : "VERIFY FAILED."
);
process.exit(exit);
