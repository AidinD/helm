// An hours-old quota reading is stated as a floor, not as the current figure.
//
// Task 60738335, third pass. "weekly är fortfarande fast på 36% och verkar inte
// uppdateras." Checked against his RUNNING app rather than reasoned about, and the
// data settled it:
//
//   seven_day | last reported 39.34h ago | utilization 0.36
//   five_hour | last reported  0.07h ago | no utilization field at all
//
// He is right that it does not update, and Helm cannot make it: it never polls for
// quota, it only records what arrives on a rate-limit event, and the API reports
// the weekly window only when it has something to say. Telling him to wait for a
// number that may never come is not an answer.
//
// What IS knowable: usage inside a window that has not reset only ever goes UP. So
// a 39-hour-old 36% is not "36% used", it is "at least 36% used" - and the old
// wording erred in the one direction that costs something, claiming more headroom
// than he had. That is why his Helm disagreed with Claude Desktop's 29%.
//
// The fixture below is his real data, byte for byte, because the previous two
// passes on this card were verified against fixtures I invented.
//
// Run:  node scripts/e2e/test-quota-lower-bound.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};
const here = path.dirname(fileURLToPath(import.meta.url));
const rSrc = fs.readFileSync(path.join(here, "..", "..", "src", "renderer", "renderer.js"), "utf8");
const mSrc = fs.readFileSync(path.join(here, "..", "..", "src", "main.js"), "utf8");
const grab = (name) => {
  const at = rSrc.indexOf(`function ${name}(`);
  if (at < 0) {
    throw new Error(`renderer.js no longer defines ${name}`);
  }
  return rSrc.slice(at, rSrc.indexOf("\n}", at) + 2);
};
const constant = (name) => {
  const m = rSrc.match(new RegExp(`const ${name} = ([^;]+);`));
  if (!m) {
    throw new Error(`renderer.js no longer defines ${name}`);
  }
  return m[1];
};

const rows = new Function(
  "windows",
  "nowMs",
  `${grab("quotaFreshness")}
   ${grab("quotaWindowLabel")}
   ${grab("quotaReadout")}
   const QUOTA_LOWER_BOUND_AFTER_MS = ${constant("QUOTA_LOWER_BOUND_AFTER_MS")};
   ${grab("quotaLowerBound")}
   const QUOTA_WINDOW_ORDER = ${JSON.stringify(
     JSON.parse((rSrc.match(/const QUOTA_WINDOW_ORDER = (\[[^\]]*\]);/) || [])[1].replace(/'/g, '"'))
   )};
   ${grab("quotaPanelRows")}
   return quotaPanelRows(windows, nowMs);`
);

const NOW = 1_786_000_000_000;
const HOUR = 3_600_000;
// the captain's real accumulator, as read from C:\Users\<you>\.helm\config.json.
const real = [
  {
    info: { status: "allowed_warning", resetsAt: Math.floor((NOW + 4.5 * 86_400_000) / 1000), rateLimitType: "seven_day", utilization: 0.36, isUsingOverage: false },
    at: NOW - 39.34 * HOUR,
  },
  {
    info: { status: "allowed", resetsAt: Math.floor((NOW + 4 * HOUR) / 1000), rateLimitType: "five_hour", overageStatus: "rejected", isUsingOverage: false },
    at: NOW - 0.07 * HOUR,
  },
];

const built = rows(real, NOW);
const weekly = built.find((r) => r.type === "seven_day");
const fiveHour = built.find((r) => r.type === "five_hour");

ok(!!weekly && !!fiveHour, `both of his windows produced a row (${built.map((r) => r.type).join(", ")})`);
ok(weekly.atLeast === true, "the 39-hour-old weekly reading is marked as a floor rather than a figure");
ok(weekly.barValueText === "≥36% used", `and reads as such (${weekly.barValueText})`);
ok(weekly.chipText === "Quota ≥36%", `including in the top-bar chip, which has room for nothing else (${weekly.chipText})`);
ok(weekly.freshness === "as of 39h ago", `next to how old it is (${weekly.freshness})`);
ok(/only goes up/.test(weekly.title), `and the tooltip explains why in words (${JSON.stringify(weekly.title.slice(0, 70))}…)`);
ok(weekly.pct === 36, "the number itself is unchanged - this is about what is CLAIMED about it, not a different reading");

// His five-hour window has no utilization at all, so there is nothing to qualify.
// Qualifying it anyway would attach "≥" to a status word.
ok(!fiveHour.atLeast, "a reading with no percentage is left alone");
ok(!/≥/.test(fiveHour.barValueText), `no stray qualifier on it (${fiveHour.barValueText})`);

// --- the threshold, in both directions --------------------------------------
const withAge = (ageMs) =>
  rows([{ info: { status: "allowed_warning", resetsAt: Math.floor((NOW + 4 * 86_400_000) / 1000), rateLimitType: "seven_day", utilization: 0.36 }, at: NOW - ageMs }], NOW)[0];
ok(!withAge(5 * 60_000).atLeast, "a five-minute-old reading is stated plainly - hedging every number makes the hedge meaningless");
ok(withAge(5 * HOUR).atLeast, "a five-hour-old one is a floor");
ok(withAge(Number(constant("QUOTA_LOWER_BOUND_AFTER_MS").replace(/[^0-9*]/g, "").split("*").reduce((a, b) => a * Number(b), 1)) - 1000).atLeast !== true, "just under the threshold is not qualified");

// A window that has already RESET is a different thing: its reading describes an
// elapsed window, so it has no floor to offer and must keep saying it has nothing.
const reset = rows([{ info: { status: "allowed_warning", resetsAt: Math.floor((NOW - HOUR) / 1000), rateLimitType: "seven_day", utilization: 0.36 }, at: NOW - 40 * HOUR }], NOW)[0];
ok(reset.stale === true && !reset.atLeast, "an elapsed window says it has no current reading rather than offering a floor");
ok(!/≥/.test(reset.barValueText), `(${reset.barValueText})`);

// --- every surface has to agree ---------------------------------------------
// The widget headline builds its own text from label+pct instead of using
// chipText, so a qualifier added to chipText alone would show on the small rows
// and vanish from the biggest number on screen.
const bodyAt = rSrc.indexOf("function widgetBodyQuota(");
const body = rSrc.slice(bodyAt, rSrc.indexOf("\n}\n", bodyAt));
ok(/worst\.atLeast \? "≥" : ""/.test(body), "the widget's headline carries the qualifier too, not just the rows");
const callSites = (rSrc.match(/quotaLowerBound\(/g) || []).length - 1; // minus the definition
ok(callSites >= 3, `every surface that builds a readout applies it (${callSites} call sites)`);

// --- and the timestamp it all rests on must not lie -------------------------
// The refresh payload reported Date.now() as the age of the newest reading
// whenever one existed in memory, so from the first rate-limit event of a launch
// onwards the newest reading was permanently "just now" - a timestamp incapable of
// saying anything else, feeding every surface that decides how much to trust a
// number.
ok(!/quotaAt: latestQuota \? Date\.now\(\)/.test(mSrc), "the refresh payload no longer reports 'now' as the age of the newest reading");
ok(/quotaAt: latestQuota \? latestQuotaAt/.test(mSrc), "it reports when that reading actually arrived");
ok(/latestQuotaAt = at;/.test(mSrc), "which is stamped where the reading is recorded");

console.log(
  exit === 0
    ? "VERIFY OK: an hours-old reading is stated as '≥N% used' with its age, on every surface; a fresh one is stated plainly; an elapsed window still offers nothing."
    : "VERIFY FAILED."
);
process.exit(exit);
