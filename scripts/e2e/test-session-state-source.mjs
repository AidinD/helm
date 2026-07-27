// E2E (real app): FSM increment 5 through the actual IPC, not just the pure module
// (Epic f3d096fa). The unit test proves the projection; this proves the SIGNALS
// reach it - that sessions:get stamps helmOwned, lifecycleState and stateSource on
// every row, and that BOTH halves of the hybrid are real: a seeded Helm-owned
// session reads as owned, while the rest of the board reads as foreign.
//
// The seeding matters. The harness hands the app a throwaway config (so a test
// can't pollute the dev repo's), which means helmSessions is empty and EVERY row is
// legitimately foreign - so a test that just looks at the live board can never
// observe the tracked half at all, and would pass while ownership was broken. So
// this writes its own config with one known session marked as Helm-launched.
// Run: node scripts/e2e/test-session-state-source.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch } from "./harness.mjs";
import { isWorkingState, isArchiveSuggestState } from "../../src/lib/sessionState.js";
import { readAllSessions } from "../../src/lib/sessions.js";

let app;
let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails++;
  }
};

const STATES = ["launching", "working", "waiting", "wrapped", "idle", "archived"];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-fsm-"));

try {
  // Pick a real session off the board to claim as Helm-launched. Transcripts are
  // NOT isolated by the harness, so a session the library can see is a session the
  // app will see.
  const seed = (readAllSessions().sessions || []).find((s) => s.sessionId && s.status !== "archived");
  if (!seed) {
    console.log("SKIP - no non-archived session on this machine to seed ownership with");
    process.exit(0);
  }
  const configPath = path.join(tmp, "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      helmSessions: {
        [seed.sessionId]: {
          sessionId: seed.sessionId,
          cliSessionId: seed.cliSessionId || seed.sessionId,
          cwd: seed.cwd || "D:/Repo/Tools/helm",
          model: "claude-sonnet-5",
          effort: "low",
          permissionMode: "auto",
          title: "[fsm-e2e] seeded owned session",
        },
      },
    }),
    "utf8"
  );
  process.env.HELM_CONFIG_PATH = configPath;

  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const res = await app.eval(`window.helm.getSessions()`);
  const rows = res?.sessions || [];
  ok(rows.length > 0, `sessions:get returned rows (${rows.length})`);

  // Every row carries the three fields. A missing field is worse than a wrong one:
  // a surface reading `undefined` silently falls through to its default branch.
  const badState = rows.filter((s) => !STATES.includes(s.lifecycleState));
  ok(badState.length === 0, `every row has a valid lifecycleState (${badState.length} bad: ${badState.slice(0, 2).map((s) => s.lifecycleState).join(",")})`);
  const badSource = rows.filter((s) => s.stateSource !== "tracked" && s.stateSource !== "derived");
  ok(badSource.length === 0, `every row has a valid stateSource (${badSource.length} bad)`);
  const badOwned = rows.filter((s) => typeof s.helmOwned !== "boolean");
  ok(badOwned.length === 0, `every row has a boolean helmOwned (${badOwned.length} bad)`);

  // Both halves of the hybrid, on real data through the real IPC.
  const owned = rows.filter((s) => s.helmOwned);
  const seedRow = rows.find((s) => s.sessionId === seed.sessionId);
  console.log(`     (board: ${rows.length} sessions, ${owned.length} helm-owned)`);
  ok(!!seedRow, "the seeded session is on the board");
  ok(seedRow?.helmOwned === true, "the seeded session reads as helm-owned - the config->IPC ownership path works");
  ok(owned.length >= 1 && owned.length < rows.length,
    `ownership is per session, not blanket (${owned.length} of ${rows.length})`);
  // The one direction that would be an outright false claim of authority.
  const lyingForeign = rows.filter((s) => !s.helmOwned && s.stateSource === "tracked");
  ok(lyingForeign.length === 0, `no foreign session claims to be 'tracked' (${lyingForeign.length} did)`);
  // Ownership alone is not a live signal: an owned session with no turn in flight is
  // still 'derived', because its status came from the file heuristic like any other.
  ok(seedRow?.stateSource === "derived",
    `an owned session with nothing in flight is still 'derived' (got ${seedRow?.stateSource}) - ownership is not a claim of live knowledge`);

  // The decision helpers must agree with the state on real data.
  const contradictory = rows.filter((s) => isWorkingState(s.lifecycleState) && isArchiveSuggestState(s.lifecycleState));
  ok(contradictory.length === 0, `no row is both working and archive-suggest (${contradictory.length})`);
  const launchingRows = rows.filter((s) => s.lifecycleState === "launching");
  ok(launchingRows.every((s) => s.helmOwned), `any launching row is helm-owned (${launchingRows.length} launching)`);

  const errs = app.getConsoleErrors();
  ok(errs.length === 0, `no console errors${errs.length ? ": " + errs[0].text.slice(0, 240) : ""}`);
} catch (e) {
  fails++;
  console.error("ERR", e.stack || e.message);
} finally {
  if (app) {
    await app.close();
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
console.log(fails === 0 ? "\nVERIFY OK: both halves of the hybrid reach the renderer - a seeded launch reads owned, the rest read foreign, and none claims false authority." : `\nVERIFY FAILED (${fails})`);
process.exit(fails === 0 ? 0 : 1);
