// Tier discipline, enforced instead of requested.
//
// WHY THIS EXISTS, in the exact words of the two incidents it comes from.
//
// 2026-08-12, Captain Hook: asked to write story circles, it hit a refused Write
// three times and wrote the same file with `cat > ... << EOF` in the same turn,
// then created four more.
//
// 2026-08-13, Captain Haddock: asked for a new app, it scaffolded an entire
// Electron project, ran the build, made four commits, and published three GitHub
// releases - all in the coordinator seat. One refused Write, then 82 Bash calls.
//
// Both sessions ran under a manual that already forbade hands-on project work. The
// prohibition was never the missing piece. Three things were:
//
//   1. The guard listed TOOL NAMES. Bash was not on the list and never can be - a
//      first mate needs a shell to read. An enumeration fails open against every
//      route it does not name, and `cat >` is a route.
//   2. The rule lived in a system prompt applied only on a FRESH session, so a
//      running mate kept whatever manual it booted with. Enforcement has to be per
//      TURN, and a hook is: --settings travels with every launch, and every turn is
//      a launch (verified against the real CLI, including --resume).
//   3. There was no legal move. resolveDispatchProject refuses a project that does
//      not exist yet, so for "build me a new app" every delegation attempt would
//      have been rejected. See toolCreateSecondMate's `create` path - a guard that
//      corners the mate just converts doing-it-wrong into refusing-to-help.
//
// So this module answers ONE question - does this tool call change files? - and
// answers it from what the call DOES, not from what the tool is called. It never
// evaluates, expands or runs any byte of a command; it lexes and inspects.
//
// Kun Chen's firstmate reached the same conclusion from its own incident and is
// worth reading on it (docs/subagent-guard.md there): classify by shape with a
// catch-all matcher, because "a stem-enumerating matcher would reintroduce the
// fail-open-by-enumeration problem this guard exists to solve".

import path from "node:path";

// ---------------------------------------------------------------------------
// Tier policy
// ---------------------------------------------------------------------------

// A first mate writes NOTHING. Not a project's files, not the meta-home's, not a
// skill, not a note, not a document the captain asked for. The scoped version of
// this rule ("no PROJECT work") is what Captain Hook read literally and correctly
// when it wrote five files that belonged to no project.
export const TIER_FIRST_MATE = "first-mate";
// A second mate orchestrates crew and compiles what comes back. The captain, 2026-08-14:
// "jag vill att 2nd mate orkestrerar crew mates att göra jobb som 2nd mate sedan
// sammanställer - den ska inte göra större jobb själv."
//
// Note the word: BIGGER. Not "any". An absolute ban would be simpler to write and
// would overshoot what was asked - it would make a one-line typo fix cost a whole
// autopilot run. So the second mate's line is a BUDGET, not a prohibition: a small
// number of file changes per turn is hands-on work a supervisor legitimately does,
// and past that the turn has become the crew's job.
//
// A budget is still mechanical - a count, not a judgment - which is what keeps this
// from degrading into the advisory nag that policing intent always becomes.
export const TIER_SECOND_MATE = "second-mate";

export const SECOND_MATE_TURN_WRITE_BUDGET = 3;

// Tools that mutate files by definition. These are ALSO removed from the model's
// schema with --disallowedTools for a first mate, which is strictly stronger than
// intercepting them: a removed tool cannot be called, so there is no decision to
// get wrong. They are listed here too because the schema removal does not apply to
// a second mate, whose budget still has to count them.
const MUTATING_TOOLS = new Set(["write", "edit", "notebookedit", "multiedit"]);

// Shell commands whose whole purpose is to change the filesystem.
const WRITING_COMMANDS = new Set([
  "tee", "mkdir", "rmdir", "touch", "cp", "mv", "rm", "ln", "truncate", "dd",
  "install", "shred", "chmod", "chown", "unzip", "tar", "rsync", "patch",
]);

