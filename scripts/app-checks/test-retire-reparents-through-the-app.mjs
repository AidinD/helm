// E2E (deterministic, no API turns): retiring a first mate RE-PARENTS its second-mate
// subtree onto the successor, through the real IPC.
//
// THIS FILE USED TO ASSERT THE OPPOSITE, and that is the point of reading its history rather
// than just its assertions. Task 58e9a433 chose teardown: retiring a seat archived its second
// mates' sessions and deleted their bindings. That was reversed on 2026-09-04 - a child keeps
// its identity and changes its parent, because rehashing a node strands the binding that holds
// its sessionId, and tearing one down destroys work whose only sin was that its coordinator
// was refreshed. So the outcome this check demands is inverted from what it was written for.
//
// IT IS KEPT RATHER THAN DELETED because what it covers is not covered elsewhere.
// scripts/pure-checks/test-retire-reparents-the-subtree.mjs proves the LOGIC re-parents; this
// drives the real `retireMate` IPC in a running app and reads the bindings file on disk, so it
// proves the WIRING. A pure check cannot tell you the handler is hooked up.
//
// Seeds two second-mate bindings under a first mate - one "created" with a session, one
// "proposed" - then retires the mate and asserts:
//   - nothing is torn down: tornDownSessionIds comes back empty,
//   - both bindings survive, under the successor's id rather than the retired seat's,
//   - and they keep their own ids, because re-parenting must not re-key a node.
// Crew autopilot runs were never torn down either; this test doesn't seed any.
//
// Uses the HELM_SECOND_MATES_PATH / HELM_GOAL_RUN_HISTORY_PATH test seams, so it
// touches only sandbox files. It DOES archive the fake session id in the real
// config (applySessionArchive has no seam) - cleaned up in finally.
//
// Run:  node scripts/e2e/test-retire-teardown.mjs
import { launch } from "../checks-lib/harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[retire-reparents-e2e]", ...a);
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

  // Retire (clean, no persona). The handler re-parents the subtree onto the successor.
  const retireRes = await app.eval(`window.helm.retireMate(${JSON.stringify(mate0.mateId)}, null, null)`);
  log("retire result:", JSON.stringify(retireRes));
  assert(retireRes && retireRes.ok, "retire succeeded");
  // ASSERTED AS EMPTY, not merely as "does not include the session". A field that came back
  // undefined would satisfy the weaker phrasing while telling us nothing about whether the
  // teardown path is really gone.
  assert(
    Array.isArray(retireRes.tornDownSessionIds) && retireRes.tornDownSessionIds.length === 0,
    `nothing was torn down (tornDownSessionIds=${JSON.stringify(retireRes?.tornDownSessionIds)})`
  );

  // `mate` is the SUCCESSOR, not the seat that was retired - retireAndRespawn returns the one
  // now on watch. Worth naming, because the first version of this check looked for a
  // `successor` field, got null, and reported "the retire minted a successor (null)" about a
  // successor that was right there under another name.
  const successorId = retireRes?.mate?.mateId || null;
  assert(!!successorId && successorId !== mate0.mateId, `the retire minted a successor (${successorId})`);

  const after = JSON.parse(fs.readFileSync(smPath, "utf8"));
  assert(!!after.sm_test_created, "the engaged second mate's binding survived the retire");
  assert(!!after.sm_test_proposed, "and so did the proposed one");
  assert(
    after.sm_test_created?.sessionId === "smsess_teardown_1",
    `and it kept the session it was holding (${after.sm_test_created?.sessionId})`
  );

  // AND THE STORED PARENT IS UNCHANGED, which is the design and not an oversight. Re-parenting
  // is resolved at READ time; the bindings file is history and history is not rewritten. That
  // is why the derivation below is the assertion that matters - a check that only read this
  // file would conclude the re-parenting never happened, and a "fix" that made this file agree
  // would be rewriting the past to satisfy a test.
  assert(
    after.sm_test_created?.firstMateId === mate0.mateId,
    `while the binding on disk still names the seat that dispatched it (${after.sm_test_created?.firstMateId}) - routed on read, never rewritten`
  );

  // And they derive under the successor rather than under the retired seat - the property the
  // ids alone cannot show, because a binding can carry the right parent while the derivation
  // that builds the tree still reads the old one.
  const derived = await app.eval(`(async () => {
    const r = await window.helm.listSecondMates();
    const list = (r && r.secondMates) || [];
    return list
      .filter((s) => s.secondMateId === "sm_test_created" || s.secondMateId === "sm_test_proposed")
      .map((s) => ({ id: s.secondMateId, parent: s.firstMateId }));
  })()`);
  log("derived after retire:", JSON.stringify(derived));
  assert(derived.length === 2, `both still derive after the retire (${derived.length})`);
  assert(
    derived.every((d) => d.parent === successorId),
    `and both hang under the successor (${JSON.stringify(derived.map((d) => d.parent))})`
  );
  assert(
    derived.every((d) => d.id === "sm_test_created" || d.id === "sm_test_proposed"),
    "with their own ids unchanged - re-parenting must not re-key a node, or the binding holding its sessionId is stranded"
  );

  // Clean up the fake archived session id from the real config (no seam for it).
  try {
    await app.eval(`window.helm.archiveSession("smsess_teardown_1", false)`);
  } catch {}

  log(exitCode === 0 ? "VERIFY OK: retire re-parents the subtree onto the successor - nothing torn down, nothing re-keyed, and the store not rewritten." : "VERIFY FAILED.");
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
