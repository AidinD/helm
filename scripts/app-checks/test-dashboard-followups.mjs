// Five things the captain reported from using the app on 2026-08-03, measured on the
// rendered page in a launched app because every one of them was invisible from
// the layer below:
//
//   1. "Man borde kunna förstora input fältet" - the composer was two fixed rows
//      with `resize: none`, so a long prompt could only be read a slit at a time.
//   2. "Vad betyder den här texten egentligen?" - the Dashboard subtitle said no
//      first mate was on watch, directly above a Fleet listing two of them.
//   3. "Quota widgeten ser inte ut som i mocken - ingen veckokvot t.ex" - the
//      weekly window WAS there, as the unlabelled headline.
//   4. "Och den verkar inte uppdateras så konsekvent" - a fresh quota reading
//      repainted the top-bar chip but not the widget.
//   5. "review gör ingenting i needs you widgeten" - the button flipped a flag and
//      asked for a repaint; the fingerprint said nothing had changed.
//
// 4 and 5 are the same defect: the widget fingerprint decides whether a repaint
// happens, and it only looked at data. View state and quota change the rendered
// output too.
//
// Run: node scripts/app-checks/test-dashboard-followups.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-dashfollow-"));
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
// Widgets OFF: the subtitle lives on the classic topbar, and flipping the mode
// mid-session lets the widget render's atomic page swap land after the classic one
// and wipe it - which cost a debugging round when a scratch probe did exactly that.
fs.writeFileSync(process.env.HELM_CONFIG_PATH, JSON.stringify({ dashboardWidgets: { enabled: false } }), "utf8");
process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
process.env.HELM_SECOND_MATES_PATH = path.join(tmp, "second-mates.json");
process.env.HELM_GOAL_RUN_HISTORY_PATH = path.join(tmp, "goal-run-history.json");
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9392";

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

  // ---- 1. The composer can grow, and can be dragged ------------------------
  const composer = await app.eval(`(async () => {
    navigateToPage("chat");
    await new Promise(r => setTimeout(r, 400));
    const el = document.querySelector('.pane[data-pane="0"] .pane-composer textarea');
    if (!el) return { missing: true };
    const base = Math.round(el.getBoundingClientRect().height);
    // Assigned through the PROPERTY, with no input event - the path a loaded draft,
    // a quoted bubble or a queued message takes. A dozen call sites do this.
    el.value = Array.from({length: 40}, (_, i) => "line " + i + " of a long pasted prompt").join("\\n");
    await new Promise(r => setTimeout(r, 60));
    const grown = Math.round(el.getBoundingClientRect().height);
    const overflowWhenFull = getComputedStyle(el).overflowY;
    const paneH = document.querySelector('.pane[data-pane="0"]').getBoundingClientRect().height;
    // A dragged height becomes a FLOOR, not a lock.
    //
    // Driven through the real GRIP now. This used to set el.style.height and fire a mouseup,
    // which is how the old native corner grabber was detected - the height was inferred
    // afterwards by noticing it no longer matched. That inference was deleted when the handle
    // moved to the composer's top edge (task dce9946c), so simulating a drag that way recorded
    // nothing and this assertion failed while the behaviour it protects was intact.
    const grip = document.querySelector('.pane[data-pane="0"] .composer-grip');
    const gbox = grip.getBoundingClientRect();
    const gy = gbox.y + gbox.height / 2;
    const send = (type, y) => grip.dispatchEvent(new PointerEvent(type, { pointerId: 1, clientX: gbox.x + gbox.width / 2, clientY: y, bubbles: true, cancelable: true }));
    send("pointerdown", gy);
    send("pointermove", gy - 60); // up is bigger
    send("pointerup", gy - 60);
    const afterDrag = Math.round(el.getBoundingClientRect().height);
    el.value = "short again";
    await new Promise(r => setTimeout(r, 60));
    const afterDragShort = Math.round(el.getBoundingClientRect().height);
    el.value = "";
    await new Promise(r => setTimeout(r, 60));
    return {
      resize: getComputedStyle(el).resize,
      hasGrip: !!grip,
      gripCursor: getComputedStyle(grip).cursor,
      base, grown, overflowWhenFull, afterDrag, afterDragShort,
      paneH: Math.round(paneH),
    };
  })()`);
  ok(!composer.missing, "the composer exists");
  // It can still be dragged by hand - by the composer's TOP EDGE, not by the textarea's own
  // native corner grip, which was deliberately turned off (task dce9946c: the corner was a small
  // target in the wrong place, and it left no signal, so the size had to be inferred from a
  // mouseup afterwards). This assertion used to read `resize === "vertical"`, which described the
  // affordance rather than the capability.
  ok(composer.hasGrip, "it can be dragged by hand - the composer's top edge is a handle");
  ok(composer.gripCursor === "ns-resize", `and says so (cursor: ${composer.gripCursor})`);
  ok(composer.resize === "none", `while the textarea's own corner grip stays off (resize: ${composer.resize})`);
  ok(composer.grown > composer.base + 20, `a long text assigned programmatically grows it (${composer.base} -> ${composer.grown}px)`);
  ok(
    composer.grown <= Math.round(composer.paneH * 0.46) + 2,
    `but never past its share of the pane, so it cannot swallow the transcript (${composer.grown} of ${composer.paneH})`
  );
  ok(composer.overflowWhenFull === "auto", "and scrolls internally once it hits that ceiling instead of growing further");
  ok(
    composer.afterDragShort >= composer.grown + 50,
    `a height you dragged to is kept as a floor when the text shrinks (${composer.afterDragShort}px)`
  );

  // ---- 2. The Dashboard subtitle tells the truth ---------------------------
  const sub = await app.eval(`(async () => {
    navigateToPage("dashboard");
    await renderDashboardPage();
    const el = () => document.getElementById("dashSubtitle");
    const until = Date.now() + 15000;
    while (Date.now() < until && !(el()?.textContent || "").trim()) {
      await new Promise(r => setTimeout(r, 150));
    }
    const mates = await window.helm.listMates();
    // EVERY SEAT KIND the board can draw, not just the coordinator pool. Asking only for
    // .active is what let the subtitle omit the assistant and every project seat while this
    // check stayed green (the captain, 2026-09-11, reading three names that did not match
    // the three widgets under them).
    return {
      text: el()?.textContent || "",
      names: (mates?.active || []).map(m => m.name),
      assistant: mates?.assistant?.name || null,
      projects: (mates?.projects || []).map(m => m.name),
    };
  })()`);
  const everySeatName = [...(sub.assistant ? [sub.assistant] : []), ...sub.names, ...sub.projects];
  ok(everySeatName.length > 0, `seats ARE on watch in this fixture (${everySeatName.join(", ")})`);
  ok(!/No first mate on watch/.test(sub.text), `so the subtitle does not claim otherwise (${JSON.stringify(sub.text.slice(0, 70))})`);
  // Named, or COUNTED in the overflow - the line caps at four names, and dropping the rest
  // silently would be the same wrong-set bug one cause further down.
  const overflow = Number((/and (\d+) more/.exec(sub.text) || [])[1] || 0);
  const namedInLine = everySeatName.filter((n) => sub.text.includes(n));
  ok(
    namedInLine.length + overflow >= everySeatName.length,
    `and every seat the board draws is named or counted (${namedInLine.length} named + ${overflow} counted of ${everySeatName.length})`
  );
  // WHERE TO ACT, asserted as a place that EXISTS rather than as a phrase. This line used to
  // pin "Fleet below", which outlived the Fleet itself (removed in 337895ce): the check was
  // written when it was true, the section went, and the wrong sentence stayed green for it.
  ok(!/Fleet/.test(sub.text), "and does not point at the Fleet, which this dashboard no longer has");
  const pointsSomewhereReal = await app.eval(`(() => {
    const text = document.getElementById("dashSubtitle")?.textContent || "";
    if (!/widget/i.test(text)) return { ok: false, why: "the line names no place at all" };
    // The place it names has to be on the page: a widget card the captain can act on.
    const cards = document.querySelectorAll("section.wd[data-widget-id]");
    return { ok: cards.length > 0, why: \`\${cards.length} widget card(s) on the page\` };
  })()`);
  ok(pointsSomewhereReal.ok, `and points at somewhere that is actually on this page (${pointsSomewhereReal.why})`);

  // With none on watch the original explanation is true again, so it comes back.
  const noMates = await app.eval(`(() => {
    paintDashboardSubtitle({ coordinators: [], assistant: null, projectSeats: [] });
    return document.getElementById("dashSubtitle")?.textContent || "";
  })()`);
  ok(/No first mate on watch/.test(noMates), "with none on watch, the old explanation is correct again and is used");

  // The kind that was MISSING gets its own assertion, because "every seat is named" passes
  // trivially on a fixture that happens to have only coordinators.
  const eachKind = await app.eval(`(() => {
    paintDashboardSubtitle({
      coordinators: [{ name: "Pool Seat" }],
      assistant: { name: "Standing Seat" },
      projectSeats: [{ name: "Project Seat" }],
    });
    return document.getElementById("dashSubtitle")?.textContent || "";
  })()`);
  for (const name of ["Standing Seat", "Pool Seat", "Project Seat"]) {
    ok(eachKind.includes(name), `a ${name.toLowerCase()} is named in the subtitle (${JSON.stringify(eachKind.slice(0, 90))})`);
  }

  // A BOARD BIGGER THAN THE NAME CAP, exercised on purpose: the real machine carries seven
  // seats, so the overflow branch is the normal case there and the untested one here. A line
  // that just stops at four is the wrong-set bug again, one cause further down.
  const manySeats = await app.eval(`(() => {
    paintDashboardSubtitle({
      coordinators: [{ name: "S1" }, { name: "S2" }, { name: "S3" }],
      assistant: { name: "S0" },
      projectSeats: [{ name: "S4" }, { name: "S5" }, { name: "S6" }],
    });
    return document.getElementById("dashSubtitle")?.textContent || "";
  })()`);
  // Plain includes, not a regex: these seven tokens are distinct and none is a substring of
  // another, and a hand-built word-boundary pattern inside a template literal is how the last
  // three measurements in this repo came out wrong.
  const manyNamed = ["S0", "S1", "S2", "S3", "S4", "S5", "S6"].filter((n) => manySeats.includes(n));
  const manyOverflow = Number((/and (\d+) more/.exec(manySeats) || [])[1] || 0);
  ok(
    manyNamed.length + manyOverflow === 7,
    `seven seats are all accounted for, named or counted (${manyNamed.length} + ${manyOverflow}) (${JSON.stringify(manySeats.slice(0, 90))})`
  );
  ok(manyOverflow > 0, `and the ones past the cap are COUNTED rather than dropped (${manyOverflow} more)`);

  // ---- 3 + 4. The quota widget names its window, and repaints on a reading --
  const quota = await app.eval(`(() => {
    const saved = state.quotaWindows;
    const fpBefore = widgetDashboardFingerprint();
    state.quotaWindows = [
      { at: Date.now(), info: { rateLimitType: "seven_day", utilization: 0.36, status: "allowed", resetsAt: Math.floor(Date.now()/1000) + 3600*30 } },
      { at: Date.now(), info: { rateLimitType: "five_hour", utilization: 0.10, status: "allowed", resetsAt: Math.floor(Date.now()/1000) + 3600 } },
    ];
    const host = document.createElement("div");
    host.append(widgetBodyQuota({ budget: null }));
    const text = host.textContent;
    const fpAfter = widgetDashboardFingerprint();
    state.quotaWindows = saved;
    return { text, fpMoved: fpBefore !== fpAfter };
  })()`);
  ok(/Weekly/.test(quota.text), `the headline NAMES the window it is reporting (${JSON.stringify(quota.text.slice(0, 40))})`);
  ok(/36%/.test(quota.text), "with its percentage");
  ok(/resets in/.test(quota.text), "and when it resets - the one thing the captain asked to see");
  ok(/5-hour limit/.test(quota.text), "while the other window is still listed below it");
  ok(!/^Quota 36%/.test(quota.text.trim()), "and never the bare 'Quota N%' written for the cramped top-bar chip");
  ok(quota.fpMoved, "a fresh quota reading changes the widget fingerprint, so the widget actually repaints");

  // ---- 5. The archive group's Review button can repaint --------------------
  const toggle = await app.eval(`(() => {
    const before = widgetDashboardFingerprint();
    dashboardArchiveGroupExpanded = !dashboardArchiveGroupExpanded;
    const after = widgetDashboardFingerprint();
    dashboardArchiveGroupExpanded = !dashboardArchiveGroupExpanded;
    const back = widgetDashboardFingerprint();
    return { moved: before !== after, restored: before === back };
  })()`);
  ok(toggle.moved, "expanding the archive group changes the fingerprint - which is what makes Review do something");
  ok(toggle.restored, "and collapsing it returns to the same fingerprint, so idle ticks stay free");

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
    ? "\nVERIFY OK: the composer grows and can be dragged, the subtitle matches the fleet under it, the quota widget names its window and its reset, and both a view toggle and a new reading repaint the widgets."
    : `\nVERIFY FAILED (${fails})`
);
process.exit(fails === 0 ? 0 : 1);
