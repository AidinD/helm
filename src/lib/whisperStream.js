// True real-time streaming transcription for continuous voice input, using
// whisper.cpp's own SDL2-based streaming tool (examples/stream) instead of
// the renderer's rolling re-transcription loop (repeatedly re-transcribing
// the whole clip-so-far via whisper-cli, see whisperCpp.js + renderer.js's
// VOICE_ROLLING_INTERVAL_MS). This module owns spawning that binary, parsing
// its stdout into partial/committed text, and killing it reliably.
//
// Binary choice: the repo's .whisper/Release/ ships BOTH `stream.exe` and
// `whisper-stream.exe`. `stream.exe` is whisper.cpp's now-deprecated name for
// this tool — running it just prints a deprecation warning to stderr and
// exits immediately (verified directly against this build), so it cannot be
// used. `whisper-stream.exe` is the real, current binary and is what this
// module spawns.
//
// stdout format (reverse-engineered from examples/stream/stream.cpp in the
// whisper.cpp source, plus a live ~5s silent capture against this exact
// build/model — see DECISIONS.md for the full sample):
//   - With --step > 0 (sliding-window mode, what we use — VAD mode only
//     kicks in when --step is 0/omitted, which we never do), each processing
//     iteration prints:
//       "\x1b[2K\r" + 100 spaces + "\x1b[2K\r" + <segment text, no trailing \n>
//     i.e. an ANSI clear-line + carriage-return, twice (clearing the
//     previous line's content), then the CURRENT window's full transcript
//     text reprinted in place. This is a REPRINT of the whole rolling
//     window's result each step, not an incremental append.
//   - Every `n_new_line = max(1, length_ms/step_ms - 1)` iterations, a plain
//     "\n" is printed and the internal audio buffer rolls forward (keeping
//     only `--keep` ms of audio for the next window). Because whisper-stream
//     is run with its default no_context=true (we never pass -kc), nothing
//     about the recognized TEXT is carried across that roll — the "\n" is
//     whisper-stream's own cosmetic scrollback break, not a linguistic
//     guarantee that the text before it can never be corrected. We still
//     treat it as our commit point (see below) because it is the only
//     boundary the tool gives us, and in practice each window's text has
//     already stabilized by the time it rolls off (that's the entire point
//     of --keep carrying a small audio overlap forward).
//   - Startup also prints a plain "[Start speaking]\n" line before the first
//     window.
//
// Partial vs. committed text, as exposed by this module: every reprint
// (segment between two "\x1b[2K\r...\x1b[2K\r" markers) replaces the
// "partial" — the in-progress, still-revisable current window. Every bare
// "\n" commits the CURRENT partial to a running "committed" buffer and
// starts the next window's partial from empty. Callers should render
// `committed + " " + partial` while streaming, and use `committed` (with the
// final trailing partial appended once more on stop) as the authoritative
// text when the stream is stopped.
import { spawn, execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLanguageCode } from "./whisperCpp.js";
import { whisperRoot } from "keel/whisper";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolved by keel, not by walking up from this file. The payload moved out
// of this repo on 2026-08-30 so that Nib could use it too: 1.3GB of CUDA DLLs
// and model weights belong outside every repository, and one copy serves the
// suite. `WHISPER_DIR` overrides it; the default is the folder beside the
// checked-out repos.
const WHISPER_ROOT = whisperRoot();
const WHISPER_STREAM_PATH = path.join(WHISPER_ROOT, "Release", "whisper-stream.exe");
const MODEL_PATH = path.join(WHISPER_ROOT, "ggml-model-q5_0.bin");

// Tuning: --step is how often a new window is transcribed (responsiveness —
// smaller = more frequent partial updates, but more GPU work per second).
// --length is how much trailing audio each window covers (accuracy — whisper
// does better with more context per inference, but a longer window costs
// more time per step and delays how quickly speech falls out of the "keep
// improving" zone). --keep is how much audio survives a window roll, to
// avoid clipping a word straddling the boundary.
//
// 700ms/5000ms/200ms: --step 700 gives sub-second visible updates (matching
// the "grows word-by-word" ask) while staying well inside the ~1.3s/11s-clip
// inference time already measured on the captain's RTX 3070 (see whisperCpp.js's
// header comment) — a 5s window transcribes considerably faster than that,
// so 700ms steps do not queue up. --length 5000 keeps each window short
// enough to stay fast on this GPU while still giving whisper a few seconds
// of audio context per inference (short windows alone tend to fragment
// words/hurt accuracy). --keep 200 is whisper-stream's own default and is
// left alone — it only needs to bridge one word's worth of boundary overlap.
const DEFAULT_STEP_MS = 700;
const DEFAULT_LENGTH_MS = 5000;
const DEFAULT_KEEP_MS = 200;

