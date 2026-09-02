// "att byta mellan vyer och sessioner [är långsamt]" (the captain, 2026-08-12).
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

  // COLD CACHE FIRST, before anything warms it. The queue cache lives in main-process
  // memory, so a freshly launched app always has none - and that is the case the Review
  // page's two-step render can get wrong. It asks for a cached payload, then asks for a
  // fresh one; when the cache is cold the FIRST call builds the whole queue anyway and
  // returns it unflagged, so an unconditional second call threw that away and built it
  // again. The first visit after launch - the slowest one, and the entire reason the
  // two-step render exists - paid for two full builds instead of one (found by review,
  // 2026-08-12). Counted here rather than timed, because the count cannot be flaky.
  // Read from the counter main carries on every payload. Two other ways were tried and do
  // not work here, both worth recording so nobody spends the time again: window.helm cannot
  // be stubbed (contextBridge makes it read-only, so the stub silently does nothing and the
  // count reads zero), and the slow-IPC log does not see it either, because 'reviews:list'
  // is async and that guard measures only a handler's synchronous span - which is now near
  // zero precisely because the build moved to the worker.
  await app.eval(`renderReviewPage()`);
  const builds = await app.eval(`window.helm.listReviews({ maxAgeMs: 3600000 }).then(r => r.builds)`);
  console.log(`      cold-cache Review render: ${builds} full queue build(s)`);
  ok(
    builds === 1,
    `a first Review visit on a cold cache costs exactly ONE full queue build (${builds}) - two means the expensive first render is paying twice for the same answer, which is what it did before this fix`
  );

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
    // SPLIT, because the total on its own cannot be acted on. Measured 2026-09-02: this
    // window is normally 0.2-0.4 ms for Dashboard and 8-19 ms for Archive, and it stayed
    // flat under 100% CPU on all cores right up to the point where the app stopped
    // responding at all. So when it reports 1000 ms, the interesting question is not "how
    // slow is a view switch" but WHICH HALF grew - and the two halves have different fixes.
    //
    // `nav` is the page's own synchronous JS: teardown plus DOM build. Note that
    // `await navigateToPage(...)` awaits a NON-promise (navigateToPage is not async), so
    // this half deliberately excludes any render work behind an await - which for Dashboard
    // is all five of its IPC calls. That is why a large number here can never be blamed on
    // the main process being busy: for these pages the main process is not in the window.
    //
    // `layout` is the forced reflow. On Archive it is already 3-6x the JS at rest, which is
    // what one row per archived session costs to lay out, and it is the half CSS
    // containment would attack.
    const split = await app.eval(`(async () => {
      const t0 = performance.now();
      await navigateToPage(${JSON.stringify(page)});
      const t1 = performance.now();
      // Force the layout the render queued, so the number is what the user waits for and
      // not just the JS that scheduled it.
      void document.body.offsetHeight;
      const t2 = performance.now();
      return { nav: t1 - t0, layout: t2 - t1, total: t2 - t0 };
    })()`);
    results[page] = split;
  }

  const rows = Object.entries(results).sort((a, b) => b[1].total - a[1].total);
  for (const [page, r] of rows) {
    console.log(`      ${page.padEnd(12)} ${r.total.toFixed(1)} ms   (js ${r.nav.toFixed(1)} + layout ${r.layout.toFixed(1)})`);
  }

  const worst = rows[0];
  // A loose ceiling on purpose. These numbers are genuinely noisy - the same page measured
  // 0.3ms and 291ms on two runs minutes apart, because a view switch competes with whatever
  // background work the app is doing at that moment. A tight threshold here would be a
  // flaky test, which is worse than none: it teaches you to re-run until it passes. The
  // ceiling is set where a real REGRESSION (a view that went back to blocking on IPC) would
  // still be caught.
  const worstSplit = worst[1];
  // The message names the half that grew, because that is the whole difference between a
  // finding and a mystery. A `js` blowup is the page building its own DOM too slowly and is
  // this app's fault. A `layout` blowup is reflow cost and scales with how much is on the
  // page. Both roughly flat while the total explodes means the renderer was stalled by
  // something outside the measured work - a stop-the-world garbage collection or the OS
  // descheduling the process - and NEITHER is a view-switch regression. That third case is
  // what the numbers recorded on 2026-09-01 look like, and reading them as slow view
  // switches sent two task cards off in the wrong direction.
  ok(
    worstSplit.total < 600,
    worstSplit.total < 600
      ? `the slowest SYNCHRONOUS view switch stays well under a second (${worst[0]} at ${worstSplit.total.toFixed(0)}ms)`
      : `${worst[0]} took ${worstSplit.total.toFixed(0)}ms: own JS ${worstSplit.nav.toFixed(1)}ms, forced layout ${worstSplit.layout.toFixed(1)}ms. ` +
        // By PROPORTION, not by an absolute millisecond cut-off. The first version of this
        // message used `> 200ms` and told a 25ms run that neither half accounted for it
        // while forced layout was 23.4 of those 25 - found by mutating the ceiling rather
        // than by reading the branch. A share works at any scale, which matters because the
        // whole point is to stay right when the total is 1000x the normal one.
        (worstSplit.nav / worstSplit.total > 0.6
          ? "The page's own DOM build is the cost - that is a real view-switch regression, in this app's render logic."
          : worstSplit.layout / worstSplit.total > 0.6
            ? "Forced reflow is the cost - look at how much this page puts on screen, not at the render logic. CSS containment attacks this half."
            : "NEITHER half dominates, so the renderer was stalled by something outside the measured work (a stop-the-world GC, or the OS descheduling it under load). Do not read this as a slow view switch, and do not raise the ceiling - capture a CDP trace with v8.gc and Layout events during a run that reproduces it.")
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
