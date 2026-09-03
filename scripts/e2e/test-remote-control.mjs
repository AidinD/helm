// Unit test (pure node): the "Continue on mobile" Remote Control launcher.
// No real terminal is opened - spawn/tmpDir/platform/claude are injected.
//
// It names claude.exe only as a fabricated path handed to an injected fake spawn, so no
// CLI is started and nothing is spent (test-live-checks-declared.mjs sees that too).
//
// Run:  node scripts/e2e/test-remote-control.mjs
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
  buildRemoteControlArgs,
  buildLauncherScript,
  continueOnMobile,
} from "../../src/lib/remoteControl.js";

let exit = 0;
function assert(cond, msg) {
  console.log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exit = 1;
  }
}

// --- buildRemoteControlArgs ---
const withId = buildRemoteControlArgs({ cliSessionId: "abc-123_DEF", title: "Fix login" });
assert(
  JSON.stringify(withId) === JSON.stringify(["--resume", "abc-123_DEF", "--remote-control", "--name", "Fix login"]),
  "args with a valid id: --resume <id> --remote-control --name <title>"
);
const noId = buildRemoteControlArgs({ cliSessionId: "", title: "Fresh" });
assert(!noId.includes("--resume"), "no id => no --resume (starts a fresh RC session)");
assert(noId.includes("--remote-control") && noId[noId.indexOf("--name") + 1] === "Fresh", "no-id path still passes --remote-control + name");
const badId = buildRemoteControlArgs({ cliSessionId: "evil; rm -rf /", title: 'A "quoted" name' });
assert(!badId.includes("--resume"), "a non-uuid-shaped id is rejected (no --resume injected)");
assert(badId[badId.indexOf("--name") + 1] === "A quoted name", "title is sanitized (quotes stripped)");

// --- buildLauncherScript ---
const script = buildLauncherScript({
  cwd: "D:\\Repo\\Tools\\helm",
  claudePath: "C:\\Users\\me\\claude.exe",
  args: ["--resume", "abc-123", "--remote-control", "--name", "My Session"],
  title: "My Session",
});
assert(/cd \/d "D:\\Repo\\Tools\\helm"/.test(script), "script cd's into the session cwd (quoted)");
assert(script.includes('"C:\\Users\\me\\claude.exe"'), "script invokes the resolved claude binary (quoted)");
assert(/--remote-control/.test(script) && /--name "My Session"/.test(script), "script carries the RC flag + quoted name");
assert(script.includes("\r\n"), "script uses CRLF line endings (a .cmd file)");

// --- the window survives long enough to be read -------------------------------------------
//
// This console is the ONLY place the session URL, the QR code and any eligibility error
// appear - Remote Control is a gated research preview, and when it refuses it refuses at once.
// The script used to end on an echo, so the window closed the instant claude exited and took
// the reason with it. It also opens MINIMIZED, which makes a console that flashes and leaves
// nothing behind even less visible - and that is precisely what "the remote session did not
// even work" looks like from the outside.
//
// It was the likeliest explanation for that report, because everything upstream checks out:
// the installed CLI has --remote-control, --resume and --name, and the argv Helm builds is
// valid against it. Checked rather than assumed, and the argument-order trap that
// `--remote-control [name]` invites was checked too - the name goes through --name, which
// exists.
assert(/^pause$/m.test(script), "the script pauses, so the window does not close on top of the reason it closed");
assert(/set RC_EXIT=%ERRORLEVEL%/.test(script), "and it captures the exit code");
// ORDER, not just presence. ERRORLEVEL is overwritten by the next command - an echo included -
// so capturing it one line later would read that command's status instead of claude's, and
// every failure would report as a clean exit.
{
  const lines = script.split("\r\n");
  const callAt = lines.findIndex((l) => l.includes("claude.exe"));
  const captureAt = lines.findIndex((l) => l.includes("set RC_EXIT="));
  assert(
    callAt >= 0 && captureAt === callAt + 1,
    `the capture is on the line straight after the call (call ${callAt}, capture ${captureAt})`
  );
}

