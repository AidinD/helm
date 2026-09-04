/**
 * Plant a dead run and check that Helm SAYS SO, on the page, without being asked.
 *
 * The card's measurable-done, in the captain's words: "plantera ett dödläge medvetet ... och
 * kontrollera att appen säger till utan att någon letat efter det."
 *
 * test-watchdog.mjs proves the judgement. This proves the wiring, and the two are not the
 * same claim - this session has already shipped a payload that was correct and a page that
 * never showed it, twice. So this asserts the DOM: the row a person would actually see,
 * with the words on it.
 *
 * It launches TWICE, and the second launch is the one that makes the first mean something:
 * a healthy fleet must produce no row at all. A check that only ever sees the broken world
 * cannot tell a working watchdog from one that shouts at everything.
 *
 * Costs nothing. No model call, no real run: the deadlock is planted straight into the
 * goal-run history through HELM_GOAL_RUN_HISTORY_PATH, as a run recorded "running" whose
 * owning process died three weeks ago - which is not a hypothetical, it is the state
 * card ef0764e0 was opened about.
 *
 * Run: node scripts/e2e/test-watchdog-says-so.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails += 1;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-watchdog-e2e-"));
const historyPath = path.join(tmp, "goal-run-history.json");
const THREE_WEEKS_AGO = Date.now() - 21 * 24 * 60 * 60 * 1000;

// Set before importing the harness so the launched app inherits it.
process.env.HELM_GOAL_RUN_HISTORY_PATH = historyPath;
const { launch } = await import("../checks-lib/harness.mjs");

/** Launch a Helm over this goal-run history and report what it says. */
async function observe(records) {
  fs.writeFileSync(historyPath, JSON.stringify(records), "utf8");
  let app;
  try {
    app = await launch();
    await app.waitForSelector("#pageToggle", 30000, { visible: true });
    const payload = await app.eval(
      `(async () => {
        const res = await window.helm.getSessions();
        return { watchdog: res?.watchdog || null };
      })()`
    );
    const page = await app.eval(
      `(async () => {
        // Poll: the dashboard paints on its own timer, and a synchronous read here would
        // be testing the timing of the first paint rather than the feature.
        const deadline = Date.now() + 20000;
        let last = null;
        while (Date.now() < deadline) {
          const rows = [...document.querySelectorAll(".dash-watchdog-row")];
          last = {
            count: rows.length,
            text: rows.map(r => r.textContent).join(" | "),
            clickable: rows.some(r => getComputedStyle(r).cursor === "pointer"),
            // The page must not say all-clear in one place while showing a stall in another.
            allClear: document.body.innerText.includes("nothing is stuck"),
          };
          if (rows.length > 0) {
            return last;
          }
          await new Promise(r => setTimeout(r, 500));
        }
        return last;
      })()`
    );
    return { payload, page };
  } finally {
    if (app) {
      await app.close();
    }
  }
}

try {
  console.log("launch 1 of 2: a run whose owner died three weeks ago…");
  const broken = await observe([
    {
      goalRunId: "planted-dead-run",
      goal: "A run whose owner died three weeks ago",
      projectPath: tmp,
      status: "running",
      // A pid that is not this app, with a heartbeat three weeks old: nobody is driving it.
      livePid: 999999,
      liveHeartbeatAt: THREE_WEEKS_AGO,
      startedAt: THREE_WEEKS_AGO,
      updatedAt: THREE_WEEKS_AGO,
    },
    {
      goalRunId: "planted-finished-run",
      goal: "A run that finished properly",
      projectPath: tmp,
      status: "done",
      livePid: null,
      startedAt: THREE_WEEKS_AGO,
      updatedAt: THREE_WEEKS_AGO,
    },
  ]);

  ok(Array.isArray(broken.payload.watchdog), "the sessions payload carries a watchdog list at all");
  const planted = (broken.payload.watchdog || []).find((s) => s.context?.goalRunId === "planted-dead-run");
  ok(!!planted, "the planted dead run is in it");
  ok(!/planted-finished-run/.test(JSON.stringify(broken.payload.watchdog)), "and the finished run is not - a finished run is not work");
  ok(!!planted && /no Helm process has claimed it/.test(planted.reason), "the reason says the owner is gone, in words");

  ok(broken.page.count >= 1, `the dashboard shows a row for it without anyone looking (${broken.page.count} row(s))`);
  ok(/owner died three weeks ago|goal run/.test(broken.page.text), "the row names the run, so it can be found");
  ok(/Resume it from the Goal page/.test(broken.page.text), "and tells the reader what to do about it");
  // Every other row in this list opens something. This one has no single right destination,
  // so it must not pretend to be a link.
  ok(!broken.page.clickable, "the row does not pretend to be clickable, because there is nowhere single to go");
  ok(!broken.page.allClear, "and the page does not claim nothing is stuck at the same time");

  console.log("launch 2 of 2: nothing wrong at all…");
  const healthy = await observe([
    {
      goalRunId: "planted-finished-run",
      goal: "A run that finished properly",
      projectPath: tmp,
      status: "done",
      livePid: null,
      startedAt: THREE_WEEKS_AGO,
      updatedAt: THREE_WEEKS_AGO,
    },
  ]);
  ok((healthy.payload.watchdog || []).length === 0, "a healthy fleet produces no findings");
  ok(healthy.page.count === 0, "and no row on the page - the check above can tell the two worlds apart");
} finally {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // temp dir; a leftover is harmless
  }
}

console.log("");
console.log(
  fails === 0
    ? "VERIFY OK: a planted deadlock reaches the page by itself with the reason and the next step on it, and a healthy fleet says nothing."
    : `VERIFY FAILED: ${fails} assertion(s)`
);
process.exit(fails === 0 ? 0 : 1);
