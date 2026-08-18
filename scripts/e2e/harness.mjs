// Reusable Electron E2E harness driven by the Chrome DevTools Protocol (CDP).
//
// Helm is a native Electron app with no browser-servable dev server, so the
// standard preview_* / browser tooling can't drive it. This harness launches an
// Electron app with `--remote-debugging-port`, connects to its renderer target
// over CDP, and exposes a tiny, obvious automation API (eval/click/type/getText/
// waitForSelector/screenshot/getConsole) so an agent or a human can script and
// SCREENSHOT the running UI end to end.
//
// Transport: raw WebSocket + the CDP JSON endpoint (http://127.0.0.1:<port>/json).
// Node 18+ ships a global `WebSocket` and `fetch`, so this needs ZERO npm
// dependencies — the most robust option on Windows (no native build, nothing to
// install). See DECISIONS.md for why raw-WS over chrome-remote-interface.
//
// Cleanup contract: this harness terminates ONLY the app instance it launched,
// matched by the per-run --user-data-dir it was launched with (see
// killByUserDataDir). It NEVER kills electron.exe machine-wide — that would take
// down Halyard or the user's own Helm. A stray instance left running is a real
// failure, so every exit path from launch() cleans up, not just close().
//
// Usage (see demo.mjs for a full example):
//   import { launch } from "./harness.mjs";
//   const app = await launch();              // launches THIS Helm repo
//   await app.waitForSelector("#pageToggle");
//   await app.screenshot("out.png");
//   await app.close();

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/e2e/ -> repo root is two levels up.
const REPO_ROOT = path.resolve(__dirname, "..", "..");

/**
 * Launch an Electron app with remote debugging enabled and connect over CDP.
 *
 * @param {object} [opts]
 * @param {string} [opts.appDir]   Directory of the Electron app to launch. The
 *   cleanup match is derived from this path, so pointing it at another app dir
 *   (jot/loom) is all that's needed to reuse the harness there. Default: this
 *   Helm repo.
 * @param {string} [opts.command]  Executable to spawn. Default: "npm".
 * @param {string[]} [opts.args]   Base args for the command. The
 *   --remote-debugging-port flag is appended (after "--" for npm so it reaches
 *   electron, not npm). Default: ["start"].
 * @param {number} [opts.port]     PREFERRED remote debugging port. Default: 9333.
 *   If it is already taken the launch still succeeds on an ephemeral port; the
 *   app is located through its own DevToolsActivePort, so `harness.port` is the
 *   port that was actually bound, which may not be this one.
 * @param {number} [opts.readyTimeoutMs]  How long to wait for a renderer target
 *   to appear on the CDP endpoint. Default: 30000.
 * @returns {Promise<Harness>}
 */
