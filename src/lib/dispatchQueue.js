import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { writeJsonAtomicSync } from "./atomicWrite.js";

// First-mate tier dispatch queue (docs/first-mate-tier-design.md, section 1
// verdict "A1": a stdio MCP server over an on-disk request/report queue). This
// is the single on-disk handshake between the MCP server a first-mate session
// launches (src/mcp/helmDispatchServer.js) and the Helm main process
// (src/main.js's dispatch watcher). No socket, no port lifecycle - the app
// stays the single dispatch authority, and the queue is trivially
// restart-survivable (heeding the whisper-server lesson, DECISIONS.md
// 2026-07-05).
//
// Layout, rooted under a caller-supplied meta-home (the first mate's root, the
// same dir orchestrator:info resolves in main.js):
//   <meta-home>/.helm-dispatch/requests/<dispatchId>.json   (mate -> app)
//   <meta-home>/.helm-dispatch/reports/<dispatchId>.json    (app -> mate)
//
// Conventions deliberately mirror goalRunHistory.js / domains.js: plain JSON
// files, tolerant reads (a corrupt/half-written file is skipped, never throws),
// atomic writes (temp file + rename, so a reader/watcher never sees a partial
// object). Writes are one-file-per-dispatch rather than a single array file, so
// concurrent producers (several dispatched runs finishing at once) never race
// on the same file.

const DISPATCH_DIRNAME = ".helm-dispatch";
const REQUESTS_SUBDIR = "requests";
const REPORTS_SUBDIR = "reports";
// Acks are the synchronous accept/reject handshake for a single dispatch: the
// app writes one the moment it validates a request (accepted -> goalRunId, or
// rejected -> reason), so the helm_dispatch tool call can return promptly
// with { dispatchId, goalRunId, status } instead of blocking until the whole
// run finishes. The final compact result arrives later as a REPORT, which the
// mate reads with helm_collect_reports (the pull model, design section 2).
const ACKS_SUBDIR = "acks";

function dispatchRoot(metaHome) {
  return path.join(metaHome, DISPATCH_DIRNAME);
}

export function requestsDir(metaHome) {
  return path.join(dispatchRoot(metaHome), REQUESTS_SUBDIR);
}

export function reportsDir(metaHome) {
  return path.join(dispatchRoot(metaHome), REPORTS_SUBDIR);
}

export function acksDir(metaHome) {
  return path.join(dispatchRoot(metaHome), ACKS_SUBDIR);
}

// Fleet-state snapshot (e07a2c5d): the app writes a compact cross-mate view here
// (single authority), and the helm_fleet_state MCP tool reads it so a
// surveying first mate can see what's already in flight across the fleet.
function fleetStatePath(metaHome) {
  return path.join(dispatchRoot(metaHome), "fleet-state.json");
}
export function writeFleetState(metaHome, state) {
  writeJsonAtomic(fleetStatePath(metaHome), state);
}
export function readFleetState(metaHome) {
  return readJsonTolerant(fleetStatePath(metaHome));
}

/** Ensures all inbox dirs exist. Safe to call repeatedly (recursive mkdir). */
export function ensureDispatchDirs(metaHome) {
  fs.mkdirSync(requestsDir(metaHome), { recursive: true });
  fs.mkdirSync(reportsDir(metaHome), { recursive: true });
  fs.mkdirSync(acksDir(metaHome), { recursive: true });
}

/**
 * Atomic JSON write: write to a temp sibling then rename over the target, so a
 * concurrent reader/fs.watch consumer never observes a half-written file. The
 * temp name carries a random suffix so two writers to the same logical target
 * (should not happen - dispatchId is unique - but cheap insurance) never
 * collide on the temp file itself.
 */
function writeJsonAtomic(filePath, value) {
  // Shared atomic write with the Dropbox-lock retry (task efcaf486). The dispatch
  // queue lives under the Dropbox-synced meta-home, so a lost write here means a
  // dispatch that silently never happened.
  const res = writeJsonAtomicSync(filePath, value);
  if (!res.ok) {
    throw new Error(`Could not write ${path.basename(filePath)}: ${res.error}`);
  }
}