// PowerShell's equivalents. Haddock used PowerShell 8 times in the session that
// prompted this, so leaving them out would reopen the door by another spelling.
const WRITING_PS_CMDLETS = new Set([
  "set-content", "add-content", "out-file", "new-item", "remove-item", "copy-item",
  "move-item", "rename-item", "clear-content", "set-itemproperty", "export-csv",
  "export-clixml", "new-itemproperty",
]);

// Interpreters that can write a file from an inline program. `python - << EOF` was
// how Haddock edited its own source after the redirect route. There is no way to
// prove an inline program does not write, so an inline program counts as a write.
const INTERPRETERS = new Set(["python", "python3", "node", "perl", "ruby", "php", "deno", "bun", "osascript"]);
const INLINE_PROGRAM_FLAGS = new Set(["-c", "-e", "--eval", "-E", "--command"]);

// git subcommands that change the repository or working tree. `git log`, `git
// status`, `git diff` and `git show` stay allowed: a coordinator that cannot read
// history cannot prioritize, which is the job.
const GIT_WRITING_SUBCOMMANDS = new Set([
  "commit", "push", "merge", "rebase", "reset", "checkout", "switch", "restore",
  "apply", "am", "cherry-pick", "revert", "clean", "stash", "tag", "branch",
  "init", "clone", "add", "rm", "mv", "worktree", "submodule", "fetch", "pull",
  "config", "gc", "prune", "remote", "notes", "update-ref", "symbolic-ref",
]);

// Package managers write into the tree (node_modules, lockfiles, build output).
const PACKAGE_MANAGERS = new Set(["npm", "npx", "pnpm", "yarn", "pip", "pip3", "cargo", "go", "dotnet", "gem", "bundle", "composer", "gh"]);
const PACKAGE_MANAGER_READONLY = new Set(["list", "ls", "view", "info", "show", "search", "outdated", "why", "config", "--version", "-v", "help", "audit"]);

// ---------------------------------------------------------------------------
// A deliberately small shell reader
// ---------------------------------------------------------------------------

/**
 * Split a command line into words, honouring quoting well enough to tell DATA from
 * CODE, and recursing into command substitutions (a write hidden inside `$(...)`
 * is still a write).
 *
 * Returns { words, redirectsToFile, error }. `error` means the line could not be
 * read - see the fail-closed note at the decision site.
 *
 * This intentionally does not implement a shell. It has one job: find the words
 * that sit in command position and notice a redirection that lands on a file.
 */
export function readShell(source) {
  const text = String(source || "").replace(/\\\r?\n/g, "");
  const words = [];
  let redirectsToFile = false;
  let current = "";
  let quote = "";
  let i = 0;
  let error = false;

  const flush = () => {
    if (current !== "") {
      words.push(current);
      current = "";
    }
  };

  while (i < text.length) {
    const ch = text[i];

    if (quote === "'") {
      if (ch === "'") {
        quote = "";
      } else {
        current += ch;
      }
      i++;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && i + 1 < text.length) {
        current += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') {
        quote = "";
      } else {
        current += ch;
      }
      i++;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < text.length) {
      current += text[i + 1];
      i += 2;
      continue;
    }

    // Command substitution: read the inside as its own line. A `$(...)` or backtick
    // body runs commands, so its words belong in this line's word list.
    if ((ch === "$" && text[i + 1] === "(") || ch === "`") {
      const open = ch === "`" ? "`" : "(";
      const close = ch === "`" ? "`" : ")";
      const start = ch === "`" ? i + 1 : i + 2;
      const end = matchDelimiter(text, start, open, close);
      if (end < 0) {
        error = true;
        break;
      }
      const inner = readShell(text.slice(start, end));
      flush();
      words.push(...inner.words);
      redirectsToFile = redirectsToFile || inner.redirectsToFile;
      error = error || inner.error;
      i = end + 1;
      continue;
    }

    // Redirection. `2>&1` duplicates a file descriptor and writes no file; `>file`,
    // `>>file` and `2>file` do. A heredoc (`<<`) is input, not output.
    if (ch === ">") {
      const isAppend = text[i + 1] === ">";
      let j = i + (isAppend ? 2 : 1);
      while (j < text.length && (text[j] === " " || text[j] === "\t")) {
        j++;
      }
      if (text[j] !== "&") {
        redirectsToFile = true;
      }
      flush();
      i = j;
      continue;
    }

    // Separators: every one of them starts a new command position, which is why the
    // word list is flat - `ls && cat > x` must expose `cat` as a command word.
    if (ch === ";" || ch === "&" || ch === "|" || ch === "\n" || ch === "(" || ch === ")" || ch === "{" || ch === "}") {
      flush();
      i++;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      flush();
      i++;
      continue;
    }
    if (ch === "<") {
      // Heredoc / input redirection - skip the operator, keep reading.
      flush();
      i += text[i + 1] === "<" ? 2 : 1;
      continue;
    }

    current += ch;
    i++;
  }

  flush();
  if (quote !== "") {
    error = true;
  }
  return { words, redirectsToFile, error };
}

