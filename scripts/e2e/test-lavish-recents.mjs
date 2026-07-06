// E2E: the Plan page shows a "Recent" list of recently-loaded mockup file
// paths (localStorage-backed, most-recent-first, capped at 5, deduped). Real
// launched Maestro via CDP.
//
// Run:  node scripts/e2e/test-lavish-recents.mjs
import { launch } from "./harness.mjs";

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

  // Seed two recents into localStorage + the in-memory list, then render Plan.
  await app.eval(`(() => {
    lavishRecents = ["C:\\\\mocks\\\\alpha-mockup.html", "D:\\\\stuff\\\\beta-mockup.html"];
    localStorage.setItem("maestro.lavish.recentMockups", JSON.stringify(lavishRecents));
    navigateToPage("lavish");
    return true;
  })()`);
  await app.waitForSelector("#lavishPage", 8000, { visible: true });

  assert((await rowCount()) === 2, `two recent rows render (got ${await rowCount()})`);
  const rows = await app.eval(`[...document.querySelectorAll("#lavishPage .lavish-recent-row")].map(r => ({ text: r.textContent, title: r.title }))`);
  log("rows:", JSON.stringify(rows));
  assert(rows[0].text === "alpha-mockup.html" && rows[1].text === "beta-mockup.html", "rows show the file basenames, most-recent-first");
  assert(/alpha-mockup\.html$/.test(rows[0].title), "row title carries the full path");

  // addLavishRecent dedupes + moves to front + caps at 5.
  const capCheck = await app.eval(`(() => {
    for (const p of ["a.html","b.html","c.html","d.html","e.html","f.html"]) addLavishRecent(p);
    addLavishRecent("c.html"); // existing -> should move to front, not duplicate
    return JSON.stringify({ len: lavishRecents.length, front: lavishRecents[0], dupes: lavishRecents.filter(x => x === "c.html").length });
  })()`);
  const cap = JSON.parse(capCheck);
  log("cap check:", capCheck);
  assert(cap.len === 5, `recents capped at 5 (got ${cap.len})`);
  assert(cap.front === "c.html", "re-adding an existing path moves it to the front");
  assert(cap.dupes === 1, "no duplicate entries");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: recent mockups list renders + dedupes + caps." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  // Clear the seeded recents so the dev app doesn't inherit test data.
  await app.eval(`localStorage.removeItem("maestro.lavish.recentMockups")`).catch(() => {});
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