/** Tolerant JSON read: returns null on a missing/corrupt/half-written file. */
function readJsonTolerant(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Writes a dispatch REQUEST (mate -> app). The caller (the MCP server) supplies
 * the request payload; a dispatchId is generated here if absent and returned so
 * the caller can correlate the later report. `.tmp`/dotfiles are ignored by the
 * reader below, so the atomic rename is invisible to the watcher.
 */
export function writeRequest(metaHome, request) {
  const dispatchId = request.dispatchId || crypto.randomUUID();
  const record = { ...request, dispatchId, requestedAt: request.requestedAt || Date.now() };
  writeJsonAtomic(path.join(requestsDir(metaHome), `${dispatchId}.json`), record);
  return dispatchId;
}

/**
 * Reads all pending request records. Skips dotfiles (the atomic-write temp
 * files start with a dot) and any file that fails a tolerant parse. Each record
 * carries the absolute file path (`_file`) so a consumer that has handled a
 * request can delete or archive exactly that file.
 */
export function readRequests(metaHome) {
  const dir = requestsDir(metaHome);
  if (!fs.existsSync(dir)) {
    return [];
  }
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(".") || !name.endsWith(".json")) {
      continue;
    }
    const file = path.join(dir, name);
    const record = readJsonTolerant(file);
    if (record) {
      out.push({ ...record, _file: file });
    }
  }
  return out;
}

/**
 * Atomically CLAIMS a request by renaming it out of the pending `.json` pool,
 * so when two Helm instances watch the SAME meta-home only ONE wins and
 * launches the run: fs.renameSync of a now-missing source throws on the loser
 * (rename is atomic; unlink-and-hope is not). Returns true iff this process won
 * the claim. The claimed file is `<id>.json.claimed` (readRequests ignores
 * non-`.json`), cleaned up by removeRequest. The caller already holds the
 * request data in memory (from readRequests), so it proceeds from that.
 */
export function claimRequest(metaHome, dispatchId) {
  const src = path.join(requestsDir(metaHome), `${dispatchId}.json`);
  const claimed = path.join(requestsDir(metaHome), `${dispatchId}.json.claimed`);
  try {
    fs.renameSync(src, claimed);
    return true;
  } catch {
    // Source gone -> another instance (or an earlier re-scan) claimed it.
    return false;
  }
}

/** Removes a consumed request's files by dispatchId (pending + claimed). No-op if gone. */
export function removeRequest(metaHome, dispatchId) {
  for (const suffix of [".json", ".json.claimed"]) {
    try {
      fs.unlinkSync(path.join(requestsDir(metaHome), `${dispatchId}${suffix}`));
    } catch {
      // already consumed/removed - fine
    }
  }
}

/**
 * Writes the accept/reject ACK for a dispatch (app -> mate), keyed by
 * dispatchId. `ack` is `{ status: "accepted", goalRunId }` or
 * `{ status: "rejected", reason }`. Atomic so the polling dispatch tool never
 * reads a half-written ack.
 */
export function writeAck(metaHome, dispatchId, ack) {
  if (!dispatchId) {
    throw new Error("writeAck requires a dispatchId");
  }
  // Honors a caller-supplied ackedAt, same as writeReport honors reportedAt below
  // - found while adding pruneDispatchQueue's test: this used to always stamp
  // Date.now(), silently discarding any ackedAt the caller passed.
  const record = { dispatchId, ...ack, ackedAt: ack?.ackedAt || Date.now() };
  writeJsonAtomic(path.join(acksDir(metaHome), `${dispatchId}.json`), record);
  return dispatchId;
}

/** Reads the ACK for a dispatchId, or null if the app hasn't acked it yet. */
export function readAck(metaHome, dispatchId) {
  return readJsonTolerant(path.join(acksDir(metaHome), `${dispatchId}.json`));
}

