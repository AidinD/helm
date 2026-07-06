// E2E: R2 - the command palette (Cmd/Ctrl+K) opens over a real launched
// Maestro, fuzzy-filters commands, is keyboard-navigable, runs a command
// (navigation), and closes cleanly. Real launched Maestro/CDP.
//
// Run:  node scripts/e2e/test-command-palette.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[command-palette-e2e]", ...a);
}
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const count = (sel) => app.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const isHidden = (sel) => app.eval(`document.querySelector(${JSON.stringify(sel)}).classList.contains("hidden")`);

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  // #commandPalette is static markup, so wait for renderer readiness (the
  // palette functions defined) before driving it - the element can exist
  // before renderer.js has finished executing.
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (await app.eval(`typeof cmdkOpen === "function"`)) {
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  // Starts hidden.
  assert(await isHidden("#commandPalette"), "palette starts hidden");

  // Ctrl+K opens it (via the real global keydown handler).
  await app.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }))`);
  assert(!(await isHidden("#commandPalette")), "Ctrl+K opens the palette");
  assert((await count("#cmdkList .cmdk-row")) > 0, "the registry populates the list (nav commands at least)");

  // Fuzzy filter narrows the list; row 0 is selected.
  await app.eval(`(() => { const i = document.getElementById("cmdkInput"); i.value = "dash"; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  const rows = await app.eval(`[...document.querySelectorAll("#cmdkList .cmdk-row .cmdk-row-label")].map(e => e.textContent)`);
  assert(rows.length > 0 && rows.every((t) => /dash/i.test(t.replace(/\\s/g, "")) || /d.*a.*s.*h/i.test(t)), "filter 'dash' narrows to matching commands (got: " + JSON.stringify(rows) + ")");
  assert((await count("#cmdkList .cmdk-row.is-selected")) === 1, "exactly one row is selected");
  const sel0 = await app.eval(`document.querySelector("#cmdkList .cmdk-row").classList.contains("is-selected")`);
  assert(sel0, "the first row is selected after filtering");

  // Enter runs the selected command (Go to Dashboard/Overview) and closes.
  await app.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))`);
  assert(await isHidden("#commandPalette"), "running a command closes the palette");
  assert(!(await isHidden("#dashboardPage")), "the navigation command actually navigated (dashboard visible)");

  // Reopen, Escape closes and clears the input.
  await app.eval(`cmdkOpen(); document.getElementById("cmdkInput").value = "leftover";`);
  await app.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  assert(await isHidden("#commandPalette"), "Escape closes the palette");
  const clearedVal = await app.eval(`document.getElementById("cmdkInput").value`);
  assert(clearedVal === "", "the input is cleared on close");

  // No-match shows a quiet empty row.
  await app.eval(`(() => { cmdkOpen(); const i = document.getElementById("cmdkInput"); i.value = "zzzqqqxyw"; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  assert((await count("#cmdkList .cmdk-empty")) === 1, "no-match shows a 'No matches' row");
  assert((await count("#cmdkList .cmdk-row")) === 0, "no command rows render on no-match");
  await app.eval(`cmdkClose()`);

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: command palette opens, filters, navigates, and closes." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
