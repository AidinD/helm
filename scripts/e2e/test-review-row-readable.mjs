// A review row is a headline until you open it, and what is inside reads as prose.
//
// the captain, task 10ac9c23: "review sectionen är lite jobbig att läsa - texten är liten och
// allt är ganska kompakt. Kanske ha alla kollapsade så expanderar man den man vill titta
// på med mycket bättre formatering."
//
// Two things are being checked, and the second is the bigger one. Evidence and
// notVerified are SENTENCES - "Not exercised against a real failing triage - the failure
// path was reasoned about from the code" - and they were rendered one chip each, in
// 10.5px monospace, wrapped across the full window. A chip is right for a commit sha and
// wrong for a sentence, so a chip holding one is the defect.
//
// The real row builder is driven with a fabricated row rather than a board fixture: the
// change is in reviewRowEl, and this way the assertions are about what it renders instead
// of about Jot.
//
// Run:  node scripts/e2e/test-review-row-readable.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-revrow-"));
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9521";
const { launch } = await import("./harness.mjs");

// A record of the shape that made the page hard to read: several long evidence lines and
// several long gaps.
const ROW = {
  taskId: "1f8cca7b-1111-2222-3333-444444444444",
  title: "auto kollar kön för ofta (tar det tokens?)",
  category: "Helm",
  priority: 0,
  criticality: "core",
  verdict: "stamp",
  problems: [],
  caveats: [],
  drift: { drifted: false, snapshot: [], live: [] },
  gauntlet: { declared: 1, passed: 0, failed: 0, stale: 0, unrun: 1, unverified: 0, unusable: 0, state: "incomplete", perCheck: [] },
  record: {
    taskId: "1f8cca7b-1111-2222-3333-444444444444",
    summary: "A failed auto triage now backs off with doubling waits instead of spending a model call on every 60-second pass forever.",
    verdict: "stamp",
    criticality: "core",
    evidence: [
      "The test lifts the real functions out of main.js (which cannot be imported - it boots Electron) rather than reimplementing the arithmetic, and asserts 2/4/8/16/32/60/60 minutes with the cap holding at 20 attempts.",
      "It also asserts the ORDER that makes the saving real: the backoff check sits before the model call and before the folder lookup, which spawns git per project.",
      { claim: "Mutation evidence", detail: "Removing the backoff branch turns the ordering assertions red." },
    ],
    notVerified: [
      "Not exercised against a real failing triage - the failure path was reasoned about from the code and tested through the functions, not by making a model call fail on purpose.",
      "Clock skew is unhandled: nextAt is an absolute stamp, so a backward system-clock jump turns a 2-minute wait into a long one until Helm restarts.",
    ],
    testSteps: [
      { step: "Turn the Auto lane on with a card whose triage cannot complete.", expect: "The card is reported as failing with a stated wait, and the wait grows each time." },
      { step: "Restart Helm while a card is waiting.", expect: "It is tried immediately - the backoff is in memory on purpose." },
    ],
    checks: [{ label: "backoff arithmetic and ordering", cmd: "node scripts/e2e/test-auto-triage-backoff.mjs" }],
    checkRuns: [],
    projectPath: "D:\\Repo\\Tools\\helm",
  },
};

