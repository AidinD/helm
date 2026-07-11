// Unit test (pure node): the "Continue on mobile" Remote Control launcher.
// No real terminal is opened - spawn/tmpDir/platform/claude are injected.
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
