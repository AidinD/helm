/**
 * When a mate's crew comes back, something has to say so.
 *
 * The case, from a real day: crew finished at 12:41 and again at 13:10, and nothing
 * told anybody. Helm knew both times - it writes the report in its own main process
 * the moment the run ends, and it sends a `dispatch:report` event.
 *
 * That event is NOT ignored, which is worth stating plainly because the first pass at
 * this concluded it was: a grep restricted to .js and .mjs missed preload.cjs and
 * produced a confident "nothing listens anywhere". Wrong. The preload bridges it and
 * the renderer subscribes. What the handler does is repaint the dashboard - and only
 * when the dashboard happens to be the page in front of you. So the signal arrives and
 * lands somewhere nobody is looking, which is a different fault with the same symptom.
 *
 * There were two halves to the silence, and both are pinned here.
 *
 * ONE. The toast for a session that needs input was suppressed whenever its mate had
 * any crew relationship at all - `mateCrewWait(...).has`, which is true for running
 * crew AND for crew that has finished. Correct while the crew is still going; exactly
 * wrong at the moment there is finally something to report.
 *
 * TWO, and the deeper one. A mate ends its turn while its crew is still running, so
 * the session settles into "waiting" long before the crew finishes. By the time the
 * crew comes back there is no session transition left to fire. The transition that
 * matters belongs to the CREW, not the session - so it needs watching on its own.
 *
 * The arrival costs nothing: no model is asked anything. That is what makes it safe
 * to fire every time, and it is why this step was worth doing before the triage step
 * that does cost.
 */
import fs from "node:fs";

let failures = 0;
const ok = (cond, label, detail = "") => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!cond) {
    failures += 1;
  }
};

const src = fs.readFileSync(new URL("../../src/renderer/renderer.js", import.meta.url), "utf8");
const slice = (marker, chars = 2600) => {
  const at = src.indexOf(marker);
  return at < 0 ? "" : src.slice(at, at + chars);
};

// --- half one: stop suppressing the toast once the crew has finished --------------
{
  const region = slice("Detect sessions newly transitioning INTO the needs-you");
  ok(/!mateCrewWait\(firstMateForSession\(session\)\)\.live/.test(region), "the toast is suppressed only while crew is LIVE");
  ok(
    !/!mateCrewWait\(firstMateForSession\(session\)\)\.has\b/.test(region),
    "and no longer while it merely HAS crew, finished or not"
  );
}

