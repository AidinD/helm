// Tier discipline, enforced instead of requested.
//
// WHY THIS EXISTS, in the exact words of the two incidents it comes from.
//
// 2026-08-12, Captain Hook: asked to write story circles, it hit a refused Write three
// times and wrote the same file with `cat > ... << EOF` in the same turn, then created
// four more.
//
// 2026-08-13, Captain Haddock: asked for a new app, it scaffolded an entire Electron
// project, ran the build, made four commits, and published three GitHub releases - all in
// the coordinator seat. One refused Write, then 82 Bash calls.
//
// WHY IT IS SHAPED THIS WAY, which is the second lesson and cost a review to learn.
//
// The first version of this file listed WRITING commands: tee, mkdir, cp, `git commit`,
// and so on. Its own header argued that enumerations fail open - and then enumerated. An
// independent review of it (2026-08-16) ran 90 genuinely file-writing commands through it
// and 80 were allowed, including `bash -c "cat > file"`: seven characters in front of the
// exact route from the incident. A guard defeated by the first thing a blocked model tries
// is worse than no guard, because it is believed in.
//
// You cannot enumerate the ways to write a file. You CAN enumerate the ways to read one.
// So the question asked here is inverted, and that inversion is the whole design:
//
//     not "does this command write?"  ->  "is this command PROVABLY read-only?"
//
// Anything not proven read-only is refused. A tool nobody has heard of, a shell nesting
// trick, a flag added by a future version of git - all land on "not proven", which is the
// safe side. The cost is a false block on a genuinely harmless command nobody listed yet,
// and the fix for that is one line in READ_ONLY below, made deliberately.
//
// The classifier never evaluates, expands or runs any byte of what it reads. It lexes,
// finds the words in COMMAND POSITION (the earlier version scanned every word, which is
// why `grep -rn install src/` and `echo 'tee'` were refused), and recurses into nested
// shells and command substitutions.

import path from "node:path";
// The advisory seats, for the one tier that may consult them. Imported rather than
// re-listed: the guard must admit exactly the seats a launch publishes, and a second
// copy of that list is a second place for a new seat to be forgotten. personas.js is a
// pure data module with no imports of its own, so this stays safe to load inside the
// hook process.
import { isAdvisorySeat, advisorySeatKeys } from "./personas.js";

export const TIER_FIRST_MATE = "first-mate";
export const TIER_SECOND_MATE = "second-mate";
/**
 * Crew. Guarded for ONE thing only: leaving the worktree.
 *
 * The other two tiers are guarded for who does the work. Crew IS the work, so nothing here
 * touches writing, committing, building or testing - that would be making Helm a permission
 * system, which this guard deliberately is not.
 *
 * What it does touch is the claim the rest of the design rests on. A crew iteration runs with
 * `--permission-mode bypassPermissions`, and the comment justifying that says in as many words:
 * "Bypassing is SAFE precisely because every iteration runs inside the isolated, never-pushed
 * worktree - that isolation is what earns the bypass." The tool description a first mate reads
 * says the same: "never pushes/merges".
 *
 * Both were true of the MODULE, which never pushes, and false of the RUN, which has a shell,
 * bypassed permissions and a worktree sharing the repository's remotes. Nothing stopped
 * `git push`. So the property that earns the bypass is now enforced rather than described.
 */
export const TIER_CREW = "crew";

/**
 * The assistant seat. Same DECISION as a first mate; a different sentence.
 *
 * It is a tier rather than a reuse of TIER_FIRST_MATE for one reason, and the reason is the
 * denial text. The first-mate refusal opens "a first mate does not write files. Anywhere - not
 * a project's, not the meta-home's, not a skill or a note". For this seat the meta-home clause
 * is exactly wrong: the goals file and the daily log ARE meta-home files it is the sole scribe
 * of, and it writes them through MCP surfaces built for the purpose. Handing it a refusal that
 * says it may not touch its own store would teach it to stop trying - and a guard that
 * misleads is one that gets routed around, which is this file's own stated failure mode.
 *
 * So the policy below is deliberately identical: no file-writing tool, no non-read-only shell.
 * What differs is what the seat is told to do instead. A first mate is told to dispatch; the
 * assistant is told that its stores have tools and that repository work belongs to a session.
 *
 * The write access it does have is therefore entirely a function of which MCP servers its
 * launch attaches, never of this guard relaxing. That was the decision (DECISIONS.md,
 * 2026-09-02): a path-aware guard would have allowed any write inside an allowed folder,
 * including an invalid one - in one of these stores a note carrying the wrong tag silently
 * resets a cadence and turns an overdue duty green, with no error anywhere. An MCP surface can
 * refuse that; a path check cannot.
 */
export const TIER_ASSISTANT = "assistant";

// A second mate orchestrates crew and compiles what comes back. The captain, 2026-08-14:
// "jag vill att 2nd mate orkestrerar crew mates att göra jobb som 2nd mate sedan
// sammanställer - den ska inte göra större jobb själv."
//
// Note the word: BIGGER. Not "any". So this tier gets a BUDGET rather than a ban - a small
// number of file changes per turn is hands-on work a supervisor legitimately does.
//
// It counts FILE MUTATIONS only. An earlier version counted anything that might touch the
// disk, so `npm test` spent budget: three test runs and a second mate was locked out
// without having edited a single file, while validating crew work is the exact thing this
// tier exists to do.
export const SECOND_MATE_TURN_WRITE_BUDGET = 3;

// ---------------------------------------------------------------------------
// Layer one: what a launch REMOVES from the schema
// ---------------------------------------------------------------------------
//
// `--disallowedTools` deletes a tool from a session's schema, and a tool that is not
// offered cannot be called - stronger than intercepting it. It is only layer one: the
// shell cannot be removed (every supervising tier reads with it), and the shell is the
// route both incidents in the header actually took. That surface belongs to the hook.
//
// The lists live HERE, next to the tiers they belong to, rather than in the launcher.
// Two tiers deny overlapping-but-different sets, and the failure mode of that is a
// copied list where one copy gets a change and the other does not - the shape of bug
// this repo keeps finding. So the difference is expressed as a NAMED piece that one
// tier adds and the other does not, and the composition is assertable from a test
// without parsing main.js.

