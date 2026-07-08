// Unit test (pure node, no Electron/claude): readAllSessions merges Helm's own
// session index (config.helmSessions) with the Desktop app's local_*.json, so
// sessions Helm creates via the headless `claude -p` launcher - which never
// writes a Desktop metadata file - still surface in Direct/Fleet. Also checks
// the Desktop-file-wins dedup and that an archived Helm entry derives "archived".
// Run:  node scripts/e2e/test-helm-session-index.mjs
import { readAllSessions } from "../../src/lib/sessions.js";

let exit = 0;
function assert(cond, msg) {
  console.log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exit = 1;
  }
}

// Baseline: real Desktop sessions only (inject an empty Helm index so this
// doesn't depend on the machine's actual config).
const base = readAllSessions({ helmSessions: {} });
assert(base.error === null || Array.isArray(base.sessions), "readAllSessions returns a sessions array");
const baseIds = new Set(base.sessions.map((s) => s.sessionId));

// 1) A Helm-owned session with a unique id appears in the merged list.
const uniqueId = "helm-test-" + "0123456789abcdef";
const withHelm = readAllSessions({
  helmSessions: {
    [uniqueId]: {
      sessionId: uniqueId,
      cliSessionId: uniqueId,
      cwd: "D:/Repo/Tools/helm",
      model: "claude-sonnet-5",
      title: "helm-created session",
      createdAt: 1,
      lastActivityAt: Date.now(),
    },
  },
});
const found = withHelm.sessions.find((s) => s.sessionId === uniqueId);
assert(!!found, "a Helm-owned session (no Desktop file) is surfaced by readAllSessions");
assert(found && found.title === "helm-created session", "the Helm session carries its own title");
assert(found && found.cwd === "D:/Repo/Tools/helm", "the Helm session carries its own cwd");

// 2) Dedup: a Helm entry whose id collides with a real Desktop session must NOT
// double it (Desktop file wins). Only runs if the machine has any real session.
if (base.sessions.length > 0) {
  const realId = base.sessions[0].sessionId;
  const merged = readAllSessions({
    helmSessions: {
      [realId]: { sessionId: realId, cliSessionId: realId, title: "SHADOW", cwd: "X", createdAt: 1, lastActivityAt: 2 },
    },
  });
  const matches = merged.sessions.filter((s) => s.sessionId === realId);
  assert(matches.length === 1, "an id collision with a Desktop session is NOT duplicated (Desktop wins)");
  assert(matches[0].title !== "SHADOW", "the Desktop session's own metadata wins over the Helm shadow entry");
} else {
  console.log("SKIP - no real Desktop sessions on this machine to test dedup against");
}

// 3) An archived Helm entry derives status "archived" (so renderer filters hide it).
const arch = readAllSessions({
  helmSessions: {
    "helm-arch-test": {
      sessionId: "helm-arch-test",
      cliSessionId: "helm-arch-test",
      title: "archived one",
      cwd: "X",
      createdAt: 1,
      lastActivityAt: Date.now(),
      isArchived: true,
    },
  },
});
const archived = arch.sessions.find((s) => s.sessionId === "helm-arch-test");
assert(archived && archived.status === "archived", "an archived Helm session derives status 'archived'");

console.log(exit === 0 ? "VERIFY OK: Helm session index merges, dedups, and archives correctly." : "VERIFY FAILED.");
process.exit(exit);
