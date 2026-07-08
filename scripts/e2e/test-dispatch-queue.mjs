// Focused test: the first-mate dispatch queue (src/lib/dispatchQueue.js) round-
// trips a request -> ack -> report through the on-disk inboxes, with tolerant
// reads and the since/dispatchIds filters. Plain-node (no Electron harness) -
// this exercises the file-handshake lib directly, the way the MCP server and
// main.js's watcher use it.
//
// Run:  node scripts/e2e/test-dispatch-queue.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureDispatchDirs,
  writeRequest,
  readRequests,
  claimRequest,
  removeRequest,
  writeAck,
  readAck,
  writeReport,
  readReports,
  requestsDir,
  reportsDir,
  acksDir,
} from "../../src/lib/dispatchQueue.js";

function log(...a) {
  console.log("[dispatch-queue-test]", ...a);
}
let exitCode = 0;
function assert(cond, msg) {
  log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exitCode = 1;
  }
}

const metaHome = fs.mkdtempSync(path.join(os.tmpdir(), "helm-dispatch-test-"));
try {
  ensureDispatchDirs(metaHome);
  assert(fs.existsSync(requestsDir(metaHome)), "requests dir created");
  assert(fs.existsSync(reportsDir(metaHome)), "reports dir created");
  assert(fs.existsSync(acksDir(metaHome)), "acks dir created");

  // Write a request; a dispatchId is generated and returned.
  const dispatchId = writeRequest(metaHome, {
    project: "skiff",
    goal: "Do the thing",
    tier: "crew",
    model: "opus",
    dispatchedBy: "mate_abc",
  });
  assert(typeof dispatchId === "string" && dispatchId.length > 0, "writeRequest returns a dispatchId");

  const requests = readRequests(metaHome);
  assert(requests.length === 1, `one request read back (got ${requests.length})`);
  assert(requests[0].dispatchId === dispatchId, "request round-trips its dispatchId");
  assert(requests[0].project === "skiff" && requests[0].goal === "Do the thing", "request round-trips project + goal");
  assert(typeof requests[0].requestedAt === "number", "request stamped with requestedAt");
  assert(typeof requests[0]._file === "string", "request carries its _file path for the consumer");

  // Tolerant read: a garbage file in the inbox is skipped, not thrown on.
  fs.writeFileSync(path.join(requestsDir(metaHome), "garbage.json"), "{not json", "utf8");
  fs.writeFileSync(path.join(requestsDir(metaHome), ".hidden.tmp"), "ignored", "utf8");
  const afterGarbage = readRequests(metaHome);
  assert(afterGarbage.length === 1, `garbage + dotfile skipped, still one valid request (got ${afterGarbage.length})`);

  // Ack accept -> readable.
  writeAck(metaHome, dispatchId, { status: "accepted", goalRunId: "grun_1" });
  const ack = readAck(metaHome, dispatchId);
  assert(ack && ack.status === "accepted" && ack.goalRunId === "grun_1", "ack accept round-trips with goalRunId");
  assert(readAck(metaHome, "no-such-id") === null, "readAck returns null for an unknown dispatchId");

  // Atomic claim (H1): exactly one winner; a claimed request leaves the pool.
  const claimId = writeRequest(metaHome, { project: "p", goal: "claim-me" });
  assert(claimRequest(metaHome, claimId) === true, "claimRequest wins on first claim");
  assert(claimRequest(metaHome, claimId) === false, "a second claim of the same request loses (atomic single-winner)");
  assert(!readRequests(metaHome).some((r) => r.dispatchId === claimId), "a claimed request leaves the pending pool");
  removeRequest(metaHome, claimId);

  // Consume the request.
  removeRequest(metaHome, dispatchId);
  assert(readRequests(metaHome).length === 0, "removeRequest consumes the request file");

  // Reports: write two, test since + dispatchIds filters + sort order.
  writeReport(metaHome, { dispatchId, dispatchedBy: "mate_abc", status: "done", summary: "first", reportedAt: 1000 });
  writeReport(metaHome, { dispatchId: "other", dispatchedBy: "mate_abc", status: "escalated", summary: "second", reportedAt: 2000 });
  const all = readReports(metaHome);
  assert(all.length === 2, `two reports read back (got ${all.length})`);
  assert(all[0].reportedAt === 1000 && all[1].reportedAt === 2000, "reports sorted ascending by reportedAt");

  const since = readReports(metaHome, { since: 1000 });
  assert(since.length === 1 && since[0].dispatchId === "other", "since filter excludes reports at/before the timestamp");

  const byId = readReports(metaHome, { dispatchIds: [dispatchId] });
  assert(byId.length === 1 && byId[0].summary === "first", "dispatchIds filter selects only the named report");

  log(exitCode === 0 ? "VERIFY OK: dispatch queue round-trip + filters + tolerant reads." : "VERIFY FAILED.");
} catch (err) {
  exitCode = 1;
  log("ERROR:", err.stack || err.message);
} finally {
  fs.rmSync(metaHome, { recursive: true, force: true });
  log("cleanup: temp meta-home removed");
}
process.exit(exitCode);
