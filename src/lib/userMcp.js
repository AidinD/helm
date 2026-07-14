import fs from "node:fs";

// The user's OWN configured MCP servers as `mcp__<key>` allowedTools entries.
//
// Why this exists (bug 1f8b54be): a second-mate session passes --mcp-config (to
// add the helm_* crew tools). Just passing --mcp-config makes Claude Code stop
// AUTO-ALLOWING the user's own MCP tools from their settings - so in a headless
// `-p` turn those tools hit a permission prompt that can't be answered and stall.
// A regular (no --mcp-config) session doesn't have this problem. Pre-approving
// the user's already-configured servers RESTORES that parity - it grants nothing
// the user hasn't set up and uses interactively / in Claude Desktop.
//
// The top-level `mcpServers` object keys in ~/.claude.json are the exact prefixes
// the tools carry (`mcp__<key>__<tool>`), verified live (e.g. "hevy" ->
// mcp__hevy__get-workout-count). Only tool-safe keys are kept: a --allowedTools
// argv value with a space or dot (e.g. a remote "claude.ai Atlassian" server)
// would either break the arg or not match - and those OAuth/remote servers don't
// load in a headless -p run anyway, so dropping them costs nothing.
//
// Pure + best-effort: returns [] on any read/parse failure. `configPath` is
// injectable for tests; production passes ~/.claude.json.
export function mcpAllowedToolsFromConfig(configPath) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return Object.keys(cfg.mcpServers || {})
      .filter((k) => /^[A-Za-z0-9_-]+$/.test(k))
      .map((k) => `mcp__${k}`);
  } catch {
    return [];
  }
}
