import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Registry of non-repo "life-domain" projects (PLAN.md's non-repo project
 * types) — plain folders the captain works in with Claude that are NOT git repos
 * (gym, cycling, kombucha, etc). They follow the exact same ephemeral-
 * session + files-as-memory model as a repo project: a session rooted in the
 * domain's folder auto-loads its CLAUDE.md + memory the same way a repo
 * session does. The only real difference is there is no git, so worktree
 * isolation (see worktree.js / goalOrchestrator.js) never applies to them.
 *
 * Stored next to config.json (same directory, same gitignored, personal/
 * machine-specific data convention) rather than folded into config.json
 * itself, since this is a distinct collection with its own shape and this
 * keeps config.js's existing merge logic untouched.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const domainsPath = path.join(__dirname, "..", "..", "domains.json");

/**
 * @typedef {object} Domain
 * @property {string} id - stable id, generated at registration time.
 * @property {string} name - display name (e.g. "Gym").
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

function writeDomains(domains) {
  fs.writeFileSync(domainsPath, JSON.stringify(domains, null, 2) + "\n", "utf8");
}

const DEFAULT_ICON = "\u{1F4CC}"; // pushpin - generic "life domain" marker

/**
 * Registers a new domain, creating its folder if it does not already exist.
 * Does NOT require a CLAUDE.md inside it — that stays optional, same as a
 * fresh repo folder before anyone bothers to add one.
 *
 * @param {object} opts
 * @param {string} opts.name
 * @param {string} opts.path - absolute path to the folder.
 * @param {string} [opts.icon]
 * @returns {{ ok: boolean, domain?: Domain, error?: string }}
 */
export function registerDomain({ name, path: domainPath, icon }) {
  const trimmedName = (name || "").trim();
  const trimmedPath = (domainPath || "").trim();
  if (!trimmedName) {
    return { ok: false, error: "Name is required" };
  }
  if (!trimmedPath) {
    return { ok: false, error: "Folder path is required" };
  }
  const resolved = path.resolve(trimmedPath);

  const domains = loadDomains();
  if (domains.some((d) => path.resolve(d.path) === resolved)) {
    return { ok: false, error: `A domain already points at ${resolved}` };
  }

  try {
    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(resolved, { recursive: true });
    } else if (!fs.statSync(resolved).isDirectory()) {
      return { ok: false, error: `${resolved} is not a folder` };
    }
  } catch (err) {
    return { ok: false, error: `Could not create folder: ${err.message}` };
  }

  const domain = {
    id: `domain_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: trimmedName,
    path: resolved,
    icon: (icon || "").trim() || DEFAULT_ICON,
  };
  domains.push(domain);
  writeDomains(domains);
  return { ok: true, domain };
}

export function removeDomain(id) {
  const domains = loadDomains();
  const next = domains.filter((d) => d.id !== id);
  if (next.length === domains.length) {
    return { ok: false, error: `No domain with id ${id}` };
  }
  writeDomains(next);
  return { ok: true };
}
