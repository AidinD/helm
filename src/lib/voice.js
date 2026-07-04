// Local, offline speech-to-text for the composer's mic button (PLAN.md Phase
// 4 "Voice input" — Kun Chen uses OpenSuperWhisper as his primary
// prompt-composition method). Spiked three options before picking this one
// (see DECISIONS.md): Windows' own OS speech-recognition API has no simple
// Node/Electron binding; nodejs-whisper/whisper-node compile whisper.cpp from
// source and require a Windows make/cmake toolchain the captain doesn't have
// installed; OpenSuperWhisper itself is macOS-only. `@huggingface/transformers`
// (transformers.js) runs Whisper via prebuilt ONNX runtime binaries — no C++
// compile step — and auto-downloads the model to its own cache on first use,
// which is a one-time background download, not a blocking manual install.
// (The current Swedish-specialized model is larger than the old ~150MB base —
// see MODEL_ID below — but is still a one-time cached download.)
import { pipeline } from "@huggingface/transformers";

// Swedish-SPECIALIZED model. Progression: "whisper-tiny.en" (English-only,
// couldn't do Swedish at all) → "whisper-tiny" (generic multilingual, "väldigt
// dålig") → "whisper-base" (generic multilingual, still "bedrövlig" on Swedish
// in the captain's live test) → this one. The generic OpenAI/Xenova multilingual
// checkpoints are simply weak at Swedish at these small sizes; going a size up
// (generic whisper-small) helps only marginally. The real fix is a
// Swedish-specialized model: KBLab (Kungliga biblioteket / National Library of
// Sweden) trained KB-Whisper on 50,000+ hours of Swedish audio, and
// onnx-community re-packaged it with ONNX weights specifically for
// transformers.js (@huggingface/transformers) — same runtime we already use,
// still no C++ compile step. Verified locally: it downloads, initializes, and
// transcribes Swedish through this exact pipeline (see the standalone load+run
// test noted in the swap report). "small" is the accuracy sweet spot; sizes up
// (kb-whisper-medium/-large ONNX) exist if even more accuracy is wanted, at a
// much larger download.
//
// NOTE: real Swedish transcription QUALITY still needs the captain's live mic test —
// a silent/synthetic buffer only proves the pipeline runs, not that dictation
// is accurate. If it's good, this is the destination; if not, bump to
// "onnx-community/kb-whisper-medium-ONNX".
const MODEL_ID = "onnx-community/kb-whisper-small-ONNX";

// Default transcription language when a caller passes nothing. Kept as
// "swedish" so a stale caller (or any code path that forgets to pass a
// language) preserves the pre-picker forced-Swedish behavior rather than
// silently changing to auto-detect. The actual per-use language now comes
// from the composer's language dropdown (config.voiceLanguage), plumbed
// through renderer -> IPC -> here (see DECISIONS.md, "voice language picker").
//
// transformers.js expects the full lowercase language NAME here ("swedish",
// "english", "norwegian", …), NOT the ISO code. The special value "auto"
// (also null/empty) means auto-detect: we then OMIT the `language` option
// entirely from the pipeline call, which is how transformers.js's ASR
// pipeline triggers language auto-detection (its own JSDoc: language "Default
// is `null`, meaning it should be auto-detected.").
const DEFAULT_TRANSCRIBE_LANGUAGE = "swedish";

// Loaded once, reused across every transcription call in the process
// lifetime — re-creating the pipeline per call would re-load the (now larger,
// ~1GB fp32) model from disk every time. Verified load+run for this model:
// ~64s cold (includes the one-time download) and ~6s per transcription; warm
// re-use skips the download.
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
 *
 * @param {Float32Array} float32Samples mono 16kHz PCM samples
 * @param {string} [language] full lowercase language NAME transformers.js
 *   accepts ("swedish"/"english"/…), or "auto"/null/empty for auto-detect.
 *   Defaults to "swedish" so a stale caller never breaks (see above).
 */
export async function transcribeAudio(float32Samples, language = DEFAULT_TRANSCRIBE_LANGUAGE) {
  const transcriber = await getTranscriber();
  // Auto-detect: omit `language` entirely so transformers.js detects it from
  // the audio (passing null/"auto" as a language name would be rejected).
  const normalized = (language || "").trim().toLowerCase();
  const options =
    !normalized || normalized === "auto"
      ? { task: "transcribe" }
      : { language: normalized, task: "transcribe" };
  const result = await transcriber(float32Samples, options);
  return (result?.text || "").trim();
}