// The tools of doing hands-on work. No supervising tier gets these, and no tier ever
// will: this is the whole content of "does not build".
export const HANDS_ON_TOOLS = Object.freeze(["Edit", "Write", "NotebookEdit"]);

// Sub-agent fan-out - the multiplier. Denied to a first mate because a coordinator that
// can spawn its own workers has no reason to dispatch through helm_*, which is the only
// route the Fleet can see.
//
// BOTH names are listed because the CLI renamed this tool from "Task" to "Agent":
// denying only the old name made this guard a silent no-op (found while chasing why a
// first mate's sub-agents never showed up in the Fleet tree either, src/lib/subAgents.js
// - the same stale-name bug in two places).
export const FAN_OUT_TOOLS = Object.freeze(["Agent", "Task"]);

/**
 * A first mate: no hands-on work, and no fan-out of its own. It dispatches through the
 * helm_* tools or it does nothing.
 */
export const FIRST_MATE_DISALLOWED_TOOLS = Object.freeze([...HANDS_ON_TOOLS, ...FAN_OUT_TOOLS]);

/**
 * The assistant seat: no hands-on work, and fan-out DELIBERATELY LEFT IN (2026-09-02).
 *
 * Not a relaxation of "it does not build" - consulting an advisory seat is not building.
 * The seats (personas.js) are pinned to Read, Grep and Glob, and a sub-agent's `tools`
 * field is an allow list, so a consulted seat can change nothing and cannot reach an
 * inherited MCP tool either. What the seat gets back is a judgment, and acting on it
 * stays with the caller under exactly the rules it already had.
 *
 * The reason it MATTERS here rather than being a nice-to-have: this is the one seat that
 * holds the people store, and one of the advisory seats exists to read a conversation
 * before somebody answers it. The seat with the conversations was the only seat
 * structurally unable to consult the seat for conversations.
 *
 * Removing a name from a deny list is not the whole change, because the deny list was
 * never the only layer. Two more had to move with it, both in decideToolCall below:
 * fan-out is admitted only for a seat Helm actually published (isAdvisorySeat - the CLI
 * offers built-in agent types alongside ours, with much broader tool sets), and a
 * consulted seat may not consult further.
 */
export const ASSISTANT_DISALLOWED_TOOLS = Object.freeze([...HANDS_ON_TOOLS]);

// Tools that mutate files by definition. Also removed from a first mate's schema entirely
// with --disallowedTools, which is stronger than intercepting them; they are listed here
// because that removal does not apply to a second mate, whose budget must still count them.
const MUTATING_TOOLS = new Set(["write", "edit", "notebookedit", "multiedit"]);

// Stems that make a tool name write-shaped. A review found Agent, Task, Workflow, ApplyPatch,
// StrReplace, create_file and mcp__filesystem__write_file all ALLOWED, because anything not
// in the four-name list above fell through to allow. Kun Chen's guard solved this by shape
// and says why an enumeration cannot work: "any future tool name outside the matcher would be
// silently missed". Same reasoning, same fix.
const WRITE_SHAPED = ["write", "edit", "patch", "creat", "delete", "remove", "rename", "upload", "commit", "push", "replace", "insert", "append", "mkdir", "save", "agent", "task", "workflow", "spawn", "dispatch", "worktree", "cron", "schedul", "sendmessage", "remotetrigger"];
// Whole names only, so neither list can widen by accident. These are read tools and Helm's own
// delegation tools - `helm_create_second_mate` contains "creat" and is the single most
// important thing a blocked first mate must still be able to call.
const NOT_WRITE_SHAPED = new Set(["todowrite", "taskcreate", "taskupdate", "websearch", "webfetch", "read", "grep", "glob", "ls"]);

/**
 * Servers whose writes this guard has no opinion about, by name prefix.
 *
 * `helm_` was the first and the reason is stated above: the delegation tools are the thing a
 * blocked seat must still be able to call, and `helm_create_second_mate` happens to contain
 * "creat".
 *
 * The personal stores are here for a sharper reason, found on 2026-09-02 while wiring the
 * assistant seat. "MCP tools are not this guard's business" was believed to be true in
 * general and is not: the check strips the server prefix and looks at the bare tool name, so
 * `assistant_append_log` was refused for containing "append" while `tend_log_touch` passed
 * for containing nothing. `jot_create_todo` would be refused and `jot_set_status` allowed.
 * The line was falling wherever a tool name happened to land, which is a guard deciding by
 * accident.
 *
 * The honest fix is not to rename tools until they slip past - that is routing around the
 * guard, which this file refuses to tolerate from a session and must not do to itself. It is
 * to say what the guard is FOR. It exists so a coordinating seat cannot do hands-on work in a
 * repository. A journal entry, a task's status, a line in a daily log: none of those are that.
 * And each of these surfaces refuses an invalid write on its own - which is exactly why the
 * writing was routed through them instead of through a path-aware exception here (see
 * TIER_ASSISTANT, and DECISIONS.md 2026-09-02).
 *
 * PREFIXES, not whole names, because these servers will grow tools and a list of every tool
 * name would go stale silently. Adding a prefix here is a deliberate statement that the store
 * behind it validates its own writes; do not add one for a server that does not.
 */
const GUARD_EXEMPT_SERVERS = ["helm_", "tend_", "jot_", "assistant_"];

function toolIsWriteShaped(name) {
  const bare = name.startsWith("mcp__") ? name.split("__").pop() : name;
  if (NOT_WRITE_SHAPED.has(bare) || GUARD_EXEMPT_SERVERS.some((prefix) => bare.startsWith(prefix))) {
    return false;
  }
  return WRITE_SHAPED.some((stem) => bare.includes(stem));
}
const SHELL_TOOLS = new Set(["bash", "powershell", "shell"]);

// The fan-out tool, lower-cased, under both names the CLI has used for it. A separate set
// from FAN_OUT_TOOLS because that one is argv spelling for --disallowedTools and this one
// is matched against a payload's tool_name.
const FAN_OUT_TOOL_NAMES = new Set(FAN_OUT_TOOLS.map((t) => t.toLowerCase()));

// ---------------------------------------------------------------------------
// Lexing
// ---------------------------------------------------------------------------