export async function launch(opts = {}) {
  const appDir = opts.appDir || REPO_ROOT;
  const command = opts.command || "npm";
  const baseArgs = opts.args || ["start"];
  // A PREFERENCE, not a requirement. Two harnesses wanting one port used to be a
  // silent disaster: the second app can't bind it, so the harness attached to the
  // FIRST app's renderer and drove the wrong window. That happens for real - the
  // review-page gauntlet runs an E2E script as a check, from inside a Helm a
  // harness already launched - which is why HELM_E2E_PORT exists to hand children
  // a different number. It is now a hint rather than the identity mechanism (see
  // resolveDebugPort / waitForOwnDebugPort): a taken port costs an ephemeral one,
  // not a wrong attach. The default stays 9333 so an interactive
  // `node scripts/e2e/foo.mjs` is still predictable to attach to.
  const requestedPort = opts.port || Number(process.env.HELM_E2E_PORT) || 9333;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 30000;

  // Electron's userData dir is derived from the app NAME, so a test run and the
  // INSTALLED Helm both resolve to %APPDATA%\helm and write the same window state,
  // localStorage and cookies at the same time. The captain noticed it live (2026-08-03):
  // his Helm was open while a suite ran, both pointed at that one directory. That is
  // both a source of flakiness (a test reads state its own app never wrote) and a
  // way for a throwaway run to change the app he actually uses. A per-run directory
  // costs nothing and removes the shared writer entirely.
  const swept = await sweepAbandonedRuns();
  if (swept.killed.length > 0) {
    console.warn(
      `[e2e-harness] reaped ${swept.killed.length} process(es) left over from earlier E2E runs (pid ${swept.killed.join(", ")})`
    );
  }
  const userDataTmpDir = makeOwnedTmpDir(USERDATA_PREFIX);
  const userDataFlag = `--user-data-dir=${userDataTmpDir}`;

  // Isolate config.json so E2E runs never write their throwaway test sessions
  // into the real dev-repo config.json. config.js already honors HELM_CONFIG_PATH
  // (a packaged-app/test seam), but tests only ever set the meta-home/mates/
  // second-mates seams - so config.json defaulted to the repo root and every run
  // that started a session appended a junk helmSessions entry (~36 accumulated,
  // all temp-dir cwds). Default it to a throwaway file here (honoring a test's own
  // override if it set one), and clean it up in close(). Belongs in the harness,
  // not each test, so ALL current and future E2Es are isolated automatically.
  const env = { ...process.env };
  let configTmpDir = null;
  if (!env.HELM_CONFIG_PATH) {
    configTmpDir = makeOwnedTmpDir(CONFIG_PREFIX);
    env.HELM_CONFIG_PATH = path.join(configTmpDir, "config.json");
  }

  // Never launch onto a debug port somebody else is already serving. Chromium
  // does not fail when it cannot bind one - it logs "Cannot start http server
  // for devtools" and runs on, headless of any debugger. The harness then found
  // the OTHER app's target on /json/list and drove that instead, while the app it
  // had just spawned sat there invisible and unclosable. Verified 2026-08-18 by
  // launching two instances on one port: exactly one page target, and the second
  // instance's profile was left in temp after the first one's close().
  const { port, note: portNote } = await resolveDebugPort(requestedPort);
  if (portNote) {
    console.warn(`[e2e-harness] ${portNote}`);
  }

  // The debug flag must reach electron. For `npm start` (which runs
  // `electron .`), npm forwards args after a literal "--" to the script.
  const debugFlag = `--remote-debugging-port=${port}`;
  const args =
    command === "npm"
      ? [...baseArgs, "--", debugFlag, userDataFlag]
      : [...baseArgs, debugFlag, userDataFlag];

  const child = spawn(command, args, {
    cwd: appDir,
    shell: true, // resolve npm.cmd / electron.cmd shims on Windows
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (c) => stdout.push(c.toString("utf8")));
  child.stderr.on("data", (c) => stderr.push(c.toString("utf8")));

  // EVERY failure between here and `return harness` used to leak the whole
  // launch: the caller gets an exception instead of a handle, so its
  // `finally { await app?.close() }` has nothing to close, and the Electron this
  // function spawned runs forever. That is the single biggest way a stray gets
  // made - a 30s ready-timeout on a slow cold start leaves a fully live Helm
  // behind, which then holds the port for the next run and spawns E2E children
  // of its own through the review gauntlet.
  try {
    // Which port Electron ACTUALLY bound, read out of our own profile directory.
    // Chromium writes DevToolsActivePort there, so its presence is proof that the
    // debugger belongs to the app WE launched and not to a stranger on the same
    // port - the identity check the port number alone could never give.
    const boundPort = await waitForOwnDebugPort(userDataTmpDir, child, readyTimeoutMs);
    const target = await waitForRendererTarget(boundPort, readyTimeoutMs, child);
    const cdp = await connectCdp(target.webSocketDebuggerUrl);
    const harness = new Harness({
      child,
      cdp,
      port: boundPort,
      appDir,
      stdout,
      stderr,
      configTmpDir,
      userDataTmpDir,
    });
    await harness._init();
    return harness;
  } catch (err) {
    await abandonLaunch({ child, userDataTmpDir, configTmpDir });
    err.message = `${err.message}\n[e2e-harness] launch failed; the instance it spawned was killed and its temp directories removed.${
      stderr.length ? `\n--- app stderr (tail) ---\n${stderr.join("").slice(-1200)}` : ""
    }`;
    throw err;
  }
}

const USERDATA_PREFIX = "helm-e2e-userdata-";
const CONFIG_PREFIX = "helm-e2e-config-";
// Written beside every per-run temp directory so a later sweep can ask "is the run
// that made this still alive?" instead of guessing from the clock. See ownerPath
// for why beside and not inside.
const OWNER_SUFFIX = ".owner.json";
// Only used for directories with NO owner marker (made before this existed, or by
// a launch that died between mkdtemp and the marker write).
const UNOWNED_STALE_MS = 60 * 60 * 1000;

/**
 * Is this path a directory THIS harness could have created - one of our prefixes,
 * sitting directly in the system temp directory?
 *
 * The single gate in front of everything destructive here (killing a process tree,
 * deleting a directory tree). Some of those paths are parsed out of ANOTHER
 * process's command line, so the prefix on its own is a check on data we do not
 * control; anchoring to os.tmpdir() as well means no reachable input can name a
 * path outside the one scratch area E2E runs are allowed to touch. The rule this
 * serves is CLAUDE.md's: a kill or a delete that can reach past its own litter has
 * already gone wrong once in this project.
 */
function isPerRunTmpDir(dir, prefix) {
  if (!dir || typeof dir !== "string") {
    return false;
  }
  const resolved = path.resolve(dir);
  const base = path.basename(resolved);
  return (
    path.dirname(resolved).toLowerCase() === path.resolve(os.tmpdir()).toLowerCase() &&
    base.startsWith(prefix) &&
    base.length > prefix.length
  );
}

/**
 * Where a directory's owner marker lives: BESIDE it, not inside it.
 *
 * Inside was the obvious place and it was wrong, in the exact case the sweep
 * exists for. `fs.rmSync(recursive, force)` deletes what it can before it throws,
 * so a close() that loses the race with Chromium's file handles removes the marker
 * and leaves the locked profile - turning a directory we KNOW is dead into an
 * unmarked one, which is the most protected state there is. Measured live: five
 * leaked profiles with forty processes between them, every one of them reading
 * "unknown" and therefore shielded by the one-hour grace period. A sibling file
 * cannot be caught by a partial delete of the directory it describes.
 */
function ownerPath(dir) {
  return path.join(os.tmpdir(), `${path.basename(dir)}${OWNER_SUFFIX}`);
}

/** Create a per-run temp directory stamped with the PID of the run that owns it. */
function makeOwnedTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    fs.writeFileSync(
      ownerPath(dir),
      JSON.stringify({ pid: process.pid, startedAt: Date.now(), argv: process.argv.slice(1, 3) })
    );
  } catch {
    /* the sweep falls back to the age rule for an unmarked directory */
  }
  return dir;
}