function matchDelimiter(text, start, open, close) {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (open !== close && text[i] === open) {
      depth++;
    } else if (text[i] === close) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/** Strip a path so `/usr/bin/tee` and `tee` classify the same. */
function commandName(word) {
  const base = String(word || "").split(/[\\/]/).pop() || "";
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

/**
 * Does this shell command change files? Returns a reason string, or null for a
 * command that only reads.
 */
export function shellWriteReason(command) {
  const { words, redirectsToFile, error } = readShell(command);
  if (error) {
    // FAIL CLOSED. Kun Chen's cd-guard deliberately fails OPEN on syntax it cannot
    // read, because a wrongly blocked backlog write there is a correctness hazard
    // while a missed exotic `cd` is only the status quo. Here the trade runs the
    // other way: a false block costs one delegation, and a miss costs an
    // unsupervised app being built in the wrong seat. That already happened once.
    return "this command could not be read well enough to prove it only reads";
  }
  if (redirectsToFile) {
    return "it redirects output into a file";
  }

  for (let i = 0; i < words.length; i++) {
    const name = commandName(words[i]);
    if (!name) {
      continue;
    }
    if (WRITING_COMMANDS.has(name)) {
      return `\`${name}\` changes files`;
    }
    if (WRITING_PS_CMDLETS.has(name)) {
      return `\`${words[i]}\` changes files`;
    }
    if (name === "sed" && words.slice(i + 1).some((w) => w === "-i" || w.startsWith("-i"))) {
      return "`sed -i` edits a file in place";
    }
    if (INTERPRETERS.has(name)) {
      const rest = words.slice(i + 1);
      // An inline program, or a script read from stdin (`python - << EOF`), can
      // write anything. A named script file is the same problem wearing a filename,
      // so only an explicit read-only-looking invocation with no program at all is
      // treated as harmless.
      if (rest.some((w) => INLINE_PROGRAM_FLAGS.has(w)) || rest.includes("-") || rest.some((w) => /\.(py|js|mjs|cjs|rb|pl|php|ts)$/i.test(w))) {
        return `\`${name}\` is being given a program to run, and a program can write files`;
      }
    }
    if (name === "git") {
      // Scan the words after `git` rather than only the next one: `git -C <dir>
      // commit` and `git --no-pager log` both put the subcommand further along, and
      // reading only words[i+1] would have let the first one straight through.
      const effective = words.slice(i + 1, i + 6).map((w) => w.toLowerCase()).find((w) => GIT_WRITING_SUBCOMMANDS.has(w));
      if (effective) {
        return `\`git ${effective}\` changes a repository`;
      }
    }
    if (PACKAGE_MANAGERS.has(name)) {
      // These take both `npm ls` and `gh issue list` shapes - the read-only verb is
      // the first word for one and the second for the other - so look at both rather
      // than only the next word. Reading GitHub is squarely this tier's job (it is
      // how a coordinator learns what is open), and blocking `gh issue list` would
      // have been a stricter guard and a worse first mate.
      const following = words.slice(i + 1, i + 3).map((w) => w.toLowerCase());
      if (!following.some((w) => PACKAGE_MANAGER_READONLY.has(w))) {
        return `\`${[name, ...following].join(" ").trim()}\` writes into the project (dependencies, lockfiles, build output) or acts on a remote`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

const FIRST_MATE_DENIAL = [
  "HELM TIER GUARD: a first mate does not write files. Anywhere - not a project's,",
  "not the meta-home's, not a skill or a note, and not a document the captain asked",
  "for directly.",
  "",
  "This is not an obstacle to route around, and reaching for a shell to do the same",
  "thing is the same violation by another spelling.",
  "",
  "What to do instead - do NOT simply refuse, and do not answer with only a pointer:",
  "hand the work down WITH the context. Call helm_create_second_mate (it will create",
  "the project if it does not exist yet - pass create: true) or helm_relay_to_second_mate,",
  "and give it what it needs to start without re-interviewing the captain: what he",
  "actually said in his own words, why he wants it, where the output belongs, and",
  "anything you have already gathered.",
].join("\n");

function secondMateDenial(used, budget) {
  return [
    `HELM TIER GUARD: this turn has already changed ${used} file(s), which is the point where`,
    "the work stops being supervision and becomes the job itself.",
    "",
    "A second mate orchestrates crew and compiles what comes back. Small hands-on",
    `corrections are yours to make - that is what the first ${budget} are for - but a change`,
    "of this size belongs to a crew run you dispatch and then review.",
    "",
    "Use helm_dispatch to send it down, then report on what comes back.",
  ].join("\n");
}

/**
 * The whole policy, as one pure function so it can be tested without a hook, a
 * session, or a model.
 *
 * @param {object} call
 * @param {string} call.tier          TIER_FIRST_MATE | TIER_SECOND_MATE | anything else (untiered = allowed)
 * @param {string} call.tool          tool name as the harness reports it
 * @param {object} call.input         the tool's own input object
 * @param {number} call.writesThisTurn how many writes this session has already made this turn
 * @param {number} call.budget        second-mate turn budget
 * @returns {{decision: "allow"|"deny", reason?: string, isWrite: boolean}}
 */
export function decideToolCall({ tier, tool, input = {}, writesThisTurn = 0, budget = SECOND_MATE_TURN_WRITE_BUDGET } = {}) {
  const name = String(tool || "").toLowerCase();
  let isWrite = false;
  let what = null;

  if (MUTATING_TOOLS.has(name)) {
    isWrite = true;
    what = `\`${tool}\` writes a file`;
  } else if (name === "bash" || name === "powershell" || name === "shell") {
    const reason = shellWriteReason(input.command);
    if (reason) {
      isWrite = true;
      what = reason;
    }
  }

  if (!isWrite) {
    return { decision: "allow", isWrite: false };
  }

  if (tier === TIER_FIRST_MATE) {
    return { decision: "deny", isWrite: true, reason: `${FIRST_MATE_DENIAL}\n\n(Blocked because ${what}.)` };
  }
  if (tier === TIER_SECOND_MATE) {
    if (writesThisTurn >= budget) {
      return { decision: "deny", isWrite: true, reason: secondMateDenial(writesThisTurn, budget) };
    }
    return { decision: "allow", isWrite: true };
  }
  // Crew, the captain's own sessions, and anything untiered are untouched. This
  // guard is about who does the work, not about making Helm a permission system.
  return { decision: "allow", isWrite: true };
}

/** Where a session's per-turn write counter lives. Reset by the app at each launch. */
export function turnCounterPath(metaHome, sessionId) {
  return path.join(metaHome, ".helm-dispatch", "tier-turns", `${String(sessionId || "unknown").replace(/[^\w.-]/g, "_")}.json`);
}
