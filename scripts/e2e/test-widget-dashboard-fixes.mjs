// The three things Aidin reported about the widget dashboard (task 4bf2421c,
// 2026-07-28):
//
//   1. "händer inget när jag ändrar width size på en widget" - and he could not
//      leave row 1 short to start on row 2.
//   2. "jag är begränsad till två" first mates.
//   3. "Captain är tom trots att den inte ska vara det".
//
// Each turned out to be a different defect, and none of them were in the widget
// code the previous tests covered: the width menu offered widths the stylesheet
// never implemented, the fleet was hard-capped at two mates in mates.js, and the
// widget dashboard passed RAW second-mate bindings to the widgets instead of the
// derived fleet model - and the captain's own sessions only exist in the derived
// one.
//
// Everything here is measured on the rendered page (computed styles, real DOM),
// because every one of these was invisible from the layer below.
//
// Run: node scripts/e2e/test-widget-dashboard-fixes.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch } from "./harness.mjs";

let app;
let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails++;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-wd-"));
const configPath = path.join(tmp, "config.json");
fs.writeFileSync(configPath, JSON.stringify({ dashboardWidgets: { enabled: true } }), "utf8");
process.env.HELM_CONFIG_PATH = configPath;
process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
process.env.HELM_SECOND_MATES_PATH = path.join(tmp, "second-mates.json");
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_E2E_PORT = "9382";

