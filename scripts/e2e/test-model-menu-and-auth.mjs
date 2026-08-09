// Two tickets in one screen area:
//   cf96055c "Kunna välja tidigare modeller ... helst i en submeny för att inte
//     plottra" - the model pill gets a "More models" submenu of older models.
//   3218cdd4 "Failed to authenticate: OAuth session expired" - Helm can read
//     sign-in status and drive the CLI's own sign-in, and an auth failure in a
//     session surfaces a one-click Sign in shortcut.
//
// Drives the real renderer: the real dropdownPill, the real getAuthStatus IPC
// (which shells out to `claude auth status --json` - a subprocess, but no model
// call, so no tokens), and the real maybeSurfaceAuthError/authStatusLine. It does
// NOT run `claude auth login` - that opens a browser and would disturb the real
// session; the login PLUMBING is exercised only up to the point of spawning.
//
// Run:  node scripts/e2e/test-model-menu-and-auth.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let exit = 0;
let app = null;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-modelauth-"));
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9541";
const { launch } = await import("./harness.mjs");

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // --- the model pill's submenu -------------------------------------------
  const menu = await app.eval(`(() => {
    document.querySelectorAll("#modelProbe").forEach((n) => n.remove());
    const wrap = document.createElement("div");
    wrap.id = "modelProbe";
    document.body.append(wrap);
    const dd = dropdownPill("auto", modelMenuWithAuto(), () => {});
    wrap.append(dd.el);
    dd.el.click(); // opens #contextMenu
    const menu = document.getElementById("contextMenu");
    const topItems = [...menu.querySelectorAll(":scope > .item")].map((it) => (it.childNodes[0]?.textContent || it.textContent).trim());
    const moreItem = [...menu.querySelectorAll(":scope > .item")].find((it) => (it.childNodes[0]?.textContent || "").trim() === "More models" || it.textContent.trim().startsWith("More models"));
    const submenuLabels = moreItem ? [...moreItem.querySelectorAll(".submenu .item")].map((it) => it.textContent.trim()) : [];
    return { topItems, submenuLabels, hasSubmenu: !!moreItem };
  })()`);
  ok(menu.topItems.includes("Auto"), `the model menu still offers Auto (${JSON.stringify(menu.topItems)})`);
  ok(menu.topItems.includes("Sonnet 5") && menu.topItems.includes("Opus 5") && menu.topItems.includes("Opus 4.8"), "the current-generation models are at the top level");
  ok(menu.hasSubmenu, "a 'More models' submenu exists so the top list stays short");
  ok(
    menu.submenuLabels.includes("Opus 4.7") && menu.submenuLabels.includes("Opus 4.6") && menu.submenuLabels.includes("Sonnet 4.6"),
    `older models live in the submenu (${JSON.stringify(menu.submenuLabels)})`
  );
  ok(
    !menu.topItems.includes("Opus 4.7") && !menu.topItems.includes("Sonnet 4.6"),
    "and are NOT also cluttering the top level"
  );

  // Picking a submenu leaf sets the pill's value AND its label - the label
  // lookup has to see nested leaves, or the pill would show the raw id.
  const picked = await app.eval(`(() => {
    let chosen = null;
    const dd = dropdownPill("auto", modelMenuWithAuto(), (v) => { chosen = v; });
    document.getElementById("modelProbe").append(dd.el);
    dd.el.click();
    const menu = document.getElementById("contextMenu");
    const moreItem = [...menu.querySelectorAll(":scope > .item")].find((it) => it.textContent.trim().startsWith("More models"));
    const leaf = [...moreItem.querySelectorAll(".submenu .item")].find((it) => it.textContent.trim() === "Opus 4.6");
    leaf.click();
    return { chosen, pillValue: dd.value, pillLabel: dd.el.textContent.trim() };
  })()`);
  ok(picked.chosen === "claude-opus-4-6", `picking a submenu model reports its id to onSelect (${picked.chosen})`);
  ok(picked.pillValue === "claude-opus-4-6", "and sets it as the pill's value");
  ok(picked.pillLabel === "Opus 4.6", `and the pill shows the readable label, not the raw id (${picked.pillLabel})`);

  // Every id in the menu is one the CLI actually resolves - guard against a
  // typo'd id silently shipping as a control that errors on use. (These are the
  // ids extracted from the installed claude.exe.)
  const validIds = new Set([
    "claude-sonnet-5", "claude-opus-5", "claude-opus-4-8", "claude-haiku-4-5-20251001",
    "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5", "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-fable-5",
  ]);
  const ids = await app.eval(`(() => flattenModelOptions(MODEL_MENU_OPTIONS).map((o) => o.value))()`);
  ok(ids.every((id) => validIds.has(id)), `every model id is a real CLI-resolvable id (${JSON.stringify(ids.filter((id) => !validIds.has(id)))} unexpected)`);

  // --- auth status (real CLI, no model call) ------------------------------
  const status = await app.eval(`window.helm.getAuthStatus()`);
  ok(status && typeof status.ok === "boolean", `getAuthStatus returns a result object (${JSON.stringify(status).slice(0, 120)})`);
  ok(status.ok === false || typeof status.loggedIn === "boolean", "a readable status carries a boolean loggedIn");

  // --- authStatusLine phrasing --------------------------------------------
  const lines = await app.eval(`(() => ({
    signedIn: authStatusLine({ ok: true, loggedIn: true, email: "a@b.c", orgName: "Org", subscriptionType: "team" }),
    signedOut: authStatusLine({ ok: true, loggedIn: false }),
    unreadable: authStatusLine({ ok: false, error: "boom" }),
  }))()`);
  ok(/Signed in/.test(lines.signedIn) && /a@b\.c/.test(lines.signedIn), `signed-in line names the account (${JSON.stringify(lines.signedIn)})`);
  ok(/Signed out/.test(lines.signedOut), "signed-out line says so plainly");
  ok(/Couldn't read/.test(lines.unreadable), "an unreadable status says that rather than pretending");

  // --- the auth-failure shortcut fires on the right messages, not others ---
  const surfacing = await app.eval(`(() => {
    document.querySelectorAll(".notice").forEach((n) => n.remove());
    const count = () => document.querySelectorAll(".notice").length;
    maybeSurfaceAuthError("Failed to authenticate: OAuth session expired and could not be refreshed");
    const afterAuth = count();
    const hasSignIn = [...document.querySelectorAll(".notice .text-btn")].some((b) => b.textContent.trim() === "Sign in");
    document.querySelectorAll(".notice").forEach((n) => n.remove());
    maybeSurfaceAuthError("TypeError: cannot read property 'foo' of undefined");
    const afterUnrelated = count();
    document.querySelectorAll(".notice").forEach((n) => n.remove());
    return { afterAuth, hasSignIn, afterUnrelated };
  })()`);
  ok(surfacing.afterAuth === 1, `an auth-expired error raises a notice (${surfacing.afterAuth})`);
  ok(surfacing.hasSignIn, "with a Sign in action on it");
  ok(surfacing.afterUnrelated === 0, "an unrelated error does NOT raise the auth shortcut");

  const consoleErrors = app.getConsoleErrors();
  ok(consoleErrors.length === 0, `no console errors (${consoleErrors.length})`);
} catch (err) {
  ok(false, `unexpected failure: ${err.message}`);
} finally {
  if (app) {
    await app.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(exit === 0 ? "VERIFY OK: model submenu picks + labels correctly, and auth status/sign-in surfacing behaves." : "VERIFY FAILED.");
process.exit(exit);
