// Jot 93835691 (Helm): "Stop knappen på en prompt verkar inte alltid fungera - kan
// ha att göra med när något tool körs, typ bash."
//
// Mechanism: main.js's session:stop handler force-kills the process tree
// (killChildTree, taskkill /T /F on Windows) and returns ok immediately, but the
// renderer only clears "Stopping…" once the CLI process's own "done" event
// arrives - and that event is only sent after Node's child_process "close" event
// fires, which waits for the child's stdio pipes to actually close. A descendant
// that inherited those pipes without itself being tracked in the killed tree (some
// shapes of a Bash-tool subprocess) can keep them open indefinitely even after the
// tree above it is dead - "close" then never fires, "done" never arrives, and the
// pane is stuck on "Stopping…" forever. That reads exactly like "Stop doesn't work."
//
// The fix (handleSendOrStop in renderer.js): once stopSession() reports the kill
// signal was delivered (res.ok), start a client-side watchdog. If no terminal event
// ("done" or "error") arrives for that launchId within the grace window, force the
// pane back to idle anyway - the kill was already issued as forcefully as this app
// can issue it, so there is nothing more to wait for. A real "done"/"error" that
// does eventually arrive clears the watchdog and is handled completely normally.
//
// Driving the actual race (a real hung child process) isn't practical here, so -
// same technique as test-reload-keeps-sent-prompt.mjs for the same class of
// event-handler-closure code - this asserts the mechanism directly against source.
//
// Run:  node scripts/e2e/test-stop-watchdog.mjs
import fs from "node:fs";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const src = fs.readFileSync(new URL("../../src/renderer/renderer.js", import.meta.url), "utf8");

ok(/pane\.stopWatchdogTimer = setTimeout\(/.test(src), "source: a successful stop arms a watchdog timer on the pane");
ok(
  /if \(panes\[index\] !== pane \|\| pane\.currentLaunchId !== launchId \|\| !pane\.busy\) {\s*\n\s*return; \/\/ a real "done"/.test(
    src
  ),
  "source: the watchdog no-ops if a real terminal event (or a fresh launch) already resolved this pane"
);
// Both terminal event kinds must cancel the watchdog, or a legitimate late "done"/
// "error" would race the forced fallback and risk firing both.
const clearSites = (src.match(/clearTimeout\(pane\.stopWatchdogTimer\);/g) || []).length;
ok(clearSites >= 3, `source: the watchdog is cleared everywhere a terminal event lands - armed once, cleared on "done" and on "error" (${clearSites} sites)`);
ok(
  /case "error":\s*\n(?:\s*\/\/.*\n)*\s*clearTimeout\(pane\.stopWatchdogTimer\);/.test(src),
  'source: the "error" branch clears the watchdog before doing anything else'
);
ok(
  /case "done":\s*\n\s*clearTimeout\(pane\.stopWatchdogTimer\);/.test(src),
  'source: the "done" branch clears the watchdog before doing anything else'
);
// The forced-idle fallback must actually restore the composer (busy/currentLaunchId/
// stopRequested cleared, busy UI reset) - a partial reset would leave the button
// looking idle but still functionally stuck.
ok(
  /pane\.busy = false;\s*\n\s*pane\.stopRequested = false;\s*\n\s*pane\.currentLaunchId = null;\s*\n\s*stopLiveStatsTicker\(index\);\s*\n\s*setPaneBusyUI\(index, ""\);\s*\n\s*pane\.turns\.push\(\{ role: "assistant", kind: "text", text: "⏹ Stopped \(still shutting down/.test(
    src
  ),
  "source: the forced fallback fully restores the composer, not just a partial reset"
);

console.log(
  exit === 0
    ? "VERIFY OK: a successful Stop always releases the pane's busy UI within the watchdog window, even if the underlying process's \"done\" event never arrives."
    : "VERIFY FAILED."
);
process.exit(exit);
