// Lavish-style interactive-plan annotation loop — SDK source + formatter.
//
// The annotation-capture logic here (the `selector`/`context`/`snapshot`
// helpers and the hover/click + shadow-DOM annotation-card overlay inside
// buildArtifactSdkSource) is LIFTED and trimmed from Kun Chen's lavish-axi
// (github.com/kunchenguid/lavish-axi, `src/artifact-sdk.js`, MIT License).
// Attribution per its license. What we deliberately did NOT carry over:
//   - Express server + long-poll + state.json transport (macOS/Linux-only,
//     and unnecessary in Electron — see below).
//   - Mermaid pan/zoom, layout-overflow auditing, text-range selection.
// In lavish-axi the artifact is a cross-origin sandboxed iframe with no app
// context, so it round-trips annotations to a local Express server via
// postMessage + HTTP long-poll. In Maestro the iframe lives in the same
// renderer process, so we collapse all of that: the injected SDK posts each
// annotation record to `window.parent` (the only channel that crosses the
// sandbox boundary), the renderer host collects it, and — when the user asks —
// formats it and hands it to a composer / clipboard. No server, no long-poll,
// no persisted state.
//
// One improvement over lavish worth keeping (per PLAN Phase 4 note): if the
// artifact HTML already carries a stable `data-lavish-id` on an element, the
// SDK records it as `lavishId`, so anchoring is exact rather than a recomputed
// best-effort CSS selector.

import { encodeToon } from "./toon.js";

/**
 * The record shape the injected SDK posts back per annotation:
 *   { uid, selector, tag, text, prompt, lavishId? }
 * where `selector` is a best-effort CSS path, `text` is up to ~240 chars of
 * the element's trimmed innerText, and `prompt` is what the user typed.
 */

// The CSP sha256 that index.html's script-src pins so the SDK's inline script
// is allowed to run inside the mockup iframe (a framed data: document still has
// the embedder's CSP applied on top of its own, so the parent must whitelist
// the SDK by hash). This is the ONLY inline script the app permits. If the SDK
// source changes, this must be regenerated and index.html updated to match;
// spike/test-lavish.mjs asserts the two agree so drift fails loudly.
export const LAVISH_SDK_SCRIPT_SHA256 = "sha256-lkHyWr9g7zAEbHgv/mmgrhYAKMZBvfcISQGhi51AgZ8=";

// The messages the injected SDK <-> host speak over postMessage. Kept as
// exported constants so the host and the SDK-source string can't drift.
export const LAVISH_MSG = {
  queuePrompt: "lavish:queuePrompt",
  snapshot: "lavish:snapshot",
  requestSnapshot: "lavish:requestSnapshot",
  setAnnotationMode: "lavish:setAnnotationMode",
  ready: "lavish:ready",
};

/**
 * Returns the annotation-SDK as a self-contained JS source string, suitable
 * for inlining inside the artifact iframe's srcdoc. It runs inside the
 * sandboxed artifact document (null origin), so it talks to the host ONLY via
 * window.parent.postMessage — the one channel that crosses the sandbox
 * boundary. Written as a string (not an imported module) precisely because it
 * must execute inside that separate, sandboxed document.
 *
 * Lifted/trimmed from lavish-axi's src/artifact-sdk.js (MIT). See file header.
 */
