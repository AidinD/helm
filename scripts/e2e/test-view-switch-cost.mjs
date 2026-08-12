// "att byta mellan vyer och sessioner [är långsamt]" (Aidin, 2026-08-12).
//
// Every page render tears its page down (innerHTML = "") and rebuilds it, and several
// AWAIT main-process work before painting anything at all. The Review page was the worst:
// it waited on a queue build that cost ~2.2s of blocked main process.
//
// Phases 1 and 2 attacked that from the other end - the build is cached on its real inputs
// and now runs off the main process entirely - so this measures what is actually left, in
// the running app, rather than assuming the renderer still needs restructuring.
//
// It launches the app, so it runs in the SLOW lane.
// Run:  node scripts/e2e/test-view-switch-cost.mjs
import { launch } from "./harness.mjs";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const PAGES = ["dashboard", "goal", "review", "routines", "analysis", "settings", "archive", "chat"];

const app = await launch();
try {
  await app.waitForSelector("#pageToggle");
  // Warm every page once: the first visit to each pays one-off work (fetching the review
  // queue, the skills list) that is not what "switching views" costs in daily use.
  for (const page of PAGES) {
    await app.eval(`navigateToPage(${JSON.stringify(page)})`);
    await new Promise((r) => setTimeout(r, 400));
  }

  const results = {};
  for (const page of PAGES) {
    // Away and back, so each measurement is a real switch INTO the page.
    await app.eval(`navigateToPage('dashboard')`);
    await new Promise((r) => setTimeout(r, 150));
    const ms = await app.eval(`(async () => {
      const t0 = performance.now();
      await navigateToPage(${JSON.stringify(page)});
      // Force the layout the render queued, so the number is what the user waits for and
      // not just the JS that scheduled it.
      void document.body.offsetHeight;
      return performance.now() - t0;
    })()`);
    results[page] = ms;
  }

  const rows = Object.entries(results).sort((a, b) => b[1] - a[1]);
  for (const [page, ms] of rows) {
    console.log(`      ${page.padEnd(12)} ${ms.toFixed(1)} ms`);
  }

  const worst = rows[0];
  // A loose ceiling on purpose. These numbers are genuinely noisy - the same page measured
  // 0.3ms and 291ms on two runs minutes apart, because a view switch competes with whatever
  // background work the app is doing at that moment. A tight threshold here would be a
  // flaky test, which is worse than none: it teaches you to re-run until it passes. The
  // ceiling is set where a real REGRESSION (a view that went back to blocking on IPC) would
  // still be caught.
  ok(
    worst[1] < 600,
    `the slowest SYNCHRONOUS view switch stays well under a second (${worst[0]} at ${worst[1].toFixed(0)}ms)`
  );

  // The numbers above are the SYNCHRONOUS part only. navigateToPage is not async, so for a
  // page that fetches before it paints (Review, Analysis) it returns while the old content
  // is still on screen - which would flatter exactly the page that used to be the worst.
  // So Review is timed properly: from the click to its rows actually being on screen.
  //
  // This is the page that waited on a ~2.2s main-process queue build before phase 1 cached
  // it on its real inputs and phase 2 moved it off the main thread.
  await app.eval(`navigateToPage('dashboard')`);
  await new Promise((r) => setTimeout(r, 200));
  const reviewToContent = await app.eval(`(async () => {
    const page = document.getElementById('reviewPage');
    // Empty it first, so "has content" unambiguously means THIS render produced it and not
    // that the previous visit's DOM was still lying around (which is what made an earlier
    // version of this measurement meaningless).
    page.replaceChildren();
    const t0 = performance.now();
    navigateToPage('review');
    let ms = null;
    while (performance.now() - t0 < 8000) {
      if (page.childElementCount > 0) { ms = performance.now() - t0; break; }
      await new Promise(r => setTimeout(r, 2));
    }
    void document.body.offsetHeight;
    return { ms: ms === null ? performance.now() - t0 : ms, elements: page.childElementCount, timedOut: ms === null };
  })()`);
  console.log(`      review, click to FIRST PAINT: ${reviewToContent.ms.toFixed(0)} ms (${reviewToContent.elements} elements)`);
  ok(reviewToContent.elements > 0, "the Review page really did paint something, so the timing above is of something");
  ok(
    reviewToContent.ms < 500,
    `the Review page paints within 500ms of the click (${reviewToContent.ms.toFixed(0)}ms) - it used to show nothing at all until a multi-second build finished`
  );

  // First paint is only worth having if the real queue then ARRIVES. A page that shows a
  // heading and never fills in is worse than one that was honestly slow - it looks done.
  const settled = await app.eval(`(async () => {
    const page = document.getElementById('reviewPage');
    const t0 = performance.now();
    while (performance.now() - t0 < 30000) {
      // The filter bar only exists on the real queue, never on the placeholder.
      if (page.querySelector('.rev-filters, .review-empty')) {
        return { ms: performance.now() - t0, children: page.childElementCount, real: true };
      }
      await new Promise(r => setTimeout(r, 25));
    }
    return { ms: performance.now() - t0, children: page.childElementCount, real: false };
  })()`);
  // That duration is NOT asserted, and the number it prints will look alarming. Read it
  // with the harness in mind: every E2E run gets a FRESH temp config (see harness.mjs), so
  // no project's commit baseline is stored yet and the build establishes all ~16 of them
  // from scratch. A real profile has them persisted and takes a fraction of it - and since
  // phase 2 the whole build runs off the main process either way, so however long it takes,
  // it is not holding the app still. What matters, and what IS asserted, is that the
  // placeholder is eventually replaced.
  console.log(`      review, placeholder replaced by the real queue after: ${settled.ms.toFixed(0)} ms (${settled.children} elements)`);
  console.log(`      (a fresh E2E profile builds every commit baseline from scratch - this is not what a real profile pays)`);
  ok(settled.real, `the placeholder is replaced by the real queue (${settled.children} elements) - a first paint that never fills in would look finished while showing nothing`);
} finally {
  await app.close();
}

console.log(exit === 0 ? "VERIFY OK: switching views is responsive." : "VERIFY FAILED.");
process.exit(exit);
