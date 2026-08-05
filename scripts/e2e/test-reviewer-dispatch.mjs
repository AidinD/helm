// The reviewer dispatch dialog, and the verdict finding its way back to the row.
//
// the captain, 2026-08-05: "jag vill att den skickar iväg direkt, men sessionen ska fortfarande
// skapas så jag kan få feedback - alternativt att feedback kommer direkt på review vyn",
// plus "en rekommendation baserat på dess komplexitet men att man själv kan välja".
//
// So three things are checked here, and one is deliberately NOT: the confirm names what it
// will spend and offers the recommendation preselected with its reason on screen; cancelling
// starts nothing; and a verdict file written by a reviewer appears on the row that asked for
// it. Actually SENDING is not exercised - it starts a real model and spends tokens, which is
// the one thing a test in the default suite must not do.
//
// Run:  node scripts/e2e/test-reviewer-dispatch.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-revdisp-"));
const metaHome = path.join(tmp, "meta-home");
const reviewsDir = path.join(metaHome, ".helm", "reviews");
fs.mkdirSync(reviewsDir, { recursive: true });

const TASK = "aabbccdd-1111-2222-3333-444444444444";
// A CRITICAL record, so the recommendation is the top model for a reason the dialog states.
fs.writeFileSync(
  path.join(reviewsDir, `${TASK}.json`),
  JSON.stringify({
    taskId: TASK,
    projectPath: "D:\\Repo\\Tools\\helm",
    criticality: "critical",
    verdict: "stamp",
    summary: "A spend guard that backs off instead of retrying forever.",
    evidence: ["The arithmetic is asserted against the real functions."],
    notVerified: ["Not exercised against a real failing triage."],
    testSteps: [{ step: "Turn the lane on", expect: "It backs off" }],
    checks: [{ label: "backoff", cmd: "node scripts/e2e/test-auto-triage-backoff.mjs" }],
  }),
  "utf8"
);
// And a verdict a reviewer already wrote.
fs.writeFileSync(
  path.join(reviewsDir, `${TASK}.independent.md`),
  "NOT CONFIRMED - the backoff is skipped when the card is retried by hand.\n\nFinding: main.js:4120 clears the map before the guard runs.\nRan: node scripts/e2e/test-auto-triage-backoff.mjs (passes, and would pass with the bug).\n",
  "utf8"
);

process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_META_HOME_OVERRIDE = metaHome;
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9522";
const { launch } = await import("./harness.mjs");

