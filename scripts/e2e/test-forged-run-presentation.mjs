// E2E: a FORGED check run must look wrong at every level of the review page.
//
// Why this is its own test. Run signing made gauntletStatus reject a fabricated
// outcome - but the page kept re-deriving each check's state from `run.ok`, a field
// the record's author writes. So a hand-written record drew a GREEN dot reading
// "exit 0" on the line a reader actually studies, while only the summary above it
// said "not confirmed". The detail contradicted the summary in the unsafe direction.
// Then the heading above BOTH still read "Ready to stamp - verified end to end".
//
// So the thing under test is not the tally, it is the PRESENTATION: dot, wording,
// visible command, summary breakdown, section heading, and header count all have to
// agree that nothing here has been verified.
//
// Run: node scripts/e2e/test-forged-run-presentation.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch } from "./harness.mjs";

let app;
let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails++;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-forge-"));
const metaHome = path.join(tmp, "meta-home");
const jotDir = path.join(tmp, "jot");
fs.mkdirSync(path.join(metaHome, ".helm", "reviews"), { recursive: true });
fs.mkdirSync(jotDir, { recursive: true });

const ID = "aaaaaaaa-1111-4111-8111-111111111111";
fs.writeFileSync(
  path.join(jotDir, "todos.json"),
  JSON.stringify({
    categories: [{ id: "c1", name: "Helm" }],
    todos: [{ id: ID, text: "Rotate the signing key", status: "review", categoryId: "c1", priority: 0, parentId: null, description: "" }],
  }),
  "utf8"
);
const configPath = path.join(tmp, "config.json");
fs.writeFileSync(configPath, JSON.stringify({ jot: { enabled: true, path: path.join(jotDir, "todos.json") } }), "utf8");

// Exactly what a session under time pressure would plausibly write: an authoritative
// label, a trivial command, and a green outcome complete with exit code and
// timestamp. Nothing validates this on write, and no command was ever executed.
const now = Date.now();
fs.writeFileSync(
  path.join(metaHome, ".helm", "reviews", `${ID}.json`),
  JSON.stringify({
    taskId: ID,
    title: "Rotate the signing key",
    verdict: "stamp",
    summary: "Key rotation implemented and verified end to end.",
    criticality: "core",
    evidence: ["34 assertions covering the rotation path"],
    notVerified: [],
    testSteps: [{ step: "Rotate a key", expect: "the old key stops working" }],
    checks: [{ label: "auth e2e (34 assertions)", cmd: "node -e \"process.exit(0)\"" }],
    checkRuns: [{ label: "auth e2e (34 assertions)", cmd: "node -e \"process.exit(0)\"", ok: true, exitCode: 0, ranAt: now }],
    updatedAt: now - 1000,
    contentUpdatedAt: now - 1000,
  }),
  "utf8"
);