// Shells and interpreters that take a PROGRAM as an argument. `bash -c "cat > x"` is the
// route the review used to defeat the previous version: the quoted body was collected into
// one word and never looked at again. Now the body is lexed as its own command line.
const NESTING = new Map([
  ["bash", ["-c"]],
  ["sh", ["-c"]],
  ["zsh", ["-c"]],
  ["dash", ["-c"]],
  ["ksh", ["-c"]],
  ["busybox", ["sh"]],
  ["cmd", ["/c", "/k"]],
  ["powershell", ["-command", "-c", "-encodedcommand", "-e"]],
  ["pwsh", ["-command", "-c", "-encodedcommand", "-e"]],
  ["eval", []],
  ["xargs", []],
  ["env", []],
  ["nohup", []],
  ["sudo", []],
  ["doas", []],
  ["timeout", []],
  ["gtimeout", []],
  ["command", []],
  ["builtin", []],
  ["exec", []],
  ["nice", []],
  ["ionice", []],
  ["setsid", []],
  ["stdbuf", []],
  ["script", []],
  ["watch", []],
  ["time", []],
]);

/**
 * Lex a command line into words, remembering which words were QUOTED (quoted words are
 * data, never a command name) and whether output is redirected to a file.
 *
 * Returns { nodes, redirectsToFile, error }, where nodes are command lists - one per
 * separator - each an array of { value, quoted }.
 */
export function readShell(source) {
  const text = String(source || "").replace(/\\\r?\n/g, "");
  const nodes = [];
  let words = [];
  let current = null;
  let redirectsToFile = false;
  let error = false;
  let i = 0;

  const pushChar = (ch, quoted) => {
    if (!current) {
      current = { value: "", quoted: false };
    }
    if (quoted) {
      current.quoted = true;
    }
    current.value += ch;
  };
  const endWord = () => {
    if (current) {
      words.push(current);
      current = null;
    }
  };
  const endNode = () => {
    endWord();
    if (words.length) {
      nodes.push(words);
    }
    words = [];
  };

  while (i < text.length) {
    const ch = text[i];

    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) {
        error = true;
        break;
      }
      for (const c of text.slice(i + 1, end)) {
        pushChar(c, true);
      }
      if (i + 1 === end) {
        pushChar("", true);
      }
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let body = "";
      let closed = false;
      while (j < text.length) {
        if (text[j] === "\\" && j + 1 < text.length) {
          body += text[j + 1];
          j += 2;
          continue;
        }
        if (text[j] === '"') {
          closed = true;
          break;
        }
        body += text[j];
        j++;
      }
      if (!closed) {
        error = true;
        break;
      }
      for (const c of body) {
        pushChar(c, true);
      }
      if (!body) {
        pushChar("", true);
      }
      i = j + 1;
      continue;
    }
    if (ch === "\\" && i + 1 < text.length) {
      pushChar(text[i + 1], false);
      i += 2;
      continue;
    }

    // Command substitution: its body runs commands, so it becomes its own node list.
    if ((ch === "$" && text[i + 1] === "(") || ch === "`") {
      const start = ch === "`" ? i + 1 : i + 2;
      const end = ch === "`" ? findBacktick(text, start) : matchParen(text, start);
      if (end < 0) {
        error = true;
        break;
      }
      const inner = readShell(text.slice(start, end));
      endWord();
      nodes.push(...inner.nodes);
      redirectsToFile = redirectsToFile || inner.redirectsToFile;
      error = error || inner.error;
      i = end + 1;
      continue;
    }

    // Redirection. Every form that can land on a FILE counts; `2>&1` and `>&2` duplicate a
    // descriptor and are left alone. `>&word` where word is not a number IS a file
    // redirect in bash (it means &>word) - the previous version allowed it.
    if (ch === ">") {
      let j = i + 1;
      if (text[j] === ">") {
        j++;
      }
      if (text[j] === "|") {
        j++;
      }
      let k = j;
      if (text[k] === "&") {
        k++;
        while (k < text.length && (text[k] === " " || text[k] === "\t")) {
          k++;
        }
        // &1 / &2 / &- are descriptors; &file is a file.
        if (!/[0-9-]/.test(text[k] || "")) {
          redirectsToFile = true;
        } else {
          // A descriptor duplication (2>&1, >&2, >&-). Consume it, or the shell resumes at
          // `&` and the digit after it is read as the next command - which is how
          // `git status 2>&1` came back refused with "`1` is not on the list".
          while (k < text.length && /[0-9-]/.test(text[k])) {
            k++;
          }
          j = k;
        }
      } else {
        redirectsToFile = true;
      }
      endWord();
      i = j;
      continue;
    }
    // `&>file` and `&>>file`.
    if (ch === "&" && text[i + 1] === ">") {
      redirectsToFile = true;
      endWord();
      i += text[i + 2] === ">" ? 3 : 2;
      continue;
    }
    if (ch === "<") {
      endWord();
      i += text[i + 1] === "<" ? (text[i + 2] === "<" ? 3 : 2) : 1;
      continue;
    }

    // `{` and `}` delimit a group command only as STANDALONE words. Splitting on them
    // mid-word turned `git diff @{u}..HEAD` into three nodes and read `u` as a command, so
    // every upstream-relative git range was refused (review, 2026-08-16).
    if ((ch === "{" || ch === "}") && current) {
      pushChar(ch, false);
      i++;
      continue;
    }
    if (ch === ";" || ch === "&" || ch === "|" || ch === "\n" || ch === "(" || ch === ")" || ch === "{" || ch === "}") {
      endNode();
      i++;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      endWord();
      i++;
      continue;
    }
    pushChar(ch, false);
    i++;
  }

  endNode();
  return { nodes, redirectsToFile, error };
}

function matchParen(text, start) {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === "(") {
      depth++;
    } else if (text[i] === ")") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}
function findBacktick(text, start) {
  for (let i = start; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === "`") {
      return i;
    }
  }
  return -1;
}

// Shell keywords occupy the first word of a node without being a command. Without this,
// `for f in a; do touch pwn; done` presented `do` as the command and the real one was never
// reached - caught by the differential oracle, not by reading.
const KEYWORDS = new Set(["do", "done", "then", "else", "elif", "fi", "esac", "in", "if", "for", "while", "until", "case", "select", "function", "!", "{", "}"]);

