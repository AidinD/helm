// Where the transformers.js fallback keeps the Whisper ONNX weights it
// downloads (~300MB at the current q4 dtype — see voice.js's MODEL_DTYPE).
//
// Its own module, not a function inside voice.js, so this can be tested
// without importing @huggingface/transformers (which pulls in the
// onnxruntime-node native addon and several seconds of module init for a
// question about a file path).
//
// ## Why this has to be set at all
//
// @huggingface/transformers computes its default cache directory from its OWN
// module location: `path.join(dirname__, '/.cache/')`, where `dirname__` is the
// package root (node_modules/@huggingface/transformers/env.js). In a checkout
// that is a writable folder under node_modules. In a packaged Helm it is
// INSIDE `resources/app.asar` — and @huggingface is not in electron-builder's
// asarUnpack list (only `@img` and `onnxruntime-node` are unpacked, verified
// against dist/win-unpacked on 2026-09-01), so the whole package is sealed
// inside the read-only archive and nothing can ever be written beside it.
//
// The failure that produces is not a clean one. transformers.js writes the
// small metadata files (config.json, tokenizer.json) through a path that
// swallows a cache-write error and carries on, so those silently re-download
// on every single app start; the big .onnx weights go through FileCache.put,
// which rethrows — after the full download has already been paid for. Either
// way the model is fetched again every time the app starts, and nothing in the
// UI says so.
//
// ## Where it points instead
//
// Helm's own data directory, which is writable in both builds and — unlike the
// repo root — is one location shared by the dev app, the installed app, and
// every git worktree, so the download is paid for once on a machine rather than
// once per checkout. Same split keel uses for whisper.cpp's 1.5GB payload: the
// code is versioned, the content is not.
import os from "node:os";
import path from "node:path";

/**
 * The directory transformers.js should cache downloaded model weights in.
 *
 *   HELM_VOICE_CACHE_DIR  explicit override (and the seam a test points at a
 *                         temp dir, so a check never touches the real cache).
 *   HELM_CONFIG_PATH      set by packagedPaths.js in a packaged build — its
 *                         directory IS Helm's data dir (HELM_DATA_DIR, or
 *                         ~/.helm by default). Deriving from it rather than
 *                         re-deriving the rule keeps one source of truth.
 *   ~/.helm               dev, where packagedPaths.js leaves everything unset.
 *                         Deliberately NOT the repo root: this is 300MB of
 *                         downloaded weights, it belongs outside the checkout,
 *                         and pointing dev at the same folder the installed app
 *                         uses means one download serves both.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} absolute path
 */
export function voiceModelCacheDir(env = process.env) {
  const override = (env.HELM_VOICE_CACHE_DIR || "").trim();
  if (override) {
    return override;
  }
  const configPath = (env.HELM_CONFIG_PATH || "").trim();
  const dataDir = configPath ? path.dirname(configPath) : path.join(os.homedir(), ".helm");
  return path.join(dataDir, "voice-models");
}
