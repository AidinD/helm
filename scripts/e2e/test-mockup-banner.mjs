// E2E: option A - when a session writes a mockup HTML file, the pane shows an
// "Open in Plan" banner that opens the mockup in the annotator. Real launched
// Helm via CDP. Tests the mockup-path heuristic, the banner render, and the
// click-through to Plan. (The tool_use -> showMockupBanner wiring is a one-line
// gate on isMockupPath; here we drive showMockupBanner directly with a real
// file, since simulating a full session launch isn't worth it.)
//
// Arg: absolute path to a sample .html mockup (defaults to the bundled one).
// Run:  node scripts/e2e/test-mockup-banner.mjs [path-to-mock.html]
import { launch } from "./harness.mjs";

const MOCK_FILE =
  process.argv[2] ||
  "C:/Users/aidin/AppData/Local/Temp/claude/D--Dropbox-Mina-Dokument-Claude/f260acf8-62c5-48c9-80fd-1589d8af917f/scratchpad/mock-sample.html";

function log(...a) {
  console.log("[mockup-banner-e2e]", ...a);
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

  // (1) The mockup-path heuristic: narrow to *mockup*.html.
  const heur = await app.eval(`JSON.stringify({
    a: isMockupPath("C:/x/dashboard-mockup.html"),
    b: isMockupPath("D:/repo/Vision-MOCKUP.HTML"),
    c: isMockupPath("C:/x/index.html"),
    d: isMockupPath("C:/x/mockup.txt"),
    e: isMockupPath(undefined)
  })`);
  const h = JSON.parse(heur);
  log("heuristic:", heur);
  assert(h.a === true && h.b === true, "matches *mockup*.html (any case)");
  assert(h.c === false && h.d === false && h.e === false, "ignores non-mockup html, non-html, and undefined");

  // (2) On the Chat view, drive a detected mockup on pane 0 and confirm the
  //     banner shows with an "Open in Plan" action.
  await app.eval(`(() => { navigateToPage("chat"); return true; })()`);
  await app.waitForSelector("#chatPage", 8000, { visible: true });
  await app.waitForSelector('.pane[data-pane="0"] .pane-mockup-banner', 8000);
  await app.eval(`showMockupBanner(0, ${JSON.stringify(MOCK_FILE)})`);
  const bannerHidden = await app.eval(`!!document.querySelector('.pane[data-pane="0"] .pane-mockup-banner')?.classList.contains("hidden")`);
  assert(bannerHidden === false, "mockup banner is shown after a mockup write");
  const bannerText = await app.eval(`document.querySelector('.pane[data-pane="0"] .pane-mockup-banner .pane-mockup-label')?.textContent || ""`);
  log("banner text:", JSON.stringify(bannerText));
  assert(/Mockup generated:/.test(bannerText), "banner names the generated mockup file");

  // (3) Click "Open in Plan" -> switches to Plan and renders the mockup iframe.
  await app.click('.pane[data-pane="0"] .pane-mockup-banner .text-btn');
  await app.waitForSelector("#lavishFrame", 8000, { visible: true });
  assert(!(await isHidden("lavishPage")), "clicking 'Open in Plan' switches to the Plan view");
  assert(!!(await app.eval(`!!document.getElementById("lavishFrame")`)), "the mockup iframe is rendered in Plan");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: mockup write -> 'Open in Plan' banner -> annotator." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
