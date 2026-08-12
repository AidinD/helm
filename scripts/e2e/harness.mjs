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
// matched by its command line containing the repo/app directory (the same
// approach as scripts/kill-helm.ps1). It NEVER kills electron.exe machine-
// wide — that would take down Reinmaker or the user's own Helm. A stray
// instance left running is a real failure.
//
// Usage (see demo.mjs for a full example):
//   import { launch } from "./harness.mjs";
//   const app = await launch();              // launches THIS Helm repo
//   await app.waitForSelector("#pageToggle");
//   await app.screenshot("out.png");
//   await app.close();

import { spawn } from "node:child_process";
import fs from "node:fs";
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
 * @param {number} [opts.port]     Remote debugging port. Default: 9333.
 * @param {number} [opts.readyTimeoutMs]  How long to wait for a renderer target
 *   to appear on the CDP endpoint. Default: 30000.
 * @returns {Promise<Harness>}
 */
export async function launch(opts = {}) {
  const appDir = opts.appDir || REPO_ROOT;
  const command = opts.command || "npm";
  const baseArgs = opts.args || ["start"];
  // A fixed default port makes two harnesses collide: the second app can't bind
  // it, so waitForRendererTarget attaches to the FIRST app's renderer (or times
  // out). That happens for real - the review-page gauntlet runs an E2E script as a
  // check, from inside a Helm that a harness already launched. HELM_E2E_PORT lets
  // the outer runner hand its children a different port; the default stays 9333 so
  // an interactive `node scripts/e2e/foo.mjs` is still predictable to attach to.
  const port = opts.port || Number(process.env.HELM_E2E_PORT) || 9333;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 30000;

  // The debug flag must reach electron. For `npm start` (which runs
  // `electron .`), npm forwards args after a literal "--" to the script.
  const debugFlag = `--remote-debugging-port=${port}`;

  // Electron's userData dir is derived from the app NAME, so a test run and the
  // INSTALLED Helm both resolve to %APPDATA%\helm and write the same window state,
  // localStorage and cookies at the same time. Aidin noticed it live (2026-08-03):
  // his Helm was open while a suite ran, both pointed at that one directory. That is
  // both a source of flakiness (a test reads state its own app never wrote) and a
  // way for a throwaway run to change the app he actually uses. A per-run directory
  // costs nothing and removes the shared writer entirely.
  sweepStaleUserDataDirs();
  const userDataTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-e2e-userdata-"));
  const userDataFlag = `--user-data-dir=${userDataTmpDir}`;
  const args =
    command === "npm"
      ? [...baseArgs, "--", debugFlag, userDataFlag]
      : [...baseArgs, debugFlag, userDataFlag];

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
    configTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-e2e-config-"));
    env.HELM_CONFIG_PATH = path.join(configTmpDir, "config.json");
  }

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

  const target = await waitForRendererTarget(port, readyTimeoutMs, child);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);

  const harness = new Harness({ child, cdp, port, appDir, stdout, stderr, configTmpDir, userDataTmpDir });
  await harness._init();
  return harness;
}

const USERDATA_PREFIX = "helm-e2e-userdata-";
const STALE_USERDATA_MS = 60 * 60 * 1000;

/**
 * Remove per-run Electron profiles an earlier launch could not delete.
 *
 * Cleanup on close() can lose the race with Windows releasing Chromium's cache
 * handles, and a killed test run (Ctrl-C, or the runner being stopped) never gets
 * to clean up at all. Without this, each of those leaks a whole Chromium profile
 * into temp forever - and nothing else would ever notice, because a leaked
 * directory breaks no test. Only touches directories older than an hour, so a
 * CONCURRENT run's live profile is never pulled out from under it.
 */
