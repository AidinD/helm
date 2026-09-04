#!/usr/bin/env node
//
// What actually gets laid out when the Dashboard is opened.
//
// WHY THIS EXISTS RATHER THAN ANOTHER CSS GUESS
// Switching to the Dashboard costs about 43ms, of which 99% is forced reflow rather than the
// page's own JavaScript, and it is five times the next most expensive view. The obvious fix -
// `contain: layout` on the widget card - was applied, measured over three runs each way, and
// made it marginally WORSE (45.0ms against 43.4ms). It was reverted: a change that looks like a
// fix and does not move a number is worse than none, because it closes the question.
//
// So the next hypothesis has to come from a profile that says WHAT is being laid out, not from
// a rule that sounds reasonable. That is what this does.
//
// HOW IT ANSWERS
// Chrome's tracing emits `LayoutInvalidationTracking` alongside `Layout`: the first names the
// node that dirtied layout and the REASON, the second says how many objects were laid out and
// how long it took. Aggregating invalidations by reason and by node tells you which element and
// which property is driving the reflow - which is the one fact no amount of reading the CSS
// will produce.
//
// A TOOL, NOT A CHECK. It asserts nothing and is not in either lane: it prints a profile for a
// person to read. It lives in scripts/ for that reason, and the lane guard would refuse it in
// either checks folder.
//
// Run:  node scripts/profile-dashboard-layout.mjs
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.HELM_E2E_HIDDEN = process.env.HELM_E2E_HIDDEN || "1";
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9541";

const { launch } = await import(pathToFileURL(path.join(here, "checks-lib", "harness.mjs")).href);

const app = await launch();
try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  // Somewhere that is NOT the dashboard, so the switch being profiled is a real switch.
  await app.eval('navigateToPage("chat")');
  await new Promise((r) => setTimeout(r, 600));

  const events = [];
  app.cdp.on("Tracing.dataCollected", (p) => {
    for (const e of p.value || []) {
      events.push(e);
    }
  });
  // The harness's CDP client has on() and no once() - a one-shot is built from it rather than
  // assumed. Resolving more than once is harmless for a promise, so no removal is needed.
  const done = new Promise((resolve) => app.cdp.on("Tracing.tracingComplete", resolve));

  await app.cdp.send("Tracing.start", {
    transferMode: "ReportEvents",
    traceConfig: {
      includedCategories: [
        "devtools.timeline",
        "disabled-by-default-devtools.timeline",
        "disabled-by-default-devtools.timeline.invalidationTracking",
      ],
    },
  });

  await app.eval('navigateToPage("dashboard")');
  // Long enough for the switch AND the reflow it forces to finish; the point is to catch the
  // layout, not to time it.
  await new Promise((r) => setTimeout(r, 2500));
  await app.cdp.send("Tracing.end");
  await done;

  const layouts = events.filter((e) => e.name === "Layout");
  const invalidations = events.filter((e) => e.name === "LayoutInvalidationTracking");

  const totalUs = layouts.reduce((n, e) => n + (e.dur || 0), 0);
  console.log("");
  console.log(`LAYOUT DURING ONE DASHBOARD SWITCH`);
  console.log(`  ${layouts.length} Layout event(s), ${(totalUs / 1000).toFixed(1)}ms total`);
  const dirty = layouts.reduce((n, e) => n + (e.args?.beginData?.dirtyObjects || 0), 0);
  const objects = layouts.reduce((n, e) => Math.max(n, e.args?.beginData?.totalObjects || 0), 0);
  console.log(`  ${dirty} dirty object(s) across those, in a tree of up to ${objects}`);
  console.log("");

  const slowest = [...layouts].sort((a, b) => (b.dur || 0) - (a.dur || 0)).slice(0, 5);
  console.log("  the five most expensive individually:");
  for (const e of slowest) {
    const d = e.args?.beginData || {};
    console.log(`    ${((e.dur || 0) / 1000).toFixed(2)}ms  dirty ${d.dirtyObjects ?? "?"} of ${d.totalObjects ?? "?"}`);
  }
  console.log("");

  if (invalidations.length === 0) {
    console.log("  NO invalidation records. The category may not be enabled in this build, in which");
    console.log("  case the reason has to come from somewhere else - do not read the absence as");
    console.log("  'nothing invalidated layout', because the Layout events above say otherwise.");
  } else {
    const byReason = new Map();
    const byNode = new Map();
    for (const e of invalidations) {
      const a = e.args?.data || {};
      const reason = a.reason || "(no reason given)";
      const node = `${a.nodeName || "?"}${a.nodeId ? ` #${a.nodeId}` : ""}`;
      byReason.set(reason, (byReason.get(reason) || 0) + 1);
      byNode.set(node, (byNode.get(node) || 0) + 1);
    }
    console.log(`  ${invalidations.length} invalidation record(s), by REASON:`);
    for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`    ${String(n).padStart(5)}  ${reason}`);
    }
    console.log("");
    console.log("  and by NODE:");
    for (const [node, n] of [...byNode].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      console.log(`    ${String(n).padStart(5)}  ${node}`);
    }
  }
  console.log("");

  // WHERE the nodes are, since "927 of 955 dirty" says the whole subtree is new and the only
  // lever left is how many nodes it is. A count per widget names the one to cap or virtualise
  // instead of guessing from the CSS again.
  const perWidget = await app.eval(`(() => {
    const page = document.getElementById("dashboardPage");
    if (!page) { return { error: "no dashboardPage" }; }
    const total = page.querySelectorAll("*").length;
    const widgets = [...page.querySelectorAll(".wd")].map((w) => ({
      name: (w.querySelector("h3, .wd-title, header")?.textContent || w.className).trim().slice(0, 40),
      nodes: w.querySelectorAll("*").length,
      rows: w.querySelectorAll("li, .dash-row, .fleet-row, .rev-item, tr").length,
    }));
    widgets.sort((a, b) => b.nodes - a.nodes);
    return { total, widgets };
  })()`);

  if (perWidget.error) {
    console.log(`  could not count nodes: ${perWidget.error}`);
  } else {
    console.log(`  ${perWidget.total} elements under #dashboardPage, by widget:`);
    for (const w of perWidget.widgets) {
      console.log(`    ${String(w.nodes).padStart(5)} nodes  ${String(w.rows).padStart(4)} rows   ${w.name}`);
    }
    const top = perWidget.widgets[0];
    if (top) {
      const share = ((top.nodes / perWidget.total) * 100).toFixed(0);
      console.log("");
      console.log(`  the largest is ${share}% of the page on its own`);
    }
  }
  console.log("");
} finally {
  await app.close();
}