/** Remove a directory's owner marker. Safe to call when there is none. */
function forgetOwner(dir) {
  try {
    fs.rmSync(ownerPath(dir), { force: true });
  } catch {
    /* best effort - an orphan marker is a few bytes and the sweep collects it */
  }
}

/**
 * "alive" | "dead" | "unknown" - is the test run that created this directory
 * still running?
 *
 * PID reuse can only make a dead directory look alive, which just defers its
 * removal to a later sweep. The reverse (deleting a LIVE run's profile) is the
 * one that breaks a test, and it cannot happen here.
 */
export function ownerState(dir) {
  if (!fs.existsSync(dir)) {
    // A process still running out of a profile directory that no longer exists is
    // abandoned by definition - there is no run left to belong to.
    return "dead";
  }
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(ownerPath(dir), "utf8"));
  } catch {
    return "unknown";
  }
  if (!Number.isInteger(marker?.pid)) {
    return "unknown";
  }
  try {
    process.kill(marker.pid, 0);
    return "alive";
  } catch (err) {
    // EPERM means the process exists but is not ours to signal - still alive.
    return err.code === "EPERM" ? "alive" : "dead";
  }
}

/**
 * Remove per-run temp directories whose owning run is gone.
 *
 * Cleanup on close() can lose the race with Windows releasing Chromium's cache
 * handles, and a killed test run (Ctrl-C, or the runner's own timeout) never gets
 * to clean up at all. Without this, each of those leaks a whole Chromium profile
 * into temp forever - and nothing else would ever notice, because a leaked
 * directory breaks no test.
 *
 * This used to be an age rule: delete anything older than an hour. That was wrong
 * in both directions. A suite or a gauntlet check that runs longer than an hour
 * would have its LIVE profile deleted out from under it by a concurrent launch,
 * and a directory leaked thirty seconds ago survived a full hour of test runs -
 * which is how ~20 of them were sitting in %TEMP% on 2026-08-18. Owner liveness
 * answers the actual question, so a leak is collected by the very next launch and
 * a live run is never touched however long it takes.
 *
 * Config directories are swept the same way. They had no sweep at all and were
 * only ever removed by a single unretried rmSync in close(), so they accumulated
 * unboundedly - 150+ of them, going back three weeks.
 *
 * It also KILLS before it deletes, which is the half that was missing. An
 * abandoned profile is usually abandoned because the Electron using it is still
 * running - so Windows has the directory locked, every rmSync fails, and a
 * delete-only sweep skips the exact case it exists for, forever. Killing first is
 * safe by construction: the only processes it can reach are ones launched into a
 * per-run E2E profile whose owning test run is gone. The captain's own Helm runs out of
 * %APPDATA%\helm and can never match.
 *
 * @returns {Promise<{killed: number[], removed: string[]}>}
 */
