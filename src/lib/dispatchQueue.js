import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// First-mate tier dispatch queue (docs/first-mate-tier-design.md, section 1
// verdict "A1": a stdio MCP server over an on-disk request/report queue). This
// is the single on-disk handshake between the MCP server a first-mate session
// launches (src/mcp/maestroDispatchServer.js) and the Maestro main process
// (src/main.js's dispatch watcher). No socket, no port lifecycle - the app
// stays the single dispatch authority, and the queue is trivially
// restart-survivable (heeding the whisper-server lesson, DECISIONS.md
// 2026-07-05).
//
// Layout, rooted under a caller-supplied meta-home (the first mate's root, the
// same dir orchestrator:info resolves in main.js):
//   <meta-home>/.maestro-dispatch/requests/<dispatchId>.json   (mate -> app)
//   <meta-home>/.maestro-dispatch/reports/<dispatchId>.json    (app -> mate)
//
// Conventions deliberately mirror goalRunHistory.js / domains.js: plain JSON
// files, tolerant reads (a corrupt/half-written file is skipped, never throws),
// atomic writes (temp file + rename, so a reader/watcher never sees a partial
// object). Writes are one-file-per-dispatch rather than a single array file, so
// concurrent producers (several dispatched runs finishing at once) never race
// on the same file.

const DISPATCH_DIRNAME = ".maestro-dispatch";
const REQUESTS_SUBDIR = "requests";
const REPORTS_SUBDIR = "reports";
// Acks are the synchronous accept/reject handshake for a single dispatch: the
// app writes one the moment it validates a request (accepted -> goalRunId, or
// rejected -> reason), so the maestro_dispatch tool call can return promptly
// with { dispatchId, goalRunId, status } instead of blocking until the whole
// run finishes. The final compact result arrives later as a REPORT, which the
// mate reads with maestro_collect_reports (the pull model, design section 2).
const ACKS_SUBDIR = "acks";

export function dispatchRoot(metaHome) {
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
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
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

/** Removes a consumed request file by dispatchId. No-op if already gone. */
export function removeRequest(metaHome, dispatchId) {
  try {
    fs.unlinkSync(path.join(requestsDir(metaHome), `${dispatchId}.json`));
  } catch {
    // already consumed/removed - fine
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
  const record = { dispatchId, ...ack, ackedAt: Date.now() };
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
 * Reads report records (app -> mate), the source `maestro_collect_reports`
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
