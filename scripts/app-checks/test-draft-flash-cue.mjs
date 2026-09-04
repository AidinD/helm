// E2E: a programmatically-inserted draft (openFreshDraftInPane) gives a visible
// cue - the composer shell flashes and the textarea is focused with the cursor
// at the end - so a silently-populated composer doesn't read as "nothing
// happened". Empty drafts (e.g. a fresh session from the Dashboard) get the
// same flash + a "New session started" toast, not silence. Real launched
// Helm via CDP.
//
// Run:  node scripts/e2e/test-draft-flash-cue.mjs
import { launch } from "../checks-lib/harness.mjs";

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

  // A toast fired too (the reliable "something happened" signal, visible
  // wherever you're looking - the flash alone was too easy to miss).
  const toastText = await app.eval(`[...document.querySelectorAll(".toast")].map(t => t.textContent).join(" | ")`);
  log("toast:", JSON.stringify(toastText));
  assert(/Draft loaded/.test(toastText), "a 'Draft loaded' toast appears on draft insert");

  // Empty draft (e.g. a fresh session from the Dashboard): still flashes,
  // and gets its own toast wording instead of the empty-composer silence
  // that used to read as "the button did nothing".
  await app.eval(`(() => { const s = document.querySelector('.pane[data-pane="0"] .composer-shell'); if (s) s.classList.remove("composer-shell-draft-flash"); openFreshDraftInPane(null, ""); return true; })()`);
  assert(await hasFlash(), "empty draft still triggers the flash cue");
  const emptyToastText = await app.eval(`[...document.querySelectorAll(".toast")].map(t => t.textContent).join(" | ")`);
  log("toast:", JSON.stringify(emptyToastText));
  assert(/New session started/.test(emptyToastText), "a 'New session started' toast appears on empty-draft insert");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: draft-insert cue (flash + focus + cursor), including empty drafts." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