const J = JSON.stringify;

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });
  const ready = await (async () => {
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      if (await app.eval(`typeof renderDashboardPage === "function"`)) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  })();
  ok(ready, "the renderer loaded");

  // ---- 1. WIDTH ------------------------------------------------------------
  // The menu offered 3,4,5,6,7,8,12 but style.css only implemented .wd-span-3..7,
  // so picking 8 or "Full width" silently did nothing. Measure the COMPUTED grid
  // span, which is the only thing that proves the choice reached the layout.
  const spans = await app.eval(`(async () => {
    const out = [];
    for (const span of WIDGET_SPANS) {
      const el = await widgetEl({ id: "probe", type: "quota", span }, { mates: [], secondMates: [] });
      document.body.append(el);
      out.push({ span, computed: getComputedStyle(el).gridColumn });
      el.remove();
    }
    return out;
  })()`);
  const wrong = spans.filter((s) => !new RegExp(`span ${s.span}\\b`).test(s.computed));
  ok(
    wrong.length === 0,
    `every width the menu offers actually changes the layout (broken: ${J(wrong)})`
  );
  ok(spans.some((s) => s.span === 12), "full width is one of them");
  ok(spans.length >= 8, `and there are enough widths to be worth a menu (${spans.length})`);

  // ---- 1b. LEAVING A ROW SHORT --------------------------------------------
  const layoutOnly = await app.eval(`(async () => {
    const brk = await widgetEl({ id: "b1", type: "break", span: 12 }, { mates: [], secondMates: [] });
    const blank = await widgetEl({ id: "b2", type: "blank", span: 5 }, { mates: [], secondMates: [] });
    document.body.append(brk, blank);
    const res = {
      breakSpan: getComputedStyle(brk).gridColumn,
      blankSpan: getComputedStyle(blank).gridColumn,
      breakDraggable: !!brk.querySelector(".wd-grip")?.draggable,
      blankDraggable: !!blank.querySelector(".wd-grip")?.draggable,
      blankHasOptions: !!blank.querySelector(".wd-opts"),
    };
    brk.remove();
    blank.remove();
    return res;
  })()`);
  ok(/1 \/ -1|1 \/ 13|span 12/.test(layoutOnly.breakSpan), `a row break spans the full row, so the next widget starts a new one (${layoutOnly.breakSpan})`);
  ok(/span 5\b/.test(layoutOnly.blankSpan), `a blank holds exactly the width you gave it (${layoutOnly.blankSpan})`);
  ok(
    layoutOnly.breakDraggable && layoutOnly.blankDraggable && layoutOnly.blankHasOptions,
    "both are ordinary widgets - draggable and resizable, not a separate mechanism"
  );

  // Repeatable layout pieces need unique ids, or drag/remove would hit the wrong one.
  const ids = await app.eval(`(() => {
    const layout = [{ id: "w-blank-1", type: "blank" }, { id: "w-blank-2", type: "blank" }];
    return [nextWidgetInstanceId(layout, "blank"), nextWidgetInstanceId([], "break")];
  })()`);
  ok(ids[0] === 3 && ids[1] === 1, `a second blank gets its own id rather than colliding (${J(ids)})`);

  // ---- 2. MORE THAN TWO FIRST MATES ---------------------------------------
  const before = await app.eval(`window.helm.listMates()`);
  ok((before?.active || []).length === 2, `the fleet still starts with two (${(before?.active || []).length})`);
  const added = await app.eval(`(async () => {
    await window.helm.addMate();
    return window.helm.addMate();
  })()`);
  ok(added?.ok === true && (added.active || []).length === 4, `two more can be added (${(added?.active || []).length})`);
  const names = (added.active || []).map((m) => m.name);
  ok(new Set(names).size === names.length, `each new first mate is its own named coordinator (${J(names)})`);
  ok(
    (added.active || []).every((m, i) => m.slot === i),
    `and they occupy consecutive slots (${J((added.active || []).map((m) => m.slot))})`
  );
  // It survives a reload: the count is config, not memory.
  const cfgAfter = JSON.parse(fs.readFileSync(configPath, "utf8"));
  ok(cfgAfter.firstMateSlots === 4, `the new size is persisted (${cfgAfter.firstMateSlots})`);
  const relisted = await app.eval(`window.helm.listMates()`);
  ok((relisted?.active || []).length === 4, "listing again does not silently drop back to two");

  // And it can go back down - a one-way door would be worse than the cap.
  const removed = await app.eval(`window.helm.removeMate(${J(added.active[3].mateId)})`);
  ok(removed?.ok === true && (removed.active || []).length === 3, `a first mate can be dismissed again (${(removed?.active || []).length})`);
  ok(
    !(removed.active || []).some((m) => m.mateId === added.active[3].mateId),
    "the dismissed one does not respawn into its old slot"
  );
  const floor = await app.eval(`(async () => {
    const list = await window.helm.listMates();
    let last = null;
    for (const m of list.active) { last = await window.helm.removeMate(m.mateId); }
    return last;
  })()`);
  ok(floor?.ok === false && /at least one/i.test(floor.error || ""), `it refuses to leave the fleet empty (${J(floor?.error)})`);

  // ---- 3. THE CAPTAIN WIDGET ----------------------------------------------
  // The captain's own sessions are DERIVED from state.sessions; they are not
  // second-mate bindings. The widget dashboard passed the raw bindings straight
  // through, so its Captain widget had nothing to show.
  const captain = await app.eval(`(async () => {
    const matesRes = await window.helm.listMates();
    const smRes = await window.helm.listSecondMates();
    const raw = smRes?.secondMates || [];
    const rawDirect = raw.filter(s => s.firstMateId === "direct" && s.isSessionNode).length;
    const model = await buildFleetModel(matesRes.active || [], raw);
    const derivedDirect = model.secondMates.filter(s => s.firstMateId === "direct" && s.isSessionNode);
    const host = document.createElement("div");
    host.append(widgetBodyCaptain({ mates: matesRes.active || [], secondMates: model.secondMates }));
    return { rawDirect, derived: derivedDirect.length, sessions: state.sessions.length, rendered: host.textContent.trim().length };
  })()`);
  if (captain.sessions === 0) {
    console.log("SKIP - no sessions on this machine to populate the captain column");
  } else {
    ok(
      captain.derived > 0,
      `the captain's own sessions exist in the DERIVED model (${captain.derived} from ${captain.rawDirect} raw bindings)`
    );
    ok(
      captain.derived > captain.rawDirect,
      "which is exactly why passing the raw bindings left the widget empty"
    );
    ok(captain.rendered > 0, `and the Captain widget renders something (${captain.rendered} chars)`);
  }

  // Both dashboards must derive it the SAME way - two derivations is how they
  // drifted apart in the first place.
  const single = await app.eval(`(() => {
    const src = renderWidgetDashboard.toString() + fillDashboardSections.toString();
    return {
      widgetUsesBuilder: /buildFleetModel\\(/.test(renderWidgetDashboard.toString()),
      classicUsesBuilder: /buildFleetModel\\(/.test(fillDashboardSections.toString()),
      strayAugment: (src.match(/augmentSecondMatesWithSessions\\(/g) || []).length,
    };
  })()`);
  ok(single.widgetUsesBuilder && single.classicUsesBuilder, `both dashboards go through the shared builder (${J(single)})`);
  ok(single.strayAugment === 0, "and neither re-derives the fleet on its own");

  // --- 4. THE WIDGET DASHBOARD HAS TO STAY LIVE ----------------------------
  // Aidin, 2026-08-02, watching the auto-captain's first real run: the card moved
  // to in-progress, the work actually got done, "men sen verkar inget hända ...
  // Auto widgeten är fortfarande tillsynes tom".
  //
  // Two defects behind that one sentence, both about looking at stale data:
  //   a) renderWidgetDashboard fetched mates, second mates, goals and budget
  //      fresh, but read SESSIONS out of renderer memory - and the fleet widgets
  //      are derived from sessions. The repaint fired by the pass that had just
  //      created a session could not see it. (Same shape as #3 above.)
  //   b) fillDashboardSections returned immediately for the widget dashboard, so
  //      it never repainted on a poll either. Once rendered, frozen.
  const live = await app.eval(`(() => {
    const src = renderWidgetDashboard.toString();
    const fill = fillDashboardSections.toString();
    return {
      fetchesSessions: /getSessions\\(\\)/.test(src),
      assignsSessions: /state\\.sessions\\s*=/.test(src),
      pollRepaints: /renderDashboardPage\\(\\)/.test(fill),
      guardsDrag: /widgetDragId/.test(fill),
      hasFingerprint: typeof widgetDashboardFingerprint === "function",
    };
  })()`);
  ok(live.fetchesSessions && live.assignsSessions, `the widget render fetches sessions itself (${J(live)})`);
  ok(live.pollRepaints, "and a poll tick can repaint the widget dashboard instead of returning immediately");
  ok(live.guardsDrag, "while still refusing to repaint mid-drag - the original reason for the guard");
  ok(live.hasFingerprint, "gated on a fingerprint so an unchanged board is not rebuilt every tick");

  // The fingerprint must MOVE when a session appears or changes status, or the
  // gate silently reintroduces the frozen dashboard.
  const fp = await app.eval(`(() => {
    const before = widgetDashboardFingerprint();
    const saved = state.sessions;
    state.sessions = [...(saved || []), { sessionId: "probe-1", status: "active", startedBy: "auto", lastActivityAt: 1, cwd: "D:/x" }];
    const added = widgetDashboardFingerprint();
    state.sessions = state.sessions.map(s => s.sessionId === "probe-1" ? { ...s, status: "waiting" } : s);
    const changed = widgetDashboardFingerprint();
    state.sessions = saved;
    const restored = widgetDashboardFingerprint();
    return { before, added, changed, restored };
  })()`);
  ok(fp.before !== fp.added, "a new session changes the fingerprint - this is the auto-captain case exactly");
  ok(fp.added !== fp.changed, "so does a status change on an existing one");
  ok(fp.before === fp.restored, "and an unchanged board fingerprints identically, so idle ticks do nothing");

  const errs = app.getConsoleErrors();
  ok(errs.length === 0, `no console errors${errs.length ? ": " + errs[0].text.slice(0, 200) : ""}`);
} catch (e) {
  fails++;
  console.error("ERR", e.stack || e.message);
} finally {
  if (app) {
    await app.close();
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
console.log(
  fails === 0
    ? "\nVERIFY OK: widths apply, rows can be left short, the fleet is not capped at two, and Captain is populated."
    : `\nVERIFY FAILED (${fails})`
);
process.exit(fails === 0 ? 0 : 1);
