// The keyboard shortcuts to the primary views, including Review.
//
// the captain asked for one for Review because it is the page he lives on. Ctrl+R was his first
// guess and is Electron's RELOAD - taking it would have meant a keypress that throws away
// every open pane. Ctrl+4 was rejected as "för långt mellan fingrarna". So Review sits on
// Ctrl+Shift+Space: the same key as the dashboard with one more modifier.
//
// That choice is only safe if the shifted combination was genuinely free and if adding it
// does not disturb the unshifted ones, so both are asserted here rather than assumed.
//
// Run:  node scripts/e2e/test-view-shortcuts.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-keys-"));
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9497";
const { launch } = await import("./harness.mjs");

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const res = await app.eval(`(async () => {
    const press = (opts) => {
      const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...opts });
      document.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    // Pages are plain ids toggled with a "hidden" class - there is no ".page" class, and
    // the first version of this probe looked for one and reported every assertion as a
    // failure while the shortcut worked fine.
    const IDS = ["chatPage", "dashboardPage", "focusPage", "goalPage", "lavishPage", "routinesPage", "reviewPage", "analysisPage", "archivePage", "settingsPage"];
    const visible = () => IDS.filter((id) => { const el = document.getElementById(id); return el && !el.classList.contains("hidden"); });
    const go = async (opts) => {
      const prevented = press(opts);
      await new Promise((r) => setTimeout(r, 300));
      return { prevented, pages: visible() };
    };

    const out = {};
    navigateToPage("chat");
    await new Promise((r) => setTimeout(r, 200));
    out.fromChat = await go({ key: " ", code: "Space", ctrlKey: true, shiftKey: true });

    // From the dashboard too - the two must not fight over the same key.
    navigateToPage("dashboard");
    await new Promise((r) => setTimeout(r, 200));
    out.fromDashboard = await go({ key: " ", code: "Space", ctrlKey: true, shiftKey: true });

    // The unshifted one still reaches the dashboard.
    out.dashboard = await go({ key: " ", code: "Space", ctrlKey: true });

    // And the digits are untouched by the new shifted branch.
    out.plan = await go({ key: "1", ctrlKey: true });

    // A shifted combination that is NOT space must be left alone, or the branch would
    // start swallowing keys other features rely on.
    navigateToPage("chat");
    await new Promise((r) => setTimeout(r, 200));
    out.shiftOne = await go({ key: "1", ctrlKey: true, shiftKey: true });

    // With the command palette open the shortcut must yield to it.
    navigateToPage("chat");
    await new Promise((r) => setTimeout(r, 200));
    const palette = document.getElementById("commandPalette");
    palette.classList.remove("hidden");
    out.withPalette = await go({ key: " ", code: "Space", ctrlKey: true, shiftKey: true });
    palette.classList.add("hidden");
    return out;
  })()`);

  ok(res.fromChat.pages.includes("reviewPage"), `Ctrl+Shift+Space opens Review from the chat page (${res.fromChat.pages.join(", ")})`);
  ok(res.fromChat.prevented, "and the key is claimed, so nothing else acts on it as well");
  ok(res.fromDashboard.pages.includes("reviewPage"), `and from the dashboard, where the unshifted twin lives (${res.fromDashboard.pages.join(", ")})`);
  ok(res.dashboard.pages.includes("dashboardPage"), `Ctrl+Space still goes to the dashboard (${res.dashboard.pages.join(", ")})`);
  ok(res.plan.pages.some((p) => /lavish|plan/i.test(p)), `Ctrl+1 still goes to Plan (${res.plan.pages.join(", ")})`);
  ok(!res.shiftOne.prevented, "Ctrl+Shift+1 is left alone - only Space is ours to take");
  ok(!res.shiftOne.pages.includes("reviewPage"), "and it does not navigate anywhere");
  ok(!res.withPalette.prevented, "with the command palette open the shortcut yields to it");
  ok(!res.withPalette.pages.includes("reviewPage"), "and does not navigate out from under it");

  // Electron's own reload accelerator must NOT have been repurposed: a keypress that
  // discards every open pane is not something to hide behind a navigation shortcut.
  const rSrc = fs.readFileSync(new URL("../../src/renderer/renderer.js", import.meta.url), "utf8");
  ok(
    !/key === "r"|key\.toLowerCase\(\) === "r"/.test(rSrc),
    "Ctrl+R was not taken for this - it is Electron's reload, and reloading throws away every pane"
  );

  const errors = app.getConsoleErrors();
  ok(errors.length === 0, `no console errors (${errors.length})`);
  for (const e of errors) {
    console.log("   ", e.text.slice(0, 160));
  }
} catch (e) {
  exit = 1;
  console.error("ERR", e.stack || e.message);
} finally {
  try {
    await app?.close();
  } catch {}
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

console.log(
  exit === 0
    ? "VERIFY OK: Ctrl+Shift+Space opens Review, Ctrl+Space and Ctrl+1 are unchanged, other shifted combinations are left alone, and the command palette still wins."
    : "VERIFY FAILED."
);
process.exit(exit);
