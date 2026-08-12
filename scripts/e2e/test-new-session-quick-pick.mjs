// "+ Session" offers the folders you actually use, instead of a folder browser.
//
// Task 0d9599bd - "new session borde ge default (minadokument/claude) som
// alternativ för snabb pick". The button called the operating system's folder
// dialog directly, so starting a session in the folder holding the CLAUDE.md
// that every session inherits meant clicking through a browse dialog every time.
//
// Driven in the real app: the interesting part is what the button opens, and what
// the menu offers for the state the app is actually in.
//
// Run:  node scripts/e2e/test-new-session-quick-pick.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-qpick-"));
const metaHome = path.join(tmp, "meta-home");
fs.mkdirSync(metaHome, { recursive: true });
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_META_HOME_OVERRIDE = metaHome;
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9475";
const { launch } = await import("./harness.mjs");

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const res = await app.eval(`(async () => {
    // Two projects, one worked in far more recently, plus a duplicate of the
    // home folder - the menu must not offer the same folder twice.
    const home = (await window.helm.getOrchestratorInfo())?.cwd || null;
    state.sessions = [
      { sessionId: "s1", title: "older", cwd: "D:\\\\Repo\\\\Tools\\\\older-project", lastActivityAt: 1000 },
      { sessionId: "s2", title: "newer", cwd: "D:\\\\Repo\\\\Tools\\\\newer-project", lastActivityAt: 9000 },
      { sessionId: "s3", title: "in home", cwd: home, lastActivityAt: 5000 },
    ];
    const items = await newSessionFolderMenuItems();
    return {
      home,
      labels: items.map((i) => (i.sep ? "---" : i.label)),
      hints: items.filter((i) => !i.sep).map((i) => i.hint || ""),
      clickable: items.filter((i) => !i.sep && typeof i.onClick === "function").length,
      total: items.length,
    };
  })()`);

  const homeName = res.home.split(/[\\/]/).filter(Boolean).pop();
  ok(res.labels[0] === homeName, `the home folder is the FIRST pick, not something to browse for (${res.labels[0]})`);
  ok(res.labels[1] === "---", "and is set apart from the recents below it");
  ok(res.labels.includes("newer-project") && res.labels.includes("older-project"), `the projects Helm has seen are offered (${res.labels.join(", ")})`);
  ok(
    res.labels.indexOf("newer-project") < res.labels.indexOf("older-project"),
    "most recently worked in first - the whole point is that the top item is usually the right one"
  );
  ok(res.labels.filter((l) => l === homeName).length === 1, `the home folder appears once even though a session is rooted there (${res.labels.filter((l) => l === homeName).length})`);
  ok(res.labels[res.labels.length - 1] === "Browse…", `browsing is still available, one item down (${res.labels[res.labels.length - 1]})`);
  ok(res.clickable === res.labels.filter((l) => l !== "---").length, `every item does something (${res.clickable})`);
  ok(
    res.hints.slice(0, -1).every((h) => h.length > 0),
    `each folder shows its path, because the name alone is a guess (${JSON.stringify(res.hints[0])})`
  );

  // A long path must stay readable while keeping the end that identifies it.
  const trunc = await app.eval(`(() => {
    const long = "D:\\\\Dropbox\\\\Mina Dokument\\\\some very long chain of folders\\\\that keeps going\\\\Claude";
    return { out: truncatePathForMenu(long), short: truncatePathForMenu("D:\\\\Repo\\\\helm") };
  })()`);
  ok(trunc.out.startsWith("…") && trunc.out.endsWith("Claude"), `a long path is cut at the FRONT, keeping the identifying tail (${trunc.out})`);
  ok(trunc.out.length <= 46, `and fits a menu (${trunc.out.length} chars)`);
  ok(trunc.short === "D:\\Repo\\helm", `a short path is left alone (${trunc.short})`);

  // --- the button actually opens it -----------------------------------------
  const opened = await app.eval(`(async () => {
    // The DASHBOARD, because there is no longer a "fleet" page to navigate to. The classic
    // section stack was retired once the widget grid had been in daily use (task 337895ce),
    // and navigateToPage has had no "fleet" branch since - so this called it, nothing
    // happened, and the card it then looked for was never on screen. The card itself is
    // alive and unchanged: the Captain widget renders it through fleetDirectCardEl, same
    // element, same "+ Session" button (2026-08-12, first full sweep since 08-02).
    navigateToPage("dashboard");
    await renderDashboardPage();
    // Poll for the captain's card to render rather than a fixed wait - the widget draws from
    // an async refresh, and a fixed delay raced it under the full serial suite's load (green
    // in isolation, flaky in the sweep).
    let btn = null;
    for (let i = 0; i < 60; i++) {
      btn = [...document.querySelectorAll(".fleet-mate-card.direct .fleet-btn")].find((b) => b.textContent.includes("+ Session"));
      if (btn) {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!btn) {
      return { found: false };
    }
    btn.click();
    const menu = document.getElementById("contextMenu");
    for (let i = 0; i < 40; i++) {
      if (menu && !menu.classList.contains("hidden") && menu.querySelectorAll(".item").length > 0) {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return {
      found: true,
      visible: !menu.classList.contains("hidden"),
      items: menu.querySelectorAll(".item").length,
      first: menu.querySelector(".item")?.textContent || "",
      onScreen: (() => {
        const r = menu.getBoundingClientRect();
        return r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight;
      })(),
    };
  })()`);

  ok(opened.found, "the + Session button is on the captain's card");
  ok(opened.visible, "clicking it opens the picker rather than a folder dialog");
  ok(opened.items >= 2, `with real choices in it (${opened.items} items, first "${opened.first}")`);
  ok(opened.onScreen, "and the menu is fully on screen where the button is");

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
    ? "VERIFY OK: + Session opens a quick pick led by the home folder, then the projects most recently worked in, with browsing still one item away."
    : "VERIFY FAILED."
);
process.exit(exit);