export function buildArtifactSdkSource() {
  return String.raw`
(function () {
  var annotationMode = true;
  var hovered = null;
  var selected = null;
  var shadow = null;
  var counter = 0;
  var ids = new WeakMap();

  function uid(el) {
    if (!ids.has(el)) ids.set(el, String(++counter));
    return ids.get(el);
  }

  // Best-effort CSS path: prefer #id, else tag:nth-of-type, capped ~5
  // ancestors. (lavish-axi selector(), verbatim behavior.)
  function selector(el) {
    if (!el || !el.tagName) return "";
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      var part = node.tagName.toLowerCase();
      if (node.id) {
        part += "#" + CSS.escape(node.id);
        parts.unshift(part);
        break;
      }
      var parent = node.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (x) {
          return x.tagName === node.tagName;
        });
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  }

  // Structured per-element record. Improvement over lavish: if the element (or
  // an ancestor) carries a stable data-lavish-id, record it so anchoring is
  // exact rather than a recomputed selector.
  function context(el) {
    var idHost = el.closest ? el.closest("[data-lavish-id]") : null;
    var base = {
      uid: uid(el),
      selector: selector(el),
      tag: (el.tagName || "").toLowerCase(),
      text: (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 240),
    };
    if (idHost) base.lavishId = idHost.getAttribute("data-lavish-id");
    return base;
  }

  function isLavishUi(el) {
    return !!(el && el.closest && el.closest("[data-lavish-ui]"));
  }

  // Native interactive controls should behave natively (type/toggle/focus)
  // rather than trigger annotation. (lavish-axi isNativeInteractiveControl.)
  function isInteractiveControl(el) {
    return !!(
      el &&
      el.closest &&
      el.closest("button,input,select,textarea,option,optgroup,label,summary,[contenteditable]:not([contenteditable='false'])")
    );
  }

  function highlightElement(el) {
    if (!el) return;
    el.style.outline = "2px solid #f4c95d";
    el.style.outlineOffset = "2px";
  }
  function clearHighlight(el) {
    if (el) el.style.outline = "";
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  // Indented uid/tag/text tree of the artifact body. (lavish-axi snapshot().)
  function snapshot() {
    var lines = [];
    function walk(el, depth) {
      if (!(el instanceof Element) || depth > 6 || isLavishUi(el)) return;
      // Skip the injected SDK <script> (and any script/style) — it's not part
      // of the artifact the user is annotating, just noise in the snapshot.
      var tagLower = (el.tagName || "").toLowerCase();
      if (tagLower === "script" || tagLower === "style") return;
      var c = context(el);
      var name = c.text ? ' "' + c.text.slice(0, 80).replace(/"/g, "'") + '"' : "";
      lines.push(new Array(depth + 1).join("  ") + "uid=" + c.uid + " " + c.tag + name);
      for (var i = 0; i < el.children.length; i++) walk(el.children[i], depth + 1);
    }
    walk(document.body, 0);
    return lines.join("\n");
  }

  function post(type, extra) {
    var msg = { type: type };
    if (extra) for (var k in extra) msg[k] = extra[k];
    window.parent.postMessage(msg, "*");
  }

  function setAnnotationMode(enabled) {
    annotationMode = !!enabled;
    var style = document.getElementById("lavish-cursor-style");
    if (annotationMode && !style) {
      style = document.createElement("style");
      style.id = "lavish-cursor-style";
      style.textContent =
        "*{cursor:crosshair!important}input,textarea,[contenteditable]:not([contenteditable='false']){cursor:text!important}button,select,label{cursor:pointer!important}";
      document.head.appendChild(style);
    }
    if (!annotationMode && style) style.remove();
    if (!annotationMode) closeCard();
  }

  function ensureShadow() {
    if (shadow) return shadow;
    var host = document.createElement("div");
    host.setAttribute("data-lavish-ui", "annotation-root");
    document.documentElement.appendChild(host);
    shadow = host.attachShadow({ mode: "open" });
    var style = document.createElement("style");
    // Trimmed from lavish-axi's shadow-DOM card styling (brass-on-ink theme).
    style.textContent =
      ":host{all:initial;position:fixed;z-index:2147483647;left:0;top:0;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif}" +
      "*{box-sizing:border-box}" +
      ".lavish-card{position:fixed;width:min(320px,calc(100vw - 24px));padding:12px;border-radius:14px;background:#11141a;color:#f7f3ea;border:1px solid #f4c95d;box-shadow:0 20px 70px rgba(0,0,0,.35);font:14px/1.4 inherit}" +
      ".lavish-heading{font-weight:700;margin-bottom:6px}" +
      ".lavish-card textarea{width:100%;min-height:86px;resize:vertical;border-radius:10px;border:1px solid #303745;background:#0f1115;color:#f7f3ea;padding:9px;font:inherit}" +
      ".lavish-card textarea::placeholder{color:#aeb6c6}" +
      ".lavish-hint{margin-top:6px;font-size:11px;color:#aeb6c6}" +
      ".lavish-row{display:flex;gap:8px;justify-content:flex-end;margin-top:8px}" +
      ".lavish-card button{border:0;border-radius:10px;padding:8px 10px;font:inherit;font-size:13px;font-weight:700;cursor:pointer}" +
      ".lavish-send{background:#f4c95d;color:#17130a}" +
      ".lavish-cancel{background:#2a2f3a;color:#f7f3ea}";
    shadow.appendChild(style);
    return shadow;
  }

  function closeCard() {
    if (shadow) {
      var cards = shadow.querySelectorAll(".lavish-card");
      for (var i = 0; i < cards.length; i++) cards[i].remove();
    }
    clearHighlight(hovered);
    clearHighlight(selected);
    hovered = null;
    selected = null;
  }

  // Floating annotation card anchored under the clicked element. (lavish-axi
  // showAnnotationCard, trimmed to the plain-element case — no mermaid/text
  // range.)
  function showAnnotationCard(target) {
    var root = ensureShadow();
    closeCard();
    var c = context(target);
    selected = target;
    highlightElement(selected);

    var rect = target.getBoundingClientRect();
    var card = document.createElement("div");
    card.className = "lavish-card";
    card.innerHTML =
      '<div class="lavish-heading">Annotate &lt;' + escapeHtml(c.tag) + '&gt;</div>' +
      '<textarea placeholder="Tell the agent what to change about this element..."></textarea>' +
      '<div class="lavish-hint">Enter to add &middot; Esc to cancel</div>' +
      '<div class="lavish-row"><button class="lavish-cancel" type="button">Cancel</button>' +
      '<button class="lavish-send" type="button">Add</button></div>';
    root.appendChild(card);

    var left = Math.min(Math.max(12, rect.left), window.innerWidth - card.offsetWidth - 12);
    var top = Math.min(Math.max(12, rect.bottom + 8), window.innerHeight - card.offsetHeight - 12);
    card.style.left = left + "px";
    card.style.top = top + "px";

    var textarea = card.querySelector("textarea");
    var cancelBtn = card.querySelector(".lavish-cancel");
    var sendBtn = card.querySelector(".lavish-send");

    cancelBtn.onclick = closeCard;
    sendBtn.onclick = function () {
      var prompt = textarea.value.trim();
      if (prompt) {
        var record = {};
        for (var k in c) record[k] = c[k];
        record.prompt = prompt;
        post("` + LAVISH_MSG.queuePrompt + `", { prompt: record });
      }
      closeCard();
    };
    textarea.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        sendBtn.click();
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeCard();
      }
    });
    setTimeout(function () {
      textarea.focus();
    }, 0);
  }

  window.addEventListener("message", function (event) {
    var msg = event.data || {};
    if (msg.type === "` + LAVISH_MSG.setAnnotationMode + `") setAnnotationMode(msg.enabled);
    if (msg.type === "` + LAVISH_MSG.requestSnapshot + `") post("` + LAVISH_MSG.snapshot + `", { snapshot: snapshot() });
  });

  document.addEventListener(
    "mouseover",
    function (event) {
      if (!annotationMode || isLavishUi(event.target) || isInteractiveControl(event.target)) return;
      var target = event.target;
      if (target === selected) return;
      if (hovered && hovered !== selected) clearHighlight(hovered);
      hovered = target;
      highlightElement(hovered);
    },
    true
  );

  document.addEventListener(
    "mouseout",
    function () {
      if (hovered && hovered !== selected) {
        clearHighlight(hovered);
        hovered = null;
      }
    },
    true
  );

  document.addEventListener(
    "click",
    function (event) {
      if (!annotationMode || isLavishUi(event.target) || isInteractiveControl(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      showAnnotationCard(event.target);
    },
    true
  );

  setAnnotationMode(true);
  post("` + LAVISH_MSG.ready + `", { snapshot: snapshot() });
})();
`;
}