/** Writes a REPORT (app -> mate), keyed by the dispatchId it answers. */
export function writeReport(metaHome, report) {
  if (!report || !report.dispatchId) {
    throw new Error("writeReport requires a report with a dispatchId");
  }
  const record = { ...report, reportedAt: report.reportedAt || Date.now() };
  writeJsonAtomic(path.join(reportsDir(metaHome), `${report.dispatchId}.json`), record);
  return report.dispatchId;
}

/**
 * Reads report records (app -> mate), the source `helm_collect_reports`
 * serves. Optional filters mirror the tool's own params:
 *  - `since`: only reports with reportedAt strictly greater than this ms epoch.
 *  - `dispatchIds`: only reports for these specific dispatch ids.
 * Returned newest-last (sorted by reportedAt) so a caller passing the max
 * reportedAt it has seen as `since` gets a clean incremental sweep.
 */
export function readReports(metaHome, { since, dispatchIds } = {}) {
  const dir = reportsDir(metaHome);
  if (!fs.existsSync(dir)) {
    return [];
  }
  const idFilter = Array.isArray(dispatchIds) && dispatchIds.length ? new Set(dispatchIds) : null;
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(".") || !name.endsWith(".json")) {
      continue;
    }
    const record = readJsonTolerant(path.join(dir, name));
    if (!record) {
      continue;
    }
    if (idFilter && !idFilter.has(record.dispatchId)) {
      continue;
    }
    if (typeof since === "number" && !(Number(record.reportedAt) > since)) {
      continue;
    }
    out.push(record);
  }
  out.sort((a, b) => (Number(a.reportedAt) || 0) - (Number(b.reportedAt) || 0));
  return out;
}

/**
 * Drops old ACK + REPORT files so the dispatch directory cannot grow without
 * bound - the same unbounded-accumulation class of gap pruneScheduledPrompts
 * (scheduledPrompts.js) already closes for the scheduled-prompt queue, and the
 * same one the atomic-writer's stray `.tmp` files were fixed for. Found live
 * 2026-08-12: 44 acks + 24 reports dating back to 2026-07-16, none ever
 * removed by any code path - readReports/readAck only ever ADD readers, no
 * writer ever cleans up after itself.
 *
 * Acks and reports are terminal, one-shot facts (a dispatch is acked/reported
 * exactly once and never updated afterwards), so unlike pruneScheduledPrompts
 * there is no "pending" case to protect - anything past maxAgeMs is safe to
 * drop outright. Ages off each record's own `ackedAt`/`reportedAt`, falling
 * back to the file's mtime for a corrupt/unparseable record rather than
 * skipping it (a file with no ever-usable content is dead weight regardless
 * of what timestamp it happens to lack).
 *
 * REQUESTS are deliberately excluded: the live claim/remove handshake
 * (claimRequest + removeRequest) already deletes a request's own files the
 * moment it's consumed, so a request file surviving to this sweep at all
 * means a stuck/orphaned claim - not routine turnover, and worth surfacing
 * rather than silently swept away.
 */
export function pruneDispatchQueue(metaHome, { now = Date.now(), maxAgeMs = 14 * 24 * 60 * 60 * 1000 } = {}) {
  let removed = 0;
  for (const dir of [acksDir(metaHome), reportsDir(metaHome)]) {
    if (!fs.existsSync(dir)) {
      continue;
    }
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(".") || !name.endsWith(".json")) {
        continue;
      }
      const file = path.join(dir, name);
      const record = readJsonTolerant(file);
      let ts = record ? Number(record.ackedAt ?? record.reportedAt) : NaN;
      if (!Number.isFinite(ts)) {
        try {
          ts = fs.statSync(file).mtimeMs;
        } catch {
          continue;
        }
      }
      if (now - ts >= maxAgeMs) {
        try {
          fs.unlinkSync(file);
          removed++;
        } catch {
          // best-effort - a locked or already-gone file is fine to skip
        }
      }
    }
  }
  return removed;
}
