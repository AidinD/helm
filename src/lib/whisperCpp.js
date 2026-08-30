// whisper.cpp + CUDA transcription engine — the fast path (see
// docs/transcription-research.md for the full research + decision). Spiked
// 2026-07-05: on the RTX 3070, an 11s clip transcribes in ~1.3s (2.5s
// including one-time model load), vs ~5.6s for a 2s clip on the previous
// transformers.js/onnxruntime CPU path — a 10-20x speedup. Uses KBLab's
// Swedish-specialized kb-whisper-small checkpoint (same model family as
// voice.js, just the GGML format whisper.cpp expects instead of ONNX), so
// this is a runtime swap, not a quality regression risk from a smaller/
// generic model.
//
// This module shells out to the prebuilt whisper-cli.exe binary (no native
// Node addon, no compile step — see voice.js's header comment for why a
// from-source whisper.cpp binding was rejected earlier) rather than linking
// against whisper.cpp directly. The binary + model live outside the repo
// (see .whisper/, gitignored — ~1.5GB of CUDA DLLs + model weights, not
// something to commit) and must be installed manually; isAvailable() below
// lets the caller fall back to the transformers.js path when they are
// missing, e.g. on a machine that hasn't had the .whisper/ folder populated
// yet.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { whisperRoot } from "keel/whisper";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// .whisper/ sits at the repo root (sibling of src/), not inside src/lib —
// see the setup instructions this module's caller followed. Resolved
// relative to this file (not process.cwd()) so it works regardless of the
// Electron process's working directory.
// Resolved by keel, not by walking up from this file. The payload moved out
// of this repo on 2026-08-30 so that Nib could use it too: 1.3GB of CUDA DLLs
// and model weights belong outside every repository, and one copy serves the
// suite. `WHISPER_DIR` overrides it; the default is the folder beside the
// checked-out repos.
const WHISPER_ROOT = whisperRoot();
const WHISPER_CLI_PATH = path.join(WHISPER_ROOT, "Release", "whisper-cli.exe");
const MODEL_PATH = path.join(WHISPER_ROOT, "ggml-model-q5_0.bin");

/**
 * True when both the whisper-cli binary and the GGML model are present on
 * disk. Callers should fall back to the transformers.js path when this is
 * false instead of spawning a binary that doesn't exist.
 */
export function isAvailable() {
  return fs.existsSync(WHISPER_CLI_PATH) && fs.existsSync(MODEL_PATH);
}

// Maps the app's language values (same ones voice.js's DEFAULT_TRANSCRIBE_LANGUAGE
// / config.voiceLanguage use — full lowercase English names, or "auto") to
// whisper.cpp's `-l` ISO-639-1 codes. Only Swedish/English are wired up in
// the composer's language dropdown today; anything unrecognized falls
// through to auto-detect (omitting -l) rather than guessing wrong.
const LANGUAGE_CODES = {
  swedish: "sv",
  english: "en",
};

// Exported for reuse by whisperStream.js (the real-time streaming path),
// which needs the same voiceLanguage -> ISO code mapping whisper-stream.exe's
// own `-l` flag expects.
export function resolveLanguageCode(language) {
  const normalized = (language || "").trim().toLowerCase();
  if (!normalized || normalized === "auto") {
    return null; // omit -l entirely -> whisper.cpp auto-detects
  }
  return LANGUAGE_CODES[normalized] || null;
}

/**
 * Builds a 16-bit PCM WAV file (as an in-memory Buffer) from a mono
 * Float32Array of PCM samples (range [-1, 1]) at the given sample rate.
 * whisper.cpp (via its bundled miniaudio decoder) reads standard PCM WAV
 * directly, so no resampling/format conversion library is needed beyond this
 * — the renderer's recorder already decodes to 16kHz mono before sending
 * samples over IPC (see voice.js's transcribeAudio docstring), so sampleRate
 * is expected to already be 16000 in normal use.
 *
 * Hand-rolled instead of pulling in a WAV-writing dependency: the format is
 * a fixed 44-byte canonical header (no extra chunks) followed by raw 16-bit
 * little-endian PCM data, which is simple enough to not warrant a
 * dependency for it. Returns a Buffer (rather than writing straight to disk)
 * so callers that only need the bytes don't have to round-trip through a
 * temp file just to read it back.
 */
