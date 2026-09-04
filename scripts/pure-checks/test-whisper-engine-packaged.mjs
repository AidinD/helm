/**
 * Does the transcription engine resolve in an INSTALLED build, and say why when
 * it does not?
 *
 * ## The bug
 *
 * keel's last-resort candidate walks three levels up from its own file. In a
 * checkout that is `keel/src/whisper` up to the folder holding the repos, and it
 * is right. Packaged, the module sits inside
 * `app.asar/node_modules/keel/src/whisper`, so the same walk points at
 * `app.asar/node_modules/.whisper` - a folder that cannot exist, because
 * package.json deliberately keeps the 1.5GB payload out of the installer.
 *
 * Helm shipped that way for months. Nobody noticed for two reasons, and the
 * second is the one worth writing down: the person running it runs a checkout,
 * AND on that same machine a Windows user environment variable happens to point
 * `WHISPER_DIR` at the payload. So the installed app worked - through an ambient
 * setting Helm did not own, did not read, did not show, and could not repair.
 *
 * ## Why this test is shaped the way it is
 *
 * The acceptance criterion was "a test catches it without anyone manually
 * inspecting an asar". Inspecting the built asar would be the obvious way and it
 * is the wrong one: it only works after a build, on the machine that built it,
 * and it tests the packaging rather than the resolution.
 *
 * So the packaged LAYOUT is reproduced on disk instead - keel's module copied to
 * the depth a packaged app really puts it at - and the resolver is asked from
 * there. It runs in the fast lane, needs no Electron, and fails on a checkout the
 * moment the resolution goes back to guessing.
 *
 * The environment is built explicitly in every case rather than inherited,
 * because this machine's own WHISPER_DIR would otherwise make every case pass
 * and the test would assert nothing. That is the exact accident being tested for.
 *
 * Run: node scripts/e2e/test-whisper-engine-packaged.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..", "..");

let fails = 0;
const ok = (cond, label, detail = "") => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!cond) {
    fails += 1;
  }
};

// --- a packaged layout, on disk -------------------------------------------------
// keel's whisper module imports node builtins only, so a copy at the right depth
// resolves exactly as the packaged one does.
const KEEL_WHISPER = path.join(repoRoot, "node_modules", "keel", "src", "whisper", "index.mjs");
ok(fs.existsSync(KEEL_WHISPER), "keel's whisper module is where this test expects it", KEEL_WHISPER);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-whisper-packaged-"));
const packagedDir = path.join(tmp, "resources", "app.asar", "node_modules", "keel", "src", "whisper");
fs.mkdirSync(packagedDir, { recursive: true });
fs.copyFileSync(KEEL_WHISPER, path.join(packagedDir, "index.mjs"));
const packaged = await import(pathToFileURL(path.join(packagedDir, "index.mjs")).href);

// A folder that looks like a real payload, so "found" means found rather than
// "the check is too weak to tell". Only the two files the code actually opens.
function fakePayload(name) {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, "Release"), { recursive: true });
  fs.writeFileSync(path.join(root, "Release", "whisper-cli.exe"), "not really a binary");
  fs.writeFileSync(path.join(root, "ggml-model-q5_0.bin"), "not really a model");
  return root;
}
const payload = fakePayload("payload");

// --- the bug itself, still true -------------------------------------------------
// Asserted rather than assumed: if keel ever ships the payload inside the bundle
// this stops being true, and a test that quietly kept passing would hide that.
{
  const walked = path.resolve(packagedDir, "..", "..", "..", ".whisper");
  ok(!fs.existsSync(walked), "the relative walk from a packaged position lands nowhere", walked);
  const status = packaged.whisperStatus("sv", { env: {}, roots: [] });
  ok(!status.ready, "so a packaged build with nothing configured finds no engine");
  ok(typeof status.why === "string" && status.why.length > 0, "and says why rather than just failing", status.why);
}

// --- Helm's own resolver, asked from the packaged position ----------------------
// Imported with HELM_CONFIG_PATH pointed at a temp config, which is both the test
// seam and the thing being tested: it is how the module works out the data
// directory in an installed build.
const configPath = path.join(tmp, "config.json");
fs.writeFileSync(configPath, JSON.stringify({}), "utf8");
process.env.HELM_CONFIG_PATH = configPath;
const engine = await import(pathToFileURL(path.join(repoRoot, "src", "lib", "whisperEngine.js")).href);

const writeConfig = (value) => fs.writeFileSync(configPath, JSON.stringify(value === null ? {} : { whisperDir: value }), "utf8");

// A packaged install with nothing set: not ready, and the message names the
// folder somebody can actually put files in.
{
  writeConfig(null);
  const status = engine.whisperEngineStatus("whisper-cli.exe", { env: { HELM_CONFIG_PATH: configPath } });
  ok(!status.ready, "an installed build with nothing configured is not ready");
  ok(status.source === "search", "and knows nobody told it where to look", status.source);
  ok(
    typeof status.why === "string" && status.why.includes(path.join(tmp, "whisper")),
    "and its message names the data directory a person can put the payload in",
    status.why
  );
}

// The setting is the fix, and it takes effect without a restart - the whole point
// of resolving per call instead of once at import.
{
  writeConfig(payload);
  const status = engine.whisperEngineStatus("whisper-cli.exe", { env: { HELM_CONFIG_PATH: configPath } });
  ok(status.ready, "pointing the setting at the payload makes it ready", status.ready ? status.root : status.why);
  ok(status.source === "config", "and the answer is attributed to the setting", status.source);
  ok(status.binary.startsWith(payload) && status.model.startsWith(payload), "with both binary and model taken from that root");
}

// A wrong setting must complain about the SETTING. Searching past it is the
// failure this suite has paid for twice: somebody repoints an app, sees no error
// because a fallback quietly found the old copy, and keeps using the old copy.
{
  const wrong = path.join(tmp, "nowhere-at-all");
  writeConfig(wrong);
  const status = engine.whisperEngineStatus("whisper-cli.exe", {
    // A working payload reachable by every other route. If any of them is
    // consulted, the wrong setting silently succeeds and this assertion fails.
    env: { HELM_CONFIG_PATH: configPath, WHISPER_DIR: payload, LOCALAPPDATA: path.dirname(payload) },
  });
  ok(!status.ready, "a wrong setting fails even when the payload is reachable another way");
  ok(status.root === wrong, "and the root it reports is the one that was set", status.root);
  ok(/whisperDir/.test(status.why || ""), "and the message names that setting, not a fallback", status.why);
}

// With no setting, the ambient variable is still honoured - it is how this
// machine works today, and taking it away silently would be its own regression.
{
  writeConfig(null);
  const status = engine.whisperEngineStatus("whisper-cli.exe", { env: { HELM_CONFIG_PATH: configPath, WHISPER_DIR: payload } });
  ok(status.ready, "WHISPER_DIR still works when nothing is configured");
  ok(status.source === "env", "and is reported as coming from the environment", status.source);
}

// The two binaries are asked about separately. A machine with whisper-cli.exe and
// no whisper-stream.exe is a real state, and answering "voice is unavailable" for
// it would be wrong.
{
  writeConfig(payload);
  const cli = engine.whisperEngineStatus("whisper-cli.exe", { env: { HELM_CONFIG_PATH: configPath } });
  const stream = engine.whisperEngineStatus("whisper-stream.exe", { env: { HELM_CONFIG_PATH: configPath } });
  ok(cli.ready && !stream.ready, "one engine present and the other missing is reported as exactly that");
  ok(/whisper-stream\.exe/.test(stream.why || ""), "and the missing one is named", stream.why);
}

// --- nothing resolves at import time ---------------------------------------------
// The original bug was not only a wrong path, it was a path decided once, before
// any config existed. A module that answers from a constant cannot be fixed by a
// setting, so this asks the same question twice across a change.
{
  writeConfig(null);
  const before = engine.whisperEngineStatus("whisper-cli.exe", { env: { HELM_CONFIG_PATH: configPath } });
  writeConfig(payload);
  const after = engine.whisperEngineStatus("whisper-cli.exe", { env: { HELM_CONFIG_PATH: configPath } });
  ok(!before.ready && after.ready, "a setting written after import changes the answer", `${before.source} -> ${after.source}`);
}

// --- and the callers really go through it ------------------------------------------
// Source-level, because the two engine modules cannot be imported here without
// pulling in their spawn paths. Comments are stripped first: a check that matches
// its own explanatory comment passes when the guarded line is commented out.
{
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const file of ["whisperCpp.js", "whisperStream.js"]) {
    const src = strip(fs.readFileSync(path.join(repoRoot, "src", "lib", file), "utf8"));
    ok(!/const\s+WHISPER_ROOT\s*=/.test(src), `${file} no longer decides its root at import time`);
    ok(/whisperEngineStatus/.test(src), `${file} asks whisperEngine instead`);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
if (fails > 0) {
  console.log(`VERIFY FAILED: ${fails} assertion(s)`);
  process.exit(1);
}
console.log("VERIFY OK: a packaged build resolves its engine from a setting it owns, and names the reason when it cannot.");