const mount = `(() => {
  document.querySelectorAll("#probeRow").forEach((n) => n.remove());
  const wrap = document.createElement("div");
  wrap.id = "probeRow";
  wrap.append(reviewRowEl(${JSON.stringify(ROW)}, "stamp"));
  document.body.append(wrap);
  return true;
})()`;

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  await app.eval(mount);

  // --- collapsed by default ---------------------------------------------------
  const collapsed = await app.eval(`(() => {
    const item = document.querySelector("#probeRow .rev-item");
    const body = item.querySelector(".rev-body");
    return {
      headText: item.querySelector(".rev-head").textContent.trim(),
      bodyHidden: body.hidden,
      bodyVisible: body.getBoundingClientRect().height > 0,
      hasChevron: !!item.querySelector(".rev-chev"),
      open: item.classList.contains("rev-open"),
      headChips: [...item.querySelectorAll(".rev-head .rev-chip")].map((c) => c.textContent.trim()),
    };
  })()`);
  ok(collapsed.bodyHidden && !collapsed.bodyVisible, "a row starts collapsed - the record is not rendered open");
  ok(!collapsed.open, "and the row is not marked open");
  ok(collapsed.hasChevron, "with a chevron to say it opens");
  ok(/auto kollar kön/.test(collapsed.headText), `the head still names the task (${JSON.stringify(collapsed.headText.slice(0, 60))})`);
  // The one thing worth knowing before deciding to open it.
  ok(
    collapsed.headChips.some((c) => /checks/.test(c)),
    `and carries the checks' state while collapsed (${JSON.stringify(collapsed.headChips)})`
  );

  // --- opening it -------------------------------------------------------------
  const opened = await app.eval(`(() => {
    const item = document.querySelector("#probeRow .rev-item");
    item.querySelector(".rev-head").click();
    const body = item.querySelector(".rev-body");
    const evid = item.querySelector(".rev-list-evidence");
    const gaps = item.querySelector(".rev-list-gaps");
    const chipTexts = [...item.querySelectorAll(".rev-chip")].map((c) => c.textContent.trim());
    const style = getComputedStyle(body);
    return {
      bodyVisible: body.getBoundingClientRect().height > 0,
      open: item.classList.contains("rev-open"),
      evidenceItems: evid ? [...evid.querySelectorAll("li")].map((li) => li.textContent.trim()) : null,
      evidenceLabel: evid?.querySelector(".rev-list-label")?.textContent || null,
      gapItems: gaps ? [...gaps.querySelectorAll("li")].map((li) => li.textContent.trim()) : null,
      gapLabel: gaps?.querySelector(".rev-list-label")?.textContent || null,
      longestChip: chipTexts.reduce((n, t) => Math.max(n, t.length), 0),
      chipTexts,
      steps: [...item.querySelectorAll(".rev-steps li")].length,
      fontSize: parseFloat(style.fontSize),
      // The reading width is the CARD's - see the note in style.css. Measured on the
      // card, because capping only the text produced a wide card with a narrow ribbon.
      cardWidth: item.getBoundingClientRect().width,
      widthPx: body.getBoundingClientRect().width,
      windowWidth: window.innerWidth,
    };
  })()`);
  ok(opened.bodyVisible && opened.open, "clicking the head opens it");

  // THE point: sentences render as list items, not as pills.
  ok(opened.evidenceItems?.length === 3, `evidence renders as a list of 3 items (${opened.evidenceItems?.length})`);
  ok(/^Evidence · 3$/.test(opened.evidenceLabel || ""), `under a labelled heading with its count (${JSON.stringify(opened.evidenceLabel)})`);
  ok(
    opened.evidenceItems?.[2] === "Mutation evidence - Removing the backoff branch turns the ordering assertions red.",
    `a {claim, detail} entry is joined into one readable line (${JSON.stringify(opened.evidenceItems?.[2])})`
  );
  ok(opened.gapItems?.length === 2, `the gaps render as their own list (${opened.gapItems?.length})`);
  ok(/^Not verified · 2$/.test(opened.gapLabel || ""), `named as gaps rather than mixed in with the evidence (${JSON.stringify(opened.gapLabel)})`);
  ok(
    opened.longestChip <= 40,
    `no chip is holding a sentence any more - longest chip is ${opened.longestChip} chars (${JSON.stringify(opened.chipTexts)})`
  );
  ok(opened.steps === 2, `the test steps still render (${opened.steps})`);

  // Readability, measured: a real prose size and a line length that does not run the
  // width of a wide window ("texten är liten och allt är ganska kompakt").
  ok(opened.fontSize >= 13, `the body text is not tiny (${opened.fontSize}px)`);
  ok(
    opened.cardWidth <= 940 && opened.cardWidth < opened.windowWidth * 0.8,
    `and the card is a readable column rather than the whole window (${Math.round(opened.cardWidth)}px of ${opened.windowWidth}px)`
  );
  ok(
    opened.widthPx <= opened.cardWidth,
    `with the text filling that column instead of a narrow ribbon inside a wide card (${Math.round(opened.widthPx)}px in ${Math.round(opened.cardWidth)}px)`
  );

  // --- and it closes again ----------------------------------------------------
  const reclosed = await app.eval(`(() => {
    const item = document.querySelector("#probeRow .rev-item");
    item.querySelector(".rev-head").click();
    return { hidden: item.querySelector(".rev-body").hidden, open: item.classList.contains("rev-open") };
  })()`);
  ok(reclosed.hidden && !reclosed.open, "clicking again closes it");

  // A row with NO record must still be actionable: its actions used to be built after an
  // early return, so that band had no controls at all. The collapse must not resurrect
  // that - the actions moved into the body, so they have to BE in the body.
  const unrecorded = await app.eval(`(() => {
    document.querySelectorAll("#probeRow").forEach((n) => n.remove());
    const wrap = document.createElement("div");
    wrap.id = "probeRow";
    wrap.append(reviewRowEl({ taskId: "2f8cca7b-1111-2222-3333-444444444444", title: "no record here", problems: ["no review record was written for this task"], verdict: "unrecorded", caveats: [], drift: { drifted: false, snapshot: [], live: [] }, gauntlet: { declared: 0, state: "none" } }, "unrecorded"));
    document.body.append(wrap);
    const item = wrap.querySelector(".rev-item");
    item.querySelector(".rev-head").click();
    const body = item.querySelector(".rev-body");
    return {
      warned: /No review record/.test(body.textContent),
      buttons: [...body.querySelectorAll("button")].map((b) => b.textContent.trim()),
    };
  })()`);
  ok(unrecorded.warned, "an unrecorded row still says so when opened");
  ok(
    unrecorded.buttons.length > 0,
    `and still has its actions, which an earlier version of this row lost entirely (${JSON.stringify(unrecorded.buttons)})`
  );

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
    ? "VERIFY OK: review rows start collapsed, open on a click, and their evidence and gaps read as prose instead of pills."
    : "VERIFY FAILED."
);
process.exit(exit);
