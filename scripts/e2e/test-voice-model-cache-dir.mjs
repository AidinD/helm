// The transformers.js model cache must never resolve inside the app bundle.
//
// @huggingface/transformers picks its cache directory from its OWN module
// location - `path.join(<package root>, '/.cache/')`. In a packaged Helm that
// package sits inside resources/app.asar, which is a FILE: mkdir there fails
// with ENOTDIR (verified against dist/win-unpacked on 2026-09-01), and
// transformers.js swallows the error for the small metadata files and rethrows
// for the .onnx weights - after the ~300MB download has already been paid for.
// Either way the model would be re-fetched on every single app start, and
// nothing would tell the user.
//
// So src/lib/voice.js sets env.cacheDir at import. This check guards both
// halves of that: the directory the resolver picks, and the fact that voice.js
// actually applies it - a resolver nobody calls fixes nothing.
//
// Paths here are built with path.join rather than written as literals: this file
// asserts on Windows paths, and a hand-written one would be a backslash-escaping
// trap in a check whose whole subject is a path.
//
// Run:  node scripts/e2e/test-voice-model-cache-dir.mjs
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { voiceModelCacheDir } from "../../src/lib/voiceModelCache.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");

// Dev: packagedPaths.js leaves every HELM_* var unset. NOT the repo root - this
// is 300MB of downloaded weights, it belongs outside the checkout, and pointing
// dev at the same folder the installed app uses means one download serves both.
ok(
  voiceModelCacheDir({}) === path.join(os.homedir(), ".helm", "voice-models"),
  `dev (no env) resolves to ~/.helm/voice-models, not the repo root: ${voiceModelCacheDir({})}`
);
ok(
  !voiceModelCacheDir({}).startsWith(repo),
  "the dev cache is outside the checkout, so worktrees share one copy instead of one each"
);

// Packaged: packagedPaths.js sets HELM_CONFIG_PATH inside Helm's data dir. Its
// DIRECTORY is that data dir - derived rather than re-decided, so HELM_DATA_DIR
// keeps working without this file having to know the rule.
const installedDataDir = path.join(os.homedir(), ".helm");
ok(
  voiceModelCacheDir({ HELM_CONFIG_PATH: path.join(installedDataDir, "config.json") }) ===
    path.join(installedDataDir, "voice-models"),
  "packaged: follows HELM_CONFIG_PATH's directory (Helm's data dir)"
);
const sharedDataDir = path.join("D:", "Dropbox", "shared-helm");
ok(
  voiceModelCacheDir({ HELM_CONFIG_PATH: path.join(sharedDataDir, "config.json") }) ===
    path.join(sharedDataDir, "voice-models"),
  "packaged with HELM_DATA_DIR pointed elsewhere: the cache follows the data dir there too"
);

// The test seam. Without it the E2E harness - which points HELM_CONFIG_PATH at a
// throwaway temp config - would make every voice check re-download the model
// into a directory it then deletes.
const seam = path.join(os.tmpdir(), "helm-voice-cache-probe");
ok(
  voiceModelCacheDir({ HELM_VOICE_CACHE_DIR: seam, HELM_CONFIG_PATH: path.join(installedDataDir, "config.json") }) === seam,
  "HELM_VOICE_CACHE_DIR overrides everything else"
);
ok(voiceModelCacheDir({ HELM_VOICE_CACHE_DIR: "   " }).endsWith("voice-models"), "a blank override is ignored, not obeyed");

// And the half that matters in production: voice.js must APPLY it. Asked of a
// real import in a child process rather than by grepping the source, because
// what is being checked is the value transformers.js will actually read.
const probe = [
  'import { env } from "@huggingface/transformers";',
  `await import(${JSON.stringify(pathToFileURL(path.join(repo, "src", "lib", "voice.js")).href)});`,
  "console.log(env.cacheDir);",
].join("\n");
let applied = "";
try {
  applied = execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: repo,
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, HELM_VOICE_CACHE_DIR: seam },
  }).trim();
} catch (err) {
  applied = `<threw: ${(err.stderr || err.message || "").toString().split("\n").slice(-3).join(" ")}>`;
}
ok(
  applied === seam,
  `importing voice.js sets transformers' env.cacheDir to the resolved directory (got ${JSON.stringify(applied)})`
);
ok(!applied.includes("node_modules"), "and never leaves it pointing inside node_modules, which is inside app.asar once packaged");

process.exit(exit);
