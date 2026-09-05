/**
 * Which commits are a card's - stored as a fact about identity, not as a review.
 *
 * ## Why this is not a review record
 *
 * A review record was the obvious place and it is the wrong one. Its admissibility gate
 * requires `testSteps`, each with a step and an expected result, on the deliberate grounds
 * that "a claim with no way to check it is an assertion". Binding commits to a card says
 * nothing whatever about testing, so writing one as a record would mean inventing test
 * steps to get past a gate that exists to stop exactly that. The gate is right; the record
 * is simply not what this is.
 *
 * So a binding is its own small thing: a task id, some shas, and who said so. It carries no
 * verdict, no evidence and no claim that anything was reviewed. A card with a binding still
 * has no record and still says so on the page - what changes is that the page can now show
 * the diff, which is the thing a person needs in order to review it at all.
 *
 * ## Who is allowed to write one
 *
 * A person, after looking. A model may PROPOSE a binding (see commitMatch.js) and its
 * proposal is stored alongside for provenance, but `by` is what makes the binding, and the
 * only caller that writes a person's name into it is the one behind a confirm in
 * the UI. An inferred binding written silently would send somebody to review the wrong diff while telling them
 * it was the right one, which is worse than showing them nothing.
 */
import fs from "node:fs";
import path from "node:path";

const SHA_RE = /^[0-9a-f]{7,40}$/i;

/** Same guard the review records use: a Jot id and nothing that could climb a directory. */
function safeId(taskId) {
  const id = String(taskId || "").trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9-]{7,63}$/.test(id) ? id : null;
}

function bindingsDir(metaHome) {
  return path.join(metaHome, ".helm", "commit-bindings");
}

export function bindingPath(metaHome, taskId) {
  const id = safeId(taskId);
  return id ? path.join(bindingsDir(metaHome), `${id}.json`) : null;
}

/**
 * @param {string} metaHome
 * @param {string} taskId
 * @returns {{ taskId: string, projectPath: string | null, shas: string[], by: string, at: number, proposedBy: string | null, note: string | null } | null}
 */
export function readBinding(metaHome, taskId) {
  const file = bindingPath(metaHome, taskId);
  if (!file || !fs.existsSync(file)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const shas = (Array.isArray(parsed.shas) ? parsed.shas : []).map((s) => String(s).trim()).filter((s) => SHA_RE.test(s));
    if (shas.length === 0) {
      return null;
    }
    return {
      taskId: String(parsed.taskId || taskId),
      projectPath: parsed.projectPath || null,
      shas,
      by: String(parsed.by || "unknown"),
      at: Number(parsed.at) || 0,
      proposedBy: parsed.proposedBy || null,
      note: parsed.note || null,
    };
  } catch {
    // A corrupt binding is the same as no binding: the page falls back to candidates and
    // the person can bind again. Never a reason to fail a queue build.
    return null;
  }
}

/**
 * @param {string} metaHome
 * @param {string} taskId
 * @param {{ projectPath?: string, shas: string[], by: string, proposedBy?: string | null, note?: string | null }} binding
 * @returns {{ ok: true, path: string, shas: string[] } | { ok: false, error: string }}
 */
export function writeBinding(metaHome, taskId, { projectPath = null, shas, by, proposedBy = null, note = null }) {
  const file = bindingPath(metaHome, taskId);
  if (!file) {
    return { ok: false, error: "That is not a task id, so there is nothing to bind commits to." };
  }
  const clean = (Array.isArray(shas) ? shas : []).map((s) => String(s || "").trim()).filter((s) => SHA_RE.test(s));
  if (clean.length === 0) {
    return { ok: false, error: "No commit was named, so there is nothing to bind." };
  }
  // `by` is not decoration. A binding says somebody decided these commits are this card,
  // and a binding with no author is an inference wearing a person's clothes.
  if (!by || !String(by).trim()) {
    return { ok: false, error: "A binding has to say who made it - an unattributed one is an inference pretending to be a decision." };
  }
  try {
    fs.mkdirSync(bindingsDir(metaHome), { recursive: true });
    const payload = {
      taskId: String(taskId),
      projectPath,
      shas: clean,
      by: String(by).trim(),
      at: Date.now(),
      proposedBy: proposedBy ? String(proposedBy) : null,
      note: note ? String(note) : null,
    };
    fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return { ok: true, path: file, shas: clean };
  } catch (err) {
    return { ok: false, error: `Could not write the binding: ${err.message}` };
  }
}

export function removeBinding(metaHome, taskId) {
  const file = bindingPath(metaHome, taskId);
  if (!file || !fs.existsSync(file)) {
    return { ok: true, removed: false };
  }
  try {
    fs.rmSync(file);
    return { ok: true, removed: true };
  } catch (err) {
    return { ok: false, error: `Could not remove the binding: ${err.message}` };
  }
}

/**
 * The shas to treat as this card's, in precedence order.
 *
 * A record wins: it is a person's own account of the work and it lists its commits. A
 * binding is the fallback, and exists precisely for the cards that have no record - which,
 * measured on the real board, is almost all of them.
 *
 * @param {string} metaHome
 * @param {string} taskId
 * @param {{ commits?: Array<string | { sha?: string }> } | null} record
 * @returns {{ shas: string[], source: "record" | "binding" | "none" }}
 */
export function boundCommits(metaHome, taskId, record) {
  const fromRecord = (record?.commits || [])
    .map((c) => (typeof c === "string" ? c : c?.sha))
    .map((s) => String(s || "").trim().split(/\s+/)[0])
    .filter((s) => SHA_RE.test(s));
  if (fromRecord.length > 0) {
    return { shas: fromRecord, source: "record" };
  }
  const binding = readBinding(metaHome, taskId);
  if (binding) {
    return { shas: binding.shas, source: "binding" };
  }
  return { shas: [], source: "none" };
}
