// A DIFFERENTIAL ORACLE for the tier guard: run the command for real in a throwaway
// directory, look at whether a file appeared or changed, and compare that against what the
// classifier said. Reality is the oracle, not a list somebody wrote.
//
// This exists because the first version of the guard was tested only against routes its
// author had thought of, and passed. An independent review then ran 90 genuinely
// file-writing commands through it and 80 were ALLOWED, including `bash -c "cat > file"` -
// seven characters in front of the exact command from the incident the guard was built for.
// Its own header had argued that enumerations fail open, and it enumerated anyway.
//
// The reviewer's first recommendation was this file, in these words: "the only check that
// cannot be limited by the author's imagination". So the corpus below is deliberately
// hostile and includes every bypass that review found.
//
// The interesting direction is one-sided. A command that WRITES and is ALLOWED is a hole -
// that is a hard failure. A command that only READS and is DENIED is a false block: it costs
// a coordinator something it legitimately needed, so those are listed and asserted
// separately against a curated read-only corpus rather than inferred from the sandbox.
//
// SAFETY: every command runs inside a fresh temp directory, with cwd set there, and only
// paths under it are used. Nothing reaches the real filesystem. Commands that would touch
// the network are excluded rather than made to fail slowly.
//
// Run:  node scripts/e2e/test-tier-guard-oracle.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { shellNotReadOnlyReason, shellMutatesFile } from "../../src/lib/tierGuard.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/bash";
if (!fs.existsSync(bash)) {
  console.log(`SKIP - no bash at ${bash}; the oracle needs a real shell to be an oracle.`);
  process.exit(0);
}

// Commands that genuinely create or change a file. Every one of these MUST be refused for a
// first mate; the oracle proves the "genuinely" half by running them.
const WRITERS = [
  "cat > pwn.txt << 'EOF'\nhi\nEOF",
  "echo hi > pwn.txt",
  "echo hi >> pwn.txt",
  "echo hi >| pwn.txt",
  "echo hi &> pwn.txt",
  "echo hi >& pwn.txt",
  "printf 'x' > pwn.txt",
  "echo hi | tee pwn.txt",
  "mkdir pwndir",
  "touch pwn.txt",
  "cp seed.txt pwn.txt",
  "mv seed.txt pwn.txt",
  "rm seed.txt",
  "ln -s seed.txt pwn.txt",
  "sed -i 's/a/b/' seed.txt",
  "bash -c \"cat > pwn.txt <<< hi\"",
  "sh -c 'echo hi > pwn.txt'",
  "bash -c 'touch pwn.txt'",
  "eval 'echo hi > pwn.txt'",
  "FOO=1 cat > pwn.txt << 'EOF'\nhi\nEOF",
  "T=tee; echo hi | $T pwn.txt",
  "node -e \"require('fs').writeFileSync('pwn.txt','y')\"",
  "node -p \"require('fs').writeFileSync('pwn.txt','y')\"",
  "node --eval \"require('fs').writeFileSync('pwn.txt','y')\"",
  "awk 'BEGIN{print \"x\" > \"pwn.txt\"}'",
  "find . -name seed.txt -exec cp {} pwn.txt \\;",
  "xargs touch pwn.txt < /dev/null",
  "env touch pwn.txt",
  "nohup touch pwn.txt",
  "timeout 5 touch pwn.txt",
  "command touch pwn.txt",
  "exec > pwn.txt; echo hi",
  "echo $(touch pwn.txt)",
  "echo `touch pwn.txt`",
  "( touch pwn.txt )",
  "true && touch pwn.txt",
  "false || touch pwn.txt",
  "for f in a; do touch pwn.txt; done",
  "git init pwnrepo",
  "tar -cf pwn.tar seed.txt",
  "install seed.txt pwn.txt",
  "dd if=seed.txt of=pwn.txt 2>/dev/null",
  "truncate -s 0 seed.txt",
  "python3 -c \"open('pwn.txt','w').write('x')\"",
  "sed 's/a/b/' seed.txt > pwn.txt",
  // Added after a third review (2026-08-16) ran its own corpus and found these three ALLOWED.
  // All three sat in READ_ONLY - the one list this design claims is safe to enumerate - which
  // is the strongest argument for keeping this file's corpus growing rather than fixed. The
  // last one overwrote its SOURCE file in place: the 2026-08-12 incident, spelled differently.
  "sort -o pwn.txt seed.txt",
  "uniq seed.txt pwn.txt",
  "awk -i inplace '{print \"MUTATED\"}' seed.txt",
  "split -l 1 seed.txt pwn",
  "shuf -o pwn.txt seed.txt",
  "csplit -f pwn seed.txt 1",
  "source ./writer.sh",
  ". ./writer.sh",
  "echo 'touch pwn.txt' | bash",
  "npx --yes -- node -e \"require('fs').writeFileSync('pwn.txt','y')\"",
  "if true; then touch pwn.txt; fi",
  "case a in a) touch pwn.txt;; esac",
  "{ touch pwn.txt; }",
  "$(echo touch) pwn.txt",
  "nice -n 5 touch pwn.txt",
  "stdbuf -o0 touch pwn.txt",
  "cat seed.txt | sed 's/a/b/' > pwn.txt",
];

