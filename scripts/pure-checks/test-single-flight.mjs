/**
 * A caller that has just written something must not be handed an answer that predates it.
 *
 * The review queue single-flights its build: one at a time, and concurrent callers join the
 * running one. That join used to be unconditional, which is correct for two readers arriving
 * together and wrong for a writer - it receives the result of a build that started before its
 * write and cannot contain it. In the app that was "I ran the checks and the result vanished".
 *
 * These are deterministic: the build is a manually-released promise, so there is no sleeping
 * and no timing luck deciding whether the test passes.
 */
import { createSingleFlight } from "../../src/lib/singleFlight.js";

let failures = 0;
const ok = (cond, label, detail = "") => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!cond) {
    failures += 1;
  }
};

/** A build that finishes only when the test says so, so ordering is exact rather than likely. */
function gate() {
  let release;
  const promise = new Promise((res) => {
    release = res;
  });
  return { promise, release: (v) => release(v) };
}

// --- 1. two readers with the same inputs share one build -------------------------------
{
  let builds = 0;
  const g = gate();
  let state = "v1";
  const flight = createSingleFlight({
    fingerprint: () => state,
    run: async () => {
      builds += 1;
      return g.promise;
    },
  });

  const a = flight();
  const b = flight(); // arrives mid-build, nothing changed
  g.release("payload-v1");
  const [ra, rb] = await Promise.all([a, b]);

  ok(builds === 1, "two readers arriving together run ONE build", `builds=${builds}`);
  ok(ra === "payload-v1" && rb === "payload-v1", "and both get it", `${ra} / ${rb}`);
}

// --- 2. a writer does NOT get the pre-write build --------------------------------------
// This is the regression. With an unconditional join, `b` below resolves to "payload-v1".
{
  let builds = 0;
  const gates = [gate(), gate()];
  let state = "v1";
  const flight = createSingleFlight({
    fingerprint: () => state,
    run: async () => {
      const g = gates[builds];
      builds += 1;
      return g.promise;
    },
  });

  const a = flight(); // build 1 starts, fingerprint "v1"
  state = "v2"; // ...and now something is written
  const b = flight(); // this caller must not be served build 1

  gates[0].release("payload-v1");
  const ra = await a;
  // Build 2 is only started once build 1 releases the slot, so let it settle first.
  await Promise.resolve();
  gates[1].release("payload-v2");
  const rb = await b;

  ok(ra === "payload-v1", "the caller that started the first build still gets it", `${ra}`);
  ok(rb === "payload-v2", "the caller that arrived AFTER the write gets the newer build", `${rb}`);
  ok(builds === 2, "which means a second build ran", `builds=${builds}`);
}

// --- 3. only one build at a time, even across a waiting writer --------------------------
{
  let concurrent = 0;
  let maxConcurrent = 0;
  const gates = [gate(), gate(), gate()];
  let state = "v1";
  let started = 0;
  const flight = createSingleFlight({
    fingerprint: () => state,
    run: async () => {
      const g = gates[started];
      started += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const out = await g.promise;
      concurrent -= 1;
      return out;
    },
  });

  const a = flight();
  state = "v2";
  const b = flight();
  state = "v3";
  const c = flight();

  gates[0].release("p1");
  await a;
  await new Promise((r) => setTimeout(r, 0));
  gates[1].release("p2");
  await new Promise((r) => setTimeout(r, 0));
  gates[2].release("p3");
  await Promise.all([b, c]);

  ok(maxConcurrent === 1, "never two builds running at once", `max=${maxConcurrent}`);
}

// --- 4. an unreadable fingerprint counts as CHANGED, not as unchanged -------------------
{
  let builds = 0;
  const gates = [gate(), gate()];
  const flight = createSingleFlight({
    fingerprint: () => null, // "could not read the inputs"
    run: async () => {
      const g = gates[builds];
      builds += 1;
      return g.promise;
    },
  });

  const a = flight();
  const b = flight();
  gates[0].release("p1");
  await a;
  await Promise.resolve();
  gates[1].release("p2");
  const rb = await b;

  ok(builds === 2, "'cannot tell' does not read as 'unchanged'", `builds=${builds}`);
  ok(rb === "p2", "so the second caller is not served the older answer", `${rb}`);
}

// --- 5. a failed build releases the slot instead of wedging the queue -------------------
{
  const gates = [gate(), gate()];
  let builds = 0;
  let state = "v1";
  const flight = createSingleFlight({
    fingerprint: () => state,
    run: async () => {
      const i = builds;
      builds += 1;
      await gates[i].promise;
      if (i === 0) {
        throw new Error("build blew up");
      }
      return "p2";
    },
  });

  const a = flight();
  state = "v2";
  const b = flight();
  const aFailed = a.then(
    () => false,
    () => true
  );
  gates[0].release();
  ok(await aFailed, "a failing build rejects for its own caller");
  await new Promise((r) => setTimeout(r, 0));
  gates[1].release();
  ok((await b) === "p2", "and the next caller still gets a fresh build, not the failure");
}

// --- 6. a stream of writers cannot starve a reader forever ------------------------------
{
  let state = 0;
  let builds = 0;
  // Every fingerprint read reports something new, which is the pathological case: without a
  // bound the loop would yield the slot forever and the caller would never be answered.
  const flight = createSingleFlight({
    fingerprint: () => `v${state++}`,
    run: async () => {
      builds += 1;
      return "eventually";
    },
    maxWaits: 3,
  });

  const answered = await Promise.race([
    flight(),
    new Promise((r) => setTimeout(() => r("NEVER ANSWERED"), 500)),
  ]);
  ok(answered === "eventually", "a reader is answered even while the inputs keep moving", `${answered}`);
  ok(builds === 1, "and it did not spin up a pile of builds getting there", `builds=${builds}`);
}

console.log("");
if (failures > 0) {
  console.log(`VERIFY FAILED: ${failures} assertion(s)`);
  process.exit(1);
}
console.log("VERIFY OK: a caller that just wrote something is never served a build that predates it.");
