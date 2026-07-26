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
      warmUtil: quotaReadout({ ...real, utilization: 0.78 }, NOW),
      rejectedLowPct: quotaReadout({ ...real, status: "rejected", utilization: 0.4 }, NOW),
      utilHigh: quotaReadout({ ...real, utilization: 0.91 }, NOW),
      nul: quotaReadout(null, NOW),
      // --- bc6786c7: per-window accumulation (the desktop-app usage panel) ---
      labels: {
        fh: quotaWindowLabel("five_hour"),
        sd: quotaWindowLabel("seven_day"),
        sdo: quotaWindowLabel("seven_day_opus"),
        sds: quotaWindowLabel("seven_day_sonnet"),
        ov: quotaWindowLabel("overage"),
      },
      fresh: {
        recent: quotaFreshness(NOW - 30 * 1000, NOW),
        min5: quotaFreshness(NOW - 5 * 60 * 1000, NOW),
        h3: quotaFreshness(NOW - 3 * 60 * 60 * 1000, NOW),
        d2: quotaFreshness(NOW - 50 * 60 * 60 * 1000, NOW),
      },
      panel: quotaPanelRows(
        [
          { info: { status: "allowed", resetsAt: ${RESETS_AT}, rateLimitType: "seven_day_opus", utilization: 0.0 }, at: NOW },
          { info: { status: "rejected", resetsAt: ${RESETS_AT}, rateLimitType: "five_hour", utilization: 1.0 }, at: NOW - 5 * 60 * 1000 },
          { info: { status: "allowed", resetsAt: ${RESETS_AT}, rateLimitType: "seven_day", utilization: 0.24 }, at: NOW - 3 * 60 * 60 * 1000 },
        ],
        NOW,
      ),
    };
  })()`);
  r.worst = await app.eval(`(() => {
    const NOW = ${NOW_MS};
    const rows = quotaPanelRows([
      { info: { status: "allowed", resetsAt: ${RESETS_AT}, rateLimitType: "seven_day_opus", utilization: 0.0 }, at: NOW },
      { info: { status: "rejected", resetsAt: ${RESETS_AT}, rateLimitType: "five_hour", utilization: 1.0 }, at: NOW - 5 * 60 * 1000 },
      { info: { status: "allowed", resetsAt: ${RESETS_AT}, rateLimitType: "seven_day", utilization: 0.24 }, at: NOW - 3 * 60 * 60 * 1000 },
    ], NOW);
    return worstFreshQuotaRow(rows);
  })()`);

  // The core bug: real payload (no utilization) must NOT read 0%.
  assert(r.real.hasPct === false, "real payload (no utilization field) -> NOT a percentage readout");
  assert(r.real.chipText === "5-hour limit · OK", `real payload chip shows the limit + status, not "0%" (got ${JSON.stringify(r.real.chipText)})`);
  assert(/resets in 2h 34m/.test(r.real.barValueText), `the readout shows the reset countdown (got ${JSON.stringify(r.real.barValueText)})`);
  // Tooltip is deliberately terse: the limit + its reset, nothing else (Aidin
  // 2026-07-22 - the old one explained the API's utilization field, which he
  // didn't want). It must NOT drag in the API-internals explanation.
  assert(r.real.title === "5-hour limit · OK · resets in 2h 34m", `tooltip is just limit + status + reset (got ${JSON.stringify(r.real.title)})`);
  assert(!/api|utilization|misleading/i.test(r.real.title), "tooltip carries no API-internals explanation");
  assert(r.real.level === "ok", "an 'allowed' status is a calm/ok level");

  assert(r.warn.level === "warm" && /near limit/.test(r.warn.chipText), "allowed_warning -> warm + 'near limit'");
  assert(r.rejected.level === "hot" && /limited/.test(r.rejected.chipText), "rejected -> hot + 'limited'");
  assert(r.sevenDay.chipText === "Weekly · all models · OK", `seven_day -> weekly label (got ${JSON.stringify(r.sevenDay.chipText)})`);
  // bug bc6786c7: a reading whose reset window has already elapsed is STALE - it
  // must NOT keep showing a confident "OK" (that's how a 2-day-old reading read
  // "5h limit · OK" while the quota was spent).
  assert(r.pastReset.stale === true, "a past-reset reading is flagged stale");
  assert(!/OK/.test(r.pastReset.chipText) && r.pastReset.chipText.includes("—"), `a stale reading shows "—", not "OK" (got ${JSON.stringify(r.pastReset.chipText)})`);
  assert(r.pastReset.level === "stale" && /no current reading/.test(r.pastReset.title), "stale reading has a stale level + a terse 'no current reading' tooltip");

  // Future-proof: if utilization ever comes back, show the real %.
  assert(r.withUtil.hasPct === true && r.withUtil.pct === 62 && r.withUtil.chipText === "Quota 62%", `utilization present -> real % (got ${JSON.stringify(r.withUtil.chipText)})`);
  assert(r.withUtil.level === "ok", "62% -> ok/neutral (comfortable headroom)");
  assert(r.warmUtil.level === "warm", "78% -> warm/amber (tightening)");
  assert(r.rejectedLowPct.level === "hot", "rejected status -> hot even when pct is low (actually blocked)");
  assert(r.utilHigh.level === "hot" && r.utilHigh.pct === 91, "91% -> hot (effectively spent)");
  assert(r.nul === null, "no quota data -> null");

  // --- bc6786c7: the accumulated usage panel (desktop-app-style multi-window) ---
  assert(r.labels.fh === "5-hour limit" && r.labels.sd === "Weekly · all models", "window labels: 5-hour + weekly-all");
  assert(r.labels.sdo === "Weekly · Opus" && r.labels.sds === "Weekly · Sonnet" && r.labels.ov === "Overage", "per-model weekly + overage labels");
  assert(r.fresh.recent === null, "a <90s-old reading is fresh (no 'as of' noise)");
  assert(r.fresh.min5 === "as of 5m ago", `5m old -> minutes (got ${JSON.stringify(r.fresh.min5)})`);
  assert(r.fresh.h3 === "as of 3h ago", `3h old -> hours (got ${JSON.stringify(r.fresh.h3)})`);
  assert(r.fresh.d2 === "as of 2d ago", `50h old -> days (got ${JSON.stringify(r.fresh.d2)})`);
  // Panel: three windows, ordered short-first then weekly-all then per-model.
  assert(r.panel.length === 3, `panel stacks every accumulated window (got ${r.panel.length})`);
  assert(
    r.panel[0].type === "five_hour" && r.panel[1].type === "seven_day" && r.panel[2].type === "seven_day_opus",
    `panel ordered 5h -> weekly-all -> per-model (got ${JSON.stringify(r.panel.map((x) => x.type))})`,
  );
  assert(r.panel[0].level === "hot" && r.panel[0].pct === 100, "the spent 5-hour window reads hot @ 100%");
  assert(r.panel[0].freshness === "as of 5m ago" && r.panel[2].freshness === null, "each window carries its OWN freshness");
  // Chip summary picks the most-constrained fresh window, not the last one seen.
  assert(r.worst && r.worst.type === "five_hour" && r.worst.level === "hot", `chip summary = worst fresh window (got ${JSON.stringify(r.worst && r.worst.type)})`);

  log(exitCode === 0 ? "VERIFY OK: quota shows the real limit status + reset (never a fabricated 0%), a true % when the API provides utilization, AND stacks every accumulated limit window like the desktop usage panel." : "VERIFY FAILED.");
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
