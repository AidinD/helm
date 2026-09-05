// Drive the real MCP server and prove a legacy call actually lands in the file.
//
// WHY THIS EXISTS SEPARATELY from the alias check next to it. That one proves the recording
// FUNCTION works and reads the server's source to show the call path exists. Neither of those
// is the thing the measurement rests on.
//
// THE PROBLEM WITH THE MEASUREMENT, and it is the day's own rule pointed at the instrument
// built to answer it: if the file's emptiness IS the answer, then "nothing called the old
// name" and "the logging never worked" produce an identical file. A short-lived server
// appending to a shared path has several quiet ways to write nothing - a meta-home that
// resolves differently under the packaged app, a directory that does not exist, a permission,
// an exception swallowed because the record must never gate the call. Every one of those looks
// exactly like success.
//
// So before that file is ever read as evidence, it has to be shown that it CAN be made
// non-empty by the real path: a real process, speaking the real protocol, called by name.
//
// WHAT THIS STILL DOES NOT COVER, said rather than implied: it runs the server the way the dev
// tree does. The packaged app resolves its data directory differently, and that difference is
// where this repo's silent divergences have lived before. A packaged run would be the stronger
// evidence and this is not it.
//
// Run:  node scripts/pure-checks/test-legacy-call-is-really-recorded.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLegacyToolCalls } from "../../src/lib/dispatchQueue.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, "..", "..", "src", "mcp", "helmDispatchServer.js");

let failures = 0;
function ok(condition, what) {
  console.log(`${condition ? "OK  " : "FAIL"} - ${what}`);
  if (!condition) {
    failures += 1;
  }
}

const metaHome = fs.mkdtempSync(path.join(os.tmpdir(), "helm-legacy-e2e-"));

/** Speak the protocol at the real server and collect its replies. */
function ask(messages, { timeoutMs = 20000 } = {}) {
  // Resolve on the LAST expected reply, not on the process closing. Ending stdin straight away
  // killed the server mid-call: the record still landed, because it is written before the tool
  // is delegated to, but the reply never arrived - which looked like the tool failing when it
  // was the harness hanging up.
  const wanted = messages.filter((m) => m.id !== undefined).length;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [server], {
      env: {
        ...process.env,
        HELM_META_HOME: metaHome,
        HELM_MATE_ID: "mate_fixture",
        HELM_CALLER_TIER: "first-mate",
        HELM_PROJECTS: JSON.stringify([{ name: "fixture", path: path.join(metaHome, "fixture-repo") }]),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let settled = false;
    const parse = () =>
      out
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    const finish = (replies) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // already gone
      }
      resolve(replies);
    };
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error("the server did not answer in time"));
      }
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      out += d.toString();
      const replies = parse();
      if (replies.length >= wanted) {
        finish(replies);
      }
    });
    child.on("error", reject);
    child.on("close", () => finish(parse()));
    for (const m of messages) {
      child.stdin.write(JSON.stringify(m) + "\n");
    }
  });
}

try {
  fs.mkdirSync(path.join(metaHome, "fixture-repo"), { recursive: true });

  ok(readLegacyToolCalls(metaHome).length === 0, "the file starts empty, so a line appearing means something");

  const replies = await ask([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "helm_create_second_mate", arguments: { project: "fixture", brief: "a fixture assignment" } },
    },
  ]);

  ok(replies.length >= 3, `the real server answered (${replies.length} messages)`);

  // The advertised list, end to end rather than by reading source.
  const listed = (replies.find((r) => r.id === 2)?.result?.tools || []).map((t) => t.name);
  ok(listed.length > 0, `it advertises tools (${listed.length})`);
  ok(!listed.includes("helm_create_second_mate"), "and the old name is NOT among them");
  ok(listed.includes("helm_open_project"), "while the new one is");

  // THE POINT. A call under the old name reached the tool AND left a trace.
  const called = replies.find((r) => r.id === 3);
  ok(!!called, "a reply came back for the call under the old name");
  ok(
    !!called && !called.error,
    `and it is not an error (${called ? JSON.stringify(called.error || "no error") : "no reply at all"})`
  );

  const recorded = readLegacyToolCalls(metaHome);
  ok(recorded.length === 1, `and the call is in the file (${recorded.length})`);
  ok(recorded[0]?.name === "helm_create_second_mate", `under the name that was used (${recorded[0]?.name})`);
  ok(typeof recorded[0]?.at === "string", `with when (${recorded[0]?.at})`);

  // A NEW name must leave nothing, or the file stops meaning "somebody used an old name".
  await ask([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "helm_open_project", arguments: { project: "fixture", brief: "again, by its real name" } },
    },
  ]);
  ok(
    readLegacyToolCalls(metaHome).length === 1,
    `a call under the CURRENT name records nothing (${readLegacyToolCalls(metaHome).length})`
  );
} finally {
  fs.rmSync(metaHome, { recursive: true, force: true });
}

console.log("");
if (failures > 0) {
  console.log(`VERIFY FAILED: ${failures} problem(s)`);
  process.exit(1);
}
console.log("VERIFY OK - the file can be made non-empty by the real path, so its emptiness will mean something");
