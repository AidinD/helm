// Warm whisper-server.exe path for single-clip transcription — removes the
// ~460ms per-call model-load that whisper-cli.exe (the previous single-clip
// backend, see whisperCpp.js) pays on EVERY call, by loading the model once
// into a long-lived HTTP server process and reusing it for every subsequent
// clip. This module owns that server's lifecycle: lazy spawn on first use,
// readiness detection, and a kill function the caller (whisperCpp.js) uses
// as part of app shutdown.
//
// Flags/endpoint confirmed by running `whisper-server.exe --help` against the
// build in .whisper/Release, then a live smoke test (POST a real WAV, read
// the response) rather than assumed from upstream whisper.cpp docs:
//   --host HOST   [127.0.0.1]              bind address
//   --port PORT   [8080]                   bind port
//   -m FNAME      model path
//   -nt           no timestamps (matches whisper-cli's -nt usage)
//   -bo 1 -bs 1   best-of 1 / beam-size 1 (greedy, matches whisper-cli's tuning)
//   -l LANG       spoken language ISO code, or "auto"
// The server exposes POST /inference (multipart form: "file" = WAV bytes,
// "language" = ISO code) and replies with JSON `{ "text": "..." }` by
// default (no response_format needed) — verified live against
// .whisper/jfk.wav: {"text":" Och så, mina \"FLO\" Amerikat: ..."} in ~0.5-0.8s
// once warm, vs ~1.2s per call for whisper-cli.exe (which re-pays model load
// every time).
//
// Readiness: whisper-server.exe loads the model and initializes its whisper
// state BEFORE starting to accept HTTP connections (confirmed: no
// "listening"/"ready" line is printed to stdout/stderr to key on instead), so
// polling for the FIRST successful TCP connection is a reliable ready signal
// — verified live by hitting /inference the instant the port opens and
// getting a correct transcription back immediately, not a connection error
// or empty response.
import { spawn, execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WHISPER_ROOT = path.join(__dirname, "..", "..", ".whisper");
const WHISPER_SERVER_PATH = path.join(WHISPER_ROOT, "Release", "whisper-server.exe");
const MODEL_PATH = path.join(WHISPER_ROOT, "ggml-model-q5_0.bin");

const HOST = "127.0.0.1";

// How long to wait for the model to load and the server to start accepting
// connections before giving up and letting the caller fall back to
// whisper-cli.exe. Generous headroom over the observed ~0.8-1.5s cold start
// on Aidin's RTX 3070 (CUDA init + GGML model load) — a slower/CPU-only
// machine should still get a fair chance before falling back.
const STARTUP_TIMEOUT_MS = 20000;
const READY_POLL_INTERVAL_MS = 50;

// Module-level singleton: at most one warm server for the process lifetime
// of whoever imports this module (the voice worker process — see
// voiceWorker.js). `starting` de-dupes concurrent transcribe calls that both
// arrive before the first one has finished spawning the server, so only one
// whisper-server.exe process is ever created.
let serverState = null; // { process, port, ready: Promise<void> }

/**
 * True when whisper-server.exe is present on disk (the model's presence is
 * already checked by whisperCpp.js's isAvailable(), which gates whether this
 * module is used at all).
 */
export function isServerBinaryAvailable() {
  return fs.existsSync(WHISPER_SERVER_PATH);
}

/**
 * Finds a free localhost TCP port by asking the OS for one (bind to port 0,
 * read back the assigned port, close). Avoids hardcoding a port that might
 * already be in use by something else on the machine.
 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, HOST, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Polls `host:port` until a TCP connection succeeds (see the module header
 * comment for why this is a reliable readiness signal for whisper-server.exe
 * specifically) or STARTUP_TIMEOUT_MS elapses.
 */
function waitUntilReady(port, deadline) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host: HOST, port }, () => {
        socket.end();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`whisper-server.exe did not become ready within ${STARTUP_TIMEOUT_MS}ms`));
          return;
        }
        setTimeout(attempt, READY_POLL_INTERVAL_MS);
      });
    };
    attempt();
  });
}

/**
 * Lazily starts whisper-server.exe (if not already running/starting) and
 * resolves once it is accepting connections. Safe to call concurrently —
 * all callers share the same in-flight startup. Throws (never leaves a
 * half-started server referenced from serverState) if the process fails to
 * spawn or does not become ready in time, so callers can fall back to
 * whisper-cli.exe.
 *
 * @returns {Promise<number>} the port the server is listening on
 */
