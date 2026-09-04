// A machine with NO Claude Desktop session store must still list the sessions Helm
// launched itself, and must SAY that the Desktop half is missing.
//
// The bug this pins: readAllSessions returned early the moment it could not locate the
// Claude Desktop app's session directory, so config.helmSessions - Helm's own index of
// the sessions it started via the headless `claude -p` launcher, which never get a
// Desktop local_*.json at all - was never merged. That is a brand-new user's machine
// exactly: install Helm, start a session in Helm, and the session Helm is running is
// invisible in Direct and Fleet. It was noticed only because test-helm-session-index and
// test-archive-overlay failed on a CI runner with no Claude installation while passing on
// a developer machine, i.e. by the tests, never by a person using the app.
//
// It also pins the DISTINCTION, which is the other half of the standard: "no Claude data
// on this machine" and "the Desktop app is installed and has no sessions yet" produce the
// same empty Desktop list and must not produce the same report.
//
// Hermetic: every root is a fresh temp fixture and the config path is overridden, so
// nothing here reads or writes the machine's real stores and the result does not depend
// on whether Claude is installed. paths.js resolves its roots ONCE at import time, so
// each condition needs its own process - hence the self-spawning child mode below.
//
// Pure (no app/harness) - runs in the fast lane.
// Run:  node scripts/e2e/test-session-store-absent.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const selfPath = fileURLToPath(import.meta.url);

const HELM_SESSION_ID = "helm-owned-fixture-session";
const HELM_SESSION_TITLE = "a session Helm started itself";
const HELM_SESSION_CWD = "D:/Fixture/Repo/example-project";
const ARCHIVED_SESSION_ID = "helm-owned-archived-fixture";

/*
 * Child mode: import the read layer under whatever roots the parent handed us and print
 * one JSON line describing what readAllSessions answered. Kept to a single line so the
 * parent's assertions read the module's real output rather than a re-derivation of it.
 */
if (process.argv.includes("--child")) {
  const { readAllSessions } = await import("../../src/lib/sessions.js");
  const result = readAllSessions();
  const find = (id) => (result.sessions || []).find((s) => s.sessionId === id) || null;
  process.stdout.write(
    "RESULT " +
      JSON.stringify({
        error: result.error,
        desktopStore: result.desktopStore,
        count: (result.sessions || []).length,
        owned: find(HELM_SESSION_ID),
        archived: find(ARCHIVED_SESSION_ID),
      }) +
      "\n"
  );
  process.exit(0);
}

let exit = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exit = 1;
  }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "helm-store-absent-"));

/*
 * A config holding Helm's own session index, written up front on purpose: loadConfig
 * SEEDS and writes a config when the file is missing, and a seeded default would give
 * this check an empty helmSessions and quietly test nothing.
 */
const configPath = path.join(root, "config.json");
fs.writeFileSync(
  configPath,
  JSON.stringify({
    jot: { enabled: false },
    helmSessions: {
      [HELM_SESSION_ID]: {
        sessionId: HELM_SESSION_ID,
        cliSessionId: HELM_SESSION_ID,
        title: HELM_SESSION_TITLE,
        cwd: HELM_SESSION_CWD,
        model: "claude-sonnet-5",
        createdAt: 1,
        lastActivityAt: Date.now(),
      },
      [ARCHIVED_SESSION_ID]: {
        sessionId: ARCHIVED_SESSION_ID,
        cliSessionId: ARCHIVED_SESSION_ID,
        title: "an archived Helm session",
        cwd: HELM_SESSION_CWD,
        createdAt: 1,
        lastActivityAt: Date.now(),
        isArchived: true,
      },
    },
  }),
  "utf8"
);

function readUnder(sessionsRoot, projectsRoot) {
  const res = spawnSync(process.execPath, [selfPath, "--child"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HELM_CONFIG_PATH: configPath,
      HELM_SESSIONS_ROOT: sessionsRoot,
      HELM_PROJECTS_ROOT: projectsRoot,
    },
  });
  const line = String(res.stdout || "")
    .split(/\r?\n/)
    .find((l) => l.startsWith("RESULT "));
  if (!line) {
    console.log("ERROR: the child produced no result line.");
    console.log(res.stdout);
    console.log(res.stderr);
    exit = 1;
    return null;
  }
  return JSON.parse(line.slice("RESULT ".length));
}