/**
 * Wrap arbitrary artifact HTML into a self-contained document that (a) carries
 * its own inline CSP that ALLOWS the injected inline SDK script, and (b) has
 * the annotation SDK injected right before </body>. If the input already looks
 * like a full document, the SDK + CSP are injected into its <head>/<body>;
 * otherwise it is wrapped in a minimal shell.
 *
 * SECURITY MODEL (corrected 2026-07-04 after review - the prior comment had
 * it backwards, which was dangerous). The returned document loads into a
 * sandboxed (`allow-scripts`, NO `allow-same-origin` - null/opaque origin)
 * iframe via a `data:` URL. A framed local-scheme (`data:`) document INHERITS
 * the embedder's (index.html) CSP; the EFFECTIVE policy is the INTERSECTION of
 * that inherited policy and this inner meta CSP - a script must be allowed by
 * BOTH to run. So:
 *   - index.html's `script-src` pins the SDK's exact sha256. That hash-pin is
 *     the LOAD-BEARING containment: a pasted artifact's own inline scripts
 *     don't match it, so the embedder half blocks them. Do NOT relax
 *     index.html's script-src to plain `'self'` - that is what breaks
 *     containment (and would CSP-block the SDK).
 *   - this inner meta's `script-src 'unsafe-inline'` is the REQUIRED inner
 *     half: it must permit inline for the intersection to admit the SDK at
 *     all. It is NOT inert/removable - dropping it or setting `'none'` makes
 *     the inner half block everything and the intersection then blocks the
 *     SDK too. (It permits inline broadly on the inner side; the outer
 *     hash-pin narrows "any inline" down to "only the SDK".)
 * `srcdoc` was rejected because it inherits the same way, but the app's
 * `default-src 'self'` left no route for the inline SDK. Verified live:
 * srcdoc -> CSP-blocked; this data: URL runs the SDK and blocks pasted scripts.
 * Follow-up (own focused pass, re-verify via scripts/e2e): pin the SDK sha256
 * on THIS inner meta too, as defense-in-depth against any regression in
 * data:-frame CSP inheritance.
 *
 * @param {string} artifactHtml raw HTML (fragment or full document)
 * @returns {string} full HTML document string to load as a data: URL
 */
