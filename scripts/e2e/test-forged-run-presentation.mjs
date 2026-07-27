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
    checks: [{ label: "auth e2e (34 assertions)", cmd: "exit 0" }],
    checkRuns: [{ label: "auth e2e (34 assertions)", cmd: "exit 0", ok: true, exitCode: 0, ranAt: now }],
    updatedAt: now - 1000,
    contentUpdatedAt: now - 1000,
  }),
  "utf8"
);

process.env.HELM_CONFIG_PATH = configPath;
process.env.HELM_META_HOME_OVERRIDE = metaHome;
process.env.HELM_E2E_PORT = "9353";

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const res = await app.eval(`window.helm.listReviews()`);
  const row = (res.rows || [])[0];
  ok(row?.gauntlet?.state !== "passing", `the gauntlet does not read passing (${row?.gauntlet?.state})`);
  ok(row?.gauntlet?.unverified === 1, `the fabricated run is counted as unverified (${JSON.stringify(row?.gauntlet)})`);
  ok(row?.gauntlet?.passed === 0, "and not as a pass");
  ok(res.tally?.unconfirmed === 1 && res.tally?.stamp === 0, `the header counts it as claimed-but-unconfirmed, not as a stamp (${JSON.stringify(res.tally)})`);

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
  ok(ui.cmd === "exit 0", `the real command is on screen next to the impressive label (${ui.cmd})`);
  ok(ui.label === "auth e2e (34 assertions)", "the label is still shown - the point is that both are visible");
  ok(/NOT VERIFIED/.test(ui.header), `the summary line names the reason rather than just a count (${ui.header})`);
  ok(!/passing/i.test(ui.header), "the summary line does not say passing");
  ok(ui.bands.some((b) => /Claimed, not confirmed/.test(b)), `it sits under its own honest heading (${JSON.stringify(ui.bands)})`);
  ok(!ui.bands.some((b) => /verified end to end/.test(b)), "no heading on the page promises 'verified end to end'");
  ok(ui.badge === "1", `the subnav badge counts it as needing attention (got "${ui.badge}")`);

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