// Driven for real, because batch syntax is easy to get subtly wrong and a script that prints
// nothing useful is the bug being fixed. Two runs of the GENERATED file, one per exit code,
// with input piped so `pause` does not block.
{
  const { spawnSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-rc-script-"));
  const runWithExit = (code) => {
    const body = buildLauncherScript({
      cwd: dir,
      // `cmd /c exit N` stands in for claude: this asserts the SCRIPT's branching, and using
      // the real binary here would either start a session or spend a token.
      claudePath: "cmd",
      args: ["/c", "exit", String(code)],
      title: "diag",
    });
    const file = path.join(dir, `rc-${code}.cmd`);
    fs.writeFileSync(file, body);
    const r = spawnSync("cmd", ["/c", file], { encoding: "utf8", input: "\r\n" });
    return String(r.stdout || "");
  };
  const clean = runWithExit(0);
  assert(/session ended/.test(clean), "a clean exit says the session ended");
  assert(!/exited with code/.test(clean), "and does not claim a failure");
  const failed = runWithExit(3);
  assert(/exited with code 3/.test(failed), "a non-zero exit names the code");
  assert(/research preview/.test(failed), "and says an eligibility refusal looks like this too, since that is the likely cause");
  assert(!/session ended/.test(failed), "and does not also claim the session ended, which would be two answers to one question");
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- continueOnMobile (injected deps; no real window) ---
let spawned = null;
const fakeSpawn = (cmd, argv, opts) => {
  spawned = { cmd, argv, opts };
  return { unref() {} };
};
const realCwd = os.tmpdir(); // a dir that actually exists
const res = continueOnMobile(
  { cwd: realCwd, cliSessionId: "sess-42", title: "Mobile handoff" },
  { spawn: fakeSpawn, resolveClaudeBinary: () => "C:\\claude.exe", tmpDir: realCwd, platform: "win32" }
);
assert(res.ok === true, "continueOnMobile returns ok on win32 with a real cwd");
assert(spawned && spawned.cmd === "cmd.exe", "spawns cmd.exe");
assert(spawned.argv[0] === "/c" && spawned.argv.includes("start"), "uses `cmd /c start` to open a NEW window");
assert(spawned.argv.includes("/min"), "opens the window MINIMIZED (/min) so it doesn't pop over your work");
assert(spawned.argv.indexOf("/min") === spawned.argv.indexOf("start") + 1, "`/min` comes right after `start` (before the title)");
assert(spawned.opts && spawned.opts.detached === true, "spawns detached (survives Helm)");
assert(res.scriptPath && fs.existsSync(res.scriptPath), "wrote the launcher .cmd to disk");
const written = fs.readFileSync(res.scriptPath, "utf8");
assert(/--remote-control/.test(written) && /--resume sess-42/.test(written), "the .cmd resumes the session with Remote Control");
try {
  fs.unlinkSync(res.scriptPath);
} catch {
  // best effort cleanup
}

// non-win32 + missing cwd guards
const nonWin = continueOnMobile(
  { cwd: realCwd, cliSessionId: "x", title: "t" },
  { spawn: fakeSpawn, resolveClaudeBinary: () => "claude", tmpDir: realCwd, platform: "darwin" }
);
assert(nonWin.ok === false && /Windows/.test(nonWin.error), "non-Windows returns a clear not-supported error");
const noCwd = continueOnMobile(
  { cwd: path.join(realCwd, "does-not-exist-xyz"), cliSessionId: "x", title: "t" },
  { spawn: fakeSpawn, resolveClaudeBinary: () => "claude", tmpDir: realCwd, platform: "win32" }
);
assert(noCwd.ok === false && /not found/i.test(noCwd.error), "a missing cwd returns a clear error (no spawn)");

console.log(exit === 0 ? "VERIFY OK: remote-control launcher builds correct args/script and guards its inputs." : "VERIFY FAILED.");
process.exit(exit);
