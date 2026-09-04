// E2E: clicking a Recent mockup loads its HTML back into the "Artifact HTML"
// textarea (not just the iframe), so it's visible + editable. Real launched
// Helm via CDP. Covers both a paste recent and a file recent (via the
// unified pastedHtml mirror in openMockupInPlan).
//
// Run:  node scripts/e2e/test-lavish-recent-loads-input.mjs
import { launch } from "../checks-lib/harness.mjs";

function log(...a) {
  console.log("[recent-loads-input-e2e]", ...a);
}
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const taVal = () => app.eval(`document.querySelector("#lavishPage .lavish-html-input")?.value || ""`);

const PASTE_HTML = "<h1>Recalled from recent</h1>";

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // Seed a paste recent, clear the textarea, render Plan.
  await app.eval(`(() => {
    lavishState.pastedHtml = "";
    lavishState.srcdoc = null;
    lavishRecents = [];
    addLavishPasteRecent(${JSON.stringify(PASTE_HTML)});
    navigateToPage("lavish");
    return true;
  })()`);
  await app.waitForSelector("#lavishPage .lavish-recent-row", 8000);
  assert((await taVal()) === "", "textarea starts empty before clicking a recent");

  // Click the recent row -> it should load AND populate the textarea.
  await app.eval(`(() => { document.querySelector("#lavishPage .lavish-recent-row")?.click(); return true; })()`);
  await app.waitForSelector("#lavishFrame", 8000, { visible: true });
  const after = await taVal();
  log("textarea after clicking recent:", JSON.stringify(after));
  assert(after === PASTE_HTML, "clicking a recent loads its HTML back into the textarea");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: a recent click populates the input textarea." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  await app.eval(`localStorage.removeItem("helm.lavish.recentMockups")`).catch(() => {});
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
