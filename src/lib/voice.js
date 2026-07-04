// Local, offline speech-to-text for the composer's mic button (PLAN.md Phase
// 4 "Voice input" — Kun Chen uses OpenSuperWhisper as his primary
// prompt-composition method). Spiked three options before picking this one
// (see DECISIONS.md): Windows' own OS speech-recognition API has no simple
// Node/Electron binding; nodejs-whisper/whisper-node compile whisper.cpp from
// source and require a Windows make/cmake toolchain the captain doesn't have
// installed; OpenSuperWhisper itself is macOS-only. `@huggingface/transformers`
// (transformers.js) runs Whisper via prebuilt ONNX runtime binaries — no C++
// compile step — and auto-downloads a small (~150MB) model to its own cache
// on first use, which is a one-time background download, not a blocking
// manual install.
import { pipeline } from "@huggingface/transformers";

// Multilingual tiny model (no ".en" suffix) — v1 shipped "whisper-tiny.en",
// which is an ENGLISH-ONLY fine-tune and was never going to transcribe
// Swedish (the captain's report: "Språk funkar inte för svenska"). Same size class
// as before (~150MB), just multilingual weights. `language` is left
// unspecified below (transformers.js defaults it to `null` = auto-detect),
// not hardcoded to "sv" — the captain mixes Swedish and English naturally in the
// same utterance, so per-call language forcing would fight his actual usage
// more than it helps.
const MODEL_ID = "Xenova/whisper-tiny";

// Loaded once, reused across every transcription call in the process
// lifetime — re-creating the pipeline per call would re-load the ~150MB model
// from disk every time (see the spike: ~1.4s warm load vs ~8s cold download).
let transcriberPromise = null;

function getTranscriber() {
  if (!transcriberPromise) {
    transcriberPromise = pipeline("automatic-speech-recognition", MODEL_ID, { dtype: "fp32" }).catch((err) => {
      // Let the next call retry instead of permanently caching a failure
      // (e.g. a transient network error on the first-ever model download).
      transcriberPromise = null;
      throw err;
    });
  }
  return transcriberPromise;
}

/**
 * Transcribes a mono Float32Array of PCM audio samples at 16kHz (the format
 * the renderer's recorder decodes to before sending over IPC) into text.
 * Returns the trimmed text, or "" if nothing recognizable came through.
 */
export async function transcribeAudio(float32Samples) {
  const transcriber = await getTranscriber();
  const result = await transcriber(float32Samples);
  return (result?.text || "").trim();
}
