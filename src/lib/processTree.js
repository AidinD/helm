import { execFile, execFileSync } from "node:child_process";

// child.kill() only signals the top-level claude.exe - it does NOT kill the
// process tree. claude.exe spawns its own children (the model runtime, any
// MCP servers, Task-tool subagents), and on Windows those are not
// automatically terminated when their parent dies. Left running, they keep
// executing (and consuming subscription usage) after a Stop click or even
// after Helm itself quits. `taskkill /T` recurses through the whole tree.
// `sync: true` runs the kill synchronously - required from the "before-quit"
// sweep, where an async execFile would very likely lose the race against the
// process actually exiting (nothing awaits it, so the app tears down before
// the async taskkill has run, leaving exactly the orphaned tree this is
// meant to prevent). The Stop-button path uses the default async form since
// the app keeps running there and blocking the main thread is pointless.
//
// MOVED OUT OF main.js 2026-08-28, behaviour unchanged, because a second caller needed it
// and could not reach it: compactSession in orchestratorHelper.js was calling the bare
// child.kill() on its timeout. So a compaction that ran past the deadline had its
// top-level process killed while the actual work carried on underneath - the run
// completed, wrote its boundary and spent the tokens, with Helm believing it had failed
// and retrying fifteen minutes later. Copying the function would have made this the third
// place the rule lives; one home, two importers.
export function killChildTree(child, { sync = false } = {}) {
  if (!child || child.killed || !child.pid) {
    return;
  }
  if (process.platform === "win32") {
    const args = ["/pid", String(child.pid), "/T", "/F"];
    if (sync) {
      try {
        execFileSync("taskkill", args, { stdio: "ignore" });
      } catch {
        // Process may have already exited on its own - taskkill then reports
        // an error, which is fine and nothing to act on.
      }
      return;
    }
    execFile("taskkill", args, (err) => {
      if (err) {
        // Best-effort: the process may have already exited on its own
        // between the check above and this call, which taskkill reports as
        // an error - nothing more useful to do with it here.
        console.error(`[helm] taskkill failed for pid ${child.pid}:`, err.message);
      }
    });
    return;
  }
  child.kill();
}