/**
 * True when both whisper-stream.exe and the GGML model are present on disk.
 * Callers should fall back to the existing rolling-chunk continuous mode
 * when this is false instead of spawning a binary that doesn't exist.
 */
export function isAvailable() {
  return fs.existsSync(WHISPER_STREAM_PATH) && fs.existsSync(MODEL_PATH);
}

// ANSI "clear entire line" + carriage return, whisper-stream's own boundary
// marker for "the following text replaces the current window's reprint".
// Always appears in pairs with a 100-space filler in between (see
// stream.cpp's print block: clear -> 100 spaces -> clear -> text), so the
// REAL boundary this parser keys on is the full triplet "clear, 100 spaces,
// clear" — splitting on that in one step avoids ever treating the
// spaces-only filler as its own text run.
// eslint-disable-next-line no-control-regex
const CLEAR_LINE = "\x1b[2K\r";
const REPRINT_BOUNDARY = CLEAR_LINE + " ".repeat(100) + CLEAR_LINE;

/**
 * Parses one chunk of whisper-stream stdout against running state, returning
 * any (partial, committed-line) updates found in this chunk. `state` is a
 * mutable { buffer, partial } the caller keeps across calls (stdout arrives
 * in arbitrary-sized chunks, not aligned to whisper-stream's own print
 * boundaries — including possibly mid-escape-sequence — so partial markers/
 * lines must be able to span calls).
 *
 * Implementation: rather than interleaving regex search with in-place buffer
 * slicing (which is easy to get subtly wrong across chunk boundaries), each
 * call re-splits the ENTIRE buffered-so-far text on REPRINT_BOUNDARY. Every
 * resulting segment except the last is a fully-finished reprint (whisper-
 * stream never emits a boundary mid-text); the last segment is still
 * accumulating and is kept in the buffer untouched until a future call
 * completes it with another boundary. Within a finished segment, a bare
 * "\n" (not part of the boundary) marks whisper-stream's own commit point —
 * text before it is a committed line, text after it (with no "\n" before
 * the next boundary) is the reprint's partial. This whole-buffer-resplit
 * approach is deterministic regardless of how the underlying stdout data
 * happens to be chunked (verified with a throwaway standalone script against
 * byte-by-byte, arbitrary-size, and whole-buffer chunking of both a
 * synthetic sample and a real captured whisper-stream.exe run — see the
 * commit message for the sample and results).
 *
 * Returns an array of events in the order they occurred in this chunk:
 *   { kind: "partial", text }   — the in-progress window text changed
 *   { kind: "committed", text } — a "\n" boundary committed `text` (the
 *                                 partial as of that boundary) to scrollback
 */
export function parseStreamChunk(state, chunk) {
  state.buffer += chunk;
  const events = [];

  // Split on the full reprint-boundary triplet. Every element except the
  // last is a "text run that was immediately followed by a reprint
  // boundary" — i.e. a complete, finished reprint (whisper-stream never
  // emits the boundary mid-text). The last element is whatever has arrived
  // since the most recent boundary, which may or may not be complete yet
  // (more stdout could still extend it), so it always stays in the buffer
  // rather than being emitted as a partial immediately — this avoids
  // flickering a truncated word into the composer before whisper-stream has
  // finished printing that window's text.
  const segments = state.buffer.split(REPRINT_BOUNDARY);
  const finished = segments.slice(0, -1);
  state.buffer = segments[segments.length - 1];

  for (const segment of finished) {
    // Each finished segment is itself "[previous reprint's text]\n"? — a
    // bare "\n" appears WITHIN a segment (not as part of the boundary)
    // whenever whisper-stream commits that window's line before rolling to
    // the next one (see stream.cpp: printf("\n") after n_new_line
    // iterations, emitted right after the text, before the next boundary
    // pair). So: everything up to the first "\n" in this segment is the
    // reprint text (a partial, or a committed line if a "\n" follows it);
    // anything AFTER a "\n" within the same segment (e.g. the
    // "[Start speaking]" banner, which is followed by its own "\r\n" before
    // the very first boundary) is a separate, already-terminated line.
    const lines = segment.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const isLastLineOfSegment = i === lines.length - 1;
      const text = lines[i].replace(/\r$/, "").trim();
      if (isLastLineOfSegment) {
        // No "\n" followed this piece within the segment -> it's the
        // reprint's current (now finished, since a boundary followed it)
        // text -> a partial update, not a commit.
        applyPartial(state, events, text);
      } else {
        // A "\n" followed this piece -> whisper-stream committed it.
        commitLine(state, events, text);
      }
    }
  }

  return events;
}