export async function ensureServerRunning() {
  if (serverState) {
    await serverState.ready;
    return serverState.port;
  }

  const port = await findFreePort();
  const args = [
    "-m", MODEL_PATH,
    "--host", HOST,
    "--port", String(port),
    "-bo", "1",
    "-bs", "1",
    "-nt",
  ];

  const child = spawn(WHISPER_SERVER_PATH, args, {
    cwd: path.dirname(WHISPER_SERVER_PATH),
    windowsHide: true,
  });

  let stderrTail = "";
  child.stderr?.on("data", (chunk) => {
    // whisper-server's own startup diagnostics (CUDA init, model load info) —
    // kept only for an error message tail if startup fails, same treatment
    // whisperCpp.js/whisperStream.js give their subprocesses' stderr.
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-1000);
  });
  child.stdout?.on("data", () => {
    // whisper-server prints little to stdout; nothing here is surfaced live.
  });

  const spawnError = new Promise((_resolve, reject) => {
    child.on("error", (err) => {
      reject(new Error(`Failed to spawn whisper-server.exe: ${err.message}`));
    });
  });

  child.on("exit", (code, signal) => {
    // The server died (crashed, or was killed for reasons other than our own
    // shutdown call) — drop the singleton so the next transcribe attempt
    // starts a fresh one instead of reusing a dead reference forever.
    if (serverState && serverState.process === child) {
      if (!child.__stoppedByCaller && code !== null) {
        console.warn(`[maestro] whisper-server.exe exited unexpectedly (code ${code}, signal ${signal}): ${stderrTail.slice(-500)}`);
      }
      serverState = null;
    }
  });

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  const ready = Promise.race([waitUntilReady(port, deadline), spawnError]).catch((err) => {
    // Startup failed — make sure we don't leave a half-alive process behind
    // and clear the singleton so a later call can retry cleanly.
    killServerProcess(child, { sync: false });
    if (serverState && serverState.process === child) {
      serverState = null;
    }
    throw err;
  });

  serverState = { process: child, port, ready };
  await ready;
  return port;
}

/**
 * POSTs a WAV file to the running whisper-server's /inference endpoint and
 * returns the transcribed text. Multipart body is built by hand (a single
 * file field + a couple of plain text fields) rather than pulling in a
 * form-data dependency — the format is simple enough not to warrant one, and
 * matches this codebase's existing preference for hand-rolled simple formats
 * (see whisperCpp.js's writeWavFile).
 *
 * @param {number} port the port ensureServerRunning() resolved
 * @param {Buffer} wavBuffer raw bytes of a WAV file
 * @param {string|null} langCode ISO-639-1 code, or null for "auto"
 */
export function transcribeViaServer(port, wavBuffer, langCode) {
  return new Promise((resolve, reject) => {
    const boundary = `----maestroWhisperServer${Date.now().toString(16)}`;
    const parts = [];

    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="language"\r\n\r\n` +
      `${langCode || "auto"}\r\n`,
      "utf8",
    ));
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n` +
      `Content-Type: audio/wav\r\n\r\n`,
      "utf8",
    ));
    parts.push(wavBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));

    const body = Buffer.concat(parts);

    const req = http.request(
      {
        host: HOST,
        port,
        path: "/inference",
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`whisper-server responded with status ${res.statusCode}: ${data.slice(0, 500)}`));
            return;
          }
          try {
            const parsed = JSON.parse(data);
            resolve((parsed.text || "").trim());
          } catch (err) {
            reject(new Error(`Failed to parse whisper-server response: ${err.message}`));
          }
        });
      },
    );
    req.on("error", (err) => {
      reject(new Error(`whisper-server request failed: ${err.message}`));
    });
    req.write(body);
    req.end();
  });
}

function killServerProcess(child, { sync = false } = {}) {
  if (!child || child.killed || !child.pid) {
    return;
  }
  child.__stoppedByCaller = true;
  if (process.platform === "win32") {
    // Same taskkill /T /F tree-kill pattern as main.js's killChildTree and
    // whisperStream.js's stopStream — a plain child.kill() only signals the
    // top-level process, and Windows does not automatically kill a process's
    // own children when it dies.
    const args = ["/pid", String(child.pid), "/T", "/F"];
    if (sync) {
      try {
        execFileSync("taskkill", args, { stdio: "ignore" });
      } catch {
        // Already exited — nothing to do.
      }
      return;
    }
    execFile("taskkill", args, (err) => {
      if (err) {
        console.error(`[maestro] taskkill failed for whisper-server pid ${child.pid}:`, err.message);
      }
    });
    return;
  }
  child.kill();
}

/**
 * Returns the PID of the currently running warm whisper-server process, or
 * null if none is running. Lets a caller in a DIFFERENT process (main.js,
 * via voiceWorker.js reporting this back over parentPort — see that
 * module's header comment) track the PID and tree-kill it directly and
 * synchronously on app shutdown, instead of relying on a cross-process
 * postMessage-then-kill sequence whose delivery order is not guaranteed.
 */
export function getServerPid() {
  return serverState && serverState.process && serverState.process.pid ? serverState.process.pid : null;
}

/**
 * Stops the warm whisper-server, if one is running. Called on app shutdown
 * (see the voice worker's own process-exit handling) so no whisper-server.exe
 * is left orphaned after Maestro quits — mirrors whisperStream.js's
 * stopStream / main.js's killChildTree "sync on shutdown" reasoning: a
 * process this module's OWN process is about to exit cannot rely on an async
 * kill completing before teardown.
 */
export function stopServer({ sync = false } = {}) {
  if (!serverState) {
    return;
  }
  killServerProcess(serverState.process, { sync });
  serverState = null;
}