// Commands a coordinator genuinely needs, which MUST stay allowed. Asserted against the
// classifier only - the sandbox cannot prove a read is "needed", and several of these
// deliberately mention writing commands as DATA, which is the false-block class the review
// found (`grep -rn install src/` was refused by the previous version).
const READERS = [
  "git log --oneline -20",
  "git log --all --grep=fix",
  "git log --grep \"mkdir\"",
  "git status --short",
  "git diff HEAD~1",
  "git show HEAD",
  "git blame src/main.js",
  "git rev-parse HEAD",
  "git branch",
  "git branch -a",
  "git branch -vv",
  "git tag -l",
  "git remote -v",
  "git stash list",
  "git config --get user.email",
  "git worktree list",
  "git ls-files",
  "git -C /some/repo log --oneline",
  "gh issue list",
  "gh pr view 12",
  "gh pr diff 12",
  "gh pr checks 12",
  "gh api repos/AidinD/jot/issues",
  "gh run view 12",
  "gh auth status",
  "ls -la",
  "ls scripts/ | grep tar",
  "cat README.md",
  "cat <your-jot-data-dir>/todos.json",
  "cat README.md | grep -i install",
  "grep -rn install src/",
  "grep -rn rm src/",
  "grep -c \"patch\" CHANGELOG.md",
  "grep -rn 'TODO' src/ | head -20",
  "echo 'tee'",
  "echo 'use cat > file to write it'",
  "find . -name '*.js'",
  "jq '.version' package.json",
  "wc -l src/main.js",
  "head -50 src/main.js",
  "node --version",
  "npm ls --depth=0",
  "npm view react version",
  "npm outdated",
  "sed 's/a/b/' file.txt",
  "awk '{print $1}' file.txt",
  "git status 2>&1",
  "pwd",
  "which node",
  "diff a.txt b.txt",
  // The false blocks a third review measured. Every one is a command a coordinator plausibly
  // reaches for, and `git diff @{u}..HEAD` was literally the command that review's own brief
  // told it to run.
  "git diff @{u}..HEAD --stat",
  "git log --oneline @{u}..HEAD",
  "git tag",
  "git branch --contains HEAD",
  "git branch --merged main",
  "git show-branch",
  "gh api -X GET repos/AidinD/jot",
  "python3 -m json.tool package.json",
  "git for-each-ref --sort=-committerdate",
  "git blame -L 1,20 src/main.js",
  "git worktree list --porcelain",
  "git bisect log",
  "cat package.json | jq '.scripts | keys'",
  "rg -n \"TODO\" --glob '!node_modules'",
  "bash -c 'ls -la'",
  "stat -c %s package.json",
];

const root = fs.mkdtempSync(path.join(os.tmpdir(), "helm-oracle-"));

function snapshot(dir) {
  const seen = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        seen.set(p, "dir");
        walk(p);
      } else {
        let st;
        try {
          st = fs.statSync(p);
        } catch {
          continue;
        }
        seen.set(p, `${st.size}`);
      }
    }
  };
  walk(dir);
  return seen;
}

