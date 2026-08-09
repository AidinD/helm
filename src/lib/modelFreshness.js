// Strategy for "a new Claude model shipped and Helm never noticed" (Jot card
// "Behöver strategi för när ny version av claude släpps"). Helm has no
// ANTHROPIC_API_KEY - every session goes through the `claude` CLI on its own
// OAuth session (see launcher.js) - so GET /v1/models is not an option, and a
// docs-page scrape is fragile and would need a network call on every boot.
//
// Instead this reads the model ids the installed `claude` binary itself
// already recognizes - the exact thing the captain verified by hand when building
// MODEL_MENU_OPTIONS in renderer.js ("verified against the ids bundled in
// claude.exe, not guessed"). No network, no API key, no model call: a local
// file read plus a regex, cheap enough to run once at every app start.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { KNOWN_MODEL_IDS } from "./models.js";

// Anchored so "claude-fable-5.md", "claude-opus-4-6-fast", "...-v1", and
// "claude-fable-5-mythos-5" style noise inside the binary never matches - only
// a family name followed by one or more purely-numeric hyphen segments.
const MODEL_ID_RE = /(?<![\w-])claude-(?:opus|sonnet|haiku|fable)(?:-\d+)+(?![\w.-])/g;

function familyOf(id) {
  return id.split("-")[1];
}

// Drops the family prefix, and a trailing 8-digit snapshot-date segment (a
// pin, e.g. ...-20251101, not a version bump) so a dated snapshot of an
// already-known version doesn't compare as newer than it.
function versionTuple(id) {
  const segs = id.split("-").slice(2);
  if (segs.length > 1 && segs[segs.length - 1].length === 8) {
    segs.pop();
  }
  return segs.map(Number);
}

function compareTuples(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

// `where`/`which` list every shim on PATH (a tiny .cmd/posix wrapper script
// alongside the real compiled binary) - the real one is by far the largest
// file, so picking the largest candidate is more robust than assuming an
// order or a fixed install path.
function findClaudeBinary() {
  const finder = process.platform === "win32" ? "where" : "which";
  let candidates;
  try {
    candidates = execFileSync(finder, ["claude"], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
  let best = null;
  for (const path of candidates) {
    try {
      const size = statSync(path).size;
      if (!best || size > best.size) {
        best = { path, size };
      }
    } catch {
      // Listed by where/which but gone by the time we stat it - skip it.
    }
  }
  return best?.path || null;
}

/** Every model-id-shaped token in `text`, deduped - the noise-filtering half. */
export function extractModelIds(text) {
  return [...new Set(String(text).match(MODEL_ID_RE) || [])];
}

/**
 * Of `foundIds`, the ones whose version is strictly newer than the highest
 * version per family in `knownIds`. Legacy ids a CLI still carries for
 * back-compat (opus 4, 4.1, ...) are never flagged - only a version ABOVE
 * what's tracked counts as "new", so a stale registry doesn't spam every
 * historical alias every run, and a genuinely new family (nothing in
 * `knownIds` to compare against) is always flagged - the comparison half.
 */
export function findNewerModelIds(foundIds, knownIds) {
  const maxKnown = new Map();
  for (const id of knownIds) {
    const family = familyOf(id);
    const tuple = versionTuple(id);
    if (!maxKnown.has(family) || compareTuples(tuple, maxKnown.get(family)) > 0) {
      maxKnown.set(family, tuple);
    }
  }
  return foundIds
    .filter((id) => {
      const known = maxKnown.get(familyOf(id));
      return !known || compareTuples(versionTuple(id), known) > 0;
    })
    .sort();
}

/**
 * Reports any model id the installed CLI recognizes that's newer than
 * anything in KNOWN_MODEL_IDS (see findNewerModelIds).
 *
 * @returns {{ checked: boolean, reason?: string, binaryPath?: string, newModelIds: string[] }}
 */
export function checkModelFreshness() {
  const binaryPath = findClaudeBinary();
  if (!binaryPath) {
    return { checked: false, reason: "claude binary not found on PATH", newModelIds: [] };
  }
  let text;
  try {
    text = readFileSync(binaryPath).toString("latin1");
  } catch (err) {
    return { checked: false, reason: `could not read ${binaryPath}: ${err.message}`, newModelIds: [] };
  }
  return { checked: true, binaryPath, newModelIds: findNewerModelIds(extractModelIds(text), KNOWN_MODEL_IDS) };
}
