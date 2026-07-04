// Standalone unit test for the PURE helpers in src/lib/lavishSdk.js — the
// annotation formatter and the srcdoc wrapper. No DOM needed. Run:
//   node spike/test-lavish.mjs
// The DOM-dependent part (selector/context/snapshot + the annotate->postMessage
// loop) is verified separately via CDP against the running renderer.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatAnnotationsAsPrompt,
  buildArtifactSrcdoc,
  buildArtifactSdkSource,
  LAVISH_SDK_SCRIPT_SHA256,
} from "../src/lib/lavishSdk.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
function ok(label) {
  passed++;
  console.log("  ok -", label);
}

// ---- formatAnnotationsAsPrompt ----
console.log("formatAnnotationsAsPrompt:");

assert.equal(formatAnnotationsAsPrompt([], "snap"), "", "empty annotations -> empty string");
ok("empty annotations returns empty string");

assert.equal(formatAnnotationsAsPrompt(null), "", "null annotations -> empty string");
ok("null annotations returns empty string");

const out = formatAnnotationsAsPrompt(
  [
    { selector: "div#hero > h1", tag: "h1", text: "Welcome home", prompt: "Make this a floating overlay" },
    { lavishId: "cta", tag: "button", text: "Sign up", prompt: "Use the brand accent color" },
    { tag: "p", text: "", prompt: "Delete this paragraph" },
  ],
  "uid=1 body\n  uid=2 h1 \"Welcome home\"",
);

assert.match(out, /The user annotated these elements/, "has intro line");
ok("has intro header");

assert.match(out, /1\. \[div#hero > h1\] "Welcome home"/, "selector + text formatted");
ok("selector-anchored line formatted correctly");

assert.match(out, /-> Make this a floating overlay/, "prompt on its own line");
ok("prompt rendered after arrow");

assert.match(out, /2\. \[#\[data-lavish-id=cta\]\] "Sign up"/, "lavishId preferred over selector");
ok("data-lavish-id anchor preferred when present");

assert.match(out, /3\. \[p\]\n\s+-> Delete this paragraph/, "empty text -> no quoted text part");
ok("empty text omits the quoted snippet");

assert.match(out, /DOM snapshot of the mockup/, "includes snapshot section");
assert.match(out, /uid=2 h1 "Welcome home"/, "snapshot body included");
ok("DOM snapshot appended when provided");

const noSnap = formatAnnotationsAsPrompt([{ selector: "a", prompt: "x" }]);
assert.doesNotMatch(noSnap, /DOM snapshot/, "no snapshot section when snapshot omitted");
ok("no snapshot section when snapshot omitted/blank");

// ---- buildArtifactSrcdoc ----
console.log("buildArtifactSrcdoc:");

const frag = buildArtifactSrcdoc("<h1>Hi</h1>");
assert.match(frag, /<!doctype html>/i, "fragment gets wrapped in a full document");
assert.match(frag, /<h1>Hi<\/h1>/, "fragment content preserved");
assert.match(frag, /<script>/, "SDK script injected");
assert.match(frag, /lavish:queuePrompt/, "SDK carries the queuePrompt message type");
ok("fragment wrapped + SDK injected");

const fullDoc = "<html><head></head><body><p>doc</p></body></html>";
const built = buildArtifactSrcdoc(fullDoc);
assert.match(built, /<p>doc<\/p>\s*<script>/, "SDK injected right before </body> for full docs");
assert.ok(built.indexOf("<html>") === built.lastIndexOf("<html>"), "did not double-wrap a full document");
ok("full document gets SDK injected before </body>, not re-wrapped");

// The SDK source must be syntactically valid JS on its own (it's inlined into
// the iframe). new Function throws on a parse error.
console.log("buildArtifactSdkSource:");
assert.doesNotThrow(() => new Function(buildArtifactSdkSource()), "SDK source parses");
ok("SDK source is syntactically valid JS");

// ---- CSP hash drift guard ----
// The SDK runs as an inline script inside the mockup iframe. A framed data:
// document still has the embedder's CSP applied, so index.html's script-src
// must pin the SDK's exact sha256 or the SDK is CSP-blocked and never runs.
// This asserts (a) the exported constant matches the current SDK source, and
// (b) index.html actually contains that hash — so any SDK edit that forgets to
// regenerate the hash fails here loudly rather than silently breaking the loop.
console.log("CSP hash drift guard:");
const liveHash = "sha256-" + crypto.createHash("sha256").update(buildArtifactSdkSource(), "utf8").digest("base64");
assert.equal(liveHash, LAVISH_SDK_SCRIPT_SHA256, "exported LAVISH_SDK_SCRIPT_SHA256 matches current SDK source");
ok("exported hash matches current SDK source");

const indexHtml = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "index.html"), "utf8");
assert.ok(indexHtml.includes(LAVISH_SDK_SCRIPT_SHA256), "index.html script-src contains the SDK hash");
ok("index.html CSP contains the SDK hash");

console.log(`\nAll ${passed} assertions passed.`);
