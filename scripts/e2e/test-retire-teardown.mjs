// E2E (deterministic, no API turns): retiring a first mate TEARS DOWN its
// second-mate subtree (task 58e9a433, option 3). Seeds two second-mate bindings
// under a first mate - one "created" with a session, one "proposed" - then
// retires the mate and asserts:
//   - the created second mate's session id comes back in tornDownSessionIds
//     (its session was archived),
//   - both bindings are removed (no lingering proposals / hidden orphans).
// Crew autopilot runs are intentionally NOT torn down; this test doesn't seed any.
//
// Uses the HELM_SECOND_MATES_PATH / HELM_GOAL_RUN_HISTORY_PATH test seams, so it
// touches only sandbox files. It DOES archive the fake session id in the real
// config (applySessionArchive has no seam) - cleaned up in finally.
//
// Run:  node scripts/e2e/test-retire-teardown.mjs
import { launch } from "./harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[retire-teardown-e2e]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-teardown-"));
const metaHome = path.join(tmp, "meta-home");
const smPath = path.join(tmp, "second-mates.json");
const historyPath = path.join(tmp, "goal-run-history.json");
fs.mkdirSync(metaHome, { recursive: true });
fs.writeFileSync(historyPath, "[]", "utf8");

let app;
try {
  process.env.HELM_META_HOME_OVERRIDE = metaHome;
  process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
  process.env.HELM_SECOND_MATES_PATH = smPath;
  process.env.HELM_GOAL_RUN_HISTORY_PATH = historyPath;
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // The first mate we'll retire.
  const mate0 = await app.eval(`(async () => {
    for (let i = 0; i < 40; i++) {
      const r = await window.helm.listMates();
      const m = (r.active || []).find((x) => x.slot === 0) || (r.active || [])[0];
      if (m) return m;
      await new Promise(res => setTimeout(res, 150));
    }
    return null;
  })()`);
  assert(mate0 && mate0.mateId, `found the slot-0 first mate (${mate0?.mateId})`);

  // Seed two second mates UNDER this first mate: one engaged (has a session),
  // one merely proposed. Both must have projectPath to be derived.
  const bindings = {
    sm_test_created: { firstMateId: mate0.mateId, projectPath: "D:/dinghy", name: "Dinghy mate", sessionId: "smsess_teardown_1", status: "created" },
    sm_test_proposed: { firstMateId: mate0.mateId, projectPath: "D:/loom", name: "Loom mate", status: "proposed" },
  };
  fs.writeFileSync(smPath, JSON.stringify(bindings, null, 2), "utf8");

  // Sanity: both derive as second mates under this mate before retire.
  const before = await app.eval(`(async () => {
    const r = await window.helm.listSecondMates();
    const list = (r && r.secondMates) || [];
    return list.filter((s) => s.firstMateId === ${JSON.stringify(mate0.mateId)}).map((s) => s.secondMateId);
  })()`);
  assert(before.includes("sm_test_created") && before.includes("sm_test_proposed"), `both second mates derive under the mate before retire (${JSON.stringify(before)})`);

  // Retire (clean, no persona). The handler tears down the subtree first.
  const retireRes = await app.eval(`window.helm.retireMate(${JSON.stringify(mate0.mateId)}, null, null)`);
  log("retire result:", JSON.stringify(retireRes));
  assert(retireRes && retireRes.ok, "retire succeeded");
  assert(Array.isArray(retireRes.tornDownSessionIds) && retireRes.tornDownSessionIds.includes("smsess_teardown_1"), `the engaged second mate's session was archived on retire (tornDownSessionIds=${JSON.stringify(retireRes?.tornDownSessionIds)})`);

  // Bindings file on disk: both must be gone (no lingering proposal / orphan).
  const after = JSON.parse(fs.readFileSync(smPath, "utf8"));
  assert(!after.sm_test_created, "the engaged second mate's binding was removed");
  assert(!after.sm_test_proposed, "the proposed second mate's binding was removed");

  // And they no longer derive under the (now-retired) mate.
  const stillThere = await app.eval(`(async () => {
    const r = await window.helm.listSecondMates();
    const list = (r && r.secondMates) || [];
    return list.some((s) => s.secondMateId === "sm_test_created" || s.secondMateId === "sm_test_proposed");
  })()`);
  assert(stillThere === false, "neither second mate lingers in the derived list after retire");

  // Clean up the fake archived session id from the real config (no seam for it).
  try {
    await app.eval(`window.helm.archiveSession("smsess_teardown_1", false)`);
  } catch {}

  log(exitCode === 0 ? "VERIFY OK: retire tears down the second-mate subtree (session archived + bindings removed)." : "VERIFY FAILED.");
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
  delete process.env.HELM_GOAL_RUN_HISTORY_PATH;
  // The teardown now writes torn-down ids to the real config.archivedSecondMates
  // overlay (no seam) - remove the test ids so real config isn't polluted.
  try {
    const configPath = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "..", "config.json");
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (Array.isArray(cfg.archivedSecondMates)) {
        cfg.archivedSecondMates = cfg.archivedSecondMates.filter((x) => x !== "sm_test_created" && x !== "sm_test_proposed");
        fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      }
    }
  } catch {}
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
process.exit(exitCode);