process.env.HELM_CONFIG_PATH = configPath;
process.env.HELM_META_HOME_OVERRIDE = metaHome;
// The SESSIONS too, not just the records. This test isolated its config and meta-home but
// left the app reading Aidin's real session files - and the review page derives its "commits
// without a task" sections from the git projects those sessions point at. So a page that was
// supposed to render exactly ONE item rendered thirteen extra project sections, and grew a
// new one every time he opened a session in another repo. The check was not wrong; it was
// looking at his machine (2026-08-12, first full sweep since 08-02).
const emptyRoot = path.join(tmp, "no-sessions");
fs.mkdirSync(path.join(emptyRoot, "projects"), { recursive: true });
fs.mkdirSync(path.join(emptyRoot, "sessions"), { recursive: true });
process.env.HELM_SESSIONS_ROOT = path.join(emptyRoot, "sessions");
process.env.HELM_PROJECTS_ROOT = path.join(emptyRoot, "projects");
// And the goal-run history, which is the OTHER source of "projects Helm knows" - it was
// still handing the scan every repo an autopilot has ever touched.
process.env.HELM_GOAL_RUN_HISTORY_PATH = path.join(tmp, "goal-run-history.json");
fs.writeFileSync(process.env.HELM_GOAL_RUN_HISTORY_PATH, "[]", "utf8");
process.env.HELM_E2E_PORT = "9353";

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // The Review PAGE defaults to showing only repo-rooted records (reviewOnlyRepoRooted),
  // and these fixtures are deliberately not bound to a repo-rooted Jot category - so
  // without this they'd be filtered out and every DOM assertion below would read an
  // empty page. The repo filter is an orthogonal "how to look at the board" choice, not
  // part of what this test checks (how a forged run is PRESENTED), so neutralise it here.
  // (It does not affect window.helm.listReviews() / res.tally, which count the whole queue.)
  await app.eval(`reviewOnlyRepoRooted = false`);

  const res = await app.eval(`window.helm.listReviews()`);
  const row = (res.rows || [])[0];
  ok(row?.gauntlet?.state !== "passing", `the gauntlet does not read passing (${row?.gauntlet?.state})`);
  ok(row?.gauntlet?.unverified === 1, `the fabricated run is counted as unverified (${JSON.stringify(row?.gauntlet)})`);
  ok(row?.gauntlet?.passed === 0, "and not as a pass");
  // A hand-written {ok:true} run on a `core` record is now re-validated as inadmissible
  // ON READ (buildReviewQueue downgrades its verdict), so it lands in the `incomplete`
  // ("below the bar") band rather than `unconfirmed` - a STRONGER non-pass classification.
  // Either way the one requirement holds: it is NOT a stamp. (Was `unconfirmed === 1`
  // before the read-validation downgrade existed.)
  ok(res.tally?.incomplete === 1 && res.tally?.stamp === 0, `the header counts it as below-the-bar, not as a stamp (${JSON.stringify(res.tally)})`);

  await app.eval(`navigateToPage("review")`);
  await new Promise((r) => setTimeout(r, 1200));
  const ui = await app.eval(`(() => {
    const p = document.getElementById("reviewPage");
    const line = p.querySelector(".rev-check");
    return {
      dot: line?.querySelector(".rev-check-dot")?.className || "",
      label: line?.querySelector(".rev-check-label")?.textContent || "",
      cmd: line?.querySelector(".rev-check-cmd")?.textContent || "",
      state: line?.querySelector(".rev-check-state")?.textContent || "",
      header: p.querySelector(".rev-gauntlet-head b")?.textContent || "",
      bands: [...p.querySelectorAll("h3.rev-group")].map(h => h.textContent),
      badge: document.getElementById("reviewBadge")?.textContent || ""
    };
  })()`);

  ok(/unverified/.test(ui.dot), `the per-check dot uses the unverified state, not a green pass (${ui.dot})`);
  ok(/NOT VERIFIED/.test(ui.state), `and the line says so in words (${ui.state})`);
  ok(!/exit 0 ·/.test(ui.state), "it does NOT present the forged exit code as a result");
  ok(ui.cmd === `node -e "process.exit(0)"`, `the real command is on screen next to the impressive label (${ui.cmd})`);
  ok(ui.label === "auth e2e (34 assertions)", "the label is still shown - the point is that both are visible");
  ok(/NOT VERIFIED/.test(ui.header), `the summary line names the reason rather than just a count (${ui.header})`);
  ok(!/passing/i.test(ui.header), "the summary line does not say passing");
  ok(ui.bands.some((b) => /Below the bar/.test(b)), `it sits under its own honest heading (${JSON.stringify(ui.bands)})`);
  // This used to assert the absence of "verified end to end" - a phrase no heading has
  // contained since the wording changed, so it asserted the absence of something that
  // never existed. Assert the real requirement: the ONLY heading present is the honest
  // one, and the reassuring stamp heading is not on the page at all.
  ok(ui.bands.length === 1, `only one band renders for a single item (${JSON.stringify(ui.bands)})`);
  ok(!ui.bands.some((b) => /Ready to stamp/.test(b)), "the reassuring 'Ready to stamp' heading is not on the page for an unconfirmed item");
  ok(ui.badge === "1", `the subnav badge counts it as needing attention (got "${ui.badge}")`);

  // THE SAME ATTACK WITHOUT ANY FORGERY. A check whose command cannot fail is
  // genuinely run and correctly signed by the app - and for a while it read "Checks
  // passing (1/1)", banded as a stamp, counted zero in tally.unconfirmed, raised no
  // badge and signed off on one click. passForcingReason detected it and nothing acted
  // on the detection.
  const FORCED = "bbbbbbbb-2222-4222-8222-222222222222";
  const board = JSON.parse(fs.readFileSync(path.join(jotDir, "todos.json"), "utf8"));
  board.todos.push({ id: FORCED, text: "Rotate the other key", status: "review", categoryId: "c1", priority: 1, parentId: null, description: "" });
  fs.writeFileSync(path.join(jotDir, "todos.json"), JSON.stringify(board), "utf8");
  fs.writeFileSync(
    path.join(metaHome, ".helm", "reviews", `${FORCED}.json`),
    JSON.stringify({
      taskId: FORCED,
      title: "Rotate the other key",
      verdict: "stamp",
      summary: "Done and covered by the auth suite.",
      criticality: "core",
      projectPath: process.cwd(),
      evidence: [],
      notVerified: [],
      testSteps: [{ step: "Rotate a key", expect: "the old key stops working" }],
      checks: [{ label: "auth suite (34 assertions)", cmd: 'node -e "process.exit(0)" || exit 0' }],
      updatedAt: now - 1000,
      contentUpdatedAt: now - 1000,
    }),
    "utf8"
  );
  const ranForReal = await app.eval(`window.helm.runReviewChecks(${JSON.stringify(FORCED)})`);
  ok(ranForReal?.results?.[0]?.exitCode === 0, `the pass-forcing command really does exit 0 (${ranForReal?.results?.[0]?.exitCode})`);
  const res2 = await app.eval(`window.helm.listReviews()`);
  const forcedRow = (res2.rows || []).find((r) => r.taskId === FORCED);
  ok(forcedRow?.gauntlet?.state !== "passing", `a genuinely-run, correctly-signed check that CANNOT FAIL does not read as passing (${forcedRow?.gauntlet?.state})`);
  ok(forcedRow?.gauntlet?.unusable === 1 && forcedRow?.gauntlet?.passed === 0, `it is counted as unusable, not as a pass (${JSON.stringify(forcedRow?.gauntlet)})`);
  ok(forcedRow?.band === "unconfirmed", `it bands as unconfirmed rather than stamp (${forcedRow?.band})`);
  ok(res2.tally?.stamp === 0, `the header does not count it as ready to stamp (${JSON.stringify(res2.tally)})`);

  await app.eval(`renderReviewPage()`);
  await new Promise((r) => setTimeout(r, 900));
  const forcedUi = await app.eval(`(() => {
    const p = document.getElementById("reviewPage");
    const line = [...p.querySelectorAll(".rev-check")].find(l => /CANNOT FAIL/i.test(l.textContent));
    return {
      found: !!line,
      cmdClass: line?.querySelector(".rev-check-cmd")?.className || "",
      state: line?.querySelector(".rev-check-state")?.textContent || "",
      headers: [...p.querySelectorAll(".rev-gauntlet-head b")].map(b => b.textContent)
    };
  })()`);
  ok(forcedUi.found === true, "the line says the command cannot fail");
  ok(/forced/.test(forcedUi.cmdClass), `the command itself is marked (${forcedUi.cmdClass})`);
  ok(forcedUi.headers.some((h) => /CANNOT FAIL/.test(h)), `and the summary line names it (${JSON.stringify(forcedUi.headers)})`);

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
console.log(fails === 0 ? "\nVERIFY OK: a fabricated green run reads as unverified in the dot, the wording, the summary, the heading and the badge." : `\nVERIFY FAILED (${fails})`);
process.exit(fails === 0 ? 0 : 1);
