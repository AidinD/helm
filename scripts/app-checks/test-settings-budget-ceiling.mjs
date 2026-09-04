// E2E: Settings gets a "Fleet guardrail" toggle + $ input for the orchestration
// budget ceiling (the captain, 2026-08-12: "sätt den som en toggle i settings där jag
// även kan ange tak" - a Settings-page mirror of the Dashboard's Stop/Resume
// chip's underlying cap, since orchestrationBudget.js already supported
// setCeiling(null) but no UI ever called it). Seeds a real budget.json with a
// ceiling set, launches the real app, and checks:
// - the toggle starts CHECKED and the input shows the seeded ceiling;
// - unchecking it calls setOrchestrationCeiling(null), persisted to disk;
// - re-checking it and editing the $ input persists the new numeric ceiling.
//
// Run:  node scripts/e2e/test-settings-budget-ceiling.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let exit = 0;
let app = null;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-budget-settings-"));
const metaHome = path.join(tmp, "meta-home");
fs.mkdirSync(metaHome, { recursive: true });

process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
process.env.HELM_SECOND_MATES_PATH = path.join(tmp, "second-mates.json");
process.env.HELM_GOAL_RUN_HISTORY_PATH = path.join(tmp, "goal-run-history.json");
process.env.HELM_META_HOME_OVERRIDE = metaHome;
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9587";

const { budgetPath, readBudget } = await import("../../src/lib/orchestrationBudget.js");
const { launch } = await import("../checks-lib/harness.mjs");

// Seed a ceiling BEFORE launch, same as a real prior session would have left one.
fs.mkdirSync(path.dirname(budgetPath(metaHome)), { recursive: true });
fs.writeFileSync(
  budgetPath(metaHome),
  JSON.stringify({ spentUsd: 4.2, ceilingUsd: 25, killed: false, updatedAt: Date.now() })
);

try {
  app = await launch();

  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  const ready = await (async () => {
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      if (await app.eval(`typeof navigateToPage === "function"`)) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  })();
  ok(ready, "the renderer finished loading");
  await app.eval(`(() => { navigateToPage("settings"); return true; })()`);
  await app.waitForSelector("#settingsPage", 30000, { visible: true });

  const headings = await app.eval(`[...document.querySelectorAll("#settingsPage .settings-group-heading")].map(h => h.textContent)`);
  ok(headings.some((h) => /Fleet guardrail/.test(h)), `'Fleet guardrail' group present (got ${JSON.stringify(headings)})`);

  // Give the async getOrchestrationBudget().then(...) a moment to populate the row.
  const populated = await (async () => {
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      const val = await app.eval(`(document.querySelector(".settings-budget-input") || {}).value`);
      if (val) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  })();
  ok(populated, "the budget input populates from the real orchestration:budget IPC");

  const initial = await app.eval(`(() => {
    const cb = [...document.querySelectorAll("#settingsPage .settings-toggle-row input[type=checkbox]")]
      .find(i => i.closest(".settings-toggle-row").textContent.includes("Cap the fleet"));
    const input = document.querySelector(".settings-budget-input");
    return { checked: cb.checked, value: input.value, disabled: input.disabled };
  })()`);
  ok(initial.checked === true, `toggle starts checked from the seeded ceiling (got ${JSON.stringify(initial)})`);
  ok(Number(initial.value) === 25, `$ input shows the seeded ceiling of 25 (got ${initial.value})`);
  ok(initial.disabled === false, "input is enabled while the ceiling is on");

  // Uncheck -> ceilingUsd must become null on disk (the real IPC round trip, no
  // model call, no mocked window.helm).
  await app.eval(`(() => {
    const cb = [...document.querySelectorAll("#settingsPage .settings-toggle-row input[type=checkbox]")]
      .find(i => i.closest(".settings-toggle-row").textContent.includes("Cap the fleet"));
    cb.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 500));
  const afterUncheck = readBudget(metaHome);
  ok(afterUncheck.ceilingUsd === null, `unchecking removes the cap on disk (got ${JSON.stringify(afterUncheck)})`);
  const inputDisabledAfterUncheck = await app.eval(`document.querySelector(".settings-budget-input").disabled`);
  ok(inputDisabledAfterUncheck === true, "input disables itself once the ceiling is off");

  // Re-check -> re-applies a numeric ceiling; then edit the $ input to a new value.
  await app.eval(`(() => {
    const cb = [...document.querySelectorAll("#settingsPage .settings-toggle-row input[type=checkbox]")]
      .find(i => i.closest(".settings-toggle-row").textContent.includes("Cap the fleet"));
    cb.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 500));
  const afterRecheck = readBudget(metaHome);
  ok(typeof afterRecheck.ceilingUsd === "number" && afterRecheck.ceilingUsd > 0, `re-checking restores a numeric cap (got ${JSON.stringify(afterRecheck)})`);

  await app.eval(`(() => {
    const input = document.querySelector(".settings-budget-input");
    input.value = "10";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 500));
  const afterEdit = readBudget(metaHome);
  ok(afterEdit.ceilingUsd === 10, `editing the $ input persists the new cap (got ${JSON.stringify(afterEdit)})`);

  const errors = app.getConsoleErrors();
  ok(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    console.log("  console error:", e.text);
  }
  console.log(exit === 0 ? "VERIFY OK: Fleet guardrail toggle + cap round-trip through the real IPC." : "VERIFY FAILED.");
} catch (err) {
  exit = 1;
  console.log("ERROR:", err.message);
} finally {
  if (app) {
    const killOut = await app.close();
    console.log("cleanup:", killOut || "(nothing killed)");
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(exit);