function commitLine(state, events, text) {
  if (!text || text === "[Start speaking]") {
    // whisper-stream's own startup banner, or an empty line — nothing to
    // commit, but the window that follows starts fresh.
    state.partial = "";
    return;
  }
  const cleaned = text === "<|nospeech|>" ? "" : text;
  if (cleaned) {
    events.push({ kind: "committed", text: cleaned });
  }
  state.partial = "";
}

function applyPartial(state, events, text) {
  const cleaned = text === "<|nospeech|>" ? "" : text;
  if (cleaned !== state.partial) {
    state.partial = cleaned;
    events.push({ kind: "partial", text: cleaned });
  }
}

/**
 * Spawns whisper-stream.exe for one continuous-voice hold. `onEvent` is
 * called with { kind: "partial" | "committed", text } as they are parsed
 * from stdout, and once with { kind: "error", message } if the process
 * fails to start or exits non-zero unexpectedly. Returns the ChildProcess so
 * the caller can track/kill it; killing is the caller's responsibility (see
 * stopStream below) — this function does not resolve/wait for the process to
 * exit, since the whole point is to keep it running until explicitly
 * stopped.
 *
 * @param {string} language full lowercase language NAME ("swedish"/
 *   "english"/…) or "auto"/null/empty — same convention as whisperCpp.js.
 */
export function startStream(language, onEvent) {
  const args = [
    "-m", MODEL_PATH,
    "--step", String(DEFAULT_STEP_MS),
    "--length", String(DEFAULT_LENGTH_MS),
    "--keep", String(DEFAULT_KEEP_MS),
    "-nf", // no temperature fallback — matches whisper-cli's greedy-only tuning
  ];
  const langCode = resolveLanguageCode(language);
  args.push("-l", langCode || "auto");

  const child = spawn(WHISPER_STREAM_PATH, args, {
    cwd: path.dirname(WHISPER_STREAM_PATH),
    windowsHide: true,
  });

  const state = { buffer: "", partial: "" };
  let stderrTail = "";

  child.stdout.on("data", (chunk) => {
    const events = parseStreamChunk(state, chunk.toString("utf8"));
    for (const event of events) {
      onEvent(event);
    }
  });
  child.stderr.on("data", (chunk) => {
    // whisper-stream's own diagnostics (model load, CUDA init, capture
    // device list, the "processing N samples..." info line) — kept only for
    // an error message tail, never surfaced live (mirrors whisperCpp.js's
    // treatment of whisper-cli's stderr).
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-1000);
  });
  child.on("error", (err) => {
    onEvent({ kind: "error", message: `Failed to spawn whisper-stream.exe: ${err.message}` });
  });
  child.on("exit", (code, signal) => {
    // A clean stop (see stopStream) kills the process, which on Windows
    // taskkill reports as a null exit code with no meaningful signal — that
    // is the expected/normal end of a hold, not an error. Anything else
    // (the process crashing on its own, e.g. losing the capture device) is
    // unexpected and worth surfacing so the renderer can fall back instead
    // of silently going quiet mid-hold.
    if (!child.__stoppedByCaller && code !== 0) {
      onEvent({ kind: "error", message: `whisper-stream.exe exited unexpectedly (code ${code}, signal ${signal}): ${stderrTail.slice(-500)}` });
    }
    onEvent({ kind: "exit" });
  });

  return child;
}

/**
 * Kills a whisper-stream.exe process started by startStream. Uses the same
 * Windows taskkill /T /F tree-kill main.js already relies on for claude.exe
 * subprocesses (see killChildTree in main.js) — whisper-stream links SDL2,
 * which on some setups spins up its own helper thread/process for audio
 * capture, so a plain child.kill() is not guaranteed to release the
 * microphone. `sync` mirrors killChildTree's before-quit usage: app
 * shutdown cannot await an async kill without risking the process outliving
 * the app teardown.
 */
export function stopStream(child, { sync = false } = {}) {
  if (!child || child.killed || !child.pid) {
    return;
  }
  child.__stoppedByCaller = true;
  if (process.platform === "win32") {
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
        console.error(`[helm] taskkill failed for whisper-stream pid ${child.pid}:`, err.message);
      }
    });
    return;
  }
  child.kill();
}
