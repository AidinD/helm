// The chat sidebar is gone, and nothing else broke with it.
//
// the captain, task 22f85eda: "Vi borde ta bort session vyn från chat", choosing "hela sidopanelen
// bort" - sessions are reached through Ctrl+K and the Dashboard instead.
//
// This test exists because of how the LAST surface removal went (the Focus track, 2026-08-04):
// the script took "everything from this function to the next `function`" and ate three unrelated
// top-level declarations, `node --check` passed - a missing declaration is valid syntax - and the
// app only broke when a page that referenced one was drawn. So the check that matters is not that
// the sidebar is absent; it is that every remaining view still RENDERS.
//
// The second failure mode of this particular removal is worse and equally invisible to a syntax
// check: an addEventListener on a getElementById that now returns null throws at module scope and
// takes the whole renderer down before it draws anything. A console-error count of zero after
// visiting every page is what rules both out.
//
// Run:  node scripts/e2e/test-chat-sidebar-removed.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-nosidebar-"));
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9511";
const { launch } = await import("../checks-lib/harness.mjs");

const PAGES = ["dashboard", "goal", "routines", "review", "chat", "jot", "lavish", "analysis", "archive", "settings"];

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  // --- the panel and its controls are actually gone ---------------------------
  const gone = await app.eval(`(() => {
    const ids = ["sidebar", "sidebarBody", "sidebarCollapse", "search", "collapseAll", "newCategory", "newChat"];
    return {
      present: ids.filter((id) => !!document.getElementById(id)),
      navs: document.querySelectorAll("nav.sidebar").length,
      layoutColumns: getComputedStyle(document.getElementById("chatPage")).gridTemplateColumns,
      // The functions that only served it must be gone too, not merely unreferenced.
      // A bare eval of "typeof x" returns a STRING - the first version of this wrapped it in
      // another typeof and compared that to "function", which can never be true, so the whole
      // clause did nothing. And the result was never asserted at all.
      leftovers: ["renderSidebar", "sectionEl", "rowEl", "moveSessionToGroup", "createCategory", "removeFromHelm", "computeSidebarFingerprint"]
        .filter((n) => eval("typeof " + n) === "function"),
    };
  })()`);
  ok(gone.present.length === 0, `every sidebar element is gone (${gone.present.join(", ") || "none left"})`);
  ok(gone.leftovers.length === 0, `and so are the functions that only served it (${gone.leftovers.join(", ") || "none left"})`);
  ok(gone.navs === 0, "and the nav itself");
  ok(!/300px/.test(gone.layoutColumns), `the chat grid no longer reserves the panel's column (${gone.layoutColumns})`);

  // --- THE point: every view still renders ------------------------------------
  for (const page of PAGES) {
    const res = await app.eval(`(async () => {
      navigateToPage(${JSON.stringify(page)});
      // Some views render asynchronously (review does an IPC round-trip for its
      // rows), so poll until the visible page has actually drawn instead of a fixed
      // delay - the fixed 350ms raced the async render under the full serial suite's
      // load, which is why this test flaked in the sweep but passed in isolation.
      let el = null;
      for (let i = 0; i < 60; i++) {
        el = document.querySelector(".analysis-page:not(.hidden), .layout:not(.hidden)");
        if (el && el.childElementCount > 0) {
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return { drew: !!el && el.childElementCount > 0, id: el?.id || null };
    })()`);
    ok(res.drew, `the ${page} view renders (${res.id || "nothing visible"})`);
  }

  // --- chat still works without it --------------------------------------------
  const chat = await app.eval(`(async () => {
    navigateToPage("chat");
    openFreshDraftInPane(${JSON.stringify(tmp.replace(/\\/g, "\\\\"))}, "hello", { forceIndex: 0 });
    // Poll for the pane + its seeded draft rather than a fixed wait (same
    // under-load race as the per-view loop above).
    let paneEl = null;
    let promptEl = null;
    for (let i = 0; i < 60; i++) {
      paneEl = document.querySelector('.pane[data-pane="0"]');
      promptEl = paneEl?.querySelector(".pane-composer textarea");
      if (promptEl && promptEl.value === "hello") {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const workspace = document.getElementById("workspace");
    return {
      pane: !!paneEl,
      draft: promptEl?.value || "",
      // The workspace should now have the whole width, not 300px less than it.
      workspaceWidth: workspace?.getBoundingClientRect().width || 0,
      windowWidth: window.innerWidth,
    };
  })()`);
  ok(chat.pane, "a chat pane still opens");
  ok(chat.draft === "hello", `and takes a draft (${JSON.stringify(chat.draft)})`);
  ok(
    chat.workspaceWidth > chat.windowWidth - 60,
    `the workspace now spans the window instead of leaving the panel's gap (${Math.round(chat.workspaceWidth)} of ${chat.windowWidth}px)`
  );

  // --- what the panel carried has somewhere else to live ----------------------
  // The row builder is read as SOURCE rather than rendered: a Fleet row needs a real second
  // mate with a backing session, which this fixture has none of. Reading the function the app
  // actually holds is weaker than clicking the button, and it is stated as such below - the
  // first version of this check was `... || true`, an assertion that could not fail.
  const carried = await app.eval(`(() => {
    const rowSrc = String(fleetSecondMateEl);
    return {
      // No Carry over button any more (the captain, 2026-08-05: "carry over är överflödigt"). The move
      // itself is not gone - Archive's menu offers "Save handoff to HANDOFF.md + archive", which is
      // the file-based continuity the app is built on, and a filling-up first mate grows its own
      // "hand off to a fresh one" nudge. So what is asserted is that the button is absent AND that
      // the handoff path is still on this row.
      // (No source-regex for the ABSENCE of the button: the comment explaining why it was removed
      // contains the words "Carry over", so such a check fails on the comment - which is finding 2
      // from the ship review, live. The RENDERED row below is the honest check.)
      handoffStillOffered: /archiveMenuItems\\(/.test(rowSrc),
      renameOnFleetRow: /renameSessionTo\\(/.test(rowSrc),
      archiveOnFleetRow: /archiveMenuItems\\(/.test(rowSrc),
      renameStillExists: typeof renameSessionTo === "function" && typeof makeInlineEditable === "function",
      hidePredicateStillExists: typeof isHiddenFromHelm === "function" && typeof restoreToHelm === "function",
      summarizeStillExists: typeof summarizeAndCarryOver === "function",
    };
  })()`);
  ok(carried.renameStillExists, "renaming a session survives - the Dashboard's Fleet row uses it");
  ok(carried.renameOnFleetRow && carried.archiveOnFleetRow, "rename and archive are on that row, which is where he was told to find them");
  ok(carried.summarizeStillExists, "summarize & carry over still exists");
  ok(
    carried.handoffStillOffered,
    "but the handoff path is still there: Archive's own menu summarises to HANDOFF.md, which is what a fresh session reads first"
  );
  ok(
    carried.hidePredicateStillExists,
    "and the hidden-session predicate stays, so anything previously removed from Helm is still hidden and still restorable"
  );

  // --- a declaration reached only from a CLICK ---------------------------------
  // Rendering every view does not exercise a row builder, a context menu or a click handler:
  // the fixture has no sessions, so none of them run. Proven by an independent review, which
  // renamed `archiveMenuItems` - a top-level declaration reached only when Archive is clicked -
  // and watched this test report VERIFY OK while clicking Archive would throw and archive
  // nothing. Regexing the call-site text out of a function's source cannot see that: the call
  // site is still there, it is the DEFINITION that is missing.
  //
  // So: inject a session, render its real Fleet row, and CLICK. Archive only opens a menu, so
  // it is safe to click; Carry over would start a real summarize call, so its button is checked
  // as rendered DOM and its handler's target as a live function, which is as far as this can go
  // without spending tokens.
  const clicked = await app.eval(`(async () => {
    navigateToPage("dashboard");
    state.sessions.push({
      sessionId: "SIDEBAR_RM_1", cliSessionId: "SIDEBAR_RM_1", cwd: ${JSON.stringify(tmp.replace(/\\/g, "\\\\"))},
      title: "probe session", status: "idle", isArchived: false, lastActivityAt: Date.now(),
    });
    const node = augmentSecondMatesWithSessions([]).find((s) => s.sessionId === "SIDEBAR_RM_1");
    if (!node) {
      return { rendered: false };
    }
    const row = fleetSecondMateEl(node);
    document.body.append(row);
    const labels = [...row.querySelectorAll("button")].map((b) => b.textContent.trim());
    const archiveBtn = [...row.querySelectorAll("button")].find((b) => b.textContent.trim() === "Archive");
    const carryBtn = [...row.querySelectorAll("button")].find((b) => b.textContent.trim() === "Carry over");
    // Expected to be ABSENT now - see above.
    let archiveThrew = null;
    let menuItems = [];
    try {
      archiveBtn.click();
      await new Promise((r) => setTimeout(r, 250));
      menuItems = [...document.querySelectorAll("#contextMenu .item")].map((i) => i.textContent.trim());
      closeContextMenu();
    } catch (err) {
      archiveThrew = String(err && err.message ? err.message : err);
    }
    row.remove();
    state.sessions = state.sessions.filter((s) => s.sessionId !== "SIDEBAR_RM_1");
    return {
      rendered: true,
      labels,
      hasCarry: !!carryBtn,
      archiveThrew,
      menuItems,
      carryTargetIsLive: typeof summarizeAndCarryOver === "function",
    };
  })()`);

  ok(clicked.rendered, "a real Fleet row renders for an injected session - the click paths are actually reachable in this fixture");
  ok(!clicked.hasCarry, `and no Carry over button is rendered on it (${JSON.stringify(clicked.labels)})`);
  // The flow itself must still EXIST, because the archive handoff and the first-mate nudge both use
  // it - removing the button must not have taken the capability with it.
  ok(clicked.carryTargetIsLive, "while the carry-over flow itself still exists, for the two entry points that kept it");
  ok(clicked.archiveThrew === null, `clicking Archive does not throw (${clicked.archiveThrew || "no error"})`);
  ok(
    clicked.menuItems.length > 0,
    `and really opens its menu, so the definition behind the click is present and not merely called (${JSON.stringify(clicked.menuItems)})`
  );

  const errors = app.getConsoleErrors();
  ok(errors.length === 0, `no console errors across all ${PAGES.length} views (${errors.length})`);
  for (const e of errors.slice(0, 8)) {
    console.log("   ", e.text.slice(0, 200));
  }
} catch (err) {
  exit = 1;
  console.error("ERR", err.stack || err.message);
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
    ? "VERIFY OK: the sidebar and its machinery are gone, every remaining view renders with no console errors, and what the panel carried still has a home."
    : "VERIFY FAILED."
);
process.exit(exit);