export async function sweepAbandonedRuns() {
  const root = os.tmpdir();
  let entries;
  try {
    entries = fs
      .readdirSync(root)
      .filter((d) => d.startsWith(USERDATA_PREFIX) || d.startsWith(CONFIG_PREFIX));
  } catch {
    return { killed: [], removed: [] };
  }
  // Candidates come from two places, not one. A directory listing misses the worst
  // case: close() kills first and removes the directory second, so a process that
  // SURVIVED the kill is left running out of a profile that no longer exists on
  // disk - invisible to a directory-driven sweep, forever. Asking the process table
  // which profiles are actually in use finds those. ownerState() calls a missing
  // directory "dead", which is exactly right for one.
  const running = await processesUsingE2EProfiles();
  const candidates = new Set([...entries, ...running.flatMap((p) => p.profiles)]);

  const abandoned = [...candidates].filter((name) => {
    const full = path.join(root, name);
    const state = ownerState(full);
    if (state === "alive") {
      return false;
    }
    if (state === "unknown") {
      try {
        return Date.now() - fs.statSync(full).mtimeMs >= UNOWNED_STALE_MS;
      } catch {
        return false;
      }
    }
    return true;
  });
  if (abandoned.length === 0) {
    return { killed: [], removed: [] };
  }

  const deadProfiles = abandoned.filter((n) => n.startsWith(USERDATA_PREFIX));
  const killed = deadProfiles.length > 0 ? await killByUserDataDirs(deadProfiles) : [];
  if (killed.length > 0) {
    await delay(300); // let Windows release the profile's file handles
  }

  // Owner markers whose directory is already gone. A few bytes each, but they are
  // the bookkeeping for this mechanism and letting them pile up would repeat, in
  // miniature, the config-directory leak this sweep was widened to fix.
  try {
    for (const f of fs.readdirSync(root)) {
      if (!f.endsWith(OWNER_SUFFIX)) {
        continue;
      }
      const owned = path.join(root, f.slice(0, -OWNER_SUFFIX.length));
      if (!fs.existsSync(owned)) {
        fs.rmSync(path.join(root, f), { force: true });
      }
    }
  } catch {
    /* best effort */
  }

  const removed = [];
  for (const name of abandoned) {
    const full = path.join(root, name);
    // A candidate found via the process table may have no directory left at all -
    // that is the case this sweep was widened to catch. Killing it was the work;
    // there is nothing to delete, and reporting it as removed would overstate.
    const existed = fs.existsSync(full);
    const gone = await rmDirWithRetries(full, 3);
    if (gone) {
      forgetOwner(full);
    }
    if (gone && existed) {
      removed.push(name);
    }
  }
  return { killed, removed };
}

/**
 * Every process currently running out of SOME per-run E2E profile, with the
 * profile basename(s) named on its command line.
 *
 * One query for all of them rather than one per directory - the whole chain
 * (cmd.exe, npm's node.exe, the electron main and its GPU/renderer/utility
 * children) carries the flag, so a full-suite backlog would otherwise mean
 * dozens of PowerShell round-trips.
 */
export async function processesUsingE2EProfiles() {
  if (process.platform !== "win32") {
    return [];
  }
  // $PID: this very PowerShell's command line contains the prefix it searches for.
  // powershell.exe is also excluded by name - a CONCURRENT harness's own kill
  // command mentions the basename it is killing, and there is nothing to gain from
  // racing it for the privilege.
  const out = await powershell(
    `Get-CimInstance Win32_Process |` +
      ` Where-Object { $_.ProcessId -ne $PID -and $_.Name -ne 'powershell.exe' -and $_.CommandLine -like '*${USERDATA_PREFIX}*' } |` +
      ` ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`
  );
  const profileRe = new RegExp(`${USERDATA_PREFIX}[A-Za-z0-9]+`, "g");
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const cut = line.indexOf("|");
      return { pid: Number(line.slice(0, cut)), commandLine: line.slice(cut + 1) };
    })
    .filter((p) => Number.isInteger(p.pid))
    .map((p) => ({ ...p, profiles: [...new Set(p.commandLine.match(profileRe) || [])] }))
    .filter((p) => p.profiles.length > 0);
}

/** Can we bind this port right now? The only honest test of "is it free". */
function portIsFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

/** Run a PowerShell snippet and resolve with its combined output (best-effort). */
function powershell(script) {
  return new Promise((resolve) => {
    const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    proc.stdout.on("data", (c) => (out += c.toString("utf8")));
    proc.stderr.on("data", (c) => (out += c.toString("utf8")));
    proc.on("close", () => resolve(out));
    proc.on("error", () => resolve(""));
  });
}

/**
 * Every process whose command line carries `--remote-debugging-port=<port>`,
 * with the per-run profile directory it was launched with (when it has one).
 *
 * `-like` cannot express a word boundary, so 9339 would also match 93390: the
 * loose filter is done in PowerShell and the exact one here.
 */
