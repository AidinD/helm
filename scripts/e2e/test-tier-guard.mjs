// The tier guard's policy, exercised directly (src/lib/tierGuard.js).
//
// The old guard was a list of tool NAMES, and its test asked a first mate to write one
// file with the Write tool and checked the file was absent. That passed for a year while
// the actual behaviour was: Write refused, `cat > file << EOF` succeeds, five files
// created. The test proved the tool was denied. It never asked the question the guard
// claimed to answer - can this mate create a file?
//
// So this suite is built from the REAL commands out of the two incident transcripts, not
// from invented ones, and every allow-case is a command a coordinator genuinely needs.
// A guard that blocks `git log` is not a stricter guard, it is a broken coordinator.
//
// Pure (no app, no model, no shell execution - the classifier never runs a byte of what
// it reads). Fast lane.
// Run:  node scripts/e2e/test-tier-guard.mjs
import {
  decideToolCall,
  shellNotReadOnlyReason,
  readShell,
  TIER_FIRST_MATE,
  TIER_SECOND_MATE,
  SECOND_MATE_TURN_WRITE_BUDGET,
} from "../../src/lib/tierGuard.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const firstMate = (tool, input) => decideToolCall({ tier: TIER_FIRST_MATE, tool, input });
const denies = (tool, input) => firstMate(tool, input).decision === "deny";
const allows = (tool, input) => firstMate(tool, input).decision === "allow";

// ---------------------------------------------------------------------------
// 1. The routes actually taken, verbatim from the transcripts
// ---------------------------------------------------------------------------

// Captain Hook, 2026-08-12: Write refused three times, then this, to the same file, in
// the same turn.
ok(
  denies("Bash", { command: "cat > people-skills/SKILL.md << 'EOF'\nhello\nEOF" }),
  "the heredoc redirect Captain Hook used after three refused Writes is refused"
);

// Captain Haddock, 2026-08-13: an entire Electron app, scaffolded this way.
ok(denies("Bash", { command: 'mkdir -p "/d/Repo/Tools/nudge/src/main"' }), "the mkdir that started the nudge scaffold is refused");
ok(denies("Bash", { command: 'cat > "/d/Repo/Tools/nudge/package.json" << \'EOF\'\n{}\nEOF' }), "and the file it wrote next");
ok(
  denies("Bash", { command: 'cd "/d/Repo/Tools/nudge" && python - << \'EOF\'\npath = "src/main/index.ts"\nEOF' }),
  "and the python heredoc it switched to for editing its own source - an inline program can write anything, so it counts as a write"
);
ok(denies("Bash", { command: 'cd "/d/Repo/Tools/nudge" && git commit -q -m "Initial Nudge app"' }), "and the commit");
ok(
  denies("Bash", { command: 'cd "/d/Repo/Tools/nudge" && gh release create v0.1.1 "dist/Nudge Setup 0.1.1.exe"' }),
  "and the GitHub release - the most outward-facing thing that turn did"
);
ok(denies("Bash", { command: "cd /d/Repo/Tools/nudge && npm run dev" }), "and the build it ran to check its own work");

// ---------------------------------------------------------------------------
// 2. The routes NOT taken, which is where a name-list guard fails open
// ---------------------------------------------------------------------------
ok(denies("Bash", { command: "echo hi >> notes.md" }), "append redirection");
ok(denies("Bash", { command: "echo hi | tee notes.md" }), "tee");
ok(denies("Bash", { command: "sed -i 's/a/b/' file.txt" }), "sed -i");
ok(denies("Bash", { command: "cp a.txt b.txt" }), "cp");
ok(denies("Bash", { command: "rm -rf build" }), "rm");
ok(denies("PowerShell", { command: 'Set-Content -Path notes.md -Value "hi"' }), "PowerShell Set-Content - Haddock's session used PowerShell 8 times");
ok(denies("PowerShell", { command: '"hi" | Out-File notes.md' }), "PowerShell Out-File");
ok(denies("Bash", { command: "node -e \"require('fs').writeFileSync('x','y')\"" }), "node -e");
ok(denies("Bash", { command: "python3 script.py" }), "a named script file, which is an inline program wearing a filename");
ok(denies("Bash", { command: "git -C /some/repo commit -m x" }), "git -C <dir> commit, where the subcommand is not the next word");
ok(denies("Bash", { command: "ls && cat > x.txt" }), "a write hidden behind an allowed command in a chain");
ok(denies("Bash", { command: "echo $(touch sneaky.txt)" }), "a write inside a command substitution");
ok(denies("Bash", { command: "echo `touch sneaky.txt`" }), "and inside backticks");
ok(denies("Write", { file_path: "x.md", content: "y" }), "the Write tool itself, for the tier whose budget still has to count it");

