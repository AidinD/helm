// E2E: R1 - Dashboard is the single primary home tab; Chat + Plan are demoted
// into the quieter secondary nav alongside Skills + Archive (no longer co-equal
// front doors). Navigation + active-state still work. Real launched Maestro/CDP.
//
// Run:  node scripts/e2e/test-chat-demoted.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[chat-demoted-e2e]", ...a);
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

  const primary = await app.eval(`[...document.querySelectorAll("#pageToggle button")].map(b => b.dataset.page)`);
  log("primary tabs:", JSON.stringify(primary));
  assert(JSON.stringify(primary) === JSON.stringify(["dashboard"]), "Dashboard is the ONLY primary tab in #pageToggle");

  const util = await app.eval(`[...document.querySelectorAll("#headerUtilityNav button")].map(b => b.dataset.page)`);
  log("secondary nav:", JSON.stringify(util));
  assert(util.includes("chat") && util.includes("lavish"), "Chat + Plan are demoted into the secondary nav");
  assert(util.includes("analysis") && util.includes("archive"), "Skills + Archive still in the secondary nav");

  // Chat still reachable + its state correct: chatPage shows, its secondary
  // button lights, the Dashboard primary tab does NOT.
  await app.eval(`document.querySelector('#headerUtilityNav button[data-page="chat"]').click()`);
  await app.waitForSelector("#chatPage", 8000, { visible: true });
  assert(!(await isHidden("chatPage")), "clicking Chat opens the chat view");
  const chatActive = await app.eval(`document.querySelector('#headerUtilityNav button[data-page="chat"]').classList.contains("active")`);
  const dashActive = await app.eval(`document.querySelector('#pageToggle button[data-page="dashboard"]').classList.contains("active")`);
  assert(chatActive, "the Chat secondary button is active on Chat");
  assert(!dashActive, "the Dashboard primary tab is NOT active while on Chat");

  // Plan still reachable.
  await app.eval(`document.querySelector('#headerUtilityNav button[data-page="lavish"]').click()`);
  await app.waitForSelector("#lavishPage", 8000, { visible: true });
  assert(!(await isHidden("lavishPage")), "clicking Plan opens the Plan view");

  // Back to Dashboard = home.
  await app.eval(`document.querySelector('#pageToggle button[data-page="dashboard"]').click()`);
  await app.waitForSelector("#dashboardPage", 8000, { visible: true });
  assert(await app.eval(`document.querySelector('#pageToggle button[data-page="dashboard"]').classList.contains("active")`), "Dashboard lights as home when selected");

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: Dashboard is home; Chat/Plan demoted but reachable." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
