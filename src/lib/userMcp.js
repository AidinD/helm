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

/**
 * A NAMED subset of the user's own MCP servers, as a `{ name: definition }` map.
 *
 * The assistant seat needs its stores and nothing else. A first mate launches with
 * `--strict-mcp-config` and only Helm's dispatch server, and the comment there says why: a
 * coordinator has no business carrying the machine's Roblox, Unity, fitness, router and HR
 * servers. That reasoning holds for this seat too - but it needs three or four of them, so
 * the answer is neither "none" nor "all" but a list.
 *
 * By NAME out of the user's own config rather than by path in Helm's source, deliberately.
 * Helm would otherwise hold absolute paths into sibling repositories, which is a second place
 * for them to be wrong and a guarantee of being wrong on another machine. A server he has not
 * configured is simply absent from the result - the seat launches without that store rather
 * than failing, and the missing tool is the visible symptom.
 *
 * The definition is copied verbatim, including its env, so the store resolves its data
 * directory exactly as it does for every other client.
 *
 * Pure + best-effort, same as above: an unreadable config yields {}.
 *
 * @param {string} configPath
 * @param {string[]} names
 * @returns {Record<string, object>}
 */
export function namedMcpServersFromConfig(configPath, names) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const servers = cfg.mcpServers || {};
    const out = {};
    for (const name of names || []) {
      // Same key rule as above: a key that cannot appear in an --allowedTools value is a
      // remote/OAuth server that does not load in a headless run anyway.
      if (servers[name] && /^[A-Za-z0-9_-]+$/.test(name)) {
        out[name] = servers[name];
      }
    }
    return out;
  } catch {
    return {};
  }
}