/** `/usr/bin/tee`, `tee.exe` and `TEE` all classify as `tee`. */
function commandName(word) {
  const base = String(word || "")
    .split(/[\\/]/)
    .pop();
  return base.replace(/\.(exe|cmd|bat|ps1|com)$/i, "").toLowerCase();
}

// ---------------------------------------------------------------------------
// Design artifacts, and the ONE place a destination is allowed to matter
// ---------------------------------------------------------------------------

/**
 * Where an artifact lives inside a project. Sibling of `.helm-goal`, and named the same way
 * for the same reason: Helm's own bookkeeping, not the project's code.
 */
export const ARTIFACT_DIR = ".helm-artifacts";

/**
 * Is this write landing in the artifacts directory?
 *
 * ## Why a destination check exists here at all, when the guard refuses to be destination-aware
 *
 * That refusal is real and it is tested: a path check cannot tell a valid write from one that
 * silently corrupts the store it lands in, so no BAN in this file is allowed to turn on where
 * a write is going. `test-assistant-tier.mjs` pins that for the tier whose policy is a ban.
 *
 * A budget is not a ban, and the difference is what makes this safe rather than an exception
 * to the rule. A second mate may write; the only question the budget answers is how much it
 * changes in one turn before a human should look. So the failure mode of a wrong match here is
 * an UNCOUNTED write, not an unguarded one - the write was permitted either way. That is a
 * different order of consequence from the one the refusal protects.
 *
 * The problem it solves is real and was blocking a feature: iterating a design artifact IS
 * writing, three edits in and a second mate has spent its whole turn budget on a mockup that
 * is not project code. Deciding that by asking what a file IS would be a judgement the guard
 * cannot make; deciding it by a directory the mate has to put the file in is mechanical.
 *
 * ## Deliberately narrow
 *
 * TOOLS ONLY, never a shell command. Where a shell command writes cannot be read off the
 * command with any honesty, and a guess in that direction is how a real exemption becomes a
 * hole. A mate that wants the exemption uses the write tool, which is what it would do anyway.
 *
 * SEGMENT match, not substring, so a directory merely named like this one does not qualify.
 */
export function isArtifactPath(filePath) {
  const s = String(filePath || "").trim();
  if (!s) {
    return false;
  }
  return s
    .replace(/\\/g, "/")
    .split("/")
    .some((segment) => segment.toLowerCase() === ARTIFACT_DIR);
}

// ---------------------------------------------------------------------------
// The read-only allowlist
// ---------------------------------------------------------------------------

// Commands with no way to modify anything, whatever their arguments.
const READ_ONLY = new Set([
  "ls", "dir", "cat", "bat", "head", "tail", "less", "more", "nl", "wc",
  "cut", "tr", "column", "fold", "rev", "seq", "echo", "printf", "pwd", "cd", "basename",
  "dirname", "realpath", "readlink", "which", "where", "whoami", "hostname", "date",
  "uname", "id", "groups", "du", "df", "stat", "file", "type", "test", "true", "false",
  "sleep", "grep", "egrep", "fgrep", "rg", "ag", "ack", "diff", "cmp", "comm", "md5sum",
  "sha1sum", "sha256sum", "cksum", "wc", "jq", "yq", "xmllint", "tree", "ps", "top",
  "tasklist", "env", "printenv", "set", "history", "man", "help", "tldr", "clear",
]);

