// Retiring a seat hands its subtree to the successor. It destroys nothing and orphans nothing.
//
// WHAT THIS REPLACES. mates:retire used to tear the subtree down first - archive every second
// mate's session, drop its binding - and retire is the ORDINARY saturation refresh, the thing
// you do to a seat whose context has filled. Under the merged tier the subtree is running crew
// with worktrees and commits, so that default destroys live work on the most routine action in
// the model. Not tearing down was the only other option on the table and it re-opens the
// orphan bug (58e9a433): rows pointing at a mateId that no longer exists, with their sessions
// still running invisibly.
//
// THE THIRD OPTION, which is what is asserted here: retire is a SUCCESSION, not a deletion.
// retireAndRespawn already mints the successor and already carries the root across, so the
// outgoing record gains a `succeededBy` link and every reader resolves forward through it.
//
// THE PROPERTY THAT IS EASIEST TO GET WRONG, asserted below because getting it wrong looks
// like success: the node's OWN id must not change. Rehashing it under the successor would mint
// a new key, and the binding - which holds the sessionId that "jump in" resumes - is stored
// against the old one. Re-parenting means a child keeps its identity and changes its parent.
//
// Run:  node scripts/pure-checks/test-retire-reparents-the-subtree.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-reparent-"));
process.env.HELM_MATES_PATH = path.join(tmp, "mates.json");
process.env.HELM_SECOND_MATES_PATH = path.join(tmp, "second-mates.json");

const mates = await import("../../src/lib/mates.js");
const sm = await import("../../src/lib/secondMates.js");

let failures = 0;
function ok(condition, what) {
  console.log(`${condition ? "OK  " : "FAIL"} - ${what}`);
  if (!condition) {
    failures += 1;
  }
}

const PROJECT = path.join(tmp, "fixture-project");