async function instancesOnPort(port) {
  if (process.platform !== "win32") {
    return [];
  }
  // $PID excludes the querying PowerShell itself, whose own command line contains
  // the pattern it is searching for. Without it this reports (and a kill built on
  // it would terminate) the process doing the asking.
  const out = await powershell(
    `Get-CimInstance Win32_Process |` +
      ` Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*--remote-debugging-port=${port}*' } |` +
      ` ForEach-Object { "$($_.ProcessId)|$($_.Name)|$($_.CommandLine)" }`
  );
  const exact = new RegExp(`--remote-debugging-port=${port}(?!\\d)`);
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pid, name, ...rest] = line.split("|");
      return { pid: Number(pid), name, commandLine: rest.join("|") };
    })
    .filter((p) => Number.isInteger(p.pid) && exact.test(p.commandLine))
    .map((p) => {
      const m = p.commandLine.match(/--user-data-dir="?([^"]+?)"?(?:\s+--|\s*$)/);
      return { ...p, userDataDir: m ? m[1] : null };
    });
}

/**
 * Decide which debug port to launch on.
 *
 * A busy port is either OUR OWN LITTER (an E2E instance whose test run has since
 * died - the stray this whole mechanism exists to stop) or something with a right
 * to be there. Litter is identified by its profile directory: a per-run E2E
 * directory in temp whose owner PID is gone. That is reaped, because leaving it
 * is precisely the bug. Anything else is left strictly alone and we take an
 * ephemeral port instead - the app is found through DevToolsActivePort, so the
 * number never had to be predictable for the harness to work.
 */
async function resolveDebugPort(requested) {
  if (await portIsFree(requested)) {
    return { port: requested, note: null };
  }
  const holders = await instancesOnPort(requested);
  const litter = holders.filter(
    (p) => isPerRunTmpDir(p.userDataDir, USERDATA_PREFIX) && ownerState(p.userDataDir) === "dead"
  );
  for (const p of litter) {
    await killByUserDataDir(p.userDataDir);
    await rmDirWithRetries(p.userDataDir);
  }
  if (litter.length > 0) {
    // Windows can hold the socket briefly after the process is gone.
    for (let i = 0; i < 10; i++) {
      if (await portIsFree(requested)) {
        return {
          port: requested,
          note: `reaped ${litter.length} abandoned E2E instance(s) still holding debug port ${requested} (pid ${litter
            .map((p) => p.pid)
            .join(", ")})`,
        };
      }
      await delay(200);
    }
  }
  const who = holders.length
    ? holders.map((p) => `${p.name} pid ${p.pid}`).join(", ")
    : "an unidentified process";
  return {
    port: 0,
    note: `debug port ${requested} is held by ${who} - launching on an ephemeral port instead (the app is located through its own DevToolsActivePort, not the number)`,
  };
}

/**
 * Wait for the port Electron actually bound, read from DevToolsActivePort inside
 * OUR per-run profile directory.
 *
 * This is what makes attaching to a stranger impossible. The file is written by
 * the Chromium instance that owns the profile, so if it says 49356 then 49356 is
 * ours; if it never appears, our app has no debugger and no amount of polling
 * /json/list can produce anything but somebody else's target.
 */
async function waitForOwnDebugPort(userDataDir, child, timeoutMs) {
  const file = path.join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Electron exited (code ${child.exitCode}) before it opened a debug port.`);
    }
    try {
      const port = Number(fs.readFileSync(file, "utf8").split("\n")[0].trim());
      if (Number.isInteger(port) && port > 0) {
        return port;
      }
    } catch {
      /* not written yet */
    }
    await delay(150);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for the app to open its own debug port ` +
      `(no DevToolsActivePort in ${userDataDir}). Electron logs "Cannot start http server for devtools" ` +
      `and keeps running when the port is already taken, so this usually means something else holds it.`
  );
}

/**
 * Tear down a launch that never produced a usable harness: kill the whole spawned
 * tree and remove the temp directories nobody else now has a handle to.
 */
async function abandonLaunch({ child, userDataTmpDir, configTmpDir }) {
  try {
    await killLaunch(child, userDataTmpDir);
  } catch {
    /* best effort - the directory removal below still has to happen */
  }
  for (const dir of [userDataTmpDir, configTmpDir]) {
    try {
      await rmDirWithRetries(dir);
    } catch {
      /* nothing here may mask the launch error the caller is about to see */
    }
  }
}

/**
 * Kill everything belonging to one launch: the spawned command's own tree (the
 * npm/cmd shims, which carry no Electron flags of their own), and every process
 * launched into this run's profile directory.
 *
 * Doing BOTH matters. Killing only the profile matches nothing when npm has not
 * reached `electron .` yet, and the shim then starts a brand-new instance with
 * nobody left to clean it up. Killing only the spawned tree misses anything that
 * has been reparented.
 */
