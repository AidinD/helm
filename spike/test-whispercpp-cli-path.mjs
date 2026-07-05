// Spike: after removing the warm whisper-server, does whisperCpp.transcribeAudio
// still transcribe end-to-end via whisper-cli.exe alone? Confirms the single-clip
// path works with the server layer gone (real whisper-cli.exe subprocess + model
// load). Skips cleanly if .whisper/ isn't installed on this machine.
import { isAvailable, transcribeAudio, buildWavBuffer } from "../src/lib/whisperCpp.js";

function log(msg) {
  console.log(`[spike] ${msg}`);
}
function assert(cond, msg) {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
  log(`OK - ${msg}`);
}

if (!isAvailable()) {
  log("SKIP - .whisper/ (whisper-cli.exe + model) not installed on this machine; cli path can't be exercised here.");
  process.exit(0);
}

// 1s of 16kHz mono silence — enough to exercise the full spawn + model-load +
// decode path without depending on a specific audio fixture. Silence usually
// transcribes to empty or near-empty text; the point is it runs and returns a
// string via the cli path (the server is gone), not the exact text.
const samples = new Float32Array(16000);

// buildWavBuffer is still exported + used by the cli path via writeWavFile.
const wav = buildWavBuffer(samples, 16000);
assert(wav.slice(0, 4).toString("ascii") === "RIFF", "buildWavBuffer still produces a valid RIFF WAV header");

log("Calling transcribeAudio (real whisper-cli.exe subprocess, ~1-2s incl. model load)...");
const t0 = Date.now();
const text = await transcribeAudio(samples, "swedish");
const ms = Date.now() - t0;
log(`transcribeAudio returned in ${ms}ms: ${JSON.stringify(text)}`);

assert(typeof text === "string", "transcribeAudio resolves to a string via the cli path (no server)");
log("ALL CHECKS PASSED");
