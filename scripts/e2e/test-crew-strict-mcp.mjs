// Task 07cd4fc9: crew iterations must NOT inherit the user's globally-configured MCP
// servers. First-mate sessions already pass --strict-mcp-config (main.js:2321); the crew
// spawn path in goalOrchestrator.js had skipped it, so every crew iteration dragged in the
// full global MCP set - extra tool name-listing tokens on every call, and a
// bypassPermissions autonomous run with access to unrelated tools (router, home-assistant,
// whatever the workstation happens to carry) it could invoke.
//
// The spawn's argv is built by the pure buildIterationArgs(), so this asserts the flag set
// directly - no subprocess, deterministic.
//
// Run:  node scripts/e2e/test-crew-strict-mcp.mjs
import { buildIterationArgs } from "../../src/lib/goalOrchestrator.js";

let exit = 0;
const ok = (c, m) => {
  console.log(`${c ? "OK  " : "FAIL"} - ${m}`);
  if (!c) {
    exit = 1;
  }
};

// Helper: the value passed to a flag (the argv element right after it).
const valueAfter = (args, flag) => {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};

const args = buildIterationArgs({ schema: '{"type":"object"}', systemPrompt: "do the work", model: "claude-sonnet-5", effort: "high" });

// The two flags that together strip MCP. BOTH are required: an empty --mcp-config alone
// would not ignore the ambient/global servers without --strict-mcp-config, and strict
// alone (no config) is the fragile form - the judge uses this exact pair (judge.js:73-75).
ok(args.includes("--strict-mcp-config"), "the crew iteration passes --strict-mcp-config, like a first mate");
const mcp = valueAfter(args, "--mcp-config");
ok(mcp !== undefined, "and passes an explicit --mcp-config");

let parsed = null;
try {
  parsed = JSON.parse(mcp);
} catch {
  parsed = null;
}
ok(parsed && parsed.mcpServers && typeof parsed.mcpServers === "object", `the --mcp-config is valid JSON with an mcpServers object (${mcp})`);
ok(parsed && Object.keys(parsed.mcpServers || {}).length === 0, `it declares ZERO servers, so strict mode leaves the session with no MCP at all (${JSON.stringify(parsed?.mcpServers)})`);

// The bounded flags the iteration depends on must still be there (the refactor into a pure
// builder must not have dropped them).
ok(valueAfter(args, "--json-schema") === '{"type":"object"}', "the JSON schema is passed through");
ok(valueAfter(args, "--system-prompt") === "do the work", "the phase system prompt is passed through");
ok(valueAfter(args, "--permission-mode") === "bypassPermissions", "the isolated-worktree bypass is preserved");
ok(valueAfter(args, "--input-format") === "text", "the prompt-on-stdin input-format is preserved (ENAMETOOLONG fix)");
ok(!args.includes(undefined) && args.every((a) => typeof a === "string"), "every argv element is a defined string");

// model / effort are appended when given, omitted when not.
ok(valueAfter(args, "--model") === "claude-sonnet-5" && valueAfter(args, "--effort") === "high", "model and effort are appended when provided");
const bare = buildIterationArgs({ schema: "{}", systemPrompt: "x" });
ok(!bare.includes("--model") && !bare.includes("--effort"), "and omitted when not provided");
// Even without model/effort, the MCP stripping is unconditional - it must never depend on them.
ok(bare.includes("--strict-mcp-config") && valueAfter(bare, "--mcp-config") === '{"mcpServers":{}}', "MCP stripping is unconditional (present even with no model/effort)");

console.log(
  exit === 0
    ? "VERIFY OK: a crew iteration's argv strips MCP (empty config + strict), so it never inherits the global MCP servers - matching first-mate sessions."
    : "VERIFY FAILED."
);
process.exit(exit);