async function killLaunch(child, userDataDir) {
  if (process.platform !== "win32") {
    if (child?.pid) {
      try {
        process.kill(child.pid);
      } catch {
        /* already gone */
      }
    }
    return "";
  }
  // ONE PowerShell for both halves. Spawning a shell costs about 700ms here - all
  // of it startup, not the query (measured: a WQL-filtered lookup saves only 50ms
  // of it) - and close() runs once per app test, so a second invocation was two
  // minutes of pure overhead across a full suite.
  const base = userDataDir ? path.basename(userDataDir) : null;
  if (base !== null && !isPerRunTmpDir(userDataDir, USERDATA_PREFIX)) {
    throw new Error(`Refusing to kill: ${userDataDir} is not a per-run E2E profile directory`);
  }
  const lines = [];
  if (child?.pid) {
    lines.push(`taskkill /PID ${child.pid} /T /F 2>&1 | Out-Null`);
  }
  if (base && /^helm-e2e-userdata-[A-Za-z0-9]+$/.test(base)) {
    // Selected and killed in the same pass - see killByUserDataDirs for why the
    // PIDs must not be resolved in one process and killed in another.
    lines.push(
      `$re = '${base}'`,
      `Get-CimInstance Win32_Process |` +
        ` Where-Object { $_.ProcessId -ne $PID -and $_.Name -ne 'powershell.exe' -and $_.CommandLine -match $re } |` +
        ` ForEach-Object { taskkill /PID $($_.ProcessId) /T /F 2>&1 | Out-Null; Write-Output "killed $($_.ProcessId)" }`
    );
  }
  return lines.length ? (await powershell(lines.join("\n"))).trim() : "";
}

/**
 * Kill every process launched into a given per-run E2E profile directory.
 *
 * The profile path is a far better discriminator than the debug port. It is
 * unique per launch by construction (mkdtemp), it appears on the command line of
 * the ENTIRE chain - cmd.exe, npm's node.exe, the electron main and every GPU /
 * renderer / utility child (verified 2026-08-18) - and it stays correct when the
 * requested port was refused and an ephemeral one was used instead. It also
 * cannot reach the captain's own Helm, whose profile is %APPDATA%\helm.
 */
async function killByUserDataDir(userDataDir) {
  if (!isPerRunTmpDir(userDataDir, USERDATA_PREFIX)) {
    throw new Error(`Refusing to kill: ${userDataDir} is not a per-run E2E profile directory`);
  }
  const killed = await killByUserDataDirs([path.basename(userDataDir)]);
  return killed.length ? `Killed E2E process tree PID ${killed.join(", ")}` : "(no matching instance)";
}

/**
 * Kill every process running out of ANY of the named per-run profiles, in one
 * pass, and return the PIDs that were killed.
 *
 * Selection and killing happen inside a SINGLE PowerShell, on purpose. Resolving
 * PIDs in one call and killing them in another leaves a window - a few hundred
 * milliseconds - in which a process can exit and Windows can reassign its PID,
 * after which `taskkill /T /F` takes down an unrelated tree. Small odds, but this
 * project has already been bitten once by a kill that reached further than it
 * meant to (the taskkill /IM electron.exe rule in CLAUDE.md), so the window is
 * closed rather than accepted.
 *
 * @param {string[]} basenames per-run profile directory names (not full paths)
 */
function killByUserDataDirs(basenames) {
  const safe = (basenames || []).filter(
    (b) => typeof b === "string" && /^helm-e2e-userdata-[A-Za-z0-9]+$/.test(b)
  );
  if (safe.length === 0 || process.platform !== "win32") {
    return Promise.resolve([]);
  }
  // $PID: this very PowerShell's own command line contains the names it searches
  // for. powershell.exe is excluded by name too - a CONCURRENT harness's kill
  // command mentions the profile it is killing, and there is nothing to gain from
  // racing it for the privilege.
  const pattern = safe.join("|");
  return powershell(
    `$re = '${pattern}'` +
      `\nGet-CimInstance Win32_Process |` +
      ` Where-Object { $_.ProcessId -ne $PID -and $_.Name -ne 'powershell.exe' -and $_.CommandLine -match $re } |` +
      ` ForEach-Object { taskkill /PID $($_.ProcessId) /T /F 2>&1 | Out-Null; Write-Output $_.ProcessId }`
  ).then((out) =>
    out
      .split(/\r?\n/)
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
  );
}

/**
 * Remove a temp directory, retrying while Windows still holds Chromium's cache
 * handles. killLaunch returns before those are released, so a single rmSync
 * throws and - being best-effort - silently leaves the whole profile behind.
 */
