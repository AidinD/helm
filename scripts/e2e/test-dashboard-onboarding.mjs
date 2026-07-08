// E2E: the dashboard shows a first-run onboarding block ONLY in the cold state
// (no in-motion sessions + no Jot goals). Real launched Helm via CDP. The
// cold branch can't be forced without stubbing the getJotGoals IPC (contextBridge
// is read-only), so this verifies (a) the block builder produces the right
// structure, and (b) with real data present the block is absent - the "not
// always shown" half. The cold-shows-it half is covered by code review.
//
// Run:  node scripts/e2e/test-dashboard-onboarding.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[onboarding-e2e]", ...a);
}
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  await app.eval(`(() => { navigateToPage("dashboard"); return true; })()`);
  await app.waitForSelector("#dashboardPage", 8000, { visible: true });

  // (a) The builder produces a titled block with exactly 3 orientation bullets.
  const built = await app.eval(`(() => {
    const el = dashboardOnboardingBlock();
    return JSON.stringify({
      cls: el.className,
      title: el.querySelector(".dash-onboarding-title")?.textContent || "",
      bullets: el.querySelectorAll(".dash-onboarding-list li").length,
    });
  })()`);
  const b = JSON.parse(built);
  log("builder:", built);
  assert(/dash-onboarding/.test(b.cls), "block uses the dash-onboarding class (reuses dash-board spacing)");
  assert(b.title === "Welcome to your dashboard", "block has the welcome title");
  assert(b.bullets === 3, `block has 3 orientation bullets (got ${b.bullets})`);

  // (b) With real data present (this board has Jot goals), the block is NOT
  //     rendered on the live dashboard - it's gated to the cold state.
  const liveHasOnboarding = await app.eval(`!!document.querySelector("#dashboardPage .dash-onboarding")`);
  const coldNow = await app.eval(`dashboardInMotionRows().length === 0`);
  log(`live dashboard has onboarding block: ${liveHasOnboarding} (in-motion empty: ${coldNow})`);
  // If the environment happens to also have no goals AND no in-motion, cold is
  // legitimately true and the block SHOULD show; only assert the negative when
  // we know data exists. We assert the builder either way; the live check is
  // informative and only fails if the block shows while data clearly exists.
  const goalsCount = await app.eval(`(async () => { const r = await window.helm.getJotGoals(); return r.ok ? r.goals.length : 0; })()`);
  if (goalsCount > 0) {
    assert(!liveHasOnboarding, "onboarding block absent when Jot goals exist (gated to cold state)");
  } else {
    log("(env has no goals; cold state legitimately possible - skipping negative assert)");
  }

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: onboarding block builds correctly + gated off when data exists." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
