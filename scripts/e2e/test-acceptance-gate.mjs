// E2E through the real app: acceptance criteria written on a Jot task before the
// work, and the criticality gradient, both enforced at the review boundary
// (Flow task bd5d7b4b).
//
// Tested through the running app rather than only the pure modules, because the
// lesson that produced this feature was that a green unit test on the layer the
// author already reasoned about proves very little. What matters here is what the
// REVIEW PAGE says: an item whose evidence doesn't answer the agreed question, or a
// critical item with nothing independent behind it, must not read as verified.
//
// Run: node scripts/e2e/test-acceptance-gate.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch } from "./harness.mjs";
import { writeReviewRecord, readReviewRecord } from "../../src/lib/reviewRecords.js";

let app;
let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails++;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-acc-"));
const metaHome = path.join(tmp, "meta-home");
const jotDir = path.join(tmp, "jot");
fs.mkdirSync(metaHome, { recursive: true });
fs.mkdirSync(jotDir, { recursive: true });

const COVERED = "aaaaaaaa-1111-4111-8111-111111111111";
const UNCOVERED = "bbbbbbbb-2222-4222-8222-222222222222";
const CRIT = "cccccccc-3333-4333-8333-333333333333";
const DRIFTED = "dddddddd-4444-4444-8444-444444444444";

// The criteria live in the task's own description, as AC: lines - where the captain can
// see and correct them before the work starts.
const AC_TEXT = "AC: clicking Jump in lands me in that project's session";
fs.writeFileSync(
  path.join(jotDir, "todos.json"),
  JSON.stringify({
    categories: [{ id: "c1", name: "Helm" }],
    todos: [
      { id: COVERED, text: "Covered feature", status: "review", categoryId: "c1", priority: 0, parentId: null, description: `blah\n${AC_TEXT}\nmore prose` },
      { id: UNCOVERED, text: "Uncovered feature", status: "review", categoryId: "c1", priority: 1, parentId: null, description: AC_TEXT },
      { id: CRIT, text: "Critical feature", status: "review", categoryId: "c1", priority: 2, parentId: null, description: "" },
      { id: DRIFTED, text: "Drifted feature", status: "review", categoryId: "c1", priority: 3, parentId: null, description: "AC: the criterion was changed after the work" },
    ],
  }),
  "utf8"
);
const configPath = path.join(tmp, "config.json");
fs.writeFileSync(configPath, JSON.stringify({ jot: { enabled: true, path: path.join(jotDir, "todos.json") } }), "utf8");
process.env.HELM_CONFIG_PATH = configPath;
process.env.HELM_META_HOME_OVERRIDE = metaHome;
process.env.HELM_E2E_PORT = "9352";

const base = (over) => ({
  verdict: "stamp",
  summary: "A feature.",
  evidence: [],
  notVerified: [],
  criticality: "cosmetic",
  projectPath: "D:/Repo/Tools/helm",
  ...over,
});
const AC = [{ index: 1, text: "clicking Jump in lands me in that project's session" }];

// 1. Criteria covered by a linked step -> admissible.
const wroteCovered = writeReviewRecord(metaHome, base({
  taskId: COVERED,
  title: "Covered feature",
  acceptanceCriteria: AC,
  testSteps: [{ step: "click Jump in", expect: "chat opens on that project's session", ac: 1 }],
}));

// 2. Same criteria, but the steps only check what the author happened to build.
//    This is the Jump-in bug reproduced as a record: a step that counts buttons.
const wroteUncovered = writeReviewRecord(metaHome, base({
  taskId: UNCOVERED,
  title: "Uncovered feature",
  acceptanceCriteria: AC,
  testSteps: [{ step: "count the Jump in buttons", expect: "one per row" }],
}));

// 3. Critical with no independent pass.
const wroteCrit = writeReviewRecord(metaHome, base({
  taskId: CRIT,
  title: "Critical feature",
  criticality: "critical",
  checks: [{ label: "unit", cmd: "node -e \"process.exit(0)\"" }],
  testSteps: [{ step: "do the thing", expect: "it happens" }],
}));

// 4. A record whose snapshotted criteria no longer match the task.
const wroteDrift = writeReviewRecord(metaHome, base({
  taskId: DRIFTED,
  title: "Drifted feature",
  acceptanceCriteria: [{ index: 1, text: "the ORIGINAL criterion before it was edited" }],
  testSteps: [{ step: "check the original thing", expect: "it works", ac: 1 }],
}));