// --- 1) The store is ABSENT: nothing has ever been created at that path. -----------
const absentSessions = path.join(root, "never-created", "sessions");
const absentProjects = path.join(root, "never-created", "projects");
ok(!fs.existsSync(absentSessions), "the fixture's Desktop session root genuinely does not exist");

const absent = readUnder(absentSessions, absentProjects);
if (absent) {
  ok(absent.desktopStore?.available === false, "an absent Desktop store reports available: false");
  ok(absent.desktopStore?.reason === "absent", "an absent Desktop store reports reason 'absent'");
  ok(absent.desktopStore?.root === absentSessions, "the report names the path it looked at");
  // The sentence has to travel with the status, not be reconstructed by whichever surface
  // renders it - a field with no explanation attached is how the explanation gets dropped.
  ok(
    typeof absent.desktopStore?.message === "string" && absent.desktopStore.message.includes(absentSessions),
    "the report carries a readable message naming that path"
  );
  // The load-bearing one. A missing Desktop store is a missing HALF, and the half Helm
  // owns must still be listed - otherwise a first launch shows the user nothing at all.
  ok(!!absent.owned, "a Helm-owned session is still listed when the Desktop store is absent");
  ok(absent.owned?.title === HELM_SESSION_TITLE, "the Helm-owned session keeps its own title");
  ok(absent.owned?.cwd === HELM_SESSION_CWD, "the Helm-owned session keeps its own cwd");
  ok(absent.owned?.helmOwned === true, "the Helm-owned session is marked helmOwned");
  ok(absent.archived?.status === "archived", "an archived Helm-owned session still derives status 'archived'");
  // `error` is for a store that is there and cannot be read. A store that legitimately
  // does not exist on this machine is not a failure of the read, and reporting it as one
  // is what made every caller treat the whole list as unusable.
  ok(absent.error === null, "an absent Desktop store is not reported as an `error`");
}

// --- 2) The store EXISTS but holds no sessions yet. --------------------------------
// Distinguishable from case 1 by design: "the Claude Desktop app has never run here" and
// "it has run and has no sessions" are different situations and get different reasons.
const emptySessions = path.join(root, "empty", "sessions");
const emptyProjects = path.join(root, "empty", "projects");
fs.mkdirSync(emptySessions, { recursive: true });
fs.mkdirSync(emptyProjects, { recursive: true });

const empty = readUnder(emptySessions, emptyProjects);
if (empty) {
  ok(empty.desktopStore?.available === false, "an empty Desktop store also reports available: false");
  ok(
    empty.desktopStore?.reason === "empty",
    "an empty-but-present Desktop store reports reason 'empty', NOT 'absent' - the two are distinguishable"
  );
  ok(!!empty.owned, "a Helm-owned session is listed when the Desktop store is empty");
}

// --- 3) The store EXISTS and has a session: nothing is reported. -------------------
const liveSessions = path.join(root, "live", "sessions", "account", "device");
const liveProjects = path.join(root, "live", "projects");
fs.mkdirSync(liveSessions, { recursive: true });
fs.mkdirSync(liveProjects, { recursive: true });
fs.writeFileSync(
  path.join(liveSessions, "local_desktop-fixture.json"),
  JSON.stringify({
    sessionId: "local_desktop-fixture",
    cliSessionId: "desktop-fixture",
    title: "a Desktop-owned session",
    cwd: HELM_SESSION_CWD,
    lastActivityAt: Date.now(),
  }),
  "utf8"
);

const live = readUnder(liveSessions, liveProjects);
if (live) {
  ok(live.desktopStore?.available === true, "a populated Desktop store reports available: true");
  ok(live.desktopStore?.reason === null, "a populated Desktop store reports no reason");
  ok(live.desktopStore?.message === null, "a populated Desktop store carries no message to show");
  ok(live.count === 3, `both stores are merged (expected 3 sessions, got ${live.count})`);
}

fs.rmSync(root, { recursive: true, force: true });

console.log(
  exit === 0
    ? "VERIFY OK: a missing Desktop session store degrades to a partial list and says so."
    : "VERIFY FAILED."
);
process.exit(exit);
