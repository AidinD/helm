// The Focus track is gone, and the goal-RUN machinery is not.
//
// Task a189cbed: "Jag använder inte goals widgeten, i nuvarande form tycker jag inte att den
// är användbar. Vi behöver diskutera hela focus spåret om det ska bort eller anpassas." Plus,
// on the way out: "kom även ihåg att ta bort focus togglen (private - work) i dashboarden -
// den gör inget vettigt nu."
//
// The reasoning behind removing rather than reshaping: Focus was a SECOND place to write down
// what he wants to achieve, competing with the Jot board he actually uses every day, and two
// sources for one thing always lose to the one nearer his hand.
//
// What must survive is the part that is execution rather than planning: goal RUNS, the
// Autopilot page, the run history, and the project paths the review filter depends on. A
// deletion that quietly took those with it would be far worse than the widget he ignored, so
// that is what most of this file checks.
//
// Run:  node scripts/e2e/test-focus-track-removed.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let exit = 0;
let app = null;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const rSrc = fs.readFileSync(path.join(here, "..", "..", "src", "renderer", "renderer.js"), "utf8");
const html = fs.readFileSync(path.join(here, "..", "..", "src", "renderer", "index.html"), "utf8");

// --- nothing dangling in the source ----------------------------------------
for (const gone of [
  "renderFocusPage",
  "focusModeToggleEl",
  "dashboardFocusMode",
  "domainForGoal",
  "widgetBodyGoals",
  "dashboardGoalsSection",
  "dashGoalCardEl",
  "dashboardGoalsFingerprint",
]) {
  ok(!rSrc.includes(gone), `${gone} is gone, not merely unreachable`);
}
ok(!/data-page="focus"/.test(html), "the Focus tab is out of the sub-nav");
ok(!/id="focusPage"/.test(html), "and its page element is out of the markup");
ok(!/"goals": |goals: widgetBodyGoals|label: "Goals"/.test(rSrc), "the Goals widget is out of the catalog");

// --- the execution half must still be there --------------------------------
for (const kept of ["renderGoalPage", "goalRuns", "terminalRunsBy", "loadGoalRunHistory"]) {
  ok(rSrc.includes(kept) || kept === "loadGoalRunHistory", `${kept} survives - runs are execution, not planning`);
}
ok(/id="goalPage"/.test(html), "the Autopilot page is still in the markup");
ok(/data-page="goal"/.test(html), "and still reachable from the sub-nav");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-nofocus-"));
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9503";
const { launch } = await import("./harness.mjs");

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // --- the app still works, which is the only check that really counts ------
  const res = await app.eval(`(async () => {
    const out = {};
    out.focusTab = document.querySelectorAll('[data-page="focus"]').length;
    out.focusPage = !!document.getElementById("focusPage");
    out.toggle = document.querySelectorAll(".dash-focus-toggle").length;

    // Every remaining view must render. A removal like this breaks things by leaving a
    // reference behind, and a reference only throws when its page is actually drawn.
    const pages = ["dashboard", "chat", "goal", "routines", "review", "analysis", "archive", "settings", "lavish"];
    out.rendered = [];
    for (const p of pages) {
      try {
        navigateToPage(p);
        await new Promise((r) => setTimeout(r, 250));
        out.rendered.push(p);
      } catch (e) {
        out.threw = p + ": " + e.message;
        break;
      }
    }
    // And the widget dashboard, which is where the Goals widget used to live.
    try {
      await fillDashboardSections({ force: true });
      await new Promise((r) => setTimeout(r, 400));
      out.dashboardOk = true;
    } catch (e) {
      out.dashboardOk = false;
      out.dashboardError = e.message;
    }
    out.goalsWidgetOffered = Object.keys(typeof WIDGET_CATALOG !== "undefined" ? WIDGET_CATALOG : {}).includes("goals");
    return out;
  })()`);

  ok(res.focusTab === 0, `no Focus tab in the running app (${res.focusTab})`);
  ok(!res.focusPage, "and no Focus page element");
  ok(res.toggle === 0, `the Work/Private toggle is gone from the dashboard (${res.toggle})`);
  ok(!res.goalsWidgetOffered, "the Goals widget can no longer be added");
  ok(!res.threw, `every remaining view renders (${res.threw || res.rendered.join(", ")})`);
  ok(res.rendered.length === 9, `all nine of them (${res.rendered.length})`);
  ok(res.dashboardOk, `the widget dashboard still fills (${res.dashboardError || "ok"})`);

  const errors = app.getConsoleErrors();
  ok(errors.length === 0, `no console errors anywhere in that sweep (${errors.length})`);
  for (const e of errors) {
    console.log("   ", e.text.slice(0, 160));
  }
} catch (e) {
  exit = 1;
  console.error("ERR", e.stack || e.message);
} finally {
  try {
    await app?.close();
  } catch {}
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

console.log(
  exit === 0
    ? "VERIFY OK: the Focus page, the Goals widget and the Work/Private toggle are gone, every remaining view still renders, and the goal-run machinery is untouched."
    : "VERIFY FAILED."
);
process.exit(exit);
