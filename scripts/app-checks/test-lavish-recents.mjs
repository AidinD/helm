// E2E: the Plan "Recent" list remembers both file-path loads AND pasted-HTML
// loads (each reloadable in one click), most-recent-first, deduped, capped at
// 5, and migrates the old string[] localStorage format. Real launched Helm
// via CDP.
//
// Run:  node scripts/e2e/test-lavish-recents.mjs
import { launch } from "../checks-lib/harness.mjs";

function log(...a) {
  console.log("[lavish-recents-e2e]", ...a);
}
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const rowCount = () => app.eval(`document.querySelectorAll("#lavishPage .lavish-recent-row").length`);

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // Old string[] format migrates to the object shape.
  const migrated = await app.eval(`(() => {
    localStorage.setItem("helm.lavish.recentMockups", JSON.stringify(["C:\\\\old\\\\legacy-mockup.html"]));
    const r = loadLavishRecents();
    return JSON.stringify(r);
  })()`);
  log("migration:", migrated);
  const m = JSON.parse(migrated);
  assert(m.length === 1 && m[0].kind === "file" && /legacy-mockup\.html$/.test(m[0].path), "old string[] entries migrate to { kind:'file', path }");

  // Seed one file + one paste via the runtime helpers, then render Plan.
  await app.eval(`(() => {
    lavishRecents = [];
    localStorage.removeItem("helm.lavish.recentMockups");
    addLavishFileRecent("C:\\\\mocks\\\\alpha-mockup.html");
    addLavishPasteRecent("<h1>Pasted A</h1>");
    navigateToPage("lavish");
    return true;
  })()`);
  await app.waitForSelector("#lavishPage .lavish-recent-row", 8000);
  assert((await rowCount()) === 2, `both a file and a paste recent render (got ${await rowCount()})`);
  const rows = await app.eval(`[...document.querySelectorAll("#lavishPage .lavish-recent-row")].map(r => r.textContent)`);
  log("rows:", JSON.stringify(rows));
  assert(rows[0] === "Pasted mockup 1", "the pasted mockup shows as 'Pasted mockup 1', most-recent-first");
  assert(rows[1] === "alpha-mockup.html", "the file recent shows its basename");

  // Re-pasting identical HTML dedupes (keeps one entry, same label) and moves front.
  const afterRepaste = await app.eval(`(() => {
    addLavishPasteRecent("<h1>Pasted A</h1>");
    return JSON.stringify({ n: lavishRecents.length, pastes: lavishRecents.filter(e => e.kind === "paste").length, frontLabel: lavishRecents[0].label });
  })()`);
  log("re-paste:", afterRepaste);
  const rp = JSON.parse(afterRepaste);
  assert(rp.pastes === 1 && rp.frontLabel === "Pasted mockup 1", "re-pasting identical HTML dedupes and keeps its label");

  // Cap at 5 across mixed kinds.
  const cap = await app.eval(`(() => {
    for (let i = 0; i < 6; i++) addLavishFileRecent("C:\\\\f" + i + "-mockup.html");
    return lavishRecents.length;
  })()`);
  assert(cap === 5, `recents capped at 5 across kinds (got ${cap})`);

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: recents remember file + pasted mockups, migrate, dedupe, cap." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  await app.eval(`localStorage.removeItem("helm.lavish.recentMockups")`).catch(() => {});
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
