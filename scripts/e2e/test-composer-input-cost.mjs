// "ibland laggar input till" (the captain, 2026-08-12).
//
// autoSizeComposer runs on every keystroke and used to begin by measuring the whole pane
// with getBoundingClientRect(). That is a FORCED SYNCHRONOUS LAYOUT - the browser has to
// lay out everything currently dirty before it can answer - and .pane contains the entire
// transcript. The pane's height is now tracked by a ResizeObserver instead.
//
// This check COUNTS the measurement rather than timing it, and that is deliberate. Timing
// it honestly turned out to be beyond what a synthetic loop can do here:
//   - performance.now() is clamped to 0.1ms in the renderer, so one keystroke is below the
//     clock;
//   - the pane has NO LAYOUT until the Chat page is visible, so an early version of this
//     file measured 0.00ms for the old code too and proved nothing;
//   - and batching keystrokes into a tight loop stops modelling typing at all - in that
//     shape, setting .value alone timed SLOWER than setting it AND dispatching the event,
//     which cannot be true. It was measurement ordering.
//
// A count cannot lie about any of that. One forced layout per keystroke is the defect; the
// assertion is that there is no longer one per keystroke.
//
// It launches the app, so it runs in the SLOW lane.
// Run:  node scripts/e2e/test-composer-input-cost.mjs
import { launch } from "./harness.mjs";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const KEYSTROKES = 30;

const app = await launch();
try {
  await app.waitForSelector(".pane .pane-composer textarea");
  await app.eval(`navigateToPage('chat')`);
  await new Promise((r) => setTimeout(r, 600));

  const built = await app.eval(`(() => {
    const scroll = document.querySelector('.pane .pane-scroll');
    scroll.innerHTML = '';
    for (let i = 0; i < 600; i++) {
      const wrap = document.createElement('div');
      wrap.className = 'turn ' + (i % 2 ? 'assistant' : 'user');
      wrap.dataset.turnFrom = String(i);
      const bubble = document.createElement('div');
      bubble.className = 'turn-bubble';
      bubble.textContent = 'Turn ' + i + ': ' + 'some reasonably long message text that wraps across a couple of lines in the chat column. '.repeat(3);
      wrap.append(bubble);
      scroll.append(wrap);
    }
    return { turns: scroll.children.length, scrollHeight: scroll.scrollHeight, paneHeight: document.querySelector('.pane').getBoundingClientRect().height };
  })()`);
  ok(
    built.paneHeight > 100 && built.scrollHeight > 1000,
    `the pane is genuinely laid out (pane ${Math.round(built.paneHeight)}px, transcript ${built.scrollHeight}px over ${built.turns} turns) - a hidden pane costs nothing to measure, which is how an earlier version of this check passed against the unfixed code`
  );

  const counted = await app.eval(`(() => {
    const pane = document.querySelector('.pane');
    const ta = document.querySelector('.pane .pane-composer textarea');
    ta.focus();
    ta.value = '';
    ta.dispatchEvent(new Event('input', { bubbles: true }));   // settle, and let any
                                                               // first-call fallback fill
                                                               // the observed height
    let paneMeasurements = 0;
    const original = pane.getBoundingClientRect.bind(pane);
    pane.getBoundingClientRect = function () { paneMeasurements++; return original(); };
    for (let i = 0; i < ${KEYSTROKES}; i++) {
      ta.value += 'x';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    pane.getBoundingClientRect = original;
    const grew = ta.getBoundingClientRect().height;
    ta.value = '';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return { paneMeasurements, grew };
  })()`);

  console.log(`      ${KEYSTROKES} keystrokes measured the pane ${counted.paneMeasurements} time(s)  (was once per keystroke)`);
  ok(
    counted.paneMeasurements === 0,
    `typing ${KEYSTROKES} characters does not measure the pane at all (${counted.paneMeasurements}) - every one of those was a forced layout over the whole transcript, and there used to be one per character`
  );

  // The resize must still WORK. A composer that stopped growing with the text would be a
  // straight regression of the feature this code is for ("just nu är det väldigt svårt att
  // se långa texter"), and it would make the count above pass for the wrong reason.
  const resize = await app.eval(`(() => {
    const ta = document.querySelector('.pane .pane-composer textarea');
    ta.value = '';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const before = ta.getBoundingClientRect().height;
    ta.value = Array.from({ length: 12 }, (_, i) => 'line ' + i).join('\\n');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const after = ta.getBoundingClientRect().height;
    ta.value = '';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const back = ta.getBoundingClientRect().height;
    return { before, after, back };
  })()`);
  console.log(`      composer height: ${resize.before.toFixed(0)}px -> ${resize.after.toFixed(0)}px (12 lines) -> ${resize.back.toFixed(0)}px (cleared)`);
  ok(resize.after > resize.before + 20, `the composer still grows with the text (${resize.before.toFixed(0)}px -> ${resize.after.toFixed(0)}px) - the saving must not come from having stopped resizing`);
  ok(Math.abs(resize.back - resize.before) < 2, "and shrinks back when the text is cleared, so the observed height is not a stale value being reused");
} finally {
  await app.close();
}

console.log(
  exit === 0
    ? "VERIFY OK: typing no longer forces a layout of the whole transcript, and the composer still sizes itself to the text."
    : "VERIFY FAILED."
);
process.exit(exit);