export function buildWavBuffer(float32Samples, sampleRate = 16000) {
  const numSamples = float32Samples.length;
  const bytesPerSample = 2; // 16-bit PCM
  const numChannels = 1;
  const byteRate = sampleRate * numChannels * bytesPerSample;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numSamples * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4); // file size - 8
  buffer.write("WAVE", 8, "ascii");

  // fmt subchunk
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // subchunk1 size (16 = PCM)
  buffer.writeUInt16LE(1, 20); // audio format (1 = PCM integer)
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bytesPerSample * 8, 34); // bits per sample

  // data subchunk
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  // PCM samples: clamp to [-1, 1] and scale to signed 16-bit range, same
  // conversion every float->int16 PCM WAV writer uses.
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const clamped = Math.max(-1, Math.min(1, float32Samples[i]));
    const intSample = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    buffer.writeInt16LE(Math.round(intSample), offset);
    offset += 2;
  }

  return buffer;
}

/**
 * Writes a mono Float32Array of PCM samples to `filePath` as a 16-bit PCM
 * WAV file. Thin wrapper around buildWavBuffer for callers (whisper-cli.exe,
 * which only accepts a file path, not stdin) that need the WAV on disk.
 */
export function writeWavFile(filePath, float32Samples, sampleRate = 16000) {
  fs.writeFileSync(filePath, buildWavBuffer(float32Samples, sampleRate));
}

/**
 * Transcribes a mono Float32Array of 16kHz PCM samples via whisper.cpp by
 * shelling out to whisper-cli.exe per call. This is the single-clip path
 * (the real-time streaming path is whisperStream.js); a warm whisper-server
 * variant was tried and removed 2026-07-05 — it only ever benefited this
 * fallback (streaming is preferred whenever available), so a managed
 * long-lived server process wasn't worth its lifecycle/orphan-cleanup cost
 * for a rarely-hit path where per-call cli latency is acceptable.
 *
 * Flags used (confirmed via `whisper-cli.exe --help` against the build in
 * .whisper/Release):
 *   -m <model>   model path
 *   -f <wav>     input audio file path
 *   -l <lang>    spoken language ISO code, or "auto" (omitted here for
 *                auto-detect since omitting -l defaults to "en", not auto)
 *   -bo 1        best-of 1 (greedy, no candidate resampling)
 *   -bs 1        beam size 1 (greedy, no beam search)
 *   -nt          no timestamps (clean text-only output)
 *
 * @param {Float32Array} float32Samples mono 16kHz PCM samples
 * @param {string} [language] full lowercase language NAME ("swedish"/
 *   "english"/…) or "auto"/null/empty for auto-detect — same convention as
 *   voice.js's transcribeAudio.
 */
export async function transcribeAudio(float32Samples, language) {
  const langCode = resolveLanguageCode(language);

  const tempPath = path.join(os.tmpdir(), `helm-voice-${crypto.randomUUID()}.wav`);
  writeWavFile(tempPath, float32Samples, 16000);
  try {
    const args = ["-m", MODEL_PATH, "-f", tempPath, "-bo", "1", "-bs", "1", "-nt", "-l", langCode || "auto"];
    const stdout = await runWhisperCli(args);
    return stdout.trim();
  } finally {
    fs.promises.unlink(tempPath).catch(() => {
      // Best-effort cleanup — a leftover temp WAV in os.tmpdir() is harmless
      // (OS/user temp cleanup handles it eventually) and not worth failing
      // the transcription over.
    });
  }
}

function runWhisperCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(WHISPER_CLI_PATH, args, {
      cwd: path.dirname(WHISPER_CLI_PATH),
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      reject(new Error(`Failed to spawn whisper-cli.exe: ${err.message}`));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`whisper-cli.exe exited with code ${code}: ${stderr.slice(-500)}`));
        return;
      }
      resolve(stdout);
    });
  });
}
