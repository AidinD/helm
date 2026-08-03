// A quota percentage is never shown without saying how old it is.
//
// Helm does not poll for quota. It records what arrives on a rate-limit event from a
// running session, so a window's figure is exactly as old as the last turn that
// happened to report it. The captain's weekly reading was 26 HOURS old and the widget
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
ok(fresh(NOW - 26 * 3_600_000, NOW) === "as of 26h ago", `the captain's actual case (${fresh(NOW - 26 * 3_600_000, NOW)})`);
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

console.log(
  exit === 0
    ? "VERIFY OK: the quota widget states how old each reading is, on the headline and on every window row."
    : "VERIFY FAILED."
);
process.exit(exit);
