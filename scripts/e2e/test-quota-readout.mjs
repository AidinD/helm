// E2E (deterministic, no API turns): the quota display model (task 1975093d -
// "Token usage often shows 0% in the quota tab"). The real rate_limit_info payload
// has NO utilization field (it's { status, resetsAt, rateLimitType, overage... }),
// so the old `q.utilization || 0` always read a fabricated 0%. quotaReadout(q,
// nowMs) reports the real signal - a % only when utilization is genuinely present,
// otherwise the limit status + reset countdown. Exercised in the real loaded
// renderer via CDP eval, with nowMs injected so the countdown is deterministic.
//
// Run:  node scripts/e2e/test-quota-readout.mjs
import { launch } from "./harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function log(...a) {
  console.log("[quota-readout-e2e]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-quota-"));
const metaHome = path.join(tmp, "meta-home");
fs.mkdirSync(metaHome, { recursive: true });

// Reset 2h34m after "now" (resetsAt is unix SECONDS).
const RESETS_AT = 1784463600;
const NOW_MS = (RESETS_AT - (2 * 3600 + 34 * 60)) * 1000;

let app;
try {
  process.env.HELM_META_HOME_OVERRIDE = metaHome;
  process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const r = await app.eval(`(() => {
    const NOW = ${NOW_MS};
    // Aidin's REAL payload (from config.lastQuota): no utilization field.
    const real = { status: "allowed", resetsAt: ${RESETS_AT}, rateLimitType: "five_hour", isUsingOverage: false };
    return {
      real: quotaReadout(real, NOW),
      warn: quotaReadout({ ...real, status: "allowed_warning" }, NOW),
      rejected: quotaReadout({ ...real, status: "rejected" }, NOW),
      sevenDay: quotaReadout({ ...real, rateLimitType: "seven_day" }, NOW),
      pastReset: quotaReadout({ ...real, resetsAt: Math.floor(NOW/1000) - 60 }, NOW),
      withUtil: quotaReadout({ ...real, utilization: 0.62 }, NOW),
      utilHigh: quotaReadout({ ...real, utilization: 0.91 }, NOW),
      nul: quotaReadout(null, NOW),
    };
  })()`);

  // The core bug: real payload (no utilization) must NOT read 0%.
  assert(r.real.hasPct === false, "real payload (no utilization field) -> NOT a percentage readout");
  assert(r.real.chipText === "5h limit · OK", `real payload chip shows the limit + status, not "0%" (got ${JSON.stringify(r.real.chipText)})`);
  assert(/resets in 2h 34m/.test(r.real.barValueText), `the readout shows the reset countdown (got ${JSON.stringify(r.real.barValueText)})`);
  assert(/no longer reports a % used/.test(r.real.title), "the tooltip explains why there's no % (API dropped utilization)");
  assert(r.real.level === "ok", "an 'allowed' status is a calm/ok level");

  assert(r.warn.level === "warm" && /near limit/.test(r.warn.chipText), "allowed_warning -> warm + 'near limit'");
  assert(r.rejected.level === "hot" && /limited/.test(r.rejected.chipText), "rejected -> hot + 'limited'");
  assert(r.sevenDay.chipText === "7d limit · OK", `seven_day -> "7d limit" label (got ${JSON.stringify(r.sevenDay.chipText)})`);
  assert(/resets in now|resets in .*now/.test(r.pastReset.barValueText) || r.pastReset.barValueText.includes("now"), "a past resetsAt reads as 'now'");

  // Future-proof: if utilization ever comes back, show the real %.
  assert(r.withUtil.hasPct === true && r.withUtil.pct === 62 && r.withUtil.chipText === "Quota 62%", `utilization present -> real % (got ${JSON.stringify(r.withUtil.chipText)})`);
  assert(r.withUtil.level === "warm", "62% -> warm");
  assert(r.utilHigh.level === "hot" && r.utilHigh.pct === 91, "91% -> hot");
  assert(r.nul === null, "no quota data -> null");

  log(exitCode === 0 ? "VERIFY OK: quota shows the real limit status + reset (never a fabricated 0%), and a true % only when the API provides utilization." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.stack || err.message);
} finally {
  if (app) {
    const k = await app.close();
    log("cleanup app:", k || "(nothing)");
  }
  delete process.env.HELM_META_HOME_OVERRIDE;
  delete process.env.HELM_MATES_PATH;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
process.exit(exitCode);
