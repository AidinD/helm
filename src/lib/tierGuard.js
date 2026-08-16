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

export const TIER_FIRST_MATE = "first-mate";
export const TIER_SECOND_MATE = "second-mate";

// A second mate orchestrates crew and compiles what comes back. Aidin, 2026-08-14:
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

function toolIsWriteShaped(name) {
  const bare = name.startsWith("mcp__") ? name.split("__").pop() : name;
  if (NOT_WRITE_SHAPED.has(bare) || bare.startsWith("helm_")) {
    return false;
  }
  return WRITE_SHAPED.some((stem) => bare.includes(stem));
}
const SHELL_TOOLS = new Set(["bash", "powershell", "shell"]);

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
 * @returns {{decision: "allow"|"deny", reason?: string, isWrite: boolean}}
 *          isWrite means "this counted as a file change" - it drives the second mate's
 *          budget and is false for reads and for builds/tests.
 */
export function decideToolCall({ tier, tool, input = {}, writesThisTurn = 0, budget = SECOND_MATE_TURN_WRITE_BUDGET } = {}) {
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

  if (tier === TIER_SECOND_MATE) {
    const isWrite = isMutatingTool || shellMutatesFile(input.command);
    if (!isWrite) {
      return { decision: "allow", isWrite: false };
    }
    if (writesThisTurn >= budget) {
      return { decision: "deny", isWrite: true, reason: secondMateDenial(writesThisTurn, budget) };
    }
    return { decision: "allow", isWrite: true };
  }

  // Crew, the captain's own sessions, and anything untiered are untouched. This guard is
  // about who does the work, not about making Helm a permission system.
  return { decision: "allow", isWrite: false };
}

/** Where a session's per-turn write counter lives. Reset by the app at each launch. */
export function turnCounterPath(metaHome, sessionId) {
  return path.join(metaHome, ".helm-dispatch", "tier-turns", `${String(sessionId || "unknown").replace(/[^\w.-]/g, "_")}.json`);
}
