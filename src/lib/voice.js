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

// Multilingual "base" model. Progression: "whisper-tiny.en" (English-only,
// couldn't do Swedish at all) → "whisper-tiny" (multilingual, but the captain
// tested it live and Swedish was "väldigt dålig och unreliable" — tiny is
// just too small for good non-English accuracy) → "whisper-base" here, the
// next size up, his own suggestion, for materially better Swedish. Larger
// one-time download than tiny and a bit slower per transcription, an
// accepted tradeoff for usable Swedish. If base is still not good enough,
// "whisper-small" is the next step (bigger again).
const MODEL_ID = "Xenova/whisper-base";

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
