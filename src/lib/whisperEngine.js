// Where the transcription engine is, and when it is nowhere, why.
//
// ## The bug this exists to close
//
// whisperCpp.js and whisperStream.js each called keel's `whisperRoot()` once, at
// module-import time, with no arguments. Two things followed from that, and both
// were invisible to the person running a checkout.
//
// The first is the one on the card. keel's last-resort candidate walks three
// levels up from its own file - `keel/src/whisper` up to the folder holding the
// repos - which is right in a checkout and wrong in every installed app, where
// the module sits inside `app.asar/node_modules/keel/src/whisper` and the same
// walk points at `app.asar/node_modules/.whisper`. That folder cannot exist:
// package.json excludes the payload from the bundle on purpose, because it is
// 1.5GB of CUDA DLLs and model weights. Measured 2026-09-01 against a real
// packaged layout - a packaged build with nothing configured finds nothing.
//
// The second is worse, because it is what made the first one hard to see. On
// this machine it works anyway: `WHISPER_DIR` is set as a Windows *user*
// environment variable pointing at `D:\whisper`, so an installed Helm launched
// from the Start menu inherits it and resolves correctly. The feature therefore
// works because of an ambient setting that Helm does not own, does not read, does
// not show, and cannot repair. Nothing about the app would change if that
// variable disappeared, except that transcription would quietly stop.
//
// ## What this module changes
//
// Helm gets its own answer, in `config.whisperDir`, and asks for it every time
// instead of once at import. Resolving per call is what lets a setting take
// effect, and what lets somebody install the payload while the app is running
// and have it picked up; the cost is a couple of `existsSync` calls per mic
// press, which is nothing next to spawning a CUDA binary.
//
// ## An explicit setting is an answer, not a hint
//
// If `config.whisperDir` (or `WHISPER_DIR`) is set, that is the root - right or
// wrong. There is deliberately no search past a bad one. keel's own module argues
// the same case and this suite has paid for the alternative twice: somebody
// points an app at a new folder, gets no error because a fallback quietly found
// the old one, and keeps using the old one for days. A wrong setting has to
// produce a complaint about that setting.
//
// The search below it is ordered by how much the app can be sure of the answer:
// the data directory it already owns, then the conventional per-user location for
// something this size, then the checkout layout that only a developer has.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { whisperCandidates, whisperRoot } from "keel/whisper";
import { loadConfig } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The model both engines load. keel names the same file for Swedish. */
export const MODEL_FILE = "ggml-model-q5_0.bin";

/**
 * The directory Helm keeps its own data in - `~/.helm` in a packaged build, the
 * repo root in dev.
 *
 * Derived from HELM_CONFIG_PATH rather than from Electron's `app`, because this
 * module is loaded by the voice utility process (which has no `app`) and by
 * plain-node tests (which have no Electron at all). packagedPaths.js sets that
 * variable before any store lib evaluates, so it is the same answer `app` would
 * have given, available in every process that matters.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function whisperDataDir(env = process.env) {
  const configPath = env.HELM_CONFIG_PATH;
  if (typeof configPath === "string" && configPath.trim().length > 0) {
    return path.dirname(configPath);
  }
  return path.join(__dirname, "..", "..");
}

/**
 * Reads `config.whisperDir` without letting a broken config file take voice
 * down with it.
 *
 * Takes no env deliberately, even though everything around it does. config.js
 * resolves HELM_CONFIG_PATH once when IT is imported, so an env passed in here
 * could not change which file is read and a parameter would only imply
 * otherwise. A caller that needs a different config must set the variable before
 * importing, which is what the packaged bootstrap and the tests both do.
 *
 * @returns {string | null}
 */
function configuredRoot() {
  try {
    const value = loadConfig().whisperDir;
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  } catch {
    // An unreadable config is somebody else's error to report; here it just
    // means "nothing configured", and the search below still has answers.
  }
  return null;
}

/**
 * Where the engine is, and where the answer came from.
 *
 * `source` is the part callers act on: "config" and "env" mean somebody said so,
 * so a missing binary is a wrong setting and the message must say which setting.
 * "search" means nobody said, so a missing binary means it needs installing or
 * pointing at.
 *
 * @param {{ env?: NodeJS.ProcessEnv, config?: string | null }} [options]
 * @returns {{ root: string, source: "config" | "env" | "search", candidates: string[] }}
 */
function resolveWhisperRoot({ env = process.env, config } = {}) {
  const configured = config === undefined ? configuredRoot() : config;
  if (configured) {
    // Handed to keel as its own explicit seam so there is ONE implementation of
    // "explicit wins outright", not a second one here that can drift from it.
    return { root: whisperRoot({ env: { ...env, WHISPER_DIR: configured } }), source: "config", candidates: [configured] };
  }
  const ambient = env.WHISPER_DIR?.trim();
  if (ambient) {
    return { root: whisperRoot({ env }), source: "env", candidates: [ambient] };
  }
  // Nobody said, so search. The data directory Helm already owns goes first: in
  // an installed build that is `~/.helm/whisper`, which is a place the app can
  // name in an error message and a person can actually put files.
  const roots = [path.join(whisperDataDir(env), "whisper")];
  const options = { env, roots };
  return { root: whisperRoot(options), source: "search", candidates: whisperCandidates(options) };
}

/**
 * Whether a named engine binary can run, and if not, a sentence that says what
 * to do about it.
 *
 * Takes the binary name because the two engines are not interchangeable:
 * whisper-cli.exe transcribes a finished clip and whisper-stream.exe owns the
 * microphone live. A machine can have one and not the other, and "voice does not
 * work" is the wrong thing to tell somebody whose one-shot transcription is fine.
 *
 * @param {string} binaryName e.g. "whisper-cli.exe"
 * @param {{ env?: NodeJS.ProcessEnv, config?: string | null }} [options]
 * @returns {{ ready: boolean, root: string, source: string, binary: string, model: string, why: string | null, candidates: string[] }}
 */
export function whisperEngineStatus(binaryName, options = {}) {
  const { root, source, candidates } = resolveWhisperRoot(options);
  const binary = path.join(root, "Release", binaryName);
  const model = path.join(root, MODEL_FILE);
  const hasBinary = fs.existsSync(binary);
  const hasModel = fs.existsSync(model);
  if (hasBinary && hasModel) {
    return { ready: true, root, source, binary, model, why: null, candidates };
  }

  const missing = [!hasBinary ? binaryName : null, !hasModel ? MODEL_FILE : null].filter(Boolean).join(" and ");
  const where =
    source === "config"
      ? `Helm's whisperDir setting points at ${root}`
      : source === "env"
        ? `WHISPER_DIR points at ${root}`
        : `${root} was the best of ${candidates.length} place${candidates.length === 1 ? "" : "s"} tried`;
  const fix =
    source === "search"
      ? `Put the engine in ${path.join(whisperDataDir(options.env ?? process.env), "whisper")}, or set whisperDir in Helm's config to the folder holding Release/ and the models.`
      : "Point that setting at the folder holding Release/ and the models, or clear it to search the usual places.";
  return { ready: false, root, source, binary, model, why: `${missing} not found: ${where}. ${fix}`, candidates };
}