export async function rmDirWithRetries(dir, attempts = 6) {
  if (!dir) {
    return true;
  }
  if (!isPerRunTmpDir(dir, USERDATA_PREFIX) && !isPerRunTmpDir(dir, CONFIG_PREFIX)) {
    throw new Error(`Refusing to remove: ${dir} is not a per-run E2E temp directory`);
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      forgetOwner(dir);
      return true;
    } catch {
      if (attempt < attempts - 1) {
        await delay(150 * (attempt + 1));
      }
    }
  }
  // Left behind on purpose rather than thrown: the owner marker inside it is now
  // this (soon to exit) process's PID, so the next launch's sweep collects it.
  return false;
}

/**
 * Poll the CDP JSON endpoint until a renderer (page) target with a debugger URL
 * is available. Fails fast if the child process exits early.
 */
async function waitForRendererTarget(port, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Electron exited (code ${child.exitCode}) before a CDP target appeared.`
      );
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const targets = await res.json();
        // A DevTools window is itself a "page" target. Skip it - it is never the
        // app under test, and picking it silently attaches the whole harness to
        // the inspector instead (every selector then "not found"). Matters for
        // any app that auto-opens DevTools in dev.
        const page = targets.find(
          (t) => t.type === "page" && t.webSocketDebuggerUrl && !String(t.url || "").startsWith("devtools://")
        );
        if (page) {
          return page;
        }
      }
    } catch (err) {
      lastErr = err;
    }
    await delay(250);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for a CDP renderer target on port ${port}.` +
      (lastErr ? ` Last error: ${lastErr.message}` : "")
  );
}

/**
 * Open a CDP WebSocket connection and return a small request/response client
 * with event subscription support.
 */
function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const eventHandlers = new Map();

    ws.addEventListener("open", () => {
      resolve({
        /** Send a CDP command and resolve with its result. */
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = nextId++;
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        /** Subscribe to a CDP event (e.g. "Runtime.consoleAPICalled"). */
        on(method, handler) {
          if (!eventHandlers.has(method)) {
            eventHandlers.set(method, []);
          }
          eventHandlers.get(method).push(handler);
        },
        close() {
          try {
            ws.close();
          } catch {
            /* already closing */
          }
        },
      });
    });

    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) {
          rej(new Error(`CDP error (${msg.error.code}): ${msg.error.message}`));
        } else {
          res(msg.result);
        }
      } else if (msg.method && eventHandlers.has(msg.method)) {
        for (const h of eventHandlers.get(msg.method)) {
          h(msg.params);
        }
      }
    });

    ws.addEventListener("error", (ev) => {
      reject(new Error(`CDP WebSocket error: ${ev.message || "unknown"}`));
    });
  });
}

class Harness {
  constructor({ child, cdp, port, appDir, stdout, stderr, configTmpDir, userDataTmpDir }) {
    this.child = child;
    this.cdp = cdp;
    this.port = port;
    this.appDir = appDir;
    this.stdout = stdout;
    this.stderr = stderr;
    this.configTmpDir = configTmpDir || null;
    this.userDataTmpDir = userDataTmpDir || null;
    /** @type {Array<{type: string, text: string}>} */
    this.console = [];
  }

  async _init() {
    // Enable the domains we use and start collecting console output.
    await this.cdp.send("Runtime.enable");
    await this.cdp.send("Page.enable");
    this.cdp.on("Runtime.consoleAPICalled", (p) => {
      const text = (p.args || [])
        .map((a) => a.value ?? a.description ?? "")
        .join(" ");
      this.console.push({ type: p.type, text });
    });
    // Uncaught exceptions in the page also matter for E2E.
    this.cdp.on("Runtime.exceptionThrown", (p) => {
      const d = p.exceptionDetails;
      const text =
        d?.exception?.description || d?.text || "(uncaught exception)";
      this.console.push({ type: "error", text });
    });
    // A renderer TARGET existing is not the same as its script having run. Roughly
    // 30 tests drive the app by calling `navigateToPage(...)` through eval, and that
    // global only exists once renderer.js has evaluated - so a launch that won the
    // race against it failed with "navigateToPage is not defined", which reads like a
    // broken test rather than a timing one. Seen while mutation-testing the settings
    // layout (2026-08-03), where it made a mutation look like it had survived.
    //
    // Best-effort and bounded: this harness is also pointed at other apps (jot, loom)
    // that have no such global, so a timeout here is not an error - it just means
    // there was nothing to wait for.
    await this.waitForRendererReady(5000);
  }

