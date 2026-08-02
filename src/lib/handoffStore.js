import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { writeFileAtomicSync } from "./atomicWrite.js";

// Durable handoffs for sessions that have NO project repo (task 663ab4b6).
//
// The repo-backed handoff writes <cwd>/HANDOFF.md, which only works when a
// session owns a folder. A non-rooted second mate - training, kombucha, job
// hunting - has no such folder, so its handoff had nowhere to go: the "save
// handoff" action was not even offered, and a meta-home-rooted session would
// have written into ONE shared HANDOFF.md that every other such session
// overwrites. Either way the knowledge was lost.
//
// So: a Helm-owned store keyed by TOPIC instead of by path. One markdown file
// per category (training.md, kombucha.md, job-search.md, ...), latest-only just
// like HANDOFF.md, living under the meta-home so it syncs and can be versioned
// with everything else Helm keeps there.
//
// Chosen over stuffing the text into the mate record (mates.js pendingHandoff):
// that is consumed once and is a message to the next instance, not a durable
// document you can open and read later.

const HANDOFF_DIR = path.join(".helm", "handoffs");

export function handoffsDir(metaHome) {
  return path.join(metaHome, HANDOFF_DIR);
}

/**
 * Normalize a category name to a safe file slug: lowercase kebab-case, ASCII
 * only, no path separators. Returns null for anything that normalizes to
 * nothing, so a junk classification can never produce a stray or escaping file.
 */
export function slugifyCategory(name) {
  if (typeof name !== "string") {
    return null;
  }
  const slug = name
    .normalize("NFKD")
    // Swedish (and other) accented letters degrade to their base letter rather
    // than being dropped: "träning" -> "traning", not "trning".
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : null;
}

/** Existing category slugs, i.e. the topics a handoff has already been filed under. */
export function listHandoffCategories(metaHome) {
  const dir = handoffsDir(metaHome);
  if (!fs.existsSync(dir)) {
    return [];
  }
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

export function handoffPath(metaHome, slug) {
  const safe = slugifyCategory(slug);
  if (!safe) {
    return null;
  }
  return path.join(handoffsDir(metaHome), `${safe}.md`);
}

export function readHandoff(metaHome, slug) {
  const file = handoffPath(metaHome, slug);
  if (!file || !fs.existsSync(file)) {
    return null;
  }
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Write (overwrite) the handoff for a category. Latest-only, mirroring
 * HANDOFF.md's contract: a handoff is the current state, superseded by the next
 * one. Atomic temp+rename so an interrupted write can't leave a torn file.
 * Returns { ok, path } or { ok: false, error }.
 */
export function writeHandoff(metaHome, slug, text, { title = null, now = Date.now() } = {}) {
  const safe = slugifyCategory(slug);
  if (!safe) {
    return { ok: false, error: "Invalid handoff category" };
  }
  if (!text || !text.trim()) {
    return { ok: false, error: "Nothing to save" };
  }
  const dir = handoffsDir(metaHome);
  const file = path.join(dir, `${safe}.md`);
  const stamp = new Date(now).toISOString().slice(0, 16).replace("T", " ");
  const body =
    `# ${safe} - latest session state\n\n` +
    `_Overwritten on each handoff (latest-only). Topic-keyed: this session has no project folder._\n` +
    `_Saved ${stamp}${title ? ` from "${title}"` : ""}._\n\n` +
    text.trim() +
    "\n";
  try {
    // Shared atomic write with the Dropbox-lock retry (task efcaf486). A handoff is
    // written precisely when a session is about to end, so losing it to a sync lock
    // loses the one artefact meant to survive the session.
    const res = writeFileAtomicSync(file, body);
    if (!res.ok) {
      return { ok: false, error: `Could not write the handoff: ${res.error}` };
    }
    return { ok: true, path: file, category: safe };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Pick the category for a handoff, given what the classifier proposed and the
 * categories that already exist. MATCH-FIRST by design (Aidin: "se om vi kan
 * matcha topic på befintliga existerande handoffs annars ta något nytt
 * passande") - reusing a topic keeps one readable file per subject instead of
 * scattering near-duplicates like training / traning / workouts.
 *
 * Pure so the matching rule is testable without spawning a model.
 * Returns { category, isNew }.
 */
export function resolveHandoffCategory(proposed, existing = [], fallback = "general") {
  const known = existing.map((e) => slugifyCategory(e)).filter(Boolean);
  // The fallback goes through the SAME matching as a real proposal. It used to
  // return immediately, which meant the one moment matching mattered most - the
  // classifier had failed, so nothing else was going to catch a near-duplicate -
  // was the one moment no matching ran at all (Aidin, 2026-08-02).
  const slug = slugifyCategory(proposed) || slugifyCategory(fallback);
  if (!slug) {
    return { category: "general", isNew: !known.includes("general") };
  }
  if (known.includes(slug)) {
    return { category: slug, isNew: false };
  }
  // Near-miss reuse: the proposal is a prefix/suffix variant of an existing
  // topic ("training-log" vs "training"). Only accept a containment match on
  // whole hyphen-separated words, so "job" never swallows "jobbot".
  const words = (s) => s.split("-").filter(Boolean);
  const slugWords = words(slug);
  for (const candidate of known) {
    const candWords = words(candidate);
    const shorter = slugWords.length <= candWords.length ? slugWords : candWords;
    const longer = slugWords.length <= candWords.length ? candWords : slugWords;
    if (shorter.length > 0 && shorter.every((w) => longer.includes(w))) {
      return { category: candidate, isNew: false };
    }
  }
  return { category: slug, isNew: true };
}

/**
 * Decide what to DO about a handoff's topic, given what (if anything) the
 * classifier proposed. Split out of the IPC handler and pure for the same reason
 * resolveHandoffCategory is: the rule that matters here is a refusal, and a
 * refusal nobody can test is a refusal that quietly stops happening.
 *
 * The rule: when no topic could be picked AND topics already exist, ASK - never
 * invent one from the session title. Inventing is what put the Hevy training
 * handoff in its own file next to the training topic it belonged in, looking for
 * all the world like it had worked (Aidin, 2026-08-02). With NO topics on file
 * yet there is nothing to mis-split, so the title is a fine first topic name.
 *
 * Returns { needsCategory: true, existing, suggestion } or { category, isNew }.
 */
export function planHandoffFiling({ proposed = null, existing = [], title = "" } = {}) {
  if (proposed) {
    return resolveHandoffCategory(proposed, existing, title || "general");
  }
  // No proposal. Try the title against the existing topics first - if it clearly
  // belongs to one, there is nothing to ask about. Only a title that would create
  // a NEW topic is worth interrupting for, because that is the case that silently
  // splits a subject across two files.
  const guess = resolveHandoffCategory(null, existing, title || "general");
  if (!guess.isNew || existing.length === 0) {
    return guess;
  }
  return { needsCategory: true, existing, suggestion: guess.category };
}
