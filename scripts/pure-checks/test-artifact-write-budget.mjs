// Iterating a design artifact does not spend a second mate's turn budget - and nothing else
// about the guard's destination-blindness moved.
//
// The block this removes was named on the artifacts card before any of it was built: design
// iteration IS writing, so three edits in, a second mate has spent its whole per-turn budget
// on a mockup that is not project code. Deciding that by asking what a file IS would be a
// judgement the guard cannot make. Deciding it by a directory the mate has to put the file in
// is mechanical, which is the same shape as the read-only command allowlist: an explicit,
// deliberate entry rather than a heuristic.
//
// ## The decision this sits next to, and why it is not a reversal of it
//
// This file refuses to be destination-aware, on purpose and with a test on it: a path check
// cannot tell a valid write from one that silently corrupts the store it lands in, so no BAN
// here turns on where a write is going.
//
// A budget is not a ban. A second mate may write; the budget only asks how much it changes
// before a human should look. So a wrong match here costs an UNCOUNTED write, never an
// unguarded one - the write was permitted either way. That distinction is the whole licence
// for this exemption, and the checks below pin both halves of it: the budget relaxes, and
// every tier whose policy is a ban stays exactly as blind to a path as it was.
import {
  decideToolCall,
  isArtifactPath,
  ARTIFACT_DIR,
  TIER_SECOND_MATE,
  TIER_FIRST_MATE,
  TIER_ASSISTANT,
  SECOND_MATE_TURN_WRITE_BUDGET,
} from "../../src/lib/tierGuard.js";

let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    fails += 1;
  }
};

const inArtifacts = `C:/work/widget-press/${ARTIFACT_DIR}/dashboard.html`;
const nested = `C:/work/widget-press/${ARTIFACT_DIR}/v2/dashboard.html`;
const windowsSpelling = `C:\\work\\widget-press\\${ARTIFACT_DIR}\\dashboard.html`;
const projectCode = "C:/work/widget-press/src/dashboard.html";

// --- the matcher, which is the whole mechanism --------------------------------------------
ok(isArtifactPath(inArtifacts), "a file in the artifacts directory matches");
ok(isArtifactPath(nested), "and one nested deeper inside it");
ok(isArtifactPath(windowsSpelling), "and the same path spelled with backslashes");
ok(!isArtifactPath(projectCode), "project code does not");
ok(!isArtifactPath(""), "an empty path does not");
ok(!isArtifactPath(null), "nor a missing one");
// SEGMENT, not substring. A directory merely named like this one must not qualify, or the
// exemption is claimable by anyone who names a folder carefully.
ok(!isArtifactPath("C:/work/my.helm-artifactsish/x.html"), "a directory whose name merely CONTAINS the artifacts name does not match");
ok(!isArtifactPath(`C:/work/prefix${ARTIFACT_DIR}/x.html`), "nor one with it as a suffix of a longer name");

// --- the budget relaxes for artifacts, and only for artifacts -----------------------------
const spent = SECOND_MATE_TURN_WRITE_BUDGET; // already at the cap
{
  const d = decideToolCall({ tier: TIER_SECOND_MATE, tool: "Write", input: { file_path: inArtifacts }, writesThisTurn: spent });
  ok(d.decision === "allow", `a second mate at its cap may still write an artifact (${d.decision})`);
  ok(d.isWrite === false, "and it does not count against the turn, or the cap would be reached again immediately");
}
{
  const d = decideToolCall({ tier: TIER_SECOND_MATE, tool: "Edit", input: { file_path: nested }, writesThisTurn: spent });
  ok(d.decision === "allow" && d.isWrite === false, "the same for an Edit deeper inside the directory");
}
{
  const d = decideToolCall({ tier: TIER_SECOND_MATE, tool: "Write", input: { file_path: projectCode }, writesThisTurn: spent });
  ok(d.decision === "deny", `but project code at the cap is still refused (${d.decision})`);
}
{
  const d = decideToolCall({ tier: TIER_SECOND_MATE, tool: "Write", input: { file_path: projectCode }, writesThisTurn: 0 });
  ok(d.decision === "allow" && d.isWrite === true, "and an ordinary write under the cap still COUNTS - the exemption did not turn the budget off");
}

// --- a shell is never exempt --------------------------------------------------------------
// Where a shell command writes cannot be read off the command with any honesty, and a guess
// there is how a narrow exemption becomes a hole.
{
  const d = decideToolCall({
    tier: TIER_SECOND_MATE,
    tool: "Bash",
    input: { command: `echo hi > ${inArtifacts}` },
    writesThisTurn: spent,
  });
  ok(d.decision === "deny", `a SHELL write into the artifacts directory is still refused at the cap (${d.decision}) - the exemption is tools only`);
}

// --- the tiers whose policy is a BAN are unchanged, and stay blind to the path -------------
// This is the half that makes the exemption defensible. If a path can talk a banning tier into
// a write, the decision this sits next to has been undone by accident.
for (const tier of [TIER_FIRST_MATE, TIER_ASSISTANT]) {
  for (const tool of ["Write", "Edit", "NotebookEdit"]) {
    const d = decideToolCall({ tier, tool, input: { file_path: inArtifacts } });
    ok(d.decision === "deny", `${tier} still cannot write ${tool} into the artifacts directory - a ban does not negotiate over a path`);
  }
  const shell = decideToolCall({ tier, tool: "Bash", input: { command: `echo hi >> ${inArtifacts}` } });
  ok(shell.decision === "deny", `${tier} still cannot append to it from a shell either`);
}

// --- and the exemption is legible in the answer -------------------------------------------
{
  const d = decideToolCall({ tier: TIER_SECOND_MATE, tool: "Write", input: { file_path: inArtifacts }, writesThisTurn: 0 });
  ok(d.artifact === true, "an exempted write says so in its answer, so a caller counting writes can tell why this one did not count");
  const ordinary = decideToolCall({ tier: TIER_SECOND_MATE, tool: "Write", input: { file_path: projectCode }, writesThisTurn: 0 });
  ok(ordinary.artifact !== true, "and an ordinary one does not claim it");
}

console.log("");
console.log(
  fails === 0
    ? "VERIFY OK: an artifact costs no budget, a shell never qualifies, and the tiers that ban writing stay blind to the path."
    : `VERIFY FAILED: ${fails} assertion(s)`
);
process.exit(fails === 0 ? 0 : 1);