export function buildArtifactSrcdoc(artifactHtml) {
  const sdkTag = `<script>${buildArtifactSdkSource()}<\/script>`;
  // Self-contained CSP for the framed document: no network at all, inline
  // script/style permitted on the inner side (see the security-model note
  // above for why the outer hash-pin is what actually contains pasted
  // scripts). img-src is data: only - a pasted mockup has no legitimate need
  // to load local files as images (dropped `file:` per review, closing a
  // local-file existence-probe vector).
  const cspTag =
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ' +
    "script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:\" />";
  const html = String(artifactHtml || "");
  const looksLikeDocument = /<html[\s>]/i.test(html) || /<body[\s>]/i.test(html);

  if (looksLikeDocument) {
    let doc = html;
    // Insert our CSP as the first thing in <head> so it governs the document.
    if (/<head[\s>]/i.test(doc)) {
      doc = doc.replace(/<head([^>]*)>/i, `<head$1>${cspTag}`);
    } else if (/<html[\s>]/i.test(doc)) {
      doc = doc.replace(/<html([^>]*)>/i, `<html$1><head>${cspTag}</head>`);
    } else {
      doc = cspTag + doc;
    }
    if (/<\/body>/i.test(doc)) {
      return doc.replace(/<\/body>/i, `${sdkTag}</body>`);
    }
    return doc + sdkTag;
  }

  return `<!doctype html>
<html lang="en">
<head>
${cspTag}
<meta charset="utf-8" />
<meta name="color-scheme" content="dark light" />
<style>body{margin:16px;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}</style>
</head>
<body>
${html}
${sdkTag}
</body>
</html>`;
}

/**
 * Turn the collected annotations into a single formatted TEXT block for an
 * agent prompt. Pure function (no DOM) so it can be unit-tested standalone.
 *
 * The annotation list itself (a uniform array of small objects) is encoded as
 * TOON rather than one numbered line per item — same information, far fewer
 * tokens once there are more than a couple of annotations (see toon.js's own
 * header comment and DECISIONS.md 2026-07-04). A one-line format hint is
 * included so the receiving agent knows how to read the table.
 *
 * @param {Array<{selector?:string, lavishId?:string, tag?:string, text?:string, prompt:string}>} annotations
 * @param {string} [domSnapshot] the indented uid/tag/text tree, if captured
 * @returns {string}
 */
export function formatAnnotationsAsPrompt(annotations, domSnapshot) {
  const list = Array.isArray(annotations) ? annotations : [];
  if (list.length === 0) {
    return "";
  }

  // Project to the exact fields the agent needs, with the anchor already
  // resolved (stable data-lavish-id preferred over the best-effort CSS
  // selector) so the TOON table has one clear "where" column instead of two
  // overlapping ones.
  const rows = list.map((a) => ({
    anchor: a.lavishId ? `#[data-lavish-id=${a.lavishId}]` : a.selector || a.tag || "(element)",
    text: (a.text || "").trim(),
    feedback: String(a.prompt || "").trim(),
  }));

  const lines = [
    "The user annotated these elements in the plan mockup.",
    "Data is in TOON: a header row of column names in {}, then one delimited row per item.",
    "",
    encodeToon(rows),
  ];

  if (domSnapshot && String(domSnapshot).trim()) {
    lines.push("");
    lines.push("DOM snapshot of the mockup (uid / tag / text tree):");
    lines.push("");
    lines.push(String(domSnapshot).trim());
  }

  return lines.join("\n");
}