function sweepStaleUserDataDirs() {
  const root = os.tmpdir();
  let entries;
  try {
    entries = fs.readdirSync(root).filter((d) => d.startsWith(USERDATA_PREFIX));
  } catch {
    return;
  }
  for (const name of entries) {
    const full = path.join(root, name);
    try {
      if (Date.now() - fs.statSync(full).mtimeMs < STALE_USERDATA_MS) {
        continue;
      }
      fs.rmSync(full, { recursive: true, force: true });
    } catch {
      /* still locked, or gone already - next launch tries again */
    }
  }
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
   * Scope discriminator = the unique `--remote-debugging-port=<port>` flag we
   * launched with. Only THIS instance's main process carries it — the user's
   * own running Helm (which spawns several electron.exe of its own) does
   * not, so matching on the app-directory basename alone (as kill-helm.ps1
   * does for boot-testing) would wrongly kill their live session too. We find
   * the one main process by port, then kill its whole process tree so its GPU/
   * renderer/utility children go with it and nothing else is touched.
   */
  async close() {
    try {
      this.cdp.close();
    } catch {
      /* ignore */
    }
    const result = await killByDebugPort(this.port);
    // Remove the throwaway config.json dir this launch created (if any). After the
    // process is gone so nothing is mid-write to it.
    // Same for the per-run Electron userData dir - but that one needs RETRIES.
    // killByDebugPort returns before Windows has released Chromium's cache handles,
    // so a single rmSync throws and, being best-effort, leaves the whole profile
    // behind. Silently: the first version of this passed every test while leaking a
    // directory per launch, i.e. ~101 Chromium profiles per full suite, on the drive
    // that ran out of space earlier the same day. Caught by
    // test-harness-userdata-isolated.mjs, which is the reason that test asserts
    // cleanup and not just isolation.
    if (this.userDataTmpDir) {
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          fs.rmSync(this.userDataTmpDir, { recursive: true, force: true });
          break;
        } catch {
          if (attempt < 5) {
            await delay(150 * (attempt + 1));
          }
          /* last attempt: leave it. sweepStaleUserDataDirs picks it up next launch. */
        }
      }
    }
    if (this.configTmpDir) {
      try {
        fs.rmSync(this.configTmpDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    return result;
  }
}

/**
 * Kill the Electron instance launched with `--remote-debugging-port=<port>`,
 * plus its child process tree, and nothing else.
 *
 * The debug port is a per-launch unique token that appears only on the main
 * process command line, so a `-like` match on it can never hit an unrelated
 * Electron app. We resolve the matching PID(s), then `taskkill /T /F` each to
 * take down that instance's whole tree (GPU, renderer, utility helpers).
 */
function killByDebugPort(port) {
  if (!Number.isInteger(port) || port < 1024) {
    return Promise.reject(
      new Error(`Refusing to kill: invalid debug port (${port})`)
    );
  }
  const pattern = `*--remote-debugging-port=${port}*`;
  const ps = [
    // electron.exe OR Helm.exe: a PACKAGED build runs under the product name, so a filter on
    // electron.exe alone silently matched nothing and left the instance running (found while
    // adding the packaged-build check, 2026-08-12). Both names stay narrow, and the debug
    // port - unique per launch - is still what actually identifies the instance, so this
    // cannot reach Aidin's own installed Helm, which carries no such flag.
    `$procs = Get-CimInstance Win32_Process |`,
    `  Where-Object { ($_.Name -eq 'electron.exe' -or $_.Name -eq 'Helm.exe') -and $_.CommandLine -like '${pattern}' }`,
    `if (-not $procs) { Write-Output '(no matching instance)'; exit 0 }`,
    `foreach ($p in $procs) {`,
    `  Write-Output "Killing E2E electron.exe tree PID $($p.ProcessId)"`,
    // /T kills the whole child tree, /F forces it. Suppress taskkill's own
    // noise; a race where a child already exited is fine.
    `  taskkill /PID $($p.ProcessId) /T /F 2>&1 | Out-Null`,
    `}`,
  ].join("\n");

  return new Promise((resolve) => {
    const proc = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let out = "";
    proc.stdout.on("data", (c) => (out += c.toString("utf8")));
    proc.stderr.on("data", (c) => (out += c.toString("utf8")));
    proc.on("close", () => resolve(out.trim()));
    proc.on("error", () => resolve("")); // best-effort cleanup
  });
}
