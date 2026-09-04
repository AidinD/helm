/**
 * A worker that loads, listens, and never says it is ready.
 *
 * Fixture for test-heavy-worker-fallback.mjs. It stands in for the real failure the design
 * has to survive: a utility process whose module graph does not load, which produces a live
 * child that answers nothing. Deliberately NOT a crash - a crash exits and takes the
 * ordinary exit path, which was already handled. This is the silent case that was not.
 */
process.parentPort.on("message", () => {
  // Swallow every job. If the fallback is working, nothing is ever sent here in the first
  // place - and if something is, answering would defeat the point of the fixture.
});
