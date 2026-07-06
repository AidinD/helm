// E2E: the Plan "Artifact HTML" textarea keeps its pasted content after you
// click Load mockup (it used to clear on the load re-render, losing your input).
// Real launched Maestro via CDP.
//
// Run:  node scripts/e2e/test-lavish-input-persist.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[lavish-persist-e2e]", ...a);
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

const SAMPLE = "<h1>Persist me</h1>";

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  await app.eval(`(() => { lavishState.pastedHtml = ""; lavishState.srcdoc = null; navigateToPage("lavish"); return true; })()`);
  await app.waitForSelector("#lavishPage .lavish-html-input", 8000);

  // Type into the textarea (dispatch input so lavishState.pastedHtml updates).
  await app.eval(`(() => {
    const ta = document.querySelector("#lavishPage .lavish-html-input");
    ta.value = ${JSON.stringify(SAMPLE)};
    ta.dispatchEvent(new Event("input"));
    return true;
  })()`);
  assert((await taVal()) === SAMPLE, "textarea holds the pasted HTML before load");

  // Click Load mockup, wait for the mockup to render (re-render happens here).
  await app.eval(`(() => { [...document.querySelectorAll("#lavishPage .goal-start-btn")].find(b => b.textContent === "Load mockup")?.click(); return true; })()`);
  await app.waitForSelector("#lavishFrame", 8000, { visible: true });

  // The textarea must STILL hold the pasted HTML (previously it cleared).
  const after = await taVal();
  log("textarea after load:", JSON.stringify(after));
  assert(after === SAMPLE, "textarea still holds the pasted HTML after Load mockup (not wiped)");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: pasted HTML persists across the load re-render." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  await app.eval(`localStorage.removeItem("maestro.lavish.recentMockups")`).catch(() => {});
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
