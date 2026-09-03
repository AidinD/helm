import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { resolveClaudeBinary } from "./launcher.js";

// "Continue on mobile" - hand a Helm session off to Claude Code's Remote
// Control feature so it can be driven from claude.ai/code or the Claude mobile
// app (https://code.claude.com/docs/en/remote-control).
//
// WHY a real terminal and not a headless child (like launcher.js): Remote
// Control only runs in an INTERACTIVE session. Verified 2026-07-12 - launching
// `claude --remote-control` with a non-TTY stdin falls back to --print mode and
// errors ("Input must be provided ... when using --print"). Helm's normal
// launcher spawns `claude -p` with piped stdio (no TTY) and one short-lived
// process per turn; RC needs a persistent process attached to a real terminal.
// So this opens a NEW visible console window running an interactive RC session,
// resuming the same conversation. That window also surfaces the session URL/QR
// and any eligibility error (RC is a research-preview gated feature) directly to
// the user, rather than us swallowing it.
//
// The conversation is a real, resumable CLI session (transcript in
// ~/.claude/projects), so `claude --resume <cliSessionId> --remote-control`
// picks it up where Helm left off. Without a cliSessionId we start a FRESH RC
// session rooted in cwd instead.

// Strip anything that could break out of the .cmd string / window title. Titles
// and names are cosmetic, so a conservative allowlist is fine.
function sanitizeTitle(s) {
  return String(s || "")
    .replace(/["\r\n]/g, " ")
    .replace(/[<>|&^%]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "Helm session";
}

// A resume/session id from the CLI is a UUID-shaped token; never let anything
// else through into the shell line.
function sanitizeSessionId(id) {
  const s = String(id || "").trim();
  return /^[A-Za-z0-9_-]+$/.test(s) ? s : "";
}

/**
 * Build the argv (after the claude binary) for a Remote Control launch.
 * Exported for unit testing without spawning anything.
 */
export function buildRemoteControlArgs({ cliSessionId, title }) {
  const args = [];
  const id = sanitizeSessionId(cliSessionId);
  if (id) {
    args.push("--resume", id);
  }
  args.push("--remote-control");
  const name = sanitizeTitle(title);
  args.push("--name", name);
  return args;
}

/**
 * Compose the .cmd script body that a new console window runs. Kept pure +
 * exported so a test can assert the exact commands without touching disk.
 */
export function buildLauncherScript({ cwd, claudePath, args, title }) {
  const name = sanitizeTitle(title);
  // Quote every interpolated path/arg; the args are already sanitized (id) or
  // fixed flags, except --name's value which reuses the sanitized title.
  const quotedArgs = args
    .map((a) => (/^[A-Za-z0-9_.:\\/-]+$/.test(a) ? a : `"${a}"`))
    .join(" ");
  return [
    "@echo off",
    `title Helm - Continue on mobile: ${name}`,
    `cd /d "${cwd}"`,
    "echo Starting a Remote Control session for this Helm conversation...",
    "echo Scan the QR / open the URL below from the Claude mobile app or claude.ai/code.",
    "echo.",
    `"${claudePath}" ${quotedArgs}`,
    // HOLD THE WINDOW OPEN. This console exists to show you the session URL, the QR code and
    // any eligibility error - Remote Control is a gated research preview, and when it refuses
    // it refuses immediately. Without a pause the window closes the instant claude exits, so
    // the reason went with it: a console flashes and nothing has happened, which is exactly
    // what "the remote session did not even work" looks like from the outside.
    //
    // The exit code is captured on the line straight after the call, because anything else -
    // an echo included - overwrites ERRORLEVEL first.
    "set RC_EXIT=%ERRORLEVEL%",
    "echo.",
    'if not "%RC_EXIT%"=="0" (',
    "  echo Remote Control exited with code %RC_EXIT%.",
    "  echo The reason is in the output above. Remote Control is a gated research preview,",
    "  echo so an eligibility refusal looks like this too.",
    ") else (",
    "  echo (Remote Control session ended.)",
    ")",
    "echo.",
    "pause",
    "",
  ].join("\r\n");
}

/**
 * Open a new terminal window running an interactive Remote Control session for
 * the given conversation. Windows-only for now (the captain's platform); other
 * platforms throw a clear error rather than silently no-op.
 *
 * @returns {{ ok: true, scriptPath: string } | { ok: false, error: string }}
 */
export function continueOnMobile({ cwd, cliSessionId, title }, deps = {}) {
  const spawnFn = deps.spawn || spawn;
  const resolveClaude = deps.resolveClaudeBinary || resolveClaudeBinary;
  const tmpDir = deps.tmpDir || os.tmpdir();
  const platform = deps.platform || process.platform;

  if (!cwd || !fs.existsSync(cwd)) {
    return { ok: false, error: `Session directory not found: ${cwd || "(none)"}` };
  }
  if (platform !== "win32") {
    return {
      ok: false,
      error: `Continue on mobile is only wired for Windows right now (platform: ${platform}). Run 'claude --remote-control' manually.`,
    };
  }

  const claudePath = resolveClaude();
  const args = buildRemoteControlArgs({ cliSessionId, title });
  const script = buildLauncherScript({ cwd, claudePath, args, title });

  // A generated .cmd sidesteps all nested cmd/start argv-quoting problems: the
  // real invocation lives inside the file, and we only have to launch the file
  // in a new window.
  const scriptPath = path.join(tmpDir, `helm-rc-${crypto.randomBytes(4).toString("hex")}.cmd`);
  try {
    fs.writeFileSync(scriptPath, script, "utf8");
  } catch (err) {
    return { ok: false, error: `Could not write launcher script: ${err.message}` };
  }

  try {
    // `start /min "TITLE" cmd /k "<script>"`: `start` opens a NEW console
    // window; `/min` opens it MINIMIZED to the taskbar so it doesn't pop up over
    // your work (Remote Control still needs a real TTY, which the console
    // provides even when minimized - you find the session on mobile by its
    // --name, or restore the window for the QR/URL). The first quoted token is
    // the window title (given explicitly so start doesn't mistake the quoted
    // script path for the title). `/k` keeps the window open after the script
    // returns, so an immediate RC eligibility error stays readable.
    const child = spawnFn(
      "cmd.exe",
      ["/c", "start", "/min", "Helm - Continue on mobile", "cmd", "/k", scriptPath],
      { detached: true, stdio: "ignore", windowsHide: false }
    );
    child.unref?.();
  } catch (err) {
    return { ok: false, error: `Could not open a terminal window: ${err.message}` };
  }
  return { ok: true, scriptPath };
}
