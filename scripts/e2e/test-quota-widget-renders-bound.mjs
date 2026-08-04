// What the Quota widget ACTUALLY SHOWS, with the captain's own data in it.
//
// Task 60738335 has come back twice, and both times the logic was verified while
// the rendered surface was not. So this one asserts the text on screen: the widget
// body is built in the real app from his real accumulator, and its words are read
// back.
//
// Run:  node scripts/e2e/test-quota-widget-renders-bound.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-qbound-"));
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9487";
const { launch } = await import("./harness.mjs");

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const res = await app.eval(`(() => {
    const HOUR = 3600000;
    const now = Date.now();
    // the captain's real windows, as read from C:\\Users\\aidin\\.helm\\config.json:
    // the weekly one 39.34h old at 36%, the five-hour one 4 minutes old with no
    // utilization field at all.
    state.quotaWindows = [
      { info: { status: "allowed_warning", resetsAt: Math.floor((now + 4.5 * 86400000) / 1000), rateLimitType: "seven_day", utilization: 0.36 }, at: now - 39.34 * HOUR },
      { info: { status: "allowed", resetsAt: Math.floor((now + 4 * HOUR) / 1000), rateLimitType: "five_hour", overageStatus: "rejected" }, at: now - 0.07 * HOUR },
    ];
    const host = document.createElement("div");
    host.append(widgetBodyQuota({ budget: null }));
    return {
      head: host.querySelector(".wd-quota-head")?.textContent || "",
      sub: host.querySelector(".wd-quota-sub")?.textContent || "",
      lines: [...host.querySelectorAll(".wd-quota-line")].map((l) => l.textContent),
      ages: [...host.querySelectorAll(".wd-quota-age")].map((a) => a.textContent),
      all: host.textContent,
    };
  })()`);

  console.log(`    head: ${JSON.stringify(res.head)}`);
  console.log(`    sub:  ${JSON.stringify(res.sub)}`);
  console.log(`    rows: ${JSON.stringify(res.lines)}`);

  // The headline goes to the FRESH window, not the most constrained one, because a
  // 39-hour-old reading is barred from the headline by the age ceiling added
  // earlier the same day. So the layout is: five-hour up top, weekly as a row. That
  // is the right way round - the biggest number on screen should be one that can
  // still be true - and it is what his screenshot showed too.
  ok(/5-hour/.test(res.head), `the headline is the window that reported minutes ago (${JSON.stringify(res.head)})`);
  ok(!/≥/.test(res.head), "which needs no qualifier, being current");

  // The weekly row is the whole complaint: it must carry BOTH its age and the
  // floor, in the row itself, not in a tooltip.
  const weeklyRow = res.lines.find((l) => /Weekly/.test(l)) || "";
  ok(!!weeklyRow, `the weekly window is listed (${JSON.stringify(res.lines)})`);
  ok(/as of 39h ago/.test(weeklyRow), `with how old the number is (${JSON.stringify(weeklyRow)})`);
  ok(/≥36% used/.test(weeklyRow), `and stated as a floor rather than a figure (${JSON.stringify(weeklyRow)})`);
  ok(res.ages.length >= 1, `the age is its own element, so it can be styled apart from the value (${res.ages.join(", ")})`);

  // The whole point of the complaint: nothing anywhere may present a bare "36%
  // used" as the current weekly figure.
  ok(!/(^|[^≥])36% used/.test(res.all), `nowhere does it claim a plain "36% used" (${JSON.stringify(res.all)})`);

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
    ? "VERIFY OK: with the captain's real data the widget says '≥36%' and 'as of 39h ago' on the surface he looks at, and never a bare 36%."
    : "VERIFY FAILED."
);
process.exit(exit);
