/**
 * One project, one node. A second session in it is not a second seat.
 *
 * Reported 2026-08-18 with screenshots: the same row in the Captain widget kept swapping
 * between two sessions in the same project - one idle, one wanting attention - and a session looked
 * like it had vanished when it had only been displaced. The list is sorted by last
 * activity, so which of the two showed moved as he worked.
 *
 * The cause: augmentSecondMatesWithSessions emits a synthetic `sess_<id>` node for every
 * unbound session, and its guard only asked whether THIS SESSION was bound to a registered
 * second mate. It never asked whether the PROJECT already had one. So a new session in a
 * project that already had a mate became a rival node for the same project.
 *
 * The synthetic node was also a claim that was not true. A plain session started in a
 * project carries no helm-dispatch MCP - verified on the real one that caused this - so it
 * cannot orchestrate crew. A seat row said otherwise.
 *
 * ## How this is tested
 *
 * The function lives in the renderer, which is a classic script reading module-level
 * globals, so it cannot be imported. Rather than settle for grepping its source - which
 * would pass on a guard that had been broken in any way that kept the words - its source
 * is lifted out and run against stubbed globals. What it RETURNS is the thing that matters.
 */
import fs from "node:fs";

let failures = 0;
const ok = (cond, label, detail = "") => {
  console.log(`${cond ? "OK  " : "FAIL"} - ${label}${detail ? ` (${detail})` : ""}`);
  if (!cond) {
    failures += 1;
  }
};

const src = fs.readFileSync(new URL("../../src/renderer/renderer.js", import.meta.url), "utf8");

/** Lift a top-level function out of the renderer by name. */
function lift(name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) {
    return null;
  }
  // Walk braces from the signature to find the function's end.
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") {
      depth += 1;
    } else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return src.slice(at, i + 1);
      }
    }
  }
  return null;
}

const augmentSrc = lift("augmentSecondMatesWithSessions");
const samePathSrc = lift("samePath");
ok(augmentSrc !== null, "augmentSecondMatesWithSessions was found in the renderer");
ok(samePathSrc !== null, "so was samePath, which the guard uses");

/**
 * Build a runnable copy with the renderer globals it reads replaced by stubs.
 * `secondMateForSession` and `isHiddenFromHelm` are the two collaborators; `state`
 * carries the sessions.
 */
function build({ sessions, registeredFor = () => null }) {
  const factory = new Function(
    "state",
    "secondMateForSession",
    "isHiddenFromHelm",
    `${samePathSrc}\n${augmentSrc}\nreturn augmentSecondMatesWithSessions;`
  );
  return factory({ sessions }, registeredFor, () => false);
}

const session = (id, cwd, extra = {}) => ({ sessionId: id, cliSessionId: id, cwd, lastActivityAt: 1, title: `t-${id}`, ...extra });
const registered = (id, cwd, sessionId = null) => ({ secondMateId: id, projectPath: cwd, sessionId, crew: [], name: `mate-${id}` });

// --- the reported bug ---------------------------------------------------------------
{
  const augment = build({ sessions: [session("s-new", "D:/Repo/Tools/widgetworks")] });
  const out = augment([registered("sm_1", "D:/Repo/Tools/widgetworks", "s-old")], []);
  const forProject = out.filter((n) => n.projectPath && n.projectPath.toLowerCase().includes("widgetworks"));
  ok(forProject.length === 1, "a project with a registered mate ends up with ONE node", `${forProject.length} nodes`);
  ok(forProject[0].secondMateId === "sm_1", "and it is the registered one, not the session", forProject[0].secondMateId);
}

// --- the case that must keep working -------------------------------------------------
// A project with no registered mate is exactly how Direct work becomes visible at all.
{
  const augment = build({ sessions: [session("s-lone", "D:/Repo/Tools/nib")] });
  const out = augment([], []);
  ok(out.length === 1, "a session in a project with NO mate still gets a node", `${out.length}`);
  ok(out[0].secondMateId === "sess_s-lone", "and it is the session node", out[0].secondMateId);
  ok(out[0].isSessionNode === true, "marked as one");
}

// --- separators and case must not create a rival --------------------------------------
// The whole bug is two nodes for one project, so a path that fails to match is the bug.
{
  const augment = build({ sessions: [session("s-new", "d:\\repo\\tools\\widgetworks\\")] });
  const out = augment([registered("sm_1", "D:/Repo/Tools/widgetworks", "s-old")], []);
  ok(out.length === 1, "a Windows path in a different case and slash direction is the same project", `${out.length} nodes`);
}

// --- unrelated projects are untouched --------------------------------------------------
{
  const augment = build({ sessions: [session("s-a", "D:/Repo/Tools/loom"), session("s-b", "D:/Repo/Tools/brief")] });
  const out = augment([registered("sm_1", "D:/Repo/Tools/widgetworks", "s-old")], []);
  ok(out.length === 3, "sessions in other projects still get their own nodes", `${out.length}`);
}

// --- a first mate's own session is still not Direct work --------------------------------
// Pre-existing behaviour that must survive the new guard.
{
  const augment = build({ sessions: [session("s-mate", "D:/Repo/Tools/helm")] });
  const out = augment([], [{ mateId: "mate_1", sessionId: "s-mate" }]);
  ok(out.length === 0, "a first mate's own session does not appear as Direct work", `${out.length}`);
}

console.log("");
if (failures > 0) {
  console.log(`VERIFY FAILED: ${failures} assertion(s)`);
  process.exit(1);
}
console.log("VERIFY OK: one project, one node - and a session with no seat does not pretend to be one.");
