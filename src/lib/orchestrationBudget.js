import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Phase-2 guardrail (docs/orchestration-phase2-plan.md, Slice 0): a per-fleet
// token/cost ceiling + a kill switch, so the tiered orchestration (first mate ->
// second mates -> crew) can never run away and burn quota with no ceiling - the
// exact failure the model was designed to avoid.
//
// One budget per META-HOME (the whole tree rooted there), stored beside the
// dispatch queue at <metaHome>/.helm-dispatch/budget.json, so it survives a
// restart. Atomic writes (temp + rename) mirror dispatchQueue.js so a reader
// never sees a half-written file. All reads are tolerant (a missing/corrupt file
// reads as a fresh zero-spend, not-killed budget).

const DISPATCH_DIRNAME = ".helm-dispatch";
const BUDGET_FILE = "budget.json";

// Default ceiling in USD when none is configured. Generous enough for a real
// day's orchestration, low enough to cap a runaway. Overridable via setCeiling
// (wired to config in main.js).
export const DEFAULT_CEILING_USD = 25;

export function budgetPath(metaHome) {
  return path.join(metaHome, DISPATCH_DIRNAME, BUDGET_FILE);
}

/** Pure: is this budget state over its ceiling? A null ceiling means "no cap". */
export function isOver(state) {
  if (!state || typeof state.ceilingUsd !== "number") {
    return false;
  }
  return (state.spentUsd || 0) >= state.ceilingUsd;
}

function freshState() {
  return { spentUsd: 0, ceilingUsd: DEFAULT_CEILING_USD, killed: false, updatedAt: 0 };
}

function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

/** Tolerant read: a missing/corrupt budget reads as a fresh one (never throws). */
export function readBudget(metaHome) {
  try {
    const parsed = JSON.parse(fs.readFileSync(budgetPath(metaHome), "utf8"));
    if (parsed && typeof parsed === "object") {
      return { ...freshState(), ...parsed };
    }
  } catch {
    // missing/corrupt - fall through to a fresh budget
  }
  return freshState();
}

function update(metaHome, patch) {
  const next = { ...readBudget(metaHome), ...patch, updatedAt: Date.now() };
  try {
    writeJsonAtomic(budgetPath(metaHome), next);
  } catch {
    // best-effort persistence; the in-memory value still governs this call
  }
  return next;
}

/** Adds a run's cost to the running total. Best-effort; returns the new state. */
export function addSpend(metaHome, costUsd) {
  const usd = Number(costUsd) || 0;
  if (usd <= 0) {
    return readBudget(metaHome);
  }
  const cur = readBudget(metaHome);
  return update(metaHome, { spentUsd: (cur.spentUsd || 0) + usd });
}

/** Sets the ceiling (USD). Pass null to remove the cap. */
export function setCeiling(metaHome, ceilingUsd) {
  // null explicitly removes the cap. A non-numeric/NaN/negative value must NOT
  // silently disable the ceiling (a guardrail that fails OPEN on bad input is
  // worse than useless) - keep the current ceiling instead (ship-review).
  if (ceilingUsd == null) {
    return update(metaHome, { ceilingUsd: null });
  }
  const n = Number(ceilingUsd);
  if (!Number.isFinite(n) || n < 0) {
    return readBudget(metaHome);
  }
  return update(metaHome, { ceilingUsd: n });
}

export function isOverBudget(metaHome) {
  return isOver(readBudget(metaHome));
}

/** Flips the kill switch. When killed, no further dispatch is accepted. */
export function setKilled(metaHome, killed) {
  return update(metaHome, { killed: !!killed });
}

export function isKilled(metaHome) {
  return !!readBudget(metaHome).killed;
}

/** Clears spend + un-kills (new orchestration day / manual reset). Keeps ceiling. */
export function resetBudget(metaHome) {
  const cur = readBudget(metaHome);
  return update(metaHome, { spentUsd: 0, killed: false, ceilingUsd: cur.ceilingUsd });
}
