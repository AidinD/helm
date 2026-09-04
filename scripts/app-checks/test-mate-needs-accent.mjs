// The amber bar on a first-mate card means the same thing as the "needs you"
// chip on it - always, in both directions.
//
// Task 8d14d861 - "varför är den här ramen där hela tiden?". Two surfaces of one
// signal were decided from two different fields: the chip from the session's
// STATUS (which honours the "done" acknowledgement and the other status
// overrides) and the bar from the raw lifecycle state, which stays "waiting"
// regardless. Acknowledging a reply removed the chip and left the bar burning -
// an amber marker with no word anywhere on the card saying what it meant, and it
// never went out.
//
// So this asserts the RULE, over the real card builder, across the states that
// actually occur: the bar is present exactly when the chip says "needs you".
// Checking one example would pass on a fix that only handled the case in the
// screenshot.
//
// Run:  node scripts/e2e/test-mate-needs-accent.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-needs-"));
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9477";
const { launch } = await import("../checks-lib/harness.mjs");

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const res = await app.eval(`(() => {
    const mate = { mateId: "m1", name: "Davy Jones", sessionId: "cli-1" };
    // Every combination that occurs in practice. "waiting/idle" is the one from
    // the screenshot: the FSM still says waiting, the status override says it is
    // settled because the reply was acknowledged.
    const cases = [
      { name: "waiting, no crew", status: "waiting", lifecycleState: "waiting" },
      { name: "acknowledged (status overridden, FSM still waiting)", status: "idle", lifecycleState: "waiting" },
      { name: "working", status: "active", lifecycleState: "running" },
      { name: "wrapped up", status: "waiting", lifecycleState: "wrapped" },
      { name: "idle both ways", status: "idle", lifecycleState: "idle" },
    ];
    const out = [];
    for (const c of cases) {
      state.sessions = [{ sessionId: "s1", cliSessionId: "cli-1", title: "mate session", cwd: "D:\\\\Repo\\\\Tools\\\\helm", status: c.status, lifecycleState: c.lifecycleState }];
      const card = fleetMateCardEl(mate, [], {});
      const badge = card.querySelector(".fleet-badge");
      out.push({
        name: c.name,
        bar: card.classList.contains("fleet-mate-needs"),
        badgeText: badge?.textContent || "",
        badgeKind: badge ? [...badge.classList].filter((x) => x !== "fleet-badge").join(" ") : "",
        title: card.title || "",
      });
    }
    return out;
  })()`);

  for (const r of res) {
    const chipSaysNeeds = r.badgeText === "needs you";
    ok(
      r.bar === chipSaysNeeds,
      `${r.name}: bar ${r.bar ? "on" : "off"}, chip "${r.badgeText || "none"}" - they agree`
    );
  }
  const acked = res.find((r) => r.name.startsWith("acknowledged"));
  ok(!acked.bar, "the case from the screenshot no longer shows a bar with nothing to explain it");
  const waiting = res.find((r) => r.name === "waiting, no crew");
  ok(waiting.bar && waiting.badgeText === "needs you", "and a mate that IS waiting on you still gets both");
  ok(waiting.title.length > 0, `the bar says in words what it means on hover (${JSON.stringify(waiting.title)})`);
  ok(!acked.title, "while a calm card carries no such claim");

  // The agreement above is only worth anything if there is ONE place that turns
  // the bar on. A second call site somewhere else would reintroduce exactly the
  // split this task was about, and the check above would not see it.
  const rSrc = fs.readFileSync(new URL("../../src/renderer/renderer.js", import.meta.url), "utf8");
  const adds = rSrc.match(/classList\.add\("fleet-mate-needs"\)/g) || [];
  ok(adds.length === 1, `exactly one place turns the bar on (${adds.length})`);
  ok(
    !/lifecycleState === "waiting" && !cw\.has/.test(rSrc),
    "and the old second opinion, read straight off the lifecycle state, is gone rather than bypassed"
  );

  const errors = app.getConsoleErrors();
  ok(errors.length === 0, `no console errors (${errors.length})`);
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
    ? "VERIFY OK: the amber bar on a first-mate card appears exactly when the card says 'needs you', and says so on hover."
    : "VERIFY FAILED."
);
process.exit(exit);
