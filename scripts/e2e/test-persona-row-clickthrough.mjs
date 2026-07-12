// Static regression guard (pure node, zero deps): the first-mate PERSONA row
// must NOT swallow clicks across its full width.
//
// Background: `.fleet-persona` is a full-width flex row whose only interactive
// child is the persona dropdown <button>. The parent `.fleet-mate-card` has a
// whole-card click handler (jumpIntoFirstMate). A previous bug added a
// row-wide `row.addEventListener("click", (e) => e.stopPropagation())` inside
// fleetPersonaEl, which caught clicks in the empty right portion of the row and
// stopped them bubbling to the card -> "clicks past the dropdown do nothing".
//
// The fix is to remove that row-level listener while keeping the button's OWN
// stopPropagation (so a dropdown click opens the menu without also jumping into
// the mate). renderer.js needs a DOM (document/window) to import, and the
// guardrail forbids launching/restarting Electron for this repo (it would kill
// the running app), so we verify the click-through path by STATIC ANALYSIS of
// the fleetPersonaEl source instead of a live DOM dispatch.
//
// Run:  node scripts/e2e/test-persona-row-clickthrough.mjs
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const RENDERER = path.join(REPO_ROOT, "src", "renderer", "renderer.js");

let exit = 0;
function assert(cond, msg) {
  console.log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exit = 1;
  }
}

/**
 * Extract a top-level `function <name>(...) { ... }` body from source by
 * brace-matching from the opening brace. Returns the full function text
 * (signature + balanced body) or null if not found.
 */
function extractFunction(src, name) {
  const sig = `function ${name}(`;
  const start = src.indexOf(sig);
  if (start === -1) {
    return null;
  }
  const open = src.indexOf("{", start);
  if (open === -1) {
    return null;
  }
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return src.slice(start, i + 1);
      }
    }
  }
  return null;
}

try {
  const src = fs.readFileSync(RENDERER, "utf8");
  const fn = extractFunction(src, "fleetPersonaEl");
  assert(!!fn, "fleetPersonaEl is present in renderer.js");

  if (fn) {
    // The bug: a click listener attached to the row container. Match any
    // whitespace/quote variant of `row.addEventListener("click", ...)`.
    const rowClick = /\brow\s*\.\s*addEventListener\s*\(\s*['"]click['"]/;
    assert(
      !rowClick.test(fn),
      "fleetPersonaEl does NOT attach a click listener to the row (no full-row click swallow)"
    );

    // The button must keep its OWN click handler...
    const btnClick = /\bbtn\s*\.\s*addEventListener\s*\(\s*['"]click['"]/;
    assert(
      btnClick.test(fn),
      "the persona dropdown button keeps its own click handler"
    );

    // ...and that handler must stopPropagation so a dropdown click opens the
    // menu WITHOUT also bubbling to the card's jumpIntoFirstMate.
    assert(
      /e\s*\.\s*stopPropagation\s*\(\s*\)/.test(fn),
      "the button handler still calls e.stopPropagation() (dropdown click won't jump into the mate)"
    );
  }

  // Sanity: the card-level handler that empty-row clicks are meant to reach
  // still exists, so removing the row swallow actually restores useful behavior.
  assert(
    /jumpIntoFirstMate/.test(src),
    "the card still wires jumpIntoFirstMate (the intended target of empty-row clicks)"
  );
} catch (err) {
  exit = 1;
  console.log("ERROR:", err.message);
}

console.log(
  exit === 0
    ? "VERIFY OK: persona row does not swallow clicks; dropdown guards itself."
    : "VERIFY FAILED."
);
process.exit(exit);
