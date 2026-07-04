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

// Multilingual tiny model (no ".en" suffix) — the English-only "whisper-tiny.en"
// couldn't transcribe Swedish at all.
const MODEL_ID = "Xenova/whisper-tiny";

// Force Swedish transcription rather than letting Whisper auto-detect the
// language. Auto-detect was the ACTUAL bug behind "still doesn't work for
// Swedish" (the captain, 2026-07-04): on his Swedish speech it guessed English and
// transcribed the audio as best-fit English words — total garbage, since the
// words are Swedish. Forcing the language removes that guess. transformers.js
// takes the full lowercase language name here ("swedish"), not the ISO code.
//
// Tradeoff, deliberately accepted for v1: the captain mixes Swedish and English, and
// a hard "swedish" will now mis-handle a purely-English utterance the mirror
// way. But his prompts are Swedish-dominant and Whisper tolerates embedded
// English tech terms under a Swedish language setting far better than the
// reverse (Swedish-under-English, which is what was failing). A language
// toggle/picker in the composer is the proper fix for true mixed use — noted
// as the follow-up rather than built now (would need renderer/IPC plumbing).
const TRANSCRIBE_LANGUAGE = "swedish";

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
  const result = await transcriber(float32Samples, { language: TRANSCRIBE_LANGUAGE, task: "transcribe" });
  return (result?.text || "").trim();
}