function reallyWrites(cmd) {
  const dir = fs.mkdtempSync(path.join(root, "run-"));
  fs.writeFileSync(path.join(dir, "seed.txt"), "bbb\naaa\naaa\n", "utf8");
  fs.writeFileSync(path.join(dir, "writer.sh"), "touch pwn.txt\n", "utf8");
  const before = snapshot(dir);
  spawnSync(bash, ["-c", cmd], { cwd: dir, timeout: 8000, encoding: "utf8", stdio: "ignore" });
  const after = snapshot(dir);
  if (before.size !== after.size) {
    return true;
  }
  for (const [p, v] of after) {
    if (before.get(p) !== v) {
      return true;
    }
  }
  return false;
}

// --- the holes: wrote for real, but the guard let it through -----------------
const holes = [];
const inertCorpus = [];
for (const cmd of WRITERS) {
  const wrote = reallyWrites(cmd);
  if (!wrote) {
    // Did not actually write in this sandbox (a missing tool, a platform difference).
    // It proves nothing either way, so it is reported and excluded rather than counted.
    inertCorpus.push(cmd);
    continue;
  }
  if (!shellNotReadOnlyReason(cmd)) {
    holes.push(cmd);
  }
}
ok(
  holes.length === 0,
  holes.length === 0
    ? `every command that actually changed the sandbox is refused for a first mate (${WRITERS.length - inertCorpus.length} verified writers)`
    : `${holes.length} command(s) CHANGED THE FILESYSTEM and were allowed:\n      ${holes.map((c) => JSON.stringify(c)).join("\n      ")}`
);
if (inertCorpus.length) {
  console.log(`     note: ${inertCorpus.length} corpus entries did not write in this sandbox and were excluded from the assertion: ${inertCorpus.map((c) => c.split("\n")[0]).join(" | ")}`);
}
ok(WRITERS.length - inertCorpus.length >= 35, `the corpus that actually ran is big enough to mean something (${WRITERS.length - inertCorpus.length} writers)`);

// --- the budget must count the same writes -----------------------------------
const uncounted = WRITERS.filter((c) => !inertCorpus.includes(c)).filter((c) => !shellMutatesFile(c));
ok(
  uncounted.length === 0,
  uncounted.length === 0
    ? "and every one of them also counts against a second mate's write budget"
    : `${uncounted.length} real write(s) would NOT spend a second mate's budget, so the budget could never bind:\n      ${uncounted.map((c) => JSON.stringify(c)).join("\n      ")}`
);

// --- false blocks: reading must stay open ------------------------------------
const blocked = READERS.map((c) => [c, shellNotReadOnlyReason(c)]).filter(([, why]) => why);
ok(
  blocked.length === 0,
  blocked.length === 0
    ? `all ${READERS.length} commands a coordinator needs for reading stay allowed`
    : `${blocked.length} read-only command(s) are wrongly refused:\n      ${blocked.map(([c, why]) => `${JSON.stringify(c)} -> ${why}`).join("\n      ")}`
);

// --- builds and tests must not spend the second mate's budget ----------------
// Validating crew work is what this tier is FOR; an earlier version made three test runs
// exhaust the budget without a single file having been edited.
const supervision = ["npm test", "npm run build", "npm ci", "git merge crew-branch", "git commit -m x", "git push"];
const spend = supervision.filter((c) => shellMutatesFile(c));
ok(
  spend.length === 0,
  spend.length === 0
    ? "running builds, tests and git commands spends none of a second mate's write budget"
    : `these supervision commands wrongly spend budget: ${spend.join(", ")}`
);
// ...but a first mate still may not run them.
const fmSupervision = supervision.filter((c) => !shellNotReadOnlyReason(c));
ok(fmSupervision.length === 0, fmSupervision.length === 0 ? "and a first mate still cannot run any of them" : `a first mate can run: ${fmSupervision.join(", ")}`);

fs.rmSync(root, { recursive: true, force: true });
console.log(
  exit === 0
    ? "VERIFY OK: reality and the classifier agree - nothing that wrote was allowed, and nothing a coordinator reads with was blocked."
    : "VERIFY FAILED - a command that really changed the filesystem got through, or a read was refused."
);
process.exit(exit);
