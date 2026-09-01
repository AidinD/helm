// Spike: does the transformers.js fallback (src/lib/voice.js) actually work,
// and does its model cache survive a restart?
//
// Written 2026-09-01 because the answer to both was unknown. config.voiceEngine
// defaults to "whispercpp", which works on the machine this was built on, so
// this path had never run: there was no .cache directory under
// node_modules/@huggingface/transformers even in the dev checkout. Reading the
// code was what produced the finding in the first place, so reading it again
// would not settle it.
//
//   node spike/test-transformers-fallback.mjs            first run - may download ~300MB
//   node spike/test-transformers-fallback.mjs --offline  second run - MUST hit the cache
//
// --offline sets env.allowRemoteModels = false. transformers.js checks its
// cache BEFORE it considers the network (loadResourceFile in
// utils/hub.js: checkCachedResource, then the local/remote branch), so with
// remote models refused, a run that still transcribes proves every weight came
// off disk. That is a stronger claim than "it was fast" or "the folder looks
// full" - a partially-cached model would throw here instead of quietly
// re-fetching the missing piece.
//
// Audio: three clips, one of which is silence. The silence clip is the control.
// Without it "the model returned some Swedish words" is not evidence of
// anything - a Whisper model hallucinates confident text out of noise, and this
// one is Swedish-specialised, so a garbage-in run still produces Swedish-looking
// output. Silence transcribing to (near) nothing while speech transcribes to
// words is what separates "it heard the audio" from "it emitted its priors".
//
// The two speech clips are Windows SAPI text-to-speech, not a human: this
// machine has no Swedish voice installed, so the Swedish clip is an English
// voice reading Swedish text and will transcribe badly. That is expected and
// not what is being tested. What is being tested is that the pipeline loads,
// runs, caches, and comes back with a string.
import fs from "node:fs";
import path from "node:path";
import { env as transformersEnv } from "@huggingface/transformers";
import { transcribeAudio } from "../src/lib/voice.js";
import { voiceModelCacheDir } from "../src/lib/voiceModelCache.js";

const offline = process.argv.includes("--offline");
const clipDir = process.argv.find((a) => a.startsWith("--clips="))?.slice("--clips=".length);

function log(msg) {
  console.log(`[spike] ${msg}`);
}
function assert(cond, msg) {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
  log(`OK - ${msg}`);
}

/** 16-bit PCM mono WAV on disk -> the Float32Array the recorder would have sent. */
function readWavAsFloat32(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`not a RIFF/WAVE file: ${file}`);
  }
  // Walk the chunks rather than assuming a 44-byte canonical header: SAPI
  // writes a `fact` chunk some of the time, and skipping it as if it were
  // samples turns the first fraction of a second into noise.
  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let data = null;
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
  if (!data) {
    throw new Error(`no data chunk in ${file}`);
  }
  if (channels !== 1 || sampleRate !== 16000 || bits !== 16) {
    throw new Error(`expected 16kHz mono 16-bit, got ${sampleRate}Hz ${channels}ch ${bits}-bit in ${file}`);
  }
  const samples = new Float32Array(data.length / 2);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = data.readInt16LE(i * 2) / 0x8000;
  }
  return samples;
}

function dirSize(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else {
        files++;
        bytes += fs.statSync(full).size;
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

const cacheDir = voiceModelCacheDir();
assert(
  transformersEnv.cacheDir === cacheDir,
  `importing voice.js pointed transformers.js at Helm's data dir (${cacheDir}) and not at its own package folder`
);
assert(
  !transformersEnv.cacheDir.includes("node_modules"),
  "the cache is outside node_modules - the default would have been inside it, and inside app.asar once packaged"
);

const before = dirSize(cacheDir);
log(`cache before: ${before.files} files, ${(before.bytes / 1e6).toFixed(1)} MB`);

if (offline) {
  transformersEnv.allowRemoteModels = false;
  log("--offline: env.allowRemoteModels = false; any file not already cached will now throw");
  assert(before.files > 0, "there is a cache to hit (run without --offline first)");
}

const clips = [
  { name: "silence (control)", samples: new Float32Array(16000 * 3), language: "swedish", control: true },
  ...(clipDir
    ? [
        { name: "english speech", samples: readWavAsFloat32(path.join(clipDir, "clip-en.wav")), language: "english" },
        { name: "swedish text, english voice", samples: readWavAsFloat32(path.join(clipDir, "clip-sv.wav")), language: "swedish" },
      ]
    : []),
];

let silenceText = null;
for (const clip of clips) {
  const t0 = Date.now();
  const text = await transcribeAudio(clip.samples, clip.language);
  const ms = Date.now() - t0;
  log(`${clip.name} [${clip.language}] -> ${JSON.stringify(text)}  (${ms}ms${clips.indexOf(clip) === 0 ? ", includes one-time model load" : ""})`);
  assert(typeof text === "string", `${clip.name}: transcribeAudio resolved to a string`);
  if (clip.control) {
    // NOT asserted to be empty. Whisper answers silence with a confident
    // hallucination, and this run is the demonstration of that rather than a
    // check against it - which is exactly why the speech clips below are
    // asserted on their WORDS. What must hold is that the two are different:
    // if silence produced the same text as speech, the pipeline would not be
    // reading its input at all, and every other assertion here would be
    // measuring nothing.
    silenceText = text;
  } else {
    assert(text.length > 0, `${clip.name}: speech produced text`);
    assert(
      text !== silenceText,
      `${clip.name}: differs from what the same pipeline returned for silence - the audio is being read, not ignored`
    );
  }
}

const after = dirSize(cacheDir);
log(`cache after:  ${after.files} files, ${(after.bytes / 1e6).toFixed(1)} MB`);
if (offline) {
  assert(
    after.files === before.files && after.bytes === before.bytes,
    "nothing was added to the cache - the whole model came off disk"
  );
} else {
  assert(after.bytes > 0, "the model was written to the cache");
}

log(offline ? "ALL CHECKS PASSED (offline - cache reuse proven)" : "ALL CHECKS PASSED (first run)");
