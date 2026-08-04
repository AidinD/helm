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
    const IDS = ["chatPage", "dashboardPage", "jotPage", "goalPage", "lavishPage", "routinesPage", "reviewPage", "analysisPage", "archivePage", "settingsPage"];
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

    // The digits follow the header's own left-to-right order: Jot, Plan, Analysis, Archive.
    // They used to start at Plan, so every one of them was a step out of step with what he
    // sees - and Jot, the FIRST tab, had no digit at all.
    out.one = await go({ key: "1", ctrlKey: true });
    out.two = await go({ key: "2", ctrlKey: true });
    out.three = await go({ key: "3", ctrlKey: true });
    out.four = await go({ key: "4", ctrlKey: true });

    // No LETTER key for Jot. Ctrl+J was tried and dropped as two-handed, and Ctrl+J still
    // has a job inside the command palette (move selection down) - so it must reach the
    // palette untouched rather than being half-claimed here.
    navigateToPage("chat");
    await new Promise((r) => setTimeout(r, 200));
    out.jotLetter = await go({ key: "j", ctrlKey: true });

    // Ctrl+X must be LEFT ALONE. It is cut, and taking it would break cut in every text
    // field in the app - which is why Jot ended up on the SHIFTED form instead.
    navigateToPage("chat");
    await new Promise((r) => setTimeout(r, 200));
    out.cut = await go({ key: "x", ctrlKey: true });

    // Ctrl+Shift+X -> Jot. One-handed, and no browser binds this chord.
    navigateToPage("chat");
    await new Promise((r) => setTimeout(r, 200));
    out.jotChord = await go({ key: "X", code: "KeyX", ctrlKey: true, shiftKey: true });

    // The physical key is what identifies it: on some layouts a shifted "x" still reports
    // key:"x", so relying on the character alone would make the shortcut layout-dependent.
    navigateToPage("chat");
    await new Promise((r) => setTimeout(r, 200));
    out.jotChordLower = await go({ key: "x", code: "KeyX", ctrlKey: true, shiftKey: true });

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
  ok(res.one.pages.includes("jotPage"), `Ctrl+1 goes to Jot - the FIRST tab in the header (${res.one.pages.join(", ")})`);
  ok(res.two.pages.includes("lavishPage"), `Ctrl+2 goes to Plan (${res.two.pages.join(", ")})`);
  ok(res.three.pages.includes("analysisPage"), `Ctrl+3 goes to Analysis (${res.three.pages.join(", ")})`);
  ok(res.four.pages.includes("archivePage"), `Ctrl+4 goes to Archive (${res.four.pages.join(", ")})`);
  ok(
    !res.jotLetter.prevented && !res.jotLetter.pages.includes("jotPage"),
    "Ctrl+J is NOT a navigation key - it was dropped as two-handed, and the command palette still needs it"
  );
  ok(!res.cut.prevented, "Ctrl+X is NOT taken - it is cut, and taking it would break cut in every text field");
  ok(!res.cut.pages.includes("jotPage"), "and it navigates nowhere");
  ok(res.jotChord.pages.includes("jotPage"), `Ctrl+Shift+X goes to Jot (${res.jotChord.pages.join(", ")})`);
  ok(res.jotChord.prevented, "and claims the key, so nothing else acts on it too");
  ok(res.jotChordLower.pages.includes("jotPage"), "identified by the physical key, so a layout reporting lowercase still works");
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
    ? "VERIFY OK: Ctrl+Space is Dashboard, Ctrl+Shift+Space is Review, Ctrl+Shift+X is Jot, Ctrl+1..4 follow the header's own tab order, Ctrl+X stays cut, and the command palette still wins."
    : "VERIFY FAILED."
);
process.exit(exit);