// Commands that are read-only ONLY under a condition their arguments must satisfy.
// Each returns true when THIS invocation is provably read-only.
const CONDITIONAL = new Map([
  // Tools whose ordinary use is a read but which carry an output-file flag. A third review
  // (2026-08-16) proved all three by running them: `sort -o f`, `uniq in out` and
  // `awk -i inplace` each wrote, and each was ALLOWED because it sat in the unconditional
  // list above. The last one overwrote its source file in place - the 2026-08-12 incident,
  // spelled differently. The lesson is that this list must be built by reading each tool's
  // flags, not by recognising its name.
  ["sort", (a) => !a.some((w) => w === "-o" || w.startsWith("--output"))],
  // GNU uniq takes an optional OUTPUT file as its second positional argument.
  ["uniq", (a) => a.filter((w) => !w.startsWith("-")).length < 2],
  ["tree", (a) => !a.some((w) => w === "-o" || w.startsWith("--output"))],
  ["xmllint", (a) => !a.some((w) => w.startsWith("--output") || w === "-o")],
  ["yq", (a) => !a.some((w) => w === "-i" || w === "--inplace" || w.startsWith("--in-place"))],
  // -i / --in-place edits the file.
  ["sed", (a) => !a.some((w) => w === "-i" || w.startsWith("-i") || w === "--in-place" || w.startsWith("--in-place"))],
  // An awk program can redirect internally: `awk 'BEGIN{print "x" > "/tmp/f"}'`.
  ["awk", (a) => !a.some((w, k) => w.includes(">") || w.includes("system(") || w === "-i" || w.startsWith("--in-place") || a[k - 1] === "-i")],
  ["gawk", (a) => !a.some((w) => w.includes(">") || w.includes("system("))],
  ["mawk", (a) => !a.some((w) => w.includes(">") || w.includes("system("))],
  // -exec / -execdir / -delete / -ok all act.
  ["find", (a) => !a.some((w) => ["-exec", "-execdir", "-delete", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"].includes(w))],
  // A version query runs no program. Anything else might.
  ["node", (a) => a.length > 0 && a.every((w) => ["--version", "-v", "--help", "-h"].includes(w))],
  ["python", pythonIsReadOnly],
  ["python3", pythonIsReadOnly],
  ["py", pythonIsReadOnly],
  ["deno", (a) => a.length > 0 && a.every((w) => ["--version", "-V", "--help", "-h"].includes(w))],
  ["bun", (a) => a.length > 0 && a.every((w) => ["--version", "-v", "--help", "-h"].includes(w))],
  ["git", gitIsReadOnly],
  ["gh", ghIsReadOnly],
  ["npm", (a) => npmIsReadOnly(a)],
  ["pnpm", (a) => npmIsReadOnly(a)],
  ["yarn", (a) => npmIsReadOnly(a)],
  ["docker", (a) => ["ps", "images", "logs", "inspect", "version", "info"].includes((a[0] || "").toLowerCase())],
]);

// git subcommands that cannot change anything.
const GIT_READ_ONLY = new Set([
  "log", "show", "diff", "status", "blame", "annotate", "rev-parse", "rev-list", "describe",
  "shortlog", "reflog", "whatchanged", "ls-files", "ls-tree", "ls-remote", "cat-file",
  "merge-base", "name-rev", "count-objects", "check-ignore", "check-attr", "verify-commit",
  "verify-tag", "grep", "diff-tree", "diff-index", "for-each-ref", "show-ref", "show-branch", "var",
  "cherry", "range-diff", "instaweb", "help", "version",
]);
// git subcommands that read OR write depending on their flags. Listing is fine; the same
// subcommand with a different flag deletes a branch. The previous version refused all of
// these outright, which blocked `git branch -a` and `git remote -v`.
const GIT_CONDITIONAL = new Map([
  ["branch", (a) => a.every((w, k) => ["--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format", "--color"].includes(a[k - 1]) ? true : w.startsWith("-") ? /^(-a|-r|-v+|-l|--list|--all|--remotes|--verbose|--show-current|--contains|--no-contains|--merged|--no-merged|--points-at|--format|--color|--no-color|--sort|--column|--i(gnore-case)?)(=.*)?$/.test(w) : false)],
  ["tag", (a) => a.length === 0 || a.every((w) => /^(-l|--list|-n\d*|--contains|--no-contains|--points-at|--merged|--no-merged|--sort|--format|--color|--no-color)(=.*)?$/.test(w) || (a.includes("-l") || a.includes("--list")))],
  ["remote", (a) => a.length === 0 || (a[0] === "-v" && a.length === 1) || ["show", "get-url"].includes(a[0])],
  ["stash", (a) => ["list", "show"].includes((a[0] || "").toLowerCase())],
  ["config", (a) => a.some((w) => ["--get", "--get-all", "--get-regexp", "--list", "-l"].includes(w))],
  ["notes", (a) => ["list", "show"].includes((a[0] || "").toLowerCase())],
  ["worktree", (a) => (a[0] || "").toLowerCase() === "list"],
  ["submodule", (a) => (a[0] || "").toLowerCase() === "status"],
  ["bisect", (a) => (a[0] || "").toLowerCase() === "log"],
]);

function gitIsReadOnly(args) {
  // Skip git's own options to find the subcommand, however many there are. The previous
  // version looked at a fixed window and `git -c a=b -c c=d -c e=f commit` escaped it.
  let i = 0;
  while (i < args.length) {
    const w = args[i];
    if (!w.startsWith("-")) {
      break;
    }
    // Options that consume the next word.
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"].includes(w)) {
      i += 2;
      continue;
    }
    i++;
  }
  const sub = (args[i] || "").toLowerCase();
  const rest = args.slice(i + 1);
  if (!sub) {
    return true; // bare `git` prints usage
  }
  if (GIT_READ_ONLY.has(sub)) {
    return true;
  }
  const cond = GIT_CONDITIONAL.get(sub);
  return cond ? cond(rest) : false;
}

const GH_READ_VERBS = new Set(["list", "view", "status", "diff", "checks", "browse", "search"]);
function ghIsReadOnly(args) {
  const lower = args.map((w) => w.toLowerCase());
  if (lower[0] === "api") {
    // `gh api` is a GET until a method or a field says otherwise.
    const mi = lower.findIndex((w) => w === "-x" || w === "--method");
    const method = mi >= 0 ? (lower[mi + 1] || "") : "get";
    if (!["get", "head"].includes(method)) {
      return false;
    }
    return !lower.some((w) => ["-f", "--raw-field", "--field", "--input"].includes(w));
  }
  if (lower[0] === "auth") {
    return lower[1] === "status" || lower[1] === "token";
  }
  // `gh <noun> <verb>` - the VERB must be a read, and it is the first non-flag word after the
  // noun. Accepting a read verb anywhere in the first three words let `gh alias set list ...`
  // through, and it really did rewrite the captain's gh config during the review.
  const words = lower.filter((w) => !w.startsWith("-"));
  return words.length >= 2 ? GH_READ_VERBS.has(words[1]) : words.length === 1;
}

// `python -m json.tool x.json` pretty-prints and is a very ordinary way to read a file.
// Anything else handed to an interpreter can write, so it stays unproven.
const PY_READ_MODULES = new Set(["json.tool", "site", "sysconfig", "platform", "this"]);
function pythonIsReadOnly(args) {
  if (args.length === 0) {
    return false;
  }
  if (args.every((w) => ["--version", "-V", "--help", "-h"].includes(w))) {
    return true;
  }
  return args[0] === "-m" && PY_READ_MODULES.has((args[1] || "").toLowerCase());
}

function npmIsReadOnly(args) {
  const sub = (args[0] || "").toLowerCase();
  if (!["ls", "list", "view", "info", "show", "outdated", "why", "search", "ping", "root", "prefix", "bin", "help", "--version", "-v", "version"].includes(sub)) {
    return false;
  }
  // `npm version 1.2.3` WRITES package.json; `npm version` alone prints.
  if (sub === "version" && args.length > 1) {
    return false;
  }
  return true;
}

// PowerShell verbs that only read. Checked by prefix because the verb-noun convention is
// what makes this safe to generalise - but Out-*, New-*, Set-*, Remove-* and friends are
// deliberately absent, and anything unmatched is simply "not proven".
const PS_READ_PREFIXES = ["get-", "select-", "where-", "measure-", "compare-", "test-", "resolve-", "convertfrom-", "convertto-", "sort-", "group-", "format-", "out-string", "out-host", "write-output", "write-host", "join-string", "split-path"];
function powershellIsReadOnly(name) {
  return PS_READ_PREFIXES.some((p) => name === p || name.startsWith(p));
}

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

/**
 * Walk a lexed command line and report the first thing that is NOT provably read-only.
 * Returns null when every command in it is proven safe.
 */
function firstUnprovenCommand(nodes, depth = 0) {
  if (depth > 8) {
    return "the command nests shells more deeply than this guard will follow";
  }
  for (const words of nodes) {
    let i = 0;
    // Skip leading VAR=value assignments - `FOO=1 cat > x` put `FOO=1` in command position
    // for the previous version.
    while (i < words.length && !words[i].quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i].value)) {
      i++;
    }
    while (i < words.length) {
      const word = words[i];
      // A quoted word is never a command name - it is data. This is what makes
      // `grep -rn install src/` and `echo 'tee'` legal, and it is positional, so it does
      // not depend on the argument happening to contain a space.
      if (word.quoted && i > 0) {
        break;
      }
      const name = commandName(word.value);
      if (!name || KEYWORDS.has(name)) {
        i++;
        continue;
      }
      const args = words.slice(i + 1).map((w) => w.value);

      // A nesting command: whatever it runs must itself be proven.
      if (NESTING.has(name)) {
        const flags = NESTING.get(name);
        const idx = words.findIndex((w, k) => k > i && flags.includes(w.value.toLowerCase()));
        if (idx >= 0 && words[idx + 1]) {
          const inner = readShell(words[idx + 1].value);
          if (inner.error) {
            return `a nested \`${name}\` program could not be read well enough to prove it only reads`;
          }
          if (inner.redirectsToFile) {
            return `a nested \`${name}\` program redirects into a file`;
          }
          const bad = firstUnprovenCommand(inner.nodes, depth + 1);
          if (bad) {
            return bad;
          }
          break;
        }
        // env / sudo / timeout / xargs / eval: the real command follows. If the next word is
        // QUOTED it is a program string (`eval 'echo hi > x'` - the oracle caught this one
        // getting through), so lex it; otherwise keep walking to the real command word.
        if (flags.length === 0) {
          const next = words[i + 1];
          if (next && next.quoted) {
            const inner = readShell(next.value);
            if (inner.error || inner.redirectsToFile) {
              return `a program string passed to \`${name}\` writes, or could not be read`;
            }
            const bad = firstUnprovenCommand(inner.nodes, depth + 1);
            if (bad) {
              return bad;
            }
            break;
          }
          i++;
          continue;
        }
        return `\`${name}\` can run a program this guard cannot see`;
      }

      if (READ_ONLY.has(name)) {
        break;
      }
      const cond = CONDITIONAL.get(name);
      if (cond) {
        if (cond(args)) {
          break;
        }
        return `\`${name} ${args.slice(0, 2).join(" ")}\`.trim() is not a read-only use of ${name}`.replace(".trim()", "");
      }
      if (powershellIsReadOnly(name)) {
        break;
      }
      return `\`${name}\` is not on the list of commands proven to only read`;
    }
  }
  return null;
}

