// The prompt box is resized by dragging its top edge.
//
// the captain, task dce9946c: "kan vi göra promptrutan dragbar för storleken istället för grejen i
// vänstra hörnet". The old way was the textarea's own native corner grip - a small target in a
// corner - and the size it produced was INFERRED afterwards, by noticing on every mouseup that
// the height no longer matched what autoSizeComposer had set. Two mechanisms deciding one
// number, one of them by guesswork.
//
// Now the handle sets the height while dragging, and there is nothing to infer.
//
// Run:  node scripts/e2e/test-composer-grip.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-grip-"));
process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9510";
const { launch } = await import("./harness.mjs");

try {
  app = await launch();
  await app.waitForSelector("#pageToggle", 30000, { visible: true });

  const res = await app.eval(`(async () => {
    navigateToPage("chat");
    openFreshDraftInPane(${JSON.stringify(tmp.replace(/\\/g, "\\\\"))}, "", { forceIndex: 0 });
    await new Promise((r) => setTimeout(r, 400));
    const paneEl = document.querySelector('.pane[data-pane="0"]');
    const grip = paneEl.querySelector(".composer-grip");
    const promptEl = paneEl.querySelector(".pane-composer textarea");
    if (!grip) {
      return { missing: true };
    }
    const startH = promptEl.getBoundingClientRect().height;
    const box = grip.getBoundingClientRect();
    const cursor = getComputedStyle(grip).cursor;
    const resizeProp = getComputedStyle(promptEl).resize;

    // Drag UP by 120px. Pointer events with capture, exactly as the handler wires them.
    const send = (type, y) => {
      grip.dispatchEvent(new PointerEvent(type, { pointerId: 1, clientX: box.x + box.width / 2, clientY: y, bubbles: true, cancelable: true }));
    };
    const y0 = box.y + box.height / 2;
    send("pointerdown", y0);
    send("pointermove", y0 - 120);
    const grownH = promptEl.getBoundingClientRect().height;
    const grownField = panes[0].composerHeight;
    const draggingClass = grip.classList.contains("dragging");
    send("pointerup", y0 - 120);
    const releasedClass = grip.classList.contains("dragging");

    // Dragging DOWN again must shrink it - and not below the floor.
    const box2 = grip.getBoundingClientRect();
    const y1 = box2.y + box2.height / 2;
    send("pointerdown", y1);
    send("pointermove", y1 + 4000); // far past any sane minimum
    const flooredH = promptEl.getBoundingClientRect().height;
    send("pointerup", y1 + 4000);

    // Up beyond the pane's own height must be capped, or the composer eats the transcript.
    const box3 = grip.getBoundingClientRect();
    const y2 = box3.y + box3.height / 2;
    send("pointerdown", y2);
    send("pointermove", y2 - 4000);
    const cappedH = promptEl.getBoundingClientRect().height;
    send("pointerup", y2 - 4000);
    const paneH = paneEl.getBoundingClientRect().height;

    // A streaming render rebuilds the composer; the size must survive that.
    panes[0].composerHeight = 220;
    renderSinglePane(0);
    await new Promise((r) => setTimeout(r, 300));
    const afterRender = document.querySelector('.pane[data-pane="0"] .pane-composer textarea').getBoundingClientRect().height;

    // Double-click gives the size back to the text.
    const grip2 = document.querySelector('.pane[data-pane="0"] .composer-grip');
    grip2.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    const afterReset = {
      field: panes[0].composerHeight,
      height: document.querySelector('.pane[data-pane="0"] .pane-composer textarea').getBoundingClientRect().height,
    };

    return { startH, grownH, grownField, draggingClass, releasedClass, flooredH, cappedH, paneH, afterRender, afterReset, cursor, resizeProp };
  })()`);

  ok(!res.missing, "the composer has a resize handle on its top edge");
  ok(res.resizeProp === "none", `the textarea's own native corner grip is gone (resize: ${res.resizeProp})`);
  ok(res.cursor === "ns-resize", `the handle says what it does (cursor: ${res.cursor})`);
  ok(res.grownH > res.startH + 100, `dragging UP grows the box (${Math.round(res.startH)} -> ${Math.round(res.grownH)}px)`);
  ok(res.grownField === Math.round(res.grownH), `and the size is recorded on the pane as it happens, not inferred afterwards (${res.grownField})`);
  ok(res.draggingClass === true && res.releasedClass === false, "the handle shows it is being dragged, and stops when released");
  ok(res.flooredH < res.grownH && res.flooredH >= 30, `dragging DOWN shrinks it but not below a usable floor (${Math.round(res.flooredH)}px)`);
  ok(res.cappedH <= res.paneH * 0.9, `dragging far up is capped so the composer cannot swallow the transcript (${Math.round(res.cappedH)}px of ${Math.round(res.paneH)}px)`);
  ok(Math.abs(res.afterRender - 220) <= 2, `the size survives the composer being rebuilt by a render (${Math.round(res.afterRender)}px)`);
  ok(res.afterReset.field === 0 && res.afterReset.height < 220, `double-click hands the size back to the text (${Math.round(res.afterReset.height)}px)`);

  const errors = app.getConsoleErrors();
  ok(errors.length === 0, `no console errors (${errors.length})`);
  for (const e of errors.slice(0, 5)) {
    console.log("   ", e.text.slice(0, 160));
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
    ? "VERIFY OK: the composer resizes by its top edge, records the size as it drags, clamps both ways, survives a render, and resets on double-click."
    : "VERIFY FAILED."
);
process.exit(exit);
