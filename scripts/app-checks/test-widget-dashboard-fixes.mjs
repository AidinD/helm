// The three things the captain reported about the widget dashboard (task 4bf2421c,
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
import { launch } from "../checks-lib/harness.mjs";

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
// A seeded auto-captain run, shaped exactly like a real one: the session carries
// startedBy "auto" (that field only ever exists on the session), and the run is a
// REGISTERED second mate under "direct" - which is what the dispatch does so the
// run is named after its project instead of the prompt's first line. Both halves
// matter: it was the combination that made the Auto widget unable to see it.
const AUTO_SESSION_ID = "e2e-auto-session";
const AUTO_PROJECT = path.join(tmp, "e2e-auto-run");
fs.mkdirSync(AUTO_PROJECT, { recursive: true });
fs.writeFileSync(
  configPath,
  JSON.stringify({
    dashboardWidgets: { enabled: true },
    autoCaptain: { enabled: false },
    helmSessions: {
      [AUTO_SESSION_ID]: {
        sessionId: AUTO_SESSION_ID,
        cliSessionId: AUTO_SESSION_ID,
        cwd: AUTO_PROJECT,
        model: "claude-opus-4-8",
        title: "Task from the board: add a --version flag",
        startedBy: "auto",
        isArchived: false,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      },
    },
  }),
  "utf8"
);
process.env.HELM_CONFIG_PATH = configPath;
process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
process.env.HELM_SECOND_MATES_PATH = path.join(tmp, "second-mates.json");
process.env.HELM_GOAL_RUN_HISTORY_PATH = path.join(tmp, "goal-run-history.json");
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9382";

// Dynamic import AFTER the env vars: secondMates.js resolves its path at import time, and a
// static import here would read the ambient value and touch the real dev data file.
const { secondMateId, AUTO_CAPTAIN } = await import("../../src/lib/secondMates.js");

