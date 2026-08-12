// Jumping into a freshly-created second mate must NOT hijack a session that
// belongs to ANOTHER node. The fallback (mostRecentSessionForCwd) picks the most
// recent session for the PROJECT, and bindSecondMateSession would then clear it
// from its real owner - stealing an active Captain "direct" session (or another
// first mate's second mate for the same repo). Aidin, 2026-08-12: "kommer den ta
// over en annan session ... under captain?".
//
// This seeds two nodes for ONE project - a "direct" (Captain) node that owns a
// session, and a fresh first-mate second mate - and drives the real
// jumpIntoSecondMate, asserting: (1) jumping into the fresh mate when the recent
// session is OWNED by the direct node starts FRESH (no steal); (2) a genuinely
// LOOSE session (owned by nobody) is still adopted, so the reconnect isn't broken.
//
// Run:  node scripts/e2e/test-jump-in-no-session-steal.mjs
import { launch } from "./harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { secondMateId } from "../../src/lib/secondMates.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-jump-steal-"));
const project = path.join(tmp, "proj");
fs.mkdirSync(project, { recursive: true });
const P = project.replace(/\\/g, "/");

const idDirect = secondMateId("direct", project); // the Captain node that OWNS a session
const idMate = secondMateId("mate_first1", project); // the fresh first-mate second mate
const OWNED = "sess-owned-by-captain";

const historyPath = path.join(tmp, "goal-run-history.json");
const bindingsPath = path.join(tmp, "second-mates.json");
const readBindings = () => JSON.parse(fs.readFileSync(bindingsPath, "utf8"));

try {
  // Both nodes need a crew run so deriveSecondMates surfaces them.
  fs.writeFileSync(
    historyPath,
    JSON.stringify([
      { goalRunId: "r-direct", projectPath: project, dispatchedBy: null, tier: "crew", status: "done" },
      { goalRunId: "r-mate", projectPath: project, dispatchedBy: "mate_first1", tier: "crew", status: "done" },
    ]),
    "utf8"
  );
  // The direct/Captain node OWNS the session; the first-mate node is a fresh proposal.
  fs.writeFileSync(
    bindingsPath,
    JSON.stringify({
      [idDirect]: { firstMateId: "direct", projectPath: project, sessionId: OWNED, status: "created" },
      [idMate]: { firstMateId: "mate_first1", projectPath: project, status: "proposed" },
    }),
    "utf8"
  );
  process.env.HELM_GOAL_RUN_HISTORY_PATH = historyPath;
  process.env.HELM_SECOND_MATES_PATH = bindingsPath;

  const app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // Stub the two openers (renderer globals) so we can see WHICH path jump-in took,
  // without doing real pane work.
  await app.eval(`(() => {
    window.__jump = {};
    openSessionInPane = (...a) => { window.__jump.opened = "session"; window.__jump.sid = a[0] && (a[0].cliSessionId || a[0].sessionId); };
    openFreshDraftInPane = () => { window.__jump.opened = "fresh"; };
    return true;
  })()`);

  // --- Scenario 1: the recent session is OWNED by the Captain node -> must NOT steal.
  await app.eval(`(() => {
    window.__jump = {};
    state.sessions = [{ sessionId: ${JSON.stringify(OWNED)}, cliSessionId: ${JSON.stringify(OWNED)}, cwd: ${JSON.stringify(P)}, isArchived: false, lastActivityAt: 1000 }];
    return true;
  })()`);
  await app.eval(`jumpIntoSecondMate({ secondMateId: ${JSON.stringify(idMate)}, projectPath: ${JSON.stringify(P)}, sessionId: null, name: "B" })`);
  await app.eval("new Promise(r => setTimeout(r, 500))");
  const s1 = await app.eval("window.__jump");
  ok(s1.opened === "fresh", `jumping into the fresh mate starts FRESH, does not adopt the Captain's session (opened=${s1.opened}, sid=${s1.sid || "-"})`);
  ok(readBindings()[idDirect].sessionId === OWNED, "the Captain node still OWNS its session (not stolen)");
  ok(!readBindings()[idMate].sessionId, "the fresh mate did not get bound to the stolen session");

  // --- Scenario 2: a genuinely LOOSE session (owned by nobody) -> still adopted.
  await app.eval(`(() => {
    window.__jump = {};
    state.sessions = [{ sessionId: "sess-loose", cliSessionId: "sess-loose", cwd: ${JSON.stringify(P)}, isArchived: false, lastActivityAt: 2000 }];
    return true;
  })()`);
  await app.eval(`jumpIntoSecondMate({ secondMateId: ${JSON.stringify(idMate)}, projectPath: ${JSON.stringify(P)}, sessionId: null, name: "B" })`);
  await app.eval("new Promise(r => setTimeout(r, 500))");
  const s2 = await app.eval("window.__jump");
  ok(s2.opened === "session" && s2.sid === "sess-loose", `a loose session owned by nobody is still adopted - reconnect intact (opened=${s2.opened}, sid=${s2.sid})`);

  const errors = app.getConsoleErrors();
  ok(errors.length === 0, `no console errors (${errors.length})`);
  await app.close();
} catch (e) {
  exit = 1;
  console.error("ERR", e.stack || e.message);
} finally {
  delete process.env.HELM_GOAL_RUN_HISTORY_PATH;
  delete process.env.HELM_SECOND_MATES_PATH;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

console.log(exit === 0 ? "VERIFY OK: jump-in never steals another node's session, but still adopts a loose one." : "VERIFY FAILED.");
process.exit(exit);
