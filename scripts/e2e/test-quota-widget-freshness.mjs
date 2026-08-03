// A quota percentage is never shown without saying how old it is.
//
// Helm does not poll for quota. It records what arrives on a rate-limit event from a
// running session, so a window's figure is exactly as old as the last turn that
// happened to report it. Aidin's weekly reading was 26 HOURS old and the widget
// printed it as the headline with no caveat - which is why his Helm said 36% while
// Claude Desktop said 29% "på samma". Not a rounding difference: a day-old number
// presented as live.
//
// The age was already computed (quotaFreshness) and already rendered by the context
// popover. The widget dropped it. So this asserts the RULE - if a row has a freshness,
// the widget's text contains it - over the real functions, rather than checking that
// one call site was edited.
//
// Run:  node scripts/e2e/test-quota-widget-freshness.mjs
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
const css = fs.readFileSync(path.join(here, "..", "..", "src", "renderer", "style.css"), "utf8");

const grab = (name) => {
  const at = rSrc.indexOf(`function ${name}(`);
  if (at < 0) {
    throw new Error(`renderer.js no longer defines ${name}`);
  }
  return rSrc.slice(at, rSrc.indexOf("\n}", at) + 2);
};
const fresh = new Function(`${grab("quotaFreshness")}\nreturn quotaFreshness;`)();

// --- the age helper itself ---------------------------------------------------
const NOW = 1_700_000_000_000;
ok(fresh(NOW - 30_000, NOW) === null, "a 30-second-old reading needs no caveat");
ok(fresh(NOW - 10 * 60_000, NOW) === "as of 10m ago", `minutes (${fresh(NOW - 10 * 60_000, NOW)})`);
ok(fresh(NOW - 26 * 3_600_000, NOW) === "as of 26h ago", `Aidin's actual case (${fresh(NOW - 26 * 3_600_000, NOW)})`);
ok(fresh(NOW - 5 * 86_400_000, NOW) === "as of 5d ago", `days (${fresh(NOW - 5 * 86_400_000, NOW)})`);
ok(fresh(null, NOW) === null && fresh(0, NOW) === null, "no timestamp means no claim about age");

// --- the widget must render it ----------------------------------------------
// Text-scanning the call site would pass on a fix that only touched the headline, so
// check BOTH surfaces of the widget body plus the ordering that puts the age with the
// number rather than in a tooltip alone.
const body = (() => {
  const at = rSrc.indexOf("function widgetBodyQuota(");
  return rSrc.slice(at, rSrc.indexOf("\n}\n", at));
})();
ok(/worst\?\.freshness/.test(body), "the headline's sub-line carries the age of the number above it");
ok(/agePrefix \+ worst\.barValueText/.test(body), "and puts it BEFORE the value, where it is read first");
ok(/if \(row\.freshness\) \{/.test(body), "every other window row carries its own age too");
ok(/wd-quota-age/.test(body), "as its own element, so it can be styled apart from the value");
ok(css.includes(".wd-quota-age"), "which the stylesheet defines");
const ageRule = css.slice(css.indexOf(".wd-quota-age"), css.indexOf(".wd-quota-age") + 160);
const tokens = [...ageRule.matchAll(/var\((--[a-z-]+)\)/g)].map((m) => m[1]);
ok(tokens.length > 0, `it uses the app's colour tokens (${tokens.join(", ")})`);
ok(
  tokens.every((t) => new RegExp(`\\${t}\\s*:`).test(css)),
  "and every one of them exists - a token that does not renders in the default colour and passes every other check"
);

// The popover already did this; the two surfaces must not drift apart again.
ok(/row\.freshness/.test(grab("cpopWindowRow")), "the context popover still shows it too");

// --- a limited window must be visible as such -------------------------------
// "5-hour limit - limited" was rendered in the same neutral headline colour as a
// comfortable 12%, and got no bar either (a limited state often has no percentage), so
// the one reading that changes what you can do looked like any other. The context
// popover already coloured it AND drew a full bar; the widget did neither.
ok(/head\.classList\.add\(worst\.level === "hot" \? "crit" : "warn"\)/.test(body), "the headline takes the state's colour");
ok(
  /quotaBar\(100, worst\.level\)/.test(body),
  "and a definite limited/near state with no percentage still gets a full bar, like the popover"
);
for (const cls of [".wd-quota-head.crit", ".wd-quota-head.warn"]) {
  ok(css.includes(cls), `${cls} is styled`);
}
// Matched on the two RULES, not on a byte window after them - a fixed-length slice ran
// past them into the next rule and picked up a third token.
const headRules = [...css.matchAll(/\.wd-quota-head\.(crit|warn)\s*\{([^}]*)\}/g)];
ok(headRules.length === 2, `both state rules were found (${headRules.map((m) => m[1]).join(", ")})`);
const headTokens = headRules.flatMap((m) => [...m[2].matchAll(/var\((--[a-z-]+)\)/g)].map((x) => x[1]));
ok(headTokens.length === 2, `both states use exactly one token (${headTokens.join(", ")})`);
ok(
  headTokens.every((t) => new RegExp(`\\${t}\\s*:`).test(css)),
  `and both tokens exist (${headTokens.join(", ")})`
);
// Same tokens as the row values, or a limited window would read differently depending
// on where you looked at it.
ok(
  headTokens.includes("--danger") && headTokens.includes("--waiting"),
  `the same two the quota VALUES already use (${headTokens.join(", ")})`
);

