// E2E: a programmatically-inserted draft (openFreshDraftInPane) gives a visible
// cue - the composer shell flashes and the textarea is focused with the cursor
// at the end - so a silently-populated composer doesn't read as "nothing
// happened". Empty drafts get no flash. Real launched Maestro via CDP.
//
// Run:  node scripts/e2e/test-draft-flash-cue.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[draft-flash-e2e]", ...a);
}
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const hasFlash = () => app.eval(`!!document.querySelector('.pane[data-pane="0"] .composer-shell')?.classList.contains("composer-shell-draft-flash")`);

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  await app.eval(`(() => { navigateToPage("chat"); return true; })()`);
  await app.waitForSelector("#chatPage", 8000, { visible: true });

  // Non-empty draft: flash + focus + cursor at end.
  await app.eval(`(() => { openFreshDraftInPane(null, "A pre-written draft for E2E"); return true; })()`);
  assert(await hasFlash(), "composer shell gets the draft-flash cue on a non-empty draft");
  const focusInfo = await app.eval(`(() => {
    const ta = document.querySelector('.pane[data-pane="0"] .pane-composer textarea');
    return JSON.stringify({ focused: document.activeElement === ta, atEnd: ta && ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length, val: ta?.value || "" });
  })()`);
  const f = JSON.parse(focusInfo);
  log("focus:", focusInfo);
  assert(f.val === "A pre-written draft for E2E", "draft text landed in the composer");
  assert(f.focused, "composer textarea is focused after draft insert");
  assert(f.atEnd, "cursor is placed at the end of the draft");

  // Empty draft: no flash cue (nothing to draw attention to).
  await app.eval(`(() => { const s = document.querySelector('.pane[data-pane="0"] .composer-shell'); if (s) s.classList.remove("composer-shell-draft-flash"); openFreshDraftInPane(null, ""); return true; })()`);
  assert(!(await hasFlash()), "empty draft does NOT trigger the flash cue");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: draft-insert cue (flash + focus + cursor), skipped for empty drafts." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
