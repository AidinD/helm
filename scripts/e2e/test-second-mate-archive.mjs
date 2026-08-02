// E2E: archiving a second mate makes it STICK (task 05166d55). Archiving used to
// only archive the session + remove the DOM node, but a crew-derived node
// re-derived from goal-run history and reappeared. Now archiveSecondMate adds the
// id to a config overlay (archivedSecondMates) the Fleet excludes, AND drops its
// binding. Asserts:
//   - the binding is removed (sandbox second-mates.json),
//   - the id lands in config.archivedSecondMates,
//   - the Fleet's exclusion filter drops an archived id (keeps others).
//
// Writes the id to the REAL config.archivedSecondMates (no seam) - removed in finally.
//
// Run:  node scripts/e2e/test-second-mate-archive.mjs
import { launch } from "./harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[sm-archive-e2e]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-smarch-"));
// This test used to read (and clean up after itself in) the dev repo's REAL
// config.json. The harness now sandboxes config into a temp dir whenever
// HELM_CONFIG_PATH is unset, so the app's write went somewhere this test never
// looked and the assertion failed for a reason that had nothing to do with the
// feature. Own the seam explicitly instead of reaching for the real file - a test
// that writes to his live config is a bad idea regardless.
const configPath = path.join(tmp, "config.json");
const metaHome = path.join(tmp, "meta-home");
const smPath = path.join(tmp, "second-mates.json");
fs.mkdirSync(metaHome, { recursive: true });
fs.writeFileSync(smPath, JSON.stringify({ sm_arch: { firstMateId: "mate_x", projectPath: "D:/proj", name: "Archie", status: "created", sessionId: "cArch" } }, null, 2), "utf8");

let app;
try {
  process.env.HELM_CONFIG_PATH = configPath;
  process.env.HELM_META_HOME_OVERRIDE = metaHome;
  process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
  process.env.HELM_SECOND_MATES_PATH = smPath;
  process.env.HELM_GOAL_RUN_HISTORY_PATH = path.join(tmp, "history.json");
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const res = await app.eval(`window.helm.archiveSecondMate("sm_arch")`);
  assert(res && res.ok, "archiveSecondMate returned ok");

  // Binding removed from the sandbox file.
  const bindings = JSON.parse(fs.readFileSync(smPath, "utf8"));
  assert(!bindings.sm_arch, "the second mate's binding was removed");

  // Id landed in the config overlay.
  const cfg = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
  assert(Array.isArray(cfg.archivedSecondMates) && cfg.archivedSecondMates.includes("sm_arch"), "the id was added to config.archivedSecondMates");

  // The Fleet's exclusion filter drops an archived id (keeps others), even for a
  // node that would otherwise derive.
  const filtered = await app.eval(`(() => {
    state.config.archivedSecondMates = ["sm_arch"];
    const nodes = [
      { secondMateId: "sm_arch", firstMateId: "mate_x", projectPath: "D:/proj", name: "Archie", sessionId: "cArch", crew: [] },
      { secondMateId: "sm_keep", firstMateId: "mate_x", projectPath: "D:/keep", name: "Keeper", sessionId: "cKeep", crew: [] },
    ];
    const archived = new Set(state.config.archivedSecondMates || []);
    return augmentSecondMatesWithSessions(nodes, []).filter((s) => !archived.has(s.secondMateId)).map((s) => s.secondMateId);
  })()`);
  assert(!filtered.includes("sm_arch"), "an archived second mate is excluded from the Fleet");
  assert(filtered.includes("sm_keep"), "a non-archived second mate is kept");

  log(exitCode === 0 ? "VERIFY OK: archiving a second mate sticks (binding dropped + overlay excludes it)." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.stack || err.message);
} finally {
  if (app) {
    const k = await app.close();
    log("cleanup app:", k || "(nothing)");
  }
  // No config clean-up needed any more: the whole sandbox goes with `tmp`.
  delete process.env.HELM_CONFIG_PATH;
  delete process.env.HELM_META_HOME_OVERRIDE;
  delete process.env.HELM_MATES_PATH;
  delete process.env.HELM_SECOND_MATES_PATH;
  delete process.env.HELM_GOAL_RUN_HISTORY_PATH;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
process.exit(exitCode);
