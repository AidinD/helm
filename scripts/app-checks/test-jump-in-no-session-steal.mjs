// Jumping into a freshly-created second mate must NOT hijack a session that
// belongs to ANOTHER node. The fallback (mostRecentSessionForCwd) picks the most
// recent session for the PROJECT, and bindSecondMateSession would then clear it
// from its real owner - stealing an active Captain "direct" session (or another
// first mate's second mate for the same repo). The captain, 2026-08-12: "kommer den ta
// over en annan session ... under captain?".
//
// THE TWO NODES CHANGED, THE PROPERTY DID NOT. This used to seed a "direct" (Captain) node
// and a per-first-mate node for the same project, which were two nodes because a project's
// node was keyed by WHO dispatched to it. Since 2026-09-04 it is keyed by LANE, so those two
// collapsed into one and this check called secondMateId with a dispatcher - which the lane
// guard now refuses outright, so it failed before asserting anything at all. The scheduled
// app lane reported that for two nights.
//
// The steal it guards is still reachable, between the two nodes that DO exist for one project:
// the AUTO lane, where an autopilot run has a session, and the PROJECT lane, which is where he
// jumps in himself. So it seeds those - the auto node owning a session, the project node fresh -
// and drives the real jumpIntoSecondMate, asserting: (1) jumping into the fresh node when the
// recent session is OWNED by the other one starts FRESH (no steal); (2) a genuinely LOOSE
// session (owned by nobody) is still adopted, so the reconnect isn't broken.
//
// Run:  node scripts/e2e/test-jump-in-no-session-steal.mjs
import { launch } from "../checks-lib/harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { secondMateId, PROJECT_LANE, AUTO_LANE } from "../../src/lib/secondMates.js";

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

const idOwner = secondMateId(AUTO_LANE, project); // the auto node, which OWNS a session
const idMate = secondMateId(PROJECT_LANE, project); // the project's own node, fresh
const OWNED = "sess-owned-by-captain";

const historyPath = path.join(tmp, "goal-run-history.json");
const bindingsPath = path.join(tmp, "second-mates.json");
const readBindings = () => JSON.parse(fs.readFileSync(bindingsPath, "utf8"));

try {
  // Both nodes need a crew run so deriveSecondMates surfaces them.
  fs.writeFileSync(
    historyPath,
    JSON.stringify([
      { goalRunId: "r-auto", projectPath: project, dispatchedBy: null, startedBy: "auto", tier: "crew", status: "done" },
      { goalRunId: "r-project", projectPath: project, dispatchedBy: null, tier: "crew", status: "done" },
    ]),
    "utf8"
  );
  // The auto node OWNS the session; the project's own node is a fresh proposal.
  fs.writeFileSync(
    bindingsPath,
    JSON.stringify({
      [idOwner]: { firstMateId: AUTO_LANE, projectPath: project, sessionId: OWNED, status: "created" },
      [idMate]: { firstMateId: PROJECT_LANE, projectPath: project, status: "proposed" },
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

  // --- Scenario 1: the recent session is OWNED by the auto node -> must NOT steal.
  await app.eval(`(() => {
    window.__jump = {};
    state.sessions = [{ sessionId: ${JSON.stringify(OWNED)}, cliSessionId: ${JSON.stringify(OWNED)}, cwd: ${JSON.stringify(P)}, isArchived: false, lastActivityAt: 1000 }];
    return true;
  })()`);
  await app.eval(`jumpIntoSecondMate({ secondMateId: ${JSON.stringify(idMate)}, projectPath: ${JSON.stringify(P)}, sessionId: null, name: "B" })`);
  await app.eval("new Promise(r => setTimeout(r, 500))");
  const s1 = await app.eval("window.__jump");
  ok(s1.opened === "fresh", `jumping into the fresh mate starts FRESH, does not adopt the auto node session (opened=${s1.opened}, sid=${s1.sid || "-"})`);
  ok(readBindings()[idOwner].sessionId === OWNED, "the auto node still OWNS its session (not stolen)");
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
