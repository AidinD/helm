// The chat sidebar is gone, and nothing else broke with it.
//
// Aidin, task 22f85eda: "Vi borde ta bort session vyn från chat", choosing "hela sidopanelen
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
const { launch } = await import("./harness.mjs");

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
      await new Promise((r) => setTimeout(r, 350));
      const el = document.querySelector(".analysis-page:not(.hidden), .layout:not(.hidden)");
      return { drew: !!el && el.childElementCount > 0, id: el?.id || null };
    })()`);
    ok(res.drew, `the ${page} view renders (${res.id || "nothing visible"})`);
  }

  // --- chat still works without it --------------------------------------------
  const chat = await app.eval(`(async () => {
    navigateToPage("chat");
    openFreshDraftInPane(${JSON.stringify(tmp.replace(/\\/g, "\\\\"))}, "hello", { forceIndex: 0 });
    await new Promise((r) => setTimeout(r, 400));
    const paneEl = document.querySelector('.pane[data-pane="0"]');
    const promptEl = paneEl?.querySelector(".pane-composer textarea");
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
      carryOverOnFleetRow: /Carry over/.test(rowSrc),
      carryOverCallsTheSharedFlow: /summarizeAndCarryOver\\(/.test(rowSrc),
      carryOverGoesToChatFirst: /navigateToPage\\("chat"\\)/.test(rowSrc),
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
  ok(carried.carryOverOnFleetRow, "and now has a button on the Fleet row - it had lived ONLY in the deleted panel's menu");
  ok(carried.carryOverCallsTheSharedFlow, "calling the same function the panel called, so there is one carry-over flow rather than two");
  ok(
    carried.carryOverGoesToChatFirst,
    "and it navigates to chat first - it ends by opening a draft in a chat pane, which would be invisible from the Dashboard"
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
  ok(clicked.hasCarry, `and it has a rendered Carry over button, not just the text in a source file (${JSON.stringify(clicked.labels)})`);
  ok(clicked.carryTargetIsLive, "whose handler calls a function that still exists");
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