// --- half two: watch the crew's own transition ------------------------------------
{
  ok(/let matesWithLiveCrew = new Set\(\)/.test(src), "the previous poll's live crew is remembered");
  // Measured across 49 real crew runs: 7 came from a first mate, 42 from second mates and
  // bare session ids. Keying on the bound first mates covered a seventh of the traffic -
  // and the first-mate tier is the one the 2026-08-16 direction decision puts on notice,
  // while project seats are what survives it. So the watch is keyed on the id in the run
  // record, which every dispatcher has.
  ok(
    /new Set\(\[\.\.\.goalRuns\.values\(\)\]\.map\(\(r\) => r\.dispatchedBy\)\.filter\(Boolean\)\)/.test(src),
    "every dispatcher is watched, not only the bound first mates"
  );
  ok(!/for \(const mate of activeMatesForBinding\)/.test(src), "the first-mate-only loop is gone");
  ok(/function crewWaitFor\(ownerId\)/.test(src), "and the crew-wait question takes a plain dispatcher id");

  const region = slice("Crew that has just SETTLED");
  ok(region.length > 0, "the poll looks for crew that has just settled");
  ok(/matesWithLiveCrew\.add\(ownerId\)/.test(region), "a dispatcher with running crew is remembered as such");
  ok(/const wasLive = matesWithLiveCrew\.delete\(ownerId\)/.test(region), "and the transition out of that is what is detected");
  ok(
    /if \(wasLive && \(wait\.reports \|\| wait\.alarm\)\)/.test(region),
    "it fires on live -> finished, so a mate that never had crew stays quiet"
  );
  ok(/notifyAttention\(notice\)/.test(region), "and it actually notifies");
  // The OS toast is gated on the window NOT being focused (main.js attention:notify),
  // so on its own it says nothing at all while he is looking straight at Helm - which
  // is a likely moment for crew to come back. The in-app notice is what covers that,
  // and it is the same pair a failed goal run already fires.
  ok(/showNotice\(/.test(region), "and posts an in-app notice too, which the focus gate cannot swallow");
  ok(/navigateToPage\("dashboard"\)/.test(region), "with somewhere to go from it");
}

// --- it must stay free -------------------------------------------------------------
{
  const fn = src.slice(src.indexOf("function crewSettledNotice("));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
  ok(body.length > 0, "crewSettledNotice exists");
  // The whole reason this step comes before the triage step: no model, no cost, so it
  // can fire on every arrival without anybody weighing whether it was worth it.
  ok(!/invoke\(|startSession|runRelayTurn|claude/i.test(body), "it asks no model anything - the arrival is free", body.slice(0, 60));
  ok(/wait\.alarm/.test(body), "it says whether the crew came back with a problem");
  ok(/nobody has read the report yet/.test(body), "and otherwise that something is waiting to be read");
  // A second mate and a bare session id have no display name - "sm_d0f280be8b39 finished"
  // tells nobody anything - so the notice names the PROJECT the runs touched.
  ok(/projects\.slice\(0, 2\)/.test(body), "it names the project rather than the dispatcher's id");
  // The separator class must contain BOTH, and it is written here as a literal because a
  // heredoc ate the backslash once already and left it splitting forward slashes only -
  // which on Windows paths means the label was the entire path.
  // Checked by RUNNING the expression rather than matching its text: the escaping is
  // exactly what went wrong (a heredoc ate the backslash and left it splitting forward
  // slashes only, so on a Windows path the label became the whole path), and a regex that
  // matches a regex is the last place to trust an eyeballed escape.
  const labelExpr = body.match(/const label = \(r\) => (.+);/);
  ok(labelExpr !== null, "the label expression is findable");
  if (labelExpr) {
    const label = new Function("r", `return ${labelExpr[1]};`);
    ok(label({ projectPath: "D:\\Repo\\Tools\\tend" }) === "tend", "a Windows path yields the project name, not the whole path");
    ok(label({ projectPath: "D:/Repo/Tools/helm" }) === "helm", "and a forward-slash path still works");
    ok(label({ projectPath: null }) === null, "and a missing path yields nothing rather than throwing");
  }
}

// --- why the existing event was not enough ----------------------------------------
// There IS a dispatch:report event, it IS bridged by the preload, and the renderer DOES
// subscribe to it. That is worth pinning, because it is easy to look at the four
// send() calls in main.js, grep the wrong file extensions, and conclude the signal goes
// nowhere. It does not go nowhere. It goes somewhere useless: the handler repaints the
// dashboard, and only if the dashboard happens to be the visible page.
{
  const main = fs.readFileSync(new URL("../../src/main.js", import.meta.url), "utf8");
  ok((main.match(/send\("dispatch:report"/g) || []).length >= 2, "main.js sends dispatch:report");

  const preload = fs.readFileSync(new URL("../../src/preload.cjs", import.meta.url), "utf8");
  ok(/onDispatchReport:/.test(preload), "the preload bridges it");

  const at = src.indexOf("window.helm.onDispatchReport?.(");
  ok(at > 0, "and the renderer subscribes");
  const handler = src.slice(at, at + 240);
  ok(/refreshDashboardIfVisible/.test(handler), "but its handler only repaints a view");
  ok(
    !/notifyAttention/.test(handler),
    "and raises no attention signal - which is why finished crew needs detecting on its own"
  );
}

console.log("");
if (failures > 0) {
  console.log(`VERIFY FAILED: ${failures} assertion(s)`);
  process.exit(1);
}
console.log("VERIFY OK: finished crew announces itself, costs nothing, and stays quiet while the crew is still running.");
