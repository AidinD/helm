// E2E through the real app: un-archiving a session must bring it back EVERYWHERE,
// not just in the sidebar.
//
// Found by the captain on 2026-07-28: he un-archived "Träning och kost (Hevy)" and it still
// did not appear under Captain. Cause: there are two independent archive lists -
// `archivedSessions` for the session, and `archivedSecondMates` for its node in the
// Fleet view, keyed "sess_<id>". Archiving from the Fleet button writes the second;
// un-archiving the session only ever cleared the first. So the session came back in
// one view and stayed invisible in the one he actually uses.
//
// A one-way overlay is the mirror image of the bug the overlay was introduced to fix
// ("archive keeps coming back"), which is why this test asserts the ROUND TRIP rather
// than just the un-archive call.
//
// Run: node scripts/e2e/test-unarchive-clears-fleet.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch } from "./harness.mjs";

let app;
let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails++;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-unarch-"));
const configPath = path.join(tmp, "config.json");
process.env.HELM_CONFIG_PATH = configPath;
process.env.HELM_E2E_PORT = "9374";

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // Pick a real, non-archived session off the board to round-trip. Its own ids are
  // what the Fleet node is keyed on, so a synthetic id would not exercise the bug.
  const target = await app.eval(`(async () => {
    const res = await window.helm.getSessions();
    const s = (res?.sessions || []).find(x => x.sessionId && !x.isArchived);
    return s ? { sessionId: s.sessionId, cliSessionId: s.cliSessionId || null, title: s.title } : null;
  })()`);
  if (!target) {
    console.log("SKIP - no non-archived session on this machine to round-trip");
    process.exit(0);
  }
  console.log(`     (round-tripping "${(target.title || "").slice(0, 40)}")`);

  const readCfg = () => (fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {});
  const nodeIds = [target.sessionId, target.cliSessionId].filter(Boolean).map((id) => `sess_${id}`);

  // Simulate what the Fleet's own Archive button does: park the NODE, not the session.
  // This is the state the captain was actually in.
  const before = readCfg();
  fs.writeFileSync(
    configPath,
    JSON.stringify({ ...before, archivedSecondMates: [...(before.archivedSecondMates || []), nodeIds[0]] }),
    "utf8"
  );
  ok(readCfg().archivedSecondMates.includes(nodeIds[0]), "the fleet node is parked, the way the Fleet Archive button parks it");

  // Now archive and un-archive the SESSION, which is the action he took.
  await app.eval(`window.helm.archiveSession(${JSON.stringify(target.sessionId)}, true)`);
  ok((readCfg().archivedSessions || []).includes(target.sessionId), "archiving the session records it");

  await app.eval(`window.helm.archiveSession(${JSON.stringify(target.sessionId)}, false)`);
  const after = readCfg();
  ok(!(after.archivedSessions || []).includes(target.sessionId), "un-archiving clears the session's own entry");
  // THE ACTUAL BUG: this list was left untouched, so Fleet/Captain kept hiding it.
  const stillParked = (after.archivedSecondMates || []).filter((x) => nodeIds.includes(x));
  ok(stillParked.length === 0, `un-archiving ALSO clears the fleet node (still parked: ${JSON.stringify(stillParked)})`);

  // And the session is genuinely visible again, through the same call the views use.
  const visible = await app.eval(`(async () => {
    const res = await window.helm.getSessions();
    const s = (res?.sessions || []).find(x => x.sessionId === ${JSON.stringify(target.sessionId)});
    return s ? { isArchived: s.isArchived, status: s.status } : null;
  })()`);
  ok(visible && visible.isArchived === false, `the session reads as not archived (${JSON.stringify(visible)})`);
  ok(visible.status !== "archived", "and its status is not archived");

  // Both id forms are cleared, because the node is built from whichever the session
  // exposes - guessing wrong leaves it hidden and is exactly how this shipped.
  if (target.cliSessionId) {
    const cfg2 = readCfg();
    fs.writeFileSync(
      configPath,
      JSON.stringify({ ...cfg2, archivedSecondMates: [...(cfg2.archivedSecondMates || []), `sess_${target.cliSessionId}`] }),
      "utf8"
    );
    await app.eval(`window.helm.archiveSession(${JSON.stringify(target.sessionId)}, false)`);
    const left = (readCfg().archivedSecondMates || []).filter((x) => x === `sess_${target.cliSessionId}`);
    ok(left.length === 0, "the OTHER id form is cleared too, given only the session id");
  }

  // Archiving must NOT start parking fleet nodes as a side effect - that would make
  // the Fleet button's own state unrecoverable in the other direction.
  const cfg3 = readCfg();
  const parkedCount = (cfg3.archivedSecondMates || []).length;
  await app.eval(`window.helm.archiveSession(${JSON.stringify(target.sessionId)}, true)`);
  ok((readCfg().archivedSecondMates || []).length === parkedCount, "archiving a session does not park its fleet node as a side effect");
  await app.eval(`window.helm.archiveSession(${JSON.stringify(target.sessionId)}, false)`);

  const errs = app.getConsoleErrors();
  ok(errs.length === 0, `no console errors${errs.length ? ": " + errs[0].text.slice(0, 200) : ""}`);
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
console.log(fails === 0 ? "\nVERIFY OK: un-archiving a session clears both overlays, so it comes back in the Fleet too." : `\nVERIFY FAILED (${fails})`);
process.exit(fails === 0 ? 0 : 1);