// --- a stale reading must not hold the headline over a current one -----------
// "den verkar inte uppdateras" (Aidin, after the age label shipped). He was right, and
// the reason was the headline CHOICE: row.stale only asks whether the WINDOW has reset,
// so a 26-hour-old weekly figure counted as fresh, outranked a five-hour reading taken
// seconds earlier, and stood in the largest text in the widget - pinned to the one
// number that cannot move often, because its window reports only when it is binding.
const maxAge = Number((rSrc.match(/const QUOTA_HEADLINE_MAX_AGE_MS = ([^;]+);/) || [])[1]?.replace(/[^0-9*]/g, "").split("*").reduce((a, b) => a * Number(b), 1) || 0);
ok(maxAge >= 30 * 60 * 1000, `there is an age ceiling for the headline (${maxAge}ms)`);
const pick = new Function(
  "rows",
  `const QUOTA_LEVEL_RANK = { hot: 3, warm: 2, ok: 1 };
   const QUOTA_HEADLINE_MAX_AGE_MS = ${maxAge};
   ${grab("worstFreshQuotaRow").replace("const QUOTA_LEVEL_RANK = { hot: 3, warm: 2, ok: 1 };", "")}
   return worstFreshQuotaRow(rows);`
);
const HOUR = 3600000;
const weeklyOld = { type: "seven_day", level: "warm", pct: 36, hasPct: true, stale: false, ageMs: 26 * HOUR };
const fiveNew = { type: "five_hour", level: "ok", pct: 12, hasPct: true, stale: false, ageMs: 5000 };
ok(pick([weeklyOld, fiveNew])?.type === "five_hour", "a seconds-old reading wins the headline over a 26h-old one");
ok(pick([weeklyOld])?.type === "seven_day", "but a stale reading still beats showing nothing when it is all there is");
// Severity must still decide BETWEEN recent readings - that was the original point of
// this function and it must not be lost to the age rule.
const weeklyNewHot = { type: "seven_day", level: "hot", pct: 95, hasPct: true, stale: false, ageMs: 60000 };
ok(pick([weeklyNewHot, fiveNew])?.type === "seven_day", "among recent readings the most constrained still wins");
ok(pick([])?.type === undefined, "no rows means no headline, not a crash");
ok(pick([{ type: "x", level: "ok", stale: true, ageMs: 1000 }]) === null, "a reset window is still excluded outright");

// The WIRING: the rows the widget actually builds must carry the age, or every
// assertion above is testing a hand-fed object. Setting ageMs to null in
// quotaPanelRows survived this file until it checked the real row model.
const rowsFn = new Function(
  "windows",
  "nowMs",
  `${grab("quotaFreshness")}
   ${grab("quotaWindowLabel")}
   ${grab("quotaReadout")}
   const QUOTA_WINDOW_ORDER = ${JSON.stringify(
     JSON.parse((rSrc.match(/const QUOTA_WINDOW_ORDER = (\[[^\]]*\]);/) || [])[1].replace(/'/g, '"'))
   )};
   ${grab("quotaPanelRows")}
   return quotaPanelRows(windows, nowMs);`
);
const built = rowsFn(
  [{ info: { rateLimitType: "seven_day", status: "allowed_warning", utilization: 0.36, resetsAt: Math.floor((NOW + 86_400_000) / 1000) }, at: NOW - 26 * HOUR }],
  NOW
);
ok(built.length === 1, `the real row builder produced a row (${built.length})`);
ok(typeof built[0].ageMs === "number", `and it carries a numeric age (${built[0].ageMs})`);
ok(built[0].ageMs === 26 * HOUR, `equal to the reading's actual age (${built[0].ageMs} vs ${26 * HOUR})`);
ok(built[0].freshness === "as of 26h ago", `alongside the human sentence (${built[0].freshness})`);

console.log(
  exit === 0
    ? "VERIFY OK: the quota widget states how old each reading is, on the headline and on every window row."
    : "VERIFY FAILED."
);
process.exit(exit);
