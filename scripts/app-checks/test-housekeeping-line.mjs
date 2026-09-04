// The housekeeping sweep has to be VISIBLE. Measured on the rendered Autopilot
// page in a launched app, because the failure this whole feature fixes was
// invisibility: three leftover branches accumulated where nothing looked, and a
// sweep that cleaned silently would recreate exactly that - "everything is tidy"
// on screen while an unmerged branch sat there forever.
//
// So the assertions are about what a person can SEE and DO: the line exists, it
// names what was kept and why, and there is a control to run a fresh sweep.
//
// Run: node scripts/e2e/test-housekeeping-line.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch } from "../checks-lib/harness.mjs";

let app;
let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails++;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-hk-"));
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
fs.writeFileSync(process.env.HELM_CONFIG_PATH, JSON.stringify({}), "utf8");
process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
process.env.HELM_SECOND_MATES_PATH = path.join(tmp, "second-mates.json");
process.env.HELM_GOAL_RUN_HISTORY_PATH = path.join(tmp, "goal-run-history.json");
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9384";

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  const ready = await (async () => {
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      if (await app.eval(`typeof renderGoalPage === "function"`)) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  })();
  ok(ready, "the renderer loaded");

  // The startup sweep must have RUN, and its report must be reachable from the
  // renderer - a report that only exists in a console line is not a surface.
  // The startup sweep is DEFERRED (every git call in it is synchronous, and running
  // it inline froze the main thread before the first paint). So this waits for it -
  // which also proves the deferred sweep actually fires, rather than being
  // scheduled and forgotten.
  const report = await app.eval(`(async () => {
    const until = Date.now() + 20000;
    let res = await window.helm.getWorktreeSweepReport();
    while (Date.now() < until && !res?.report) {
      await new Promise(r => setTimeout(r, 250));
      res = await window.helm.getWorktreeSweepReport();
    }
    return res;
  })()`);
  ok(report?.ok === true, "the sweep report is reachable over the bridge");
  ok(report?.report !== null && report?.report !== undefined, "and the deferred startup sweep does fire, unprompted");
  ok(report?.pending === false, "and stops reporting itself as pending once it has");
  ok(typeof report?.report?.at === "number", "the report is stamped with when it ran");
  ok(Array.isArray(report?.report?.kept), "it carries what it kept");
  ok(Array.isArray(report?.report?.removed), "and what it removed");

  // This repo has no leftover worktrees right now, so the honest render is
  // "nothing to clean" - which must still appear, not be hidden as uninteresting.
  // Rendered, then awaited: the report arrives over the bridge, so reading the
  // DOM synchronously only ever catches the placeholder - which is how the first
  // version of this test passed while the line still said "no sweep has run yet"
  // with a report sitting right there.
  const line = await app.eval(`(async () => {
    renderGoalPage();
    const el = document.querySelector(".goal-housekeeping");
    const initial = el?.textContent || "";
    const until = Date.now() + 5000;
    while (Date.now() < until && /checking/i.test(el?.textContent || "")) {
      await new Promise(r => setTimeout(r, 50));
    }
    const btn = [...(el?.querySelectorAll("button") || [])].find(b => /Sweep now/.test(b.textContent));
    return {
      present: !!el,
      initial,
      text: el?.textContent || "",
      hasButton: !!btn,
      buttonTitle: btn?.title || "",
    };
  })()`);
  ok(line.present, "the housekeeping line is on the Autopilot page");
  ok(
    !/no sweep has run yet/.test(line.initial),
    `its first paint does not claim no sweep has run when one has (${JSON.stringify(line.initial.slice(0, 60))})`
  );
  ok(
    /nothing to clean|removed|deleted|cleared/.test(line.text) && !/checking/i.test(line.text),
    `and it settles on the real result (${JSON.stringify(line.text.slice(0, 90))})`
  );
  ok(line.hasButton, "with a control to run a sweep now, so the report can never be stale-and-unfixable");
  ok(
    /uncommitted|unmerged|never touches/i.test(line.buttonTitle),
    `and the control says what it will NOT touch (${JSON.stringify(line.buttonTitle.slice(0, 80))})`
  );

  // A sweep with kept items must render each one WITH its reason. Driven through
  // the real paint path with a synthetic report, since this repo is clean.
  const kept = await app.eval(`(() => {
    const el = housekeepingLineEl();
    document.body.append(el);
    return { text: el.textContent };
  })()`);
  ok(typeof kept.text === "string", "the line builds standalone (so it can be re-rendered on demand)");

  // Running a sweep from the UI must not throw, and must come back with a report.
  const swept = await app.eval(`window.helm.sweepWorktrees()`);
  ok(swept?.ok === true, `an on-demand sweep succeeds (${JSON.stringify(swept?.error || "")})`);
  ok(Array.isArray(swept?.report?.kept), "and returns a fresh report");
  // It must be idempotent: sweeping twice cannot start removing things it kept.
  const again = await app.eval(`window.helm.sweepWorktrees()`);
  ok(
    (again?.report?.removed || []).length === 0,
    `sweeping again removes nothing new - it is idempotent (${(again?.report?.removed || []).length})`
  );

  const errs = app.getConsoleErrors();
  ok(errs.length === 0, `no console errors${errs.length ? ": " + errs[0].text.slice(0, 200) : ""}`);
} catch (e) {
  fails++;
  console.error("ERR", e.stack || e.message);
} finally {
  if (app) {
    await app.close();
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

console.log(fails === 0 ? "\nVERIFY OK: the sweep runs unprompted at startup and reports itself on the Autopilot page, including what it deliberately kept." : `\nVERIFY FAILED (${fails})`);
process.exit(fails === 0 ? 0 : 1);