// ---------------------------------------------------------------------------
// 3. A coordinator that cannot read is not a coordinator
// ---------------------------------------------------------------------------
ok(allows("Bash", { command: "git log --oneline -20" }), "git log");
ok(allows("Bash", { command: "git status --short" }), "git status");
ok(allows("Bash", { command: "git diff HEAD~1" }), "git diff");
ok(allows("Bash", { command: "ls -la /d/Repo/Tools" }), "ls");
ok(allows("Bash", { command: "cat <your-jot-data-dir>/todos.json" }), "cat, reading the board - the single most common thing this tier does");
ok(allows("Bash", { command: "grep -rn 'TODO' src/ | head -20" }), "grep piped into head - a pipe is not a redirect");
ok(allows("Bash", { command: "node --version" }), "node --version, which runs no program");
ok(allows("Bash", { command: "npm ls --depth=0" }), "npm ls");
ok(allows("Bash", { command: "gh issue list" }), "gh issue list");
ok(allows("Bash", { command: "echo 'hello world'" }), "a plain echo");
ok(allows("Bash", { command: "git status 2>&1" }), "2>&1 duplicates a file descriptor and writes no file");
ok(allows("Read", { file_path: "x.md" }), "the Read tool");
ok(allows("mcp__helm-dispatch__helm_create_second_mate", { project: "dinghy" }), "and the delegation tool this guard exists to push it toward");

// ---------------------------------------------------------------------------
// 4. Unreadable input fails CLOSED
// ---------------------------------------------------------------------------
// Kun Chen's cd-guard deliberately fails OPEN on syntax it cannot parse, because a
// wrongly blocked write there is a correctness hazard. Here the trade runs the other
// way, and the asymmetry is the point rather than an oversight.
const broken = shellNotReadOnlyReason("echo 'unterminated");
ok(!!broken, `an unreadable command is refused rather than waved through (${broken})`);
ok(readShell("echo 'unterminated").error === true, "and the reader reports WHY, rather than silently returning a partial word list");

// ---------------------------------------------------------------------------
// 5. Quoted data is data, not code
// ---------------------------------------------------------------------------
// The counterpart risk: a guard that greps the raw string blocks a coordinator for
// TALKING about a write. The captain's own note from 2026-07-03 is that a compound command
// is matched as one string by the permission list, which is why this lexes instead.
ok(allows("Bash", { command: "echo 'use cat > file to write it'" }), "a redirect INSIDE quotes is text, not a redirect");
ok(allows("Bash", { command: 'git log --grep="mkdir"' }), "a writing command named inside a quoted argument is a search term");

// ---------------------------------------------------------------------------
// 6. The second mate's budget: bigger jobs, not all jobs
// ---------------------------------------------------------------------------
const sm = (writes) => decideToolCall({ tier: TIER_SECOND_MATE, tool: "Write", input: { file_path: "a.ts" }, writesThisTurn: writes });
ok(sm(0).decision === "allow", "a second mate's first hands-on change is allowed - the ask was 'not BIGGER jobs', not 'nothing'");
ok(sm(SECOND_MATE_TURN_WRITE_BUDGET - 1).decision === "allow", `and the last one inside the budget (${SECOND_MATE_TURN_WRITE_BUDGET})`);
const over = sm(SECOND_MATE_TURN_WRITE_BUDGET);
ok(over.decision === "deny", "the one past the budget is refused");
ok(/helm_dispatch/.test(over.reason || ""), "and the refusal names the tool to use instead, rather than only saying no");
ok(sm(0).isWrite === true, "an ALLOWED write still reports as a write, so the counter advances - counting only denials would make the budget unreachable");

// The same command, two tiers, two answers - the guard is about who does the work.
const cmd = { command: "cat > src/app.ts << 'EOF'\nx\nEOF" };
ok(decideToolCall({ tier: TIER_FIRST_MATE, tool: "Bash", input: cmd }).decision === "deny", "a first mate cannot write source");
ok(decideToolCall({ tier: TIER_SECOND_MATE, tool: "Bash", input: cmd, writesThisTurn: 0 }).decision === "allow", "a second mate can, within its budget");
ok(decideToolCall({ tier: "crew", tool: "Bash", input: cmd }).decision === "allow", "and crew is untouched - crew IS the tier that writes code");
ok(decideToolCall({ tier: "", tool: "Bash", input: cmd }).decision === "allow", "an untiered session (the captain's own) is untouched too - this is not a permission system");

console.log(
  exit === 0
    ? "VERIFY OK: every route from both incidents is refused, reading is untouched, unreadable input fails closed, and the second mate keeps small changes."
    : "VERIFY FAILED."
);
process.exit(exit);
