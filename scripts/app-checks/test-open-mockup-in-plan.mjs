// E2E: a mockup can be opened straight into the Plan (Lavish) view in one
// action - both from raw HTML (openMockupInPlan) and from a file on disk
// (openMockupFileInPlan, the path a generated artifact takes). Real launched
// Helm via CDP. Starts on Dashboard and confirms the call switches to Plan
// and renders the sandboxed mockup iframe.
//
// Arg: absolute path to a sample .html mockup. With none given the test writes
// its OWN temp mockup and cleans it up - it used to default to a hardcoded path
// inside one session's scratchpad, which vanished with that session and made the
// file-open half fail with "File not found" for everyone after.
// Run:  node scripts/e2e/test-open-mockup-in-plan.mjs [path-to-mock.html]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch } from "../checks-lib/harness.mjs";

let ownTempFile = null;
const MOCK_FILE =
  process.argv[2] ||
  (() => {
    ownTempFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "helm-mockopen-")), "mock-sample.html");
    fs.writeFileSync(ownTempFile, "<!doctype html><html><body><h1 id='mm'>Mock from file</h1></body></html>", "utf8");
    return ownTempFile;
  })();

function log(...a) {
  console.log("[open-mockup-e2e]", ...a);
}
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const isHidden = (id) => app.eval(`!!document.getElementById(${JSON.stringify(id)})?.classList.contains("hidden")`);

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  // Start away from Plan so we can prove the call switches to it.
  await app.eval(`(() => { navigateToPage("dashboard"); return true; })()`);
  await app.waitForSelector("#dashboardPage", 8000, { visible: true });

  // (1) Raw-HTML path.
  const r1 = await app.eval(`openMockupInPlan("<h1 id='mm'>Mock from HTML</h1>")`);
  log("openMockupInPlan ->", JSON.stringify(r1));
  assert(r1 && r1.ok === true, "openMockupInPlan returns ok");
  assert(!(await isHidden("lavishPage")), "Plan view is now visible");
  assert(await isHidden("dashboardPage"), "Dashboard view was switched away from");
  await app.waitForSelector("#lavishFrame", 8000, { visible: true });
  assert(!!(await app.eval(`!!document.getElementById("lavishFrame")`)), "sandboxed mockup iframe (#lavishFrame) is present");

  // (2) File-on-disk path (what a generated artifact takes). Go back to
  //     Dashboard first so success is provably a re-switch to Plan.
  await app.eval(`(() => { navigateToPage("dashboard"); return true; })()`);
  await app.waitForSelector("#dashboardPage", 8000, { visible: true });
  const r2 = await app.eval(`openMockupFileInPlan(${JSON.stringify(MOCK_FILE)})`);
  log("openMockupFileInPlan ->", JSON.stringify(r2));
  assert(r2 && r2.ok === true, "openMockupFileInPlan reads the file and returns ok");
  assert(!(await isHidden("lavishPage")), "Plan view visible after opening the file");
  await app.waitForSelector("#lavishFrame", 8000, { visible: true });
  assert(!!(await app.eval(`!!document.getElementById("lavishFrame")`)), "mockup iframe present after file open");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: mockups open straight into the Plan view (HTML + file)." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
  if (ownTempFile) {
    try {
      fs.rmSync(path.dirname(ownTempFile), { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  }
}
process.exit(exitCode);
