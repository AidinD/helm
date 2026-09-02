import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Registry of non-repo "life-domain" projects: plain folders that are worked in with Claude
 * but are not git repositories. They follow the same ephemeral-session, files-as-memory model
 * as a repo project - a session rooted in the folder auto-loads its CLAUDE.md and memory
 * exactly as a repo session does. The only real difference is that there is no git, so
 * worktree isolation (see worktree.js / goalOrchestrator.js) never applies to them.
 *
 * READ-ONLY SINCE 2026-09-02, on purpose. The app's registration control had already
 * disappeared from the renderer, leaving `registerDomain`, `removeDomain`, their two IPC
 * handlers and four preload bridges reachable from nowhere - found by the linter's first run
 * on this repo. Measured before deciding rather than after: no domain has ever been
 * registered, and there is no domains file on disk at all, so the feature was retired instead
 * of having its button put back.
 *
 * `loadDomains` is the whole remaining job: knownProjects still resolves an existing domain
 * folder as a project, so a registry written by hand or by an older build keeps working. The
 * two writers are in the history if the decision is ever reversed.
 *
 * Stored next to config.json (same directory, same gitignored machine-specific convention)
 * rather than folded into config.json, since this is a distinct collection with its own shape
 * and it keeps config.js's merge logic untouched.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// HELM_DOMAINS_PATH is a test/packaged-app seam (see main.js's packagedPaths.js);
// production/dev leaves it unset and uses the plain JSON file beside the app.
const domainsPath = process.env.HELM_DOMAINS_PATH || path.join(__dirname, "..", "..", "domains.json");

/**
 * @typedef {object} Domain
 * @property {string} id - stable id, generated when the entry was created.
 * @property {string} name - display name.
 * @property {string} path - absolute path to the domain's folder.
 * @property {string} icon - a single emoji shown on the project chip.
 */

export function domainsFilePath() {
  return domainsPath;
}

/** Reads the registry. Returns [] if none exists yet or the file is corrupt. */
export function loadDomains() {
  if (!fs.existsSync(domainsPath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(domainsPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
