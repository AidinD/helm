import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Where the meta home is - the folder holding `.helm/`, `.helm-dispatch/` and the
 * canonical CLAUDE.md.
 *
 * Lifted out of main.js on 2026-08-31 so something other than the Electron main
 * process can find it. The review-record writer runs as a plain script, from any
 * session, with no app running; without this it would need a second copy of the
 * rule, and a second copy is how the jot path resolver got a caller wrong once
 * already (see reviewQueueInputs in main.js).
 *
 * The rule itself: `~/.claude/CLAUDE.md` is a stub that imports the real file from
 * wherever it is synced to. Read the import line, take its directory. Fall back to
 * the home directory, which is what an install with no stub looks like.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.allowOverride] Honour HELM_META_HOME_OVERRIDE. The caller
 *   decides, because main.js must refuse it in a packaged build - a stray env var
 *   silently relocating the queue in production was a review finding (L5) - while a
 *   script run by hand has no such production to protect.
 */
export function resolveMetaHome({ allowOverride = false } = {}) {
  if (allowOverride && process.env.HELM_META_HOME_OVERRIDE) {
    return process.env.HELM_META_HOME_OVERRIDE;
  }
  try {
    const stub = fs.readFileSync(path.join(os.homedir(), ".claude", "CLAUDE.md"), "utf8");
    const importMatch = stub.match(/^@(.+?CLAUDE\.md)\s*$/m);
    if (importMatch) {
      const metaHome = path.dirname(importMatch[1].trim());
      if (fs.existsSync(metaHome)) {
        return metaHome;
      }
    }
  } catch {
    // No stub, or unreadable. The home dir is the honest fallback.
  }
  return os.homedir();
}
