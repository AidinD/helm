// A finished-runs roll-up that needs something from you has to be visible
// WITHOUT looking for it.
//
// Task 72670135 - "Denna syns knappt". The row sits at the bottom of a fleet
// card, and its needs-you state differed from its all-clear state by text colour
// alone, at 11.5px. An attention signal you have to already be watching is not
// one, and under-flagging is the worse failure here.
//
// Checked over the stylesheet rather than in the app because the defect IS the
// stylesheet, and because the trap this file exists to catch is a colour token
// that does not exist: it renders in the default colour and passes every other
// check. That has slipped through three times.
//
// Run:  node scripts/e2e/test-rollup-needs-visible.mjs
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
const css = fs.readFileSync(path.join(here, "..", "..", "src", "renderer", "style.css"), "utf8");
const rSrc = fs.readFileSync(path.join(here, "..", "..", "src", "renderer", "renderer.js"), "utf8");

const rule = (selector) => {
  const at = css.indexOf(selector + " {");
  if (at < 0) {
    return null;
  }
  return css.slice(at + selector.length + 2, css.indexOf("}", at));
};

const calm = rule(".fleet-report-rollup-head");
const needs = rule(".fleet-report-rollup.has-needs .fleet-report-rollup-head");
ok(!!calm && !!needs, "both the calm and the needs-you state are styled");

// The rule, not the example: the needs state must differ by MORE than colour.
const nonColour = ["background", "border", "font-weight", "font-size", "padding"];
const changed = nonColour.filter((p) => new RegExp(`(^|;|\\s)${p}\\s*:`).test(needs));
ok(changed.length >= 3, `it differs from the calm state by more than colour (${changed.join(", ") || "colour only"})`);
ok(/font-size:\s*12\.5px/.test(needs) && /font-size:\s*11\.5px/.test(calm), "the text is larger than the quiet state's 11.5px");
ok(/font-weight:\s*[6-9]00/.test(needs), "and heavier");
ok(/background:/.test(needs) && /border:/.test(needs), "with a ground and an edge, so it reads as a chip rather than a line of text");

// The calm state must NOT have been made loud too - that would trade one
// unreadable card for a card that shouts constantly.
ok(!/background:/.test(calm), "the all-clear state stays quiet - only the state that needs you got louder");

// Every colour token has to exist. A token that does not renders in the default
// colour and passes every other assertion in this file.
const tokens = [...new Set([...(needs + (rule(".fleet-report-rollup.has-needs") || "")).matchAll(/var\((--[a-z-]+)\)/g)].map((m) => m[1]))];
ok(tokens.length > 0, `it uses the app's tokens (${tokens.join(", ")})`);
ok(
  tokens.every((t) => new RegExp(`\\${t}\\s*:`).test(css)),
  `and every one of them exists (${tokens.join(", ")})`
);
ok(tokens.includes("--waiting"), `specifically the same amber the rest of the app uses for waiting (${tokens.join(", ")})`);

// The class has to be reachable, or the styling is dead.
ok(/" has-needs"/.test(rSrc) && /needs > 0 \? " has-needs" : ""/.test(rSrc), "the renderer sets has-needs when runs need the captain");
ok(/need\$\{needs === 1 \? "s" : ""\} you/.test(rSrc), "and the label says how many");

console.log(
  exit === 0
    ? "VERIFY OK: a roll-up with runs needing the captain reads as an amber chip, not as one more dim line, and the quiet state stayed quiet."
    : "VERIFY FAILED."
);
process.exit(exit);