/**
 * Why this shell command is not provably read-only, or null if it is.
 * This is the FIRST MATE question: anything unproven is refused.
 */
export function shellNotReadOnlyReason(command) {
  const text = String(command ?? "");
  if (!text.trim()) {
    return null; // nothing to run
  }
  const { nodes, redirectsToFile, error } = readShell(text);
  if (error) {
    // FAIL CLOSED. Kun Chen's cd-guard fails OPEN on unreadable syntax because a false
    // block there is a correctness hazard. Here the trade is reversed: a false block costs
    // one delegation, a miss cost an unsupervised app being built in the wrong seat.
    return "this command could not be read well enough to prove it only reads";
  }
  if (redirectsToFile) {
    return "it redirects output into a file";
  }
  return firstUnprovenCommand(nodes);
}

// Supervision: what a second mate does to VALIDATE crew work rather than to author it.
// Running the project's build, its tests, and landing a crew branch are the whole job of
// this tier, so they must not spend an authoring budget.
const SUPERVISION_RUNNERS = new Set(["npm", "pnpm", "yarn", "make", "gradlew", "cargo", "dotnet", "mvn", "gradle", "docker", "jest", "vitest", "pytest", "tsc", "eslint"]);
// git is supervision EXCEPT where it materialises working-tree content the second mate did
// not write by hand. `git apply` and `git checkout -- .` are authoring by another name; the
// review found both costing zero.
const GIT_AUTHORING = new Set(["init", "clone", "apply", "am", "cherry-pick", "revert", "checkout", "restore", "clean", "stash"]);

function isSupervisionCommand(command) {
  const { nodes, error } = readShell(command);
  if (error) {
    return false;
  }
  for (const words of nodes) {
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (!w.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.value)) {
        continue;
      }
      const name = commandName(w.value);
      if (KEYWORDS.has(name)) {
        continue;
      }
      if (name === "git") {
        const sub = words.slice(i + 1).map((x) => x.value.toLowerCase()).find((x) => !x.startsWith("-"));
        return !GIT_AUTHORING.has(sub || "");
      }
      // A named script run through an interpreter is a test or a build, not hand authoring.
      // Deliberate accuracy trade: a script CAN write, so this is where the budget is least
      // exact. It costs an uncounted edit, never a tier violation, because a first mate is
      // refused either way - and the alternative charged three `npm test` runs against a
      // three-edit budget and locked a second mate out of validating its own crew.
      if (["node", "python", "python3", "py", "deno", "bun"].includes(name)) {
        const rest = words.slice(i + 1).map((x) => x.value);
        return rest.length > 0 && !rest.some((x) => ["-e", "-p", "-c", "--eval", "--print"].includes(x)) && !rest.includes("-");
      }
      return SUPERVISION_RUNNERS.has(name);
    }
  }
  return false;
}

/**
 * Did this shell command change a file? (second-mate budget accounting)
 *
 * DEFINED IN TERMS OF THE READ-ONLY QUESTION, not as a second enumeration. It used to walk
 * the command again with its own FILE_MUTATORS list, and a review measured what that costs:
 * `sort -o`, `uniq in out`, `split`, `source ./writer.sh`, `npx --yes -- node -e "...write"`
 * and six more all wrote for real and spent nothing, while `git apply` and
 * `npx prettier --write` were free by design. Two lists over one lexer drift apart; one list
 * with an explicit exception set cannot.
 */
export function shellMutatesFile(command) {
  if (!shellNotReadOnlyReason(command)) {
    return false;
  }
  return !isSupervisionCommand(command);
}

/*
 * Publishing, as opposed to working.
 *
 * Deliberately a SHORT list of the ways work leaves an isolated worktree, not another
 * attempt at "is this dangerous". Crew is meant to write, commit, build and test freely;
 * the isolation is what makes that safe, and these are the commands that end it.
 */
