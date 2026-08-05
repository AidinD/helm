// The navigation's CURRENT shape, in one place.
//
// This replaces four tests that each pinned a different historical shape and contradicted each
// other, which is a large part of why the full sweep stopped being readable:
//
//   test-nav-consolidation      expected 3 primary buttons, a Chat tab among them, Analysis
//                               relabelled "Skills"
//   test-nav-restructure        expected a "Skills" button in the header
//   test-chat-demoted           expected Chat demoted INTO the secondary nav
//   test-agents-facet-removed   expected the sub-nav to be exactly Overview/Autopilot/Routines
//
// Every one of those was true when it was written. The nav then shrank further in deliberate
// steps: the primary bar is Dashboard alone, the secondary nav lost Chat entirely (it is reached
// through Ctrl+K and the Dashboard now), Analysis went back to being called Analysis, and the
// sub-nav gained Review. Repairing four files would have left four descriptions of one thing; the
// claims worth keeping are folded in here instead, and each is marked with where it came from.
//
// Run:  node scripts/e2e/test-nav-shape.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[nav-shape-e2e]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const app = await launch();
const isHidden = (id) => app.eval(`!!document.getElementById(${JSON.stringify(id)})?.classList.contains("hidden")`);

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const nav = await app.eval(`(() => {
    const btns = (sel) => [...document.querySelectorAll(sel + " button")].map((b) => ({ page: b.dataset.page, label: b.textContent.trim() }));
    return {
      primary: btns("#pageToggle"),
      secondary: btns("#headerUtilityNav"),
      subnav: btns("#dashboardSubnav"),
      hasGear: !!document.getElementById("settingsGear"),
      agentsPage: document.getElementById("agentsPage") !== null,
      // Every page element the router can show, so a removed page cannot linger in the markup.
      pages: [...document.querySelectorAll('[id$="Page"]')].map((e) => e.id).sort(),
    };
  })()`);

  // --- the primary bar: one tab (from test-chat-demoted, still true) ----------
  assert(
    JSON.stringify(nav.primary.map((b) => b.page)) === JSON.stringify(["dashboard"]),
    `Dashboard is the ONLY primary tab (${JSON.stringify(nav.primary.map((b) => b.page))})`
  );
  assert(nav.primary[0]?.label.startsWith("Dashboard"), `and it is labelled Dashboard (${JSON.stringify(nav.primary[0]?.label)})`);

  // --- the secondary nav, and that Chat is NOT in it any more -----------------
  assert(
    JSON.stringify(nav.secondary.map((b) => b.page)) === JSON.stringify(["jot", "lavish", "analysis", "archive"]),
    `the secondary nav is Jot / Plan / Analysis / Archive (${JSON.stringify(nav.secondary.map((b) => b.page))})`
  );
  assert(
    !nav.secondary.some((b) => b.page === "chat"),
    "Chat has no nav button at all - it is reached through Ctrl+K and the Dashboard, which is what test-chat-demoted was written before"
  );
  assert(
    nav.secondary.find((b) => b.page === "lavish")?.label === "Plan",
    `the Plan button is labelled Plan rather than by its internal name (${JSON.stringify(nav.secondary.find((b) => b.page === "lavish")?.label)})`
  );
  assert(
    nav.secondary.find((b) => b.page === "analysis")?.label === "Analysis",
    `and Analysis is labelled Analysis - it was called Skills for a while, which two old tests still asserted (${JSON.stringify(nav.secondary.find((b) => b.page === "analysis")?.label)})`
  );

  // --- the Dashboard sub-nav (from test-agents-facet-removed, plus Review) ----
  assert(
    JSON.stringify(nav.subnav.map((b) => b.page)) === JSON.stringify(["dashboard", "goal", "routines", "review"]),
    `the sub-nav is Overview / Autopilot / Routines / Review (${JSON.stringify(nav.subnav.map((b) => b.page))})`
  );
  assert(
    nav.subnav.find((b) => b.page === "goal")?.label === "Autopilot",
    "the goal facet reads 'Autopilot', not its internal name - the claim test-nav-restructure was protecting"
  );
  assert(!nav.subnav.some((b) => b.page === "agents"), "there is no Agents facet");
  assert(nav.agentsPage === false, "and no #agentsPage element left in the markup - Autopilot is the single autonomous-runs surface");

  assert(nav.hasGear, "the settings gear is present");

  // --- the sub-nav belongs to the Dashboard group only -----------------------
  await app.eval(`navigateToPage("dashboard")`);
  assert(!(await isHidden("dashboardSubnav")), "the sub-nav is visible on the Dashboard");
  await app.eval(`navigateToPage("archive")`);
  assert(await isHidden("dashboardSubnav"), "and hidden once you leave the Dashboard group");

  // --- every nav button opens its page in one click --------------------------
  for (const b of nav.secondary) {
    const opened = await app.eval(`(() => {
      const btn = document.querySelector('#headerUtilityNav button[data-page="${b.page}"]');
      if (!btn) { return false; }
      btn.click();
      return true;
    })()`);
    assert(opened, `the ${b.label} button is clickable`);
    assert(!(await isHidden(`${b.page}Page`)), `and opens ${b.label} in one click`);
  }

  // --- Settings, and that its buried utility row stayed gone -----------------
  await app.eval(`navigateToPage("settings")`);
  assert(!(await isHidden("settingsPage")), "the settings page opens");
  const gearActive = await app.eval(`document.getElementById("settingsGear").classList.contains("active")`);
  assert(gearActive, "and the gear shows active for Settings itself");
  const buriedRow = await app.eval(`!!document.querySelector("#settingsPage .settings-util-row, #settingsPage [data-page='analysis'], #settingsPage [data-page='archive']")`);
  assert(!buriedRow, "Settings has no buried Skills/Archive row - they live in the header, which is what test-nav-restructure won");

  // --- chat is still REACHABLE, just not from the nav ------------------------
  await app.eval(`navigateToPage("chat")`);
  assert(!(await isHidden("chatPage")), "chat still opens when navigated to - it lost its button, not its page");

  // --- no page element exists that the nav cannot reach ----------------------
  // A page left in the markup with no way in is how #agentsPage lingered.
  const reachable = new Set([
    ...nav.primary.map((b) => b.page),
    ...nav.secondary.map((b) => b.page),
    ...nav.subnav.map((b) => b.page),
    "settings",
    "chat", // deliberately button-less; reached via Ctrl+K and the Dashboard
  ]);
  const orphans = nav.pages.map((id) => id.replace(/Page$/, "")).filter((p) => !reachable.has(p));
  assert(orphans.length === 0, `every page element has a way in (${orphans.join(", ") || "no orphans"})`);

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors.slice(0, 5)) {
    log("  console error:", e.text.slice(0, 160));
  }

  log(
    exitCode === 0
      ? "VERIFY OK: one primary tab, four secondary buttons, a four-facet Dashboard sub-nav, no Agents leftovers, and no page without a way in."
      : "VERIFY FAILED."
  );
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