// The auto fixture, in the shape the app produces TODAY.
//
// It used to seed the pre-2026-08-03 shape: a Helm SESSION carrying startedBy:"auto",
// registered as a second mate under "direct". Two later changes retired both halves. An auto
// task is no longer a session of its own - it is an autopilot RUN under a project's second
// mate - and a node only becomes an auto node because a RUN under it says startedBy:"auto".
// Then AUTO_CAPTAIN gave the auto lane its own dispatcher identity, so a binding registered
// under "direct" lands on a DIFFERENT node than the run does. The sibling file
// test-auto-widget-renders-run.mjs was written because of exactly this and says so in its
// header; this fixture simply never caught up (2026-08-12, first full sweep since 08-02).
const AUTO_SM_ID = secondMateId(AUTO_CAPTAIN, AUTO_PROJECT);
fs.writeFileSync(
  process.env.HELM_SECOND_MATES_PATH,
  JSON.stringify({
    [AUTO_SM_ID]: {
      firstMateId: AUTO_CAPTAIN,
      projectPath: AUTO_PROJECT,
      name: "e2e-auto-run",
      status: "proposed",
      sessionId: null,
    },
  }),
  "utf8"
);
fs.writeFileSync(
  process.env.HELM_GOAL_RUN_HISTORY_PATH,
  JSON.stringify([
    {
      goalRunId: "e2e-auto-run-1",
      goal: "Task from the board: add a --version flag",
      projectPath: AUTO_PROJECT,
      status: "running",
      dispatchedBy: AUTO_SM_ID,
      tier: "crew",
      startedBy: "auto",
      autoTaskId: "e2e-card-1",
      updatedAt: Date.now(),
    },
  ]),
  "utf8"
);

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

  // The dashboard derives the fleet through the shared builder - not its own
  // second derivation, which is how the two dashboards drifted apart before the
  // classic one was removed (task 337895ce). Only the widget dashboard remains,
  // so this now guards that IT uses the builder and nothing re-derives on its own.
  const single = await app.eval(`(() => {
    const src = renderWidgetDashboard.toString() + fillDashboardSections.toString();
    return {
      widgetUsesBuilder: /buildFleetModel\\(/.test(renderWidgetDashboard.toString()),
      strayAugment: (src.match(/augmentSecondMatesWithSessions\\(/g) || []).length,
    };
  })()`);
  ok(single.widgetUsesBuilder, `the (only) dashboard goes through the shared fleet builder (${J(single)})`);
  ok(single.strayAugment === 0, "and nothing re-derives the fleet on its own");

  // --- 4. THE WIDGET DASHBOARD HAS TO STAY LIVE ----------------------------
  // the captain, 2026-08-02, watching the auto-captain's first real run: the card moved
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

  // ...and it must MOVE when a live goal run gains an iteration, even though its
  // status stays "running". Otherwise the crew row's `iter N` label sits frozen
  // until an unrelated repaint (the captain, 2026-08-11: "den här renderas inte om
  // förän jag byter vy och tillbaka"). goalRuns is a module-level Map, so save it,
  // seed a run, mutate, and restore it just like state.sessions above.
  const fpRuns = await app.eval(`(() => {
    const saved = new Map(goalRuns);
    goalRuns.set("probe-run-1", { goalRunId: "probe-run-1", status: "running", iterations: [] });
    const seeded = widgetDashboardFingerprint();
    goalRuns.get("probe-run-1").iterations.push({ n: 1 });
    const iterated = widgetDashboardFingerprint();
    goalRuns.get("probe-run-1").status = "done";
    const doneStatus = widgetDashboardFingerprint();
    goalRuns.clear();
    for (const [k, v] of saved) goalRuns.set(k, v);
    const restored = widgetDashboardFingerprint();
    return { seeded, iterated, doneStatus, restored };
  })()`);
  ok(fpRuns.seeded !== fpRuns.iterated, "a new iteration on a still-running run changes the fingerprint - the iter N repaint bug");
  ok(fpRuns.iterated !== fpRuns.doneStatus, "and a status change on the run still moves it too (regression guard)");

  // --- 5. AND THE AUTO WIDGET HAS TO SHOW THE RUN --------------------------
  // the captain, 2026-08-03, after the liveness fixes above shipped: "ramen fungerar
  // men den hamnar fortfarande inte i auto captenens widget". The dashboard was
  // live by then; the widget's own filter was the problem. See
  // test-auto-widget-visibility.mjs for the why. This is the same claim measured
  // on the RENDERED widget, with a seeded auto run that mirrors his real data.
  const autoWidget = await app.eval(`(async () => {
    const matesRes = await window.helm.listMates();
    const smRes = await window.helm.listSecondMates();
    const model = await buildFleetModel(matesRes.active || [], smRes?.secondMates || []);
    const data = { mates: matesRes.active || [], secondMates: model.secondMates };
    const host = document.createElement("div");
    host.append(widgetBodyAuto(data));
    const autoNodes = model.secondMates.filter(s => s.startedBy === "auto");
    return {
      autoNodes: autoNodes.length,
      names: autoNodes.map(s => s.name),
      text: host.textContent,
      rows: host.querySelectorAll(".fleet-branch").length,
      inDirect: widgetBodyCaptain(data).textContent.includes("${"e2e-auto-run"}"),
    };
  })()`);
  ok(autoWidget.autoNodes === 1, `the seeded auto run is in the fleet model (${J(autoWidget.names)})`);
  ok(autoWidget.rows === 1, `and the Auto widget renders it as a row (${autoWidget.rows} rows)`);
  ok(/e2e-auto-run/.test(autoWidget.text), "the row names the project the work ran in");
  ok(!/Nothing started yet/.test(autoWidget.text), "so the widget is not showing its empty state while a run exists");
  ok(/Auto-captain/.test(autoWidget.text), "the card is labelled Auto-captain, not Captain");
  ok(!/work you drive yourself/.test(autoWidget.text), "and does not call work nobody started your own");
  ok(!autoWidget.inDirect, "the same run is not double-listed in the Captain widget");

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
