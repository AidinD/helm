// Entry point for the voice-transcription utility process, forked via
// Electron's `utilityProcess.fork()` from main.js. Runs in its own OS
// process with its own V8 event loop, so the (CPU-bound) ONNX inference in
// voice.js's transcribeAudio never blocks the Electron main process's event
// loop.
//
// Why this exists: before this worker, `voice:transcribe` ran
// transcribeAudio() directly on the main process's IPC handler. That is a
// CPU-bound synchronous-ish computation (ONNX matmuls under the hood, not an
// I/O wait), so a multi-second transcription starved the main process's
// event loop, and every OTHER IPC call the renderer made during that window
// (including the mic button's own mousedown/mouseup handlers, which are
// renderer-side but still round-trip through main for session state) queued
// up behind it - this is what made the mic button feel laggy, not just the
// transcription itself. Moving inference into a dedicated process means the
// main process only ever does a cheap postMessage + await reply.
//
// Communication protocol (main.js <-> this worker), over Electron's
// `MessagePortMain`-based utility-process IPC (`process.parentPort`):
//   main -> worker: { id, samples: number[], language: string, engine: string }
//   worker -> main: { id, ok: true, text } | { id, ok: false, error }
// `id` round-trips a request to its response so overlapping calls (the
// rolling re-transcription tick firing while a previous one is still
// in-flight, or a rolling tick overlapping the final on-release
// transcription) never get matched to the wrong reply. samples travels as a
// plain number array (same reasoning as the renderer->main hop already
// documented in main.js: structured-clone of a Float32Array isn't reliable
// across every Electron IPC boundary), rebuilt into a Float32Array here.
//
// `engine` selects the transcription backend (config.voiceEngine, see
// config.js): "whispercpp" spawns the whisper.cpp CUDA subprocess (see
// whisperCpp.js — ~10-20x faster, see docs/transcription-research.md),
// "transformers" uses the original @huggingface/transformers ONNX pipeline
// (voice.js). whisper.cpp's binary+model live outside the repo (.whisper/,
// gitignored) and may not be installed on every machine, so a request for
// "whispercpp" silently falls back to "transformers" (with a logged
// warning) when whisperCpp.isAvailable() is false, rather than failing the
// transcription outright.
import { transcribeAudio as transcribeWithTransformers } from "./voice.js";
import { transcribeAudio as transcribeWithWhisperCpp, isAvailable as whisperCppAvailable } from "./whisperCpp.js";

function transcribe(samples, language, engine) {
  if (engine === "whispercpp") {
    if (whisperCppAvailable()) {
      return transcribeWithWhisperCpp(samples, language);
    }
    console.warn("[helm] voiceEngine is \"whispercpp\" but .whisper/ binary+model are missing; falling back to transformers.js");
  }
  return transcribeWithTransformers(samples, language);
}

process.parentPort.on("message", (event) => {
  const { id, samples, language, engine } = event.data;
  transcribe(Float32Array.from(samples), language, engine)
    .then((text) => {
      process.parentPort.postMessage({ id, ok: true, text });
    })
    .catch((err) => {
      process.parentPort.postMessage({ id, ok: false, error: err.message });
    });
});
