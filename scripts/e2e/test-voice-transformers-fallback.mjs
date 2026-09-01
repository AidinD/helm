// The transformers.js fallback, driven through the real app.
//
// config.voiceEngine defaults to "whispercpp", and whisper.cpp works on the
// machine this was built on, so until 2026-09-01 the fallback had never run
// anywhere: there was no model cache under node_modules/@huggingface/
// transformers in the dev checkout either. Settings called it the engine that
// "always works", which was a claim nobody had ever tested.
//
// This drives the whole pipe the mic button uses - renderer IPC -> main ->
// utilityProcess -> voiceWorker -> voice.js - with voiceEngine set to
// "transformers", and asserts the words come back. Not silence: silence proves
// only that the pipe returns a string, and Whisper answers silence with a
// confident hallucination (measured: "Jag kunde inte släppa banden."). Real
// speech transcribed correctly is the only result that separates "it heard the
// audio" from "it emitted its priors".
//
// The clip is Windows SAPI text-to-speech, generated here rather than committed:
// a WAV in the repo is a binary asset nobody can diff, and this app is
// Windows-only anyway. English, because no Swedish voice ships with Windows -
// the model is Swedish-specialised, so English is the harder ask and a pass
// means more, not less.
//
// SKIPS when the model cache is empty. Downloading 300MB is not something a
// test suite should do behind someone's back; `node spike/test-transformers-
// fallback.mjs` is the deliberate way to populate it.
//
// Run:  node scripts/e2e/test-voice-transformers-fallback.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { voiceModelCacheDir } from "../../src/lib/voiceModelCache.js";

let exit = 0;
let app = null;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const SPOKEN = "The quick brown fox jumps over the lazy dog near the river bank.";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-voicefb-"));

// The real cache, not this run's temp dir. The harness points HELM_CONFIG_PATH at
// a throwaway config, and voiceModelCacheDir derives from that - so without this
// override every run of this check would re-download the model into a directory
// it then deletes.
const cacheDir = voiceModelCacheDir({});
const cachedModel = path.join(cacheDir, "onnx-community", "kb-whisper-small-ONNX", "onnx", "encoder_model_q4.onnx");
if (!fs.existsSync(cachedModel)) {
  console.log(`SKIPPED - no transformers.js model cached at ${cacheDir}; run: node spike/test-transformers-fallback.mjs`);
  process.exit(0);
}

const wavPath = path.join(tmp, "clip.wav");
try {
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      [
        "Add-Type -AssemblyName System.Speech;",
        "$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono);",
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
        "$s.Rate = -1;",
        `$s.SetOutputToWaveFile('${wavPath}', $fmt);`,
        `$s.Speak('${SPOKEN}');`,
        "$s.Dispose();",
      ].join(" "),
    ],
    { stdio: "pipe", timeout: 60000 }
  );
} catch (err) {
  console.log(`SKIPPED - Windows speech synthesis is not available here: ${err.message.split("\n")[0]}`);
  process.exit(0);
}
if (!fs.existsSync(wavPath) || fs.statSync(wavPath).size < 5000) {
  console.log("SKIPPED - speech synthesis produced no usable audio (no voice installed?)");
  process.exit(0);
}

/** 16kHz mono 16-bit PCM WAV -> the plain float array the renderer sends over IPC. */
function wavToFloats(file) {
  const buf = fs.readFileSync(file);
  let offset = 12;
  let data = null;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  // Chunk walk rather than a fixed 44-byte header: SAPI sometimes writes a
  // `fact` chunk, and treating it as samples turns the start into noise.
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      data = buf.subarray(body, body + size);
    }
    offset = body + size + (size % 2);
  }
  if (!data || channels !== 1 || sampleRate !== 16000 || bits !== 16) {
    throw new Error(`expected 16kHz mono 16-bit PCM, got ${sampleRate}Hz ${channels}ch ${bits}-bit`);
  }
  const out = new Array(data.length / 2);
  for (let i = 0; i < out.length; i++) {
    // Rounded to five decimals: this array is inlined into a CDP eval
    // expression, and full float precision makes that string three times
    // longer for detail below one 16-bit step (1/32768 is 3e-5).
    out[i] = Number((data.readInt16LE(i * 2) / 0x8000).toFixed(5));
  }
  return out;
}

const samples = wavToFloats(wavPath);

process.env.HELM_CONFIG_PATH = path.join(tmp, "config.json");
process.env.HELM_META_HOME_OVERRIDE = path.join(tmp, "meta-home");
process.env.HELM_VOICE_CACHE_DIR = cacheDir;
// Point whisper.cpp at a folder that does not exist, so it is unavailable here
// whether or not this machine has the 1.5GB payload installed (keel's
// whisperRoot honours WHISPER_DIR verbatim and does not search past it). Two
// things follow: the transcript below can only have come from transformers.js,
// and a run that reached this point by the WRONG route - config not read, so
// the engine defaulted to whispercpp - would have had to announce a fallback,
// which the last assertion refuses. Without this the check would pass on a
// whisper.cpp transcript and prove nothing.
process.env.WHISPER_DIR = path.join(tmp, "no-whisper-here");
process.env.HELM_E2E_PORT = process.env.HELM_E2E_PORT || "9561";
// The point of the whole check: the app must take the transformers.js branch,
// not whisper.cpp, whether or not whisper.cpp happens to be installed here.
fs.writeFileSync(process.env.HELM_CONFIG_PATH, JSON.stringify({ voiceEngine: "transformers" }), "utf8");

const { launch } = await import("./harness.mjs");

try {
  app = await launch();
  await app.waitForSelector("#pageToggle");

  const result = await app.eval(
    `(async () => {
       const t0 = Date.now();
       const r = await window.helm.transcribeVoice(${JSON.stringify(samples)}, "english");
       return { ...r, ms: Date.now() - t0 };
     })()`
  );

  // Asked of MAIN, not of the renderer's copy: config:set with an empty patch
  // returns what loadConfig() sees, which is the same value the transcribe
  // handler passes to the worker. If this said "whispercpp", the transcript
  // below would be evidence about the wrong engine.
  const engine = await app.eval(`window.helm.setConfig({}).then((c) => c.voiceEngine)`);
  ok(engine === "transformers", `the main process reads the engine it was given (voiceEngine: ${JSON.stringify(engine)})`);

  ok(result?.ok === true, `voice:transcribe succeeded through the transformers engine${result?.error ? ` (error: ${result.error})` : ""}`);
  const text = (result?.text || "").toLowerCase();
  console.log(`     transcript: ${JSON.stringify(result?.text)} (${result?.ms}ms)`);
  ok(text.includes("brown fox"), "the transcript contains the words that were spoken - the engine read the audio, it did not hallucinate");
  ok(text.includes("lazy dog"), "the whole clip was transcribed, not just its opening");

  // whisper.cpp is unreachable in this process tree (WHISPER_DIR above), so the
  // words can only have come from transformers.js. What remains to check is the
  // ROUTE: the worker logs this warning only when it was asked for whispercpp
  // and had to fall back, so its absence means the config reached it and it went
  // straight to transformers.
  const stderr = app.stderr?.join?.("") || "";
  ok(
    !stderr.includes("falling back to transformers"),
    "the app never announced a fallback - it was asked for transformers.js and used it directly"
  );
} catch (err) {
  ok(false, `threw: ${err.message}`);
} finally {
  await app?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

process.exit(exit);