  /**
   * Wait until the renderer's own script has run, detected by its page-navigation
   * global existing. Resolves true if it appeared, false if the wait timed out.
   */
  async waitForRendererReady(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const ready = await this.eval(`typeof navigateToPage === "function"`);
        if (ready) {
          return true;
        }
      } catch {
        // the page can be mid-navigation; keep polling
      }
      await delay(100);
    }
    return false;
  }

  /**
   * Evaluate a JS expression in the page and return its (JSON-serializable)
   * value. Awaits promises. Throws on a thrown exception.
   * @param {string} jsExpr
   */
  async eval(jsExpr) {
    const result = await this.cdp.send("Runtime.evaluate", {
      expression: jsExpr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      throw new Error(
        `eval threw: ${d.exception?.description || d.text || "unknown"}`
      );
    }
    return result.result?.value;
  }

  /**
   * Click an element by CSS selector (dispatches a real click via the DOM).
   * Throws if the selector matches nothing.
   * @param {string} selector
   */
  async click(selector) {
    const ok = await this.eval(
      `(() => { const el = document.querySelector(${JSON.stringify(
        selector
      )}); if (!el) return false; el.click(); return true; })()`
    );
    if (!ok) {
      throw new Error(`click: no element matched selector ${selector}`);
    }
  }

  /**
   * Set the value of an input/textarea and fire input+change events so app
   * listeners react as they would to real typing.
   * @param {string} selector
   * @param {string} text
   */
  async type(selector, text) {
    const ok = await this.eval(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.focus();
        el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`
    );
    if (!ok) {
      throw new Error(`type: no element matched selector ${selector}`);
    }
  }

  /**
   * Return the trimmed textContent of the first element matching selector, or
   * null if there is no match.
   * @param {string} selector
   */
  async getText(selector) {
    return this.eval(
      `(() => { const el = document.querySelector(${JSON.stringify(
        selector
      )}); return el ? (el.textContent || '').trim() : null; })()`
    );
  }

  /**
   * Wait until an element matching selector exists in the DOM (optionally also
   * visible). Resolves with true, or rejects on timeout.
   * @param {string} selector
   * @param {number} [timeoutMs]
   * @param {object} [opts]
   * @param {boolean} [opts.visible] Also require the element to be visible
   *   (non-zero box, not display:none). Default: false.
   */
  async waitForSelector(selector, timeoutMs = 10000, opts = {}) {
    const wantVisible = !!opts.visible;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = await this.eval(
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false;
          if (!${wantVisible}) return true;
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        })()`
      );
      if (found) {
        return true;
      }
      await delay(100);
    }
    throw new Error(
      `waitForSelector: ${selector}${
        wantVisible ? " (visible)" : ""
      } not found within ${timeoutMs}ms`
    );
  }

  /**
   * Capture a full-page PNG screenshot to outPath.
   *
   * The CDP Page.captureScreenshot call can occasionally hang (observed
   * 2026-07-05: an E2E run's top-level await never settled on this call),
   * which would stall a whole test. It is raced against a timeout so a flaky
   * screenshot rejects instead of hanging - callers can treat it as
   * best-effort (try/catch) without the run getting stuck.
   * @param {string} outPath
   * @param {number} [timeoutMs] reject if the capture takes longer. Default 10000.
   * @returns {Promise<number>} bytes written
   */
  async screenshot(outPath, timeoutMs = 10000) {
    const { data } = await Promise.race([
      this.cdp.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`screenshot timed out after ${timeoutMs}ms`)),
          timeoutMs
        )
      ),
    ]);
    const buf = Buffer.from(data, "base64");
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
    await writeFile(outPath, buf);
    return buf.length;
  }

  /**
   * Return a copy of all console messages collected since launch.
   * @returns {Array<{type: string, text: string}>}
   */
  getConsole() {
    return this.console.slice();
  }

  /** Convenience: only the error-level console/exception messages. */
  getConsoleErrors() {
    return this.console.filter((m) => m.type === "error");
  }

  /**
   * Close the CDP connection and terminate ONLY the app instance this harness
   * launched. Never kills electron.exe machine-wide.
   *
   * Scope discriminator = this run's unique `--user-data-dir`, plus the spawned
   * command's own process tree. See killByUserDataDir for why the profile path
   * beats the debug port here: it covers the npm/cmd shims and the Electron
   * children alike, and it stays right when the requested port was refused.
   *
   * Both temp directories are then removed WITH RETRIES. The kill returns before
   * Windows has released Chromium's cache handles, so a single rmSync throws and,
   * being best-effort, leaves the whole profile behind. Silently: the first
   * version of this passed every test while leaking a directory per launch, i.e.
   * ~101 Chromium profiles per full suite, on the drive that ran out of space
   * earlier the same day. Caught by test-harness-userdata-isolated.mjs, which is
   * the reason that test asserts cleanup and not just isolation.
   */
  async close() {
    try {
      this.cdp.close();
    } catch {
      /* ignore */
    }
    const result = await killLaunch(this.child, this.userDataTmpDir);
    await rmDirWithRetries(this.userDataTmpDir);
    await rmDirWithRetries(this.configTmpDir);
    return result;
  }
}
