// E2E (real launched Helm via CDP): the five new themes (fantasy, superhero,
// cyberpunk, western, noir) each apply as a full var-map swap + swap the brand
// logo to their glyph. Verifies the CSS block, THEMES registry entry, and icon
// are all wired for each.
//
// Run:  node scripts/e2e/test-themes-new.mjs
import { launch } from "./harness.mjs";

function log(...a) {
  console.log("[themes-new-e2e]", ...a);
}
const app = await launch();
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// id -> [expected --accent, expected logo glyph]
const EXPECT = {
  fantasy: ["#e6b23c", "🐉"],
  superhero: ["#e63946", "🦸"],
  cyberpunk: ["#ff2fb0", "🤖"],
  western: ["#cf6b3a", "🤠"],
  noir: ["#c0454f", "🕵️"],
  evil: ["#b3121b", "😈"],
};

try {
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  await wait(800);

  // The picker lists all themes (registry wired).
  const labels = await app.eval(`(typeof THEMES !== "undefined") ? THEMES.map((t) => t.id) : []`);
  for (const id of Object.keys(EXPECT)) {
    assert(labels.includes(id), `THEMES registry includes "${id}"`);
  }

  for (const [id, [accent, glyph]] of Object.entries(EXPECT)) {
    const r = await app.eval(`(() => {
      applyTheme(${JSON.stringify(id)});
      const stamped = document.documentElement.getAttribute("data-theme");
      const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
      // brand logo becomes a glyph span for emoji-logo themes
      const logoEl = document.querySelector(".brand .logo");
      const logoText = logoEl ? (logoEl.textContent || "").trim() : "";
      const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
      return { stamped, accent, logoTag: logoEl ? logoEl.tagName : null, logoText, bg };
    })()`);
    assert(r.stamped === id, `${id}: <html data-theme> set (got "${r.stamped}")`);
    assert(r.accent.toLowerCase() === accent, `${id}: --accent resolves to ${accent} (got "${r.accent}")`);
    assert(!!r.bg && r.bg !== "", `${id}: --bg is defined (full var-map swap, got "${r.bg}")`);
    assert(r.logoText === glyph, `${id}: brand logo swapped to its glyph ${glyph} (got "${r.logoText}")`);
  }

  // Back to the default so we don't leave the running app on a probe theme.
  await app.eval(`applyTheme("dark")`);

  const errors = app.getConsoleErrors();
  assert(errors.length === 0, `no console errors (got ${errors.length})`);
  for (const e of errors) {
    log("  console error:", e.text);
  }
  log(exitCode === 0 ? "VERIFY OK: five new themes apply (var-map + registry + logo glyph)." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.message);
} finally {
  const killOut = await app.close();
  log("cleanup:", killOut || "(nothing killed)");
}
process.exit(exitCode);