const ROW = {
  taskId: TASK,
  title: "auto kollar kön för ofta",
  criticality: "critical",
  verdict: "stamp",
  problems: [],
  caveats: [],
  drift: { drifted: false, snapshot: [], live: [] },
  gauntlet: { declared: 1, passed: 0, failed: 0, stale: 0, unrun: 1, unverified: 0, unusable: 0, state: "incomplete", perCheck: [] },
  record: JSON.parse(fs.readFileSync(path.join(reviewsDir, `${TASK}.json`), "utf8")),
};

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // --- the plan, straight from main ------------------------------------------
  const plan = await app.eval(`window.helm.getReviewerPlan(${JSON.stringify(TASK)})`);
  ok(plan?.ok === true, `a plan comes back for a record that exists (${plan?.error || "ok"})`);
  ok(plan.recommendation?.model === "claude-opus-5", `a critical item is recommended the top model (${plan.recommendation?.model})`);
  ok(plan.recommendation?.effort === "high", `at high effort (${plan.recommendation?.effort})`);
  ok(/CRITICAL/.test(plan.recommendation?.why || ""), `with a reason naming the signal (${JSON.stringify((plan.recommendation?.why || "").slice(0, 50))})`);
  ok((plan.models || []).length >= 3, `and the full list of models to pick from (${(plan.models || []).length})`);
  // THE path both ends must agree on. Two spellings of it is how this feature would
  // silently do nothing: the reviewer writes one file, the row reads another.
  ok(
    plan.notePath === path.join(reviewsDir, `${TASK}.independent.md`),
    `the note path main hands the brief is the one main reads back (${plan.notePath})`
  );

  // --- the dialog ------------------------------------------------------------
  const dialog = await app.eval(`(async () => {
    document.querySelectorAll("#probeRow, .confirm-overlay").forEach((n) => n.remove());
    const wrap = document.createElement("div");
    wrap.id = "probeRow";
    wrap.append(reviewRowEl(${JSON.stringify(ROW)}, "stamp"));
    document.body.append(wrap);
    const item = wrap.querySelector(".rev-item");
    item.querySelector(".rev-head").click();
    await new Promise((r) => setTimeout(r, 200));
    const btn = [...item.querySelectorAll("button")].find((b) => b.textContent.trim() === "Independent reviewer");
    if (!btn) {
      return { button: false, labels: [...item.querySelectorAll("button")].map((b) => b.textContent.trim()) };
    }
    btn.click();
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (document.querySelector(".confirm-overlay")) {
        break;
      }
    }
    const box = document.querySelector(".confirm-overlay .confirm-box");
    if (!box) {
      return { button: true, dialog: false };
    }
    const selects = [...box.querySelectorAll("select")];
    return {
      button: true,
      dialog: true,
      message: box.querySelector(".confirm-msg")?.textContent || "",
      why: box.querySelector(".reviewer-why")?.textContent || "",
      facts: box.querySelector(".suggest-hint")?.textContent || "",
      selects: selects.map((s) => ({ value: s.value, options: [...s.options].map((o) => o.textContent) })),
      confirmLabel: box.querySelector(".confirm-ok")?.textContent || "",
    };
  })()`);
  ok(dialog.button, `the row offers an "Independent reviewer" button (${JSON.stringify(dialog.labels || "")})`);
  ok(dialog.dialog, "clicking it opens a confirm rather than dispatching straight away");
  ok(
    /spends tokens/.test(dialog.message),
    `whose message says it will spend (${JSON.stringify((dialog.message || "").slice(-60))})`
  );
  ok(/CRITICAL/.test(dialog.why), `with the recommendation's reason on screen, not just its answer (${JSON.stringify(dialog.why.slice(0, 50))})`);
  ok(dialog.selects?.length === 2, `and two pickers - model and effort (${dialog.selects?.length})`);
  ok(dialog.selects?.[0]?.value === "claude-opus-5", `the model picker preselects the recommendation (${dialog.selects?.[0]?.value})`);
  ok(
    (dialog.selects?.[0]?.options || []).some((o) => /\(recommended\)/.test(o)),
    `which is marked as recommended rather than silently chosen (${JSON.stringify(dialog.selects?.[0]?.options)})`
  );
  ok(
    (dialog.selects?.[0]?.options || []).length >= 3,
    `while every other model stays pickable - the whole point of a recommendation you can refuse (${(dialog.selects?.[0]?.options || []).length} options)`
  );
  ok(dialog.selects?.[1]?.value === "high", `and the effort picker preselects its recommendation too (${dialog.selects?.[1]?.value})`);

  // Cancelling must start NOTHING. This is the assertion that keeps this test free.
  const cancelled = await app.eval(`(async () => {
    const before = state.sessions.length;
    document.querySelector(".confirm-overlay .confirm-cancel").click();
    await new Promise((r) => setTimeout(r, 300));
    return { overlay: !!document.querySelector(".confirm-overlay"), sessionsBefore: before, sessionsAfter: state.sessions.length };
  })()`);
  ok(!cancelled.overlay, "cancelling closes the dialog");
  ok(cancelled.sessionsAfter === cancelled.sessionsBefore, `and starts no session (${cancelled.sessionsBefore} -> ${cancelled.sessionsAfter})`);

  // --- the verdict, back on the row -----------------------------------------
  const note = await app.eval(`(async () => {
    document.querySelectorAll("#probeRow").forEach((n) => n.remove());
    const wrap = document.createElement("div");
    wrap.id = "probeRow";
    wrap.append(reviewRowEl(${JSON.stringify(ROW)}, "stamp"));
    document.body.append(wrap);
    const item = wrap.querySelector(".rev-item");
    item.querySelector(".rev-head").click();
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (item.querySelector(".rev-list-independent")) {
        break;
      }
    }
    const box = item.querySelector(".rev-list-independent");
    return {
      present: !!box,
      label: box?.querySelector(".rev-list-label")?.textContent || null,
      text: box?.querySelector(".rev-independent-note")?.textContent || null,
    };
  })()`);
  ok(note.present, "a verdict a reviewer wrote shows up on the row that asked for it");
  ok(/Independent reviewer · written/.test(note.label || ""), `labelled with when it was written (${JSON.stringify(note.label)})`);
  ok(/NOT CONFIRMED/.test(note.text || ""), `carrying its actual verdict (${JSON.stringify((note.text || "").slice(0, 40))})`);
  ok(/main\.js:4120/.test(note.text || ""), "including the finding's file:line, unmangled");

  // A row whose reviewer has not written anything renders no such block - an empty
  // "Independent reviewer" heading would read as a pass that was never made.
  const absent = await app.eval(`(async () => {
    const row = ${JSON.stringify({ ...ROW, taskId: "ffffffff-1111-2222-3333-444444444444" })};
    document.querySelectorAll("#probeRow").forEach((n) => n.remove());
    const wrap = document.createElement("div");
    wrap.id = "probeRow";
    wrap.append(reviewRowEl(row, "stamp"));
    document.body.append(wrap);
    wrap.querySelector(".rev-head").click();
    await new Promise((r) => setTimeout(r, 700));
    return { present: !!wrap.querySelector(".rev-list-independent") };
  })()`);
  ok(!absent.present, "and a row with no verdict shows no reviewer block at all");

  const errors = app.getConsoleErrors();
  ok(errors.length === 0, `no console errors (${errors.length})`);
  for (const e of errors.slice(0, 5)) {
    console.log("   ", e.text.slice(0, 200));
  }
} catch (err) {
  exit = 1;
  console.error("ERR", err.stack || err.message);
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
    ? "VERIFY OK: the dispatch names its cost and its recommendation, cancelling spends nothing, and a reviewer's verdict lands on the row."
    : "VERIFY FAILED."
);
process.exit(exit);