try {
  ok(wroteCovered.ok === true, "a record whose steps answer the agreed criteria is accepted");
  ok(wroteUncovered.ok === false, `a record whose steps DON'T answer the criteria is REFUSED (${wroteUncovered.error?.slice(0, 90)})`);
  ok(/no test step covering it/.test(wroteUncovered.error || ""), "and the refusal names the uncovered criterion");
  ok(readReviewRecord(metaHome, UNCOVERED) === null, "nothing was written for the refused record - it can't half-exist");
  ok(wroteCrit.ok === false && /independentReview/.test(wroteCrit.error || ""), `a CRITICAL record with no independent pass is refused (${wroteCrit.error?.slice(0, 80)})`);
  ok(wroteDrift.ok === true, "the drifted record itself is valid - drift is not a validity problem");

  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const res = await app.eval(`window.helm.listReviews()`);
  const rows = res?.rows || [];
  const byId = Object.fromEntries(rows.map((r) => [r.taskId, r]));
  ok(rows.length === 4, `all four board items appear in the queue (${rows.length})`);

  // The refused ones must be visibly NOT verified, and distinguishable from each
  // other: nobody-wrote-one vs somebody-wrote-an-inadmissible-one.
  ok(byId[COVERED]?.verdict === "stamp", `the admissible record reads as a stamp (${byId[COVERED]?.verdict})`);
  ok(byId[UNCOVERED]?.verdict === "unrecorded", `the refused record leaves the task with NO record at all (${byId[UNCOVERED]?.verdict})`);
  ok(byId[CRIT]?.verdict === "unrecorded", `the refused critical record likewise (${byId[CRIT]?.verdict})`);
  ok(byId[COVERED]?.criticality === "cosmetic", "criticality reaches the queue row");
  ok(byId[DRIFTED]?.drift?.drifted === true, "a record whose criteria were edited afterwards is flagged as drifted");
  ok(byId[COVERED]?.drift?.drifted === false, "a record matching its task's criteria is not flagged");

  // An inadmissible record that ALREADY EXISTS on disk (e.g. written before a rule
  // tightened) must read as "incomplete" - louder than unrecorded, because somebody
  // claimed this was reviewed.
  const legacyPath = path.join(metaHome, ".helm", "reviews", `${CRIT}.json`);
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(
    legacyPath,
    JSON.stringify({ taskId: CRIT, title: "Critical feature", verdict: "stamp", summary: "legacy", evidence: [], notVerified: [], criticality: "critical", testSteps: [{ step: "a", expect: "b" }], checks: [{ label: "u", cmd: "x" }] }),
    "utf8"
  );
  const res2 = await app.eval(`window.helm.listReviews()`);
  const crit = (res2.rows || []).find((r) => r.taskId === CRIT);
  ok(crit?.verdict === "incomplete", `an existing-but-inadmissible record reads as "incomplete", not "unrecorded" (${crit?.verdict})`);
  ok((crit?.problems || []).some((p) => /independentReview/.test(p)), "and says exactly what it is missing");
  ok(res2.tally?.incomplete === 1, `the header counts it apart from the missing ones (${JSON.stringify(res2.tally)})`);
  ok(res2.tally?.critical >= 1, "and counts how many critical items are in the queue");

  // Ordering: judgment first, then criticality - a critical item must never sit
  // below a cosmetic one just because it was filed later.
  const order = (res2.rows || []).map((r) => `${r.verdict}/${r.criticality || "-"}`);
  const firstIncomplete = order.findIndex((o) => o.startsWith("incomplete"));
  const firstUnrecorded = order.findIndex((o) => o.startsWith("unrecorded"));
  ok(firstIncomplete < firstUnrecorded, `an inadmissible record outranks a missing one (${order.join(" | ")})`);
  // A critical item claiming to be reviewed but inadmissible belongs ABOVE cheap
  // stamps: burying it under a batch of cosmetic rubber-stamps hides the one alarm
  // the criticality gradient exists to raise.
  ok(order[0] === "incomplete/critical", `a critical-but-inadmissible record sorts to the TOP, above cosmetic stamps (${order.join(" | ")})`);

  // And the page renders all of it.
  await app.eval(`navigateToPage("review")`);
  await new Promise((r) => setTimeout(r, 1200));
  const ui = await app.eval(`(() => {
    const p = document.getElementById("reviewPage");
    return {
      acceptanceBoxes: p.querySelectorAll(".rev-acceptance").length,
      acLinks: [...p.querySelectorAll(".rev-step-ac")].map(e => e.textContent),
      warns: [...p.querySelectorAll(".rev-warn")].map(e => e.textContent.slice(0, 70)),
      critChips: [...p.querySelectorAll(".rev-chip")].filter(e => /critical|core|cosmetic/.test(e.textContent)).map(e => e.textContent)
    };
  })()`);
  ok(ui.acceptanceBoxes >= 1, `the agreed criteria are shown on the card (${ui.acceptanceBoxes} box(es))`);
  ok(ui.acLinks.some((t) => /AC 1/.test(t)), `each step shows which criterion it answers (${JSON.stringify(ui.acLinks)})`);
  ok(ui.warns.some((w) => /does not meet the bar/i.test(w)), `the inadmissible record is called out on the page (${JSON.stringify(ui.warns)})`);
  ok(ui.warns.some((w) => /acceptance criteria changed/i.test(w)), "and so is the drift");
  ok(ui.critChips.length >= 1, `criticality shows as a chip (${JSON.stringify(ui.critChips)})`);

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
console.log(fails === 0 ? "\nVERIFY OK: evidence that doesn't answer the agreed question is refused, and a critical item can't be stamped without an independent pass." : `\nVERIFY FAILED (${fails})`);
process.exit(fails === 0 ? 0 : 1);