const GIT_PUBLISHES = new Set(["push", "remote", "submodule"]);
const PUBLISHING_RUNNERS = new Set(["gh", "glab", "hub"]);

/**
 * Would this command move work out of the worktree it runs in?
 *
 * @param {string} command
 * @returns {string|null} the reason, or null when it stays local
 */
export function shellLeavesWorktree(command) {
  const text = String(command ?? "");
  if (!text.trim()) {
    return null;
  }
  const { nodes, error } = readShell(text);
  if (error) {
    // FAIL CLOSED, same trade as the read-only question: a false block costs one command,
    // a miss costs work landing on a remote that nobody reviewed.
    return "this command could not be read well enough to prove it stays in the worktree";
  }
  for (const words of nodes) {
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (!w.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.value)) {
        continue; // leading VAR=value assignment
      }
      const name = commandName(w.value);
      if (!name) {
        continue;
      }
      if (PUBLISHING_RUNNERS.has(name)) {
        return `\`${name}\` talks to the forge, which is outside this worktree`;
      }
      if (name === "git") {
        /*
         * The first word after git that is neither a flag nor a flag's VALUE is the
         * subcommand. The value part is not pedantry: `git -C . push` slipped straight
         * through the first version of this, because -C takes a path, the path is not a
         * flag, and the scan stopped there having decided "." was the subcommand. Found by
         * this module's own check rather than in the wild, which is the only reason it is
         * not a story about a push instead of a paragraph.
         */
        const TAKES_A_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);
        for (let k = i + 1; k < words.length; k++) {
          const sub = String(words[k].value || "");
          if (TAKES_A_VALUE.has(sub)) {
            k += 1; // step over the value it consumes
            continue;
          }
          if (sub.startsWith("-")) {
            continue; // a plain flag, or --flag=value which carries its own
          }
          if (GIT_PUBLISHES.has(sub.toLowerCase())) {
            return `\`git ${sub.toLowerCase()}\` moves work outside this worktree`;
          }
          break;
        }
      }
    }
  }
  return null;
}

const FIRST_MATE_DENIAL = [
  "HELM TIER GUARD: a first mate does not write files. Anywhere - not a project's, not the",
  "meta-home's, not a skill or a note, and not a document the captain asked for directly.",
  "",
  "This is not an obstacle to route around, and reaching for a shell to do the same thing is",
  "the same violation by another spelling.",
  "",
  "The shell is open to you for READING - git log, git diff, git status, ls, cat, grep, find,",
  "jq, gh list/view. Anything not provably read-only is refused, including a command wrapped",
  "in another shell.",
  "",
  "What to do instead - do NOT simply refuse, and do not answer with only a pointer: hand the",
  "work down WITH the context. Call helm_create_second_mate (it will create the project if it",
  "does not exist yet - pass create: true) or helm_relay_to_second_mate, and give it what it",
  "needs to start without re-interviewing the captain: what he actually said in his own words,",
  "why he wants it, where the output belongs, and anything you have already gathered.",
].join("\n");

const ASSISTANT_DENIAL = [
  "HELM TIER GUARD: the assistant seat does not write files with a tool or a shell.",
  "",
  "That is not the same as being read-only, and the difference is the point. Your own stores",
  "have MCP tools built for writing them - the task board, the people store, your goals file",
  "and your daily log. Use those. They can refuse a write that would corrupt the store, which",
  "is exactly why the writing goes through them rather than through Write, Edit or a shell.",
  "",
  "The shell is open to you for READING - ls, cat, grep, find, jq, git log, git diff,",
  "git status. Anything not provably read-only is refused, including a command wrapped in",
  "another shell.",
  "",
  "What to do instead, and do NOT simply refuse or answer with a pointer: if this is work in a",
  "repository, hand it to a session WITH the context - what he actually said in his own words,",
  "why he wants it, where the output belongs, and whatever you have already gathered. If it is",
  "a note, a plan or a document, draft it in your reply and let the session that owns the tree",
  "write it. If it belongs in one of your stores, it has a tool.",
].join("\n");

/**
 * Refusing a consult that named something other than a published advisory seat.
 *
 * The seat names come from personas.js so this sentence cannot list a seat that does not
 * exist, or omit one that does.
 */
function assistantSeatDenial(seat) {
  return [
    seat
      ? `HELM TIER GUARD: \`${seat}\` is not one of the advisory seats, so this consult is refused.`
      : "HELM TIER GUARD: a consult has to name which advisory seat it wants, so this one is refused.",
    "",
    "You CAN consult an advisory seat, and it is not building - a seat reads and answers, it",
    "changes nothing. What you cannot do is reach a general-purpose worker: those come with the",
    "tools of doing the job, and doing the job is not this seat's tier. Only the seats below are",
    "open to you, by these exact names:",
    "",
    ...advisorySeatKeys().map((key) => `  - ${key}`),
    "",
    "Pass one of them as subagent_type. If none of them fits, what you want is a session that",
    "owns a tree - hand it over with the context rather than looking for a worker here.",
  ].join("\n");
}

/**
 * Refusing a consult made from INSIDE a consulted seat. One level, not a tree: the point of
 * a consult is a second opinion, and an opinion that fans out is a crew run in disguise.
 */
function consultedSeatFanOutDenial(agentType) {
  return [
    `HELM TIER GUARD: this call came from inside the \`${agentType}\` seat, and a consulted seat does not`,
    "consult further.",
    "",
    "A consult is one level deep on purpose. You were asked a question by the seat that has the",
    "context; answer that question with what you can read, and name what you could not check so",
    "the caller can decide whether to go and get it.",
  ].join("\n");
}

function crewDenial(why) {
  return [
    `HELM TIER GUARD: ${why}.`,
    "",
    "This run is isolated on purpose: it works in its own worktree on its own branch, and the",
    "whole reason it is allowed to write, commit and run commands without asking is that",
    "nothing it does leaves that worktree until a person has looked at it.",
    "",
    "Commit your work as normal - that is how it gets reviewed. Landing it is the captain's",
    "call, and it happens after somebody reads the branch, not from in here.",
  ].join("\n");
}

