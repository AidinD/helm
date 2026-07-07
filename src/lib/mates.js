import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// First-mate identity (docs/first-mate-tier-design.md section 3, "Mate identity
// (new, tiny)"). A first mate is an orchestrator session rooted in a meta-home
// (the dir holding the canonical CLAUDE.md + auto-memory; see main.js's
// orchestrator:info). We key dispatched runs and their reports by a stable
// `mateId` derived from that root, so the Dashboard can later group a mate's
// runs under it (the mate -> second-mate edge).
//
// Persisted next to config.json / domains.json / goal-run-history.json - the
// same "plain JSON file beside the app, machine-specific, gitignored" data
// convention every other Maestro store uses (domains.js's doc comment spells
// this out). Deliberately tiny: one entry per first-mate root, nothing more
// than the model needs to correlate a run to the mate that dispatched it.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const matesPath = path.join(__dirname, "..", "..", "mates.json");

export function matesFilePath() {
  return matesPath;
}

function readAll() {
  if (!fs.existsSync(matesPath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(matesPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(mates) {
  fs.writeFileSync(matesPath, JSON.stringify(mates, null, 2) + "\n", "utf8");
}

/**
 * Normalizes a root path for identity comparison: absolute, no trailing
 * separator, lowercased (Windows paths are case-insensitive - matches
 * isOwnWorktreeRoot's own normalization in goalOrchestrator.js).
 */
function normRoot(root) {
  return path.resolve(root).replace(/[\\/]+$/, "").toLowerCase();
}

/** Returns all persisted mates. */
export function loadMates() {
  return readAll();
}

/**
 * Resolves the `mateId` for a first-mate root, creating and persisting a new
 * mate record on first sight. Idempotent: the same root always maps to the same
 * mateId across restarts. `name` is a human label (defaults to the root's
 * basename, e.g. "Claude" for the meta-home) and is refreshed if a caller
 * passes a better one later.
 */
export function resolveMate(root, name) {
  if (!root) {
    throw new Error("resolveMate requires a root path");
  }
  const key = normRoot(root);
  const mates = readAll();
  const existing = mates.find((m) => normRoot(m.root) === key);
  if (existing) {
    if (name && name !== existing.name) {
      existing.name = name;
      writeAll(mates);
    }
    return existing;
  }
  const mate = {
    mateId: `mate_${crypto.randomUUID()}`,
    root: path.resolve(root),
    name: name || path.basename(path.resolve(root)) || "mate",
    createdAt: Date.now(),
  };
  mates.push(mate);
  writeAll(mates);
  return mate;
}

/** Looks up a mate by id, or null. */
export function findMateById(mateId) {
  return readAll().find((m) => m.mateId === mateId) || null;
}
