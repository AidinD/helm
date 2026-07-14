// E2E: a session handoff is saved to <cwd>/HANDOFF.md and OVERWRITES (latest-
// only), so it never grows the way appending into DECISIONS.md did (the captain
// 2026-07-14 - Skiff's DECISIONS.md had bloated with transient handoff
// narrative). Drives the real context:saveHandoff IPC via a launched Helm.
//
// Run:  node scripts/e2e/test-handoff-file.mjs
import { launch } from "./harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[handoff-file-e2e]", ...a);
}
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-handoff-"));
try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const cwd = tmp.replace(/\\/g, "/");
  const first = await app.eval(`window.helm.saveHandoff(${JSON.stringify(cwd)}, "FIRST handoff - state A")`);
  assert(first && first.ok, `saveHandoff writes HANDOFF.md (got ${JSON.stringify(first)})`);
  const afterFirst = fs.readFileSync(path.join(tmp, "HANDOFF.md"), "utf8");
  assert(/FIRST handoff - state A/.test(afterFirst), "the first handoff text is in HANDOFF.md");
  assert(/# Handoff - latest session state/.test(afterFirst), "HANDOFF.md carries the latest-state header");
  assert(/Overwritten on each handoff/.test(afterFirst), "the header explains it's overwritten (latest-only)");

  // A SECOND handoff must OVERWRITE, not append.
  await app.eval(`window.helm.saveHandoff(${JSON.stringify(cwd)}, "SECOND handoff - state B")`);
  const afterSecond = fs.readFileSync(path.join(tmp, "HANDOFF.md"), "utf8");
  assert(/SECOND handoff - state B/.test(afterSecond), "the second handoff text is in HANDOFF.md");
  assert(!/FIRST handoff - state A/.test(afterSecond), "the first handoff is GONE - overwritten, not appended (won't grow)");
  assert((afterSecond.match(/# Handoff - latest session state/g) || []).length === 1, "exactly one handoff header (not stacked)");

  // Empty text is a no-op error (doesn't clobber with an empty file).
  const empty = await app.eval(`window.helm.saveHandoff(${JSON.stringify(cwd)}, "   ")`);
  assert(empty && empty.ok === false, "empty handoff text is rejected, not saved");
  assert(/SECOND handoff/.test(fs.readFileSync(path.join(tmp, "HANDOFF.md"), "utf8")), "the prior handoff survives an empty-save attempt");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  log(exitCode === 0 ? "VERIFY OK: handoffs land in HANDOFF.md and overwrite (latest-only)." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  await app.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
process.exit(exitCode);