function secondMateDenial(used, budget) {
  return [
    `HELM TIER GUARD: this turn has already changed ${used} file(s), which is the point where the`,
    "work stops being supervision and becomes the job itself.",
    "",
    "A second mate orchestrates crew and compiles what comes back. Small hands-on corrections",
    `are yours to make - that is what the first ${budget} are for - but a change of this size belongs`,
    "to a crew run you dispatch and then review. Running builds, tests and git commands does",
    "not count against this; only changing files does.",
    "",
    "Use helm_dispatch to send it down, then report on what comes back.",
  ].join("\n");
}

/**
 * The whole policy, as one pure function so it can be tested without a hook, a session or
 * a model.
 *
 * @param {string} [agentType] The sub-agent this call came FROM, when it came from one -
 *        `agent_type` in the hook payload, absent for the session's own calls. The guard
 *        reads it rather than ignoring it: a call from inside a consulted seat is a
 *        different question from the same call made by the seat that did the consulting.
 *        Everything else about the decision is deliberately independent of it, so an
 *        unfamiliar payload shape cannot soften a refusal.
 * @returns {{decision: "allow"|"deny", reason?: string, isWrite: boolean}}
 *          isWrite means "this counted as a file change" - it drives the second mate's
 *          budget and is false for reads and for builds/tests.
 */
export function decideToolCall({ tier, tool, input = {}, writesThisTurn = 0, budget = SECOND_MATE_TURN_WRITE_BUDGET, agentType = "" } = {}) {
  const name = String(tool || "").toLowerCase();
  const isShell = SHELL_TOOLS.has(name);
  const isMutatingTool = MUTATING_TOOLS.has(name) || toolIsWriteShaped(name);

  if (!isShell && !isMutatingTool) {
    // Read tools, MCP tools, everything else. Not this guard's business.
    return { decision: "allow", isWrite: false };
  }

  if (tier === TIER_FIRST_MATE) {
    if (isMutatingTool) {
      return { decision: "deny", isWrite: true, reason: `${FIRST_MATE_DENIAL}\n\n(Blocked because \`${tool}\` writes a file.)` };
    }
    const why = shellNotReadOnlyReason(input.command);
    if (why) {
      return { decision: "deny", isWrite: true, reason: `${FIRST_MATE_DENIAL}\n\n(Blocked because ${why}.)` };
    }
    return { decision: "allow", isWrite: false };
  }

  if (tier === TIER_ASSISTANT) {
    // Identical policy to a first mate on writing, different sentence. See TIER_ASSISTANT.
    // The ONE place the two tiers genuinely differ is here, and it is checked first:
    // "agent" and "task" are write-shaped stems, so a consult would otherwise be refused
    // as if it changed a file.
    if (FAN_OUT_TOOL_NAMES.has(name)) {
      // A consulted seat may not consult further. The seats are pinned to Read/Grep/Glob
      // so today they have no fan-out tool to call - this refuses the recursion at the
      // policy layer too, so it does not depend on a tool list staying pinned. It is also
      // what the sub-agent fields in the hook payload are FOR: the guard reads them
      // instead of ignoring an input shape it has not seen before.
      if (agentType) {
        return { decision: "deny", isWrite: false, reason: consultedSeatFanOutDenial(agentType) };
      }
      // An ALLOW LIST of seat names, and the reason is the same inversion this whole file
      // is built on. `--agents` ADDS to the CLI's built-in agent types rather than
      // replacing them (measured, claude 2.1.226, 2026-09-02: a launch carrying one custom
      // seat offered claude, claude-code-guide, Explore, general-purpose, Plan, the custom
      // seat, statusline-setup). `general-purpose` gets the session's whole tool set, and a
      // deny list of built-in names would have to be kept in step with a CLI Helm does not
      // ship. Naming what IS consultable puts every present and future built-in on the
      // refused side without anybody having to notice it appeared.
      const seat = typeof input.subagent_type === "string" ? input.subagent_type : "";
      if (isAdvisorySeat(seat)) {
        return { decision: "allow", isWrite: false };
      }
      return { decision: "deny", isWrite: false, reason: assistantSeatDenial(seat) };
    }
    if (isMutatingTool) {
      return { decision: "deny", isWrite: true, reason: `${ASSISTANT_DENIAL}\n\n(Blocked because \`${tool}\` writes a file.)` };
    }
    const why = shellNotReadOnlyReason(input.command);
    if (why) {
      return { decision: "deny", isWrite: true, reason: `${ASSISTANT_DENIAL}\n\n(Blocked because ${why}.)` };
    }
    return { decision: "allow", isWrite: false };
  }

  if (tier === TIER_SECOND_MATE) {
    const isWrite = isMutatingTool || shellMutatesFile(input.command);
    if (!isWrite) {
      return { decision: "allow", isWrite: false };
    }
    // An artifact costs no budget. Tool writes only, and only into the named directory - see
    // isArtifactPath for why a destination may decide a BUDGET here while it may never decide
    // a BAN anywhere else in this file.
    if (isMutatingTool && !isShell && isArtifactPath(input.file_path || input.notebook_path)) {
      return { decision: "allow", isWrite: false, artifact: true };
    }
    if (writesThisTurn >= budget) {
      return { decision: "deny", isWrite: true, reason: secondMateDenial(writesThisTurn, budget) };
    }
    return { decision: "allow", isWrite: true };
  }

  if (tier === TIER_CREW) {
    // Writing, committing, building, testing: all crew's job, none of this guard's business.
    // Only the exits are closed - see TIER_CREW for why that one property is different.
    if (!isShell) {
      return { decision: "allow", isWrite: isMutatingTool };
    }
    const why = shellLeavesWorktree(input.command);
    if (why) {
      return { decision: "deny", isWrite: false, reason: crewDenial(why) };
    }
    return { decision: "allow", isWrite: shellMutatesFile(input.command) };
  }

  // The captain's own sessions and anything untiered are untouched. This guard is about who
  // does the work, not about making Helm a permission system.
  return { decision: "allow", isWrite: false };
}

/** Where a session's per-turn write counter lives. Reset by the app at each launch. */
export function turnCounterPath(metaHome, sessionId) {
  return path.join(metaHome, ".helm-dispatch", "tier-turns", `${String(sessionId || "unknown").replace(/[^\w.-]/g, "_")}.json`);
}