try {
  const root = path.join(tmp, "meta-home");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(PROJECT, { recursive: true });
  mates.ensureMates(root, 1);

  // THE SEAT IS THE PROJECT'S SEAT, not a coordinator, and that changed on 2026-09-04 with the
  // rest of stage 4. A project node's parent is no longer whoever dispatched to it - the
  // dispatcher does not enter its identity OR its parentage - so a coordinator retiring says
  // nothing about where that node hangs. The seat opened against the checkout is what does.
  //
  // The succession link this file is about is unchanged and still load-bearing: it is what a
  // node dispatched BY A NODE resolves its binding's parent through, and it is what makes the
  // lookup below find the successor rather than nothing.
  const first = mates.ensureSeatForProject(PROJECT);

  // A crew run in that project, which is what mints its node.
  const history = [{ id: "run1", projectPath: PROJECT, dispatchedBy: first.mateId, status: "done" }];
  const before = sm.deriveSecondMates(history, {});
  ok(before.length === 1, `one project node before the retire (${before.length})`);
  const nodeId = before[0].secondMateId;
  ok(before[0].firstMateId === first.mateId, "and it hangs under the seat that dispatched it");

  // Bind a session to it, because that is what a teardown used to archive and what a rehash
  // would strand. The binding is the thing with something to lose.
  sm.bindSecondMateSession(nodeId, "session-abc", { projectPath: PROJECT });

  const successor = mates.retireAndRespawn(first.mateId, null);
  ok(successor.mateId !== first.mateId, "retiring mints a successor");
  // Same assertion, one field over: identity is a tag as of 2026-09-05. What it protects is
  // unchanged and is the reason this line exists - a refreshed project seat that came back
  // pooled would be a seat of a different sort wearing the old one's root.
  ok(
    (successor.tags || []).includes("project"),
    `and the successor is still WHAT IT WAS, not a pooled seat wearing its root (${JSON.stringify(successor.tags)})`
  );
  ok(successor.slot === null, "so it does not take a slot in the coordinator pool either");
  ok(
    mates.currentSeatId(first.mateId) === successor.mateId,
    `the retired id resolves forward to it (${mates.currentSeatId(first.mateId)})`
  );

  const after = sm.deriveSecondMates(history, sm.readBindings());
  ok(after.length === 1, `still ONE project node after the retire, not two (${after.length})`);
  ok(
    after[0].firstMateId === successor.mateId,
    `and it hangs under the successor rather than a dead id (${after[0].firstMateId})`
  );

  // THE ANTI-REHASH ASSERTION.
  ok(after[0].secondMateId === nodeId, "the node kept its own id - re-parenting must not re-key it");
  ok(
    after[0].sessionId === "session-abc",
    `so its binding still resolves and jump-in still works (${JSON.stringify(after[0].sessionId)})`
  );
  ok(after[0].crew.length === 1, "and its crew came with it rather than being torn down");

  // A CHAIN, because a long-lived project retires more than once.
  const second = mates.retireAndRespawn(successor.mateId, null);
  const third = mates.retireAndRespawn(second.mateId, null);
  ok(
    mates.currentSeatId(first.mateId) === third.mateId,
    `a three-hop chain resolves to the seat holding the role now (${mates.currentSeatId(first.mateId)})`
  );
  ok(
    sm.deriveSecondMates(history, sm.readBindings())[0].firstMateId === third.mateId,
    "and the node follows the whole chain, not just the first hop"
  );

  // THE SYNTHETIC DISPATCHERS. Neither is a seat, so neither is in the store. A resolver that
  // nulled an unknown id would strip exactly the two identities that mean top-of-chain.
  ok(mates.currentSeatId("direct") === "direct", "the direct identity is returned unchanged");
  ok(mates.currentSeatId("auto") === "auto", "the auto-captain identity is returned unchanged");
  const autoHistory = [{ id: "run2", projectPath: PROJECT, dispatchedBy: "direct", startedBy: "auto" }];
  ok(
    sm.deriveSecondMates(autoHistory, {})[0].firstMateId === "auto",
    "and an auto run still lands on the auto node rather than losing its lane"
  );
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// A CYCLE, on a hand-written store. Not reachable through the API, but this store is a plain
// JSON file on a synced disk that has been hand-edited before, and this function runs once per
// node on every Fleet render - a runaway walk here hangs the window rather than logging.
{
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "helm-reparent-cycle-"));
  process.env.HELM_MATES_PATH = path.join(tmp2, "mates.json");
  fs.writeFileSync(
    path.join(tmp2, "mates.json"),
    JSON.stringify({
      mates: [
        { mateId: "mate_a", status: "retired", succeededBy: "mate_b" },
        { mateId: "mate_b", status: "retired", succeededBy: "mate_a" },
      ],
    })
  );
  const fresh = await import(`../../src/lib/mates.js?cycle=${Date.now()}`);
  const started = Date.now();
  const landed = fresh.currentSeatId("mate_a");
  ok(Date.now() - started < 2000, `a cycle returns promptly instead of spinning (${Date.now() - started}ms)`);
  ok(landed === "mate_a" || landed === "mate_b", `and returns one of the two rather than throwing (${landed})`);
  fs.rmSync(tmp2, { recursive: true, force: true });
}

// The retire/dismiss split, which lives in an IPC handler and so is read from source. Comments
// are stripped first: this change ADDED a comment naming tearDownSecondMatesFor to explain why
// retire no longer calls it, and a scan that matched its own documentation would pass for free.
//
// WHAT THIS CANNOT PROVE, said plainly: that the handlers are reachable, that the renderer
// copes with an empty torn-down list, or that no other path tears the subtree down.
const mainSrc = fs
  .readFileSync(new URL("../../src/main.js", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
  .join("\n");

function handlerBody(channel) {
  const at = mainSrc.indexOf(`ipcMain.handle("${channel}"`);
  if (at < 0) {
    return "";
  }
  const rest = mainSrc.slice(at);
  const next = rest.indexOf("ipcMain.handle", 10);
  return next < 0 ? rest : rest.slice(0, next);
}

const retireBody = handlerBody("mates:retire");
const removeBody = handlerBody("mates:remove");
ok(retireBody.length > 0 && removeBody.length > 0, "both handlers were found, so the two scans below mean something");
ok(!/tearDownSecondMatesFor/.test(retireBody), "the retire handler no longer tears the subtree down");
ok(
  /tearDownSecondMatesFor/.test(removeBody),
  "and dismiss still does, because it has no successor to hand the subtree to"
);

console.log("");
if (failures > 0) {
  console.log(`VERIFY FAILED: ${failures} problem(s)`);
  process.exit(1);
}
console.log("VERIFY OK - retire hands the subtree to the successor, keeps its identity, and dismiss still tears down");
