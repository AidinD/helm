// Unit test: mcpAllowedToolsFromConfig turns the user's ~/.claude.json
// mcpServers into `mcp__<key>` allowedTools entries, so a second-mate session
// can actually use them in headless -p (bug 1f8b54be). Only tool-safe keys are
// kept - a remote "claude.ai X" server (space/dot) is dropped (it breaks the
// argv + doesn't load headless anyway).
//
// Run:  node scripts/e2e/test-user-mcp-allow.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mcpAllowedToolsFromConfig } from "../../src/lib/userMcp.js";

let exit = 0;
function assert(cond, msg) {
  console.log(`${cond ? "OK  " : "FAIL"} - ${msg}`);
  if (!cond) {
    exit = 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-usermcp-"));
try {
  const cfgPath = path.join(tmp, ".claude.json");
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({
      claudeAiMcpEverConnected: true,
      mcpServers: {
        hevy: { command: "hevy-mcp" },
        "home-assistant": { url: "https://x/sse" },
        "asus-router": { command: "python" },
        Roblox_Studio: { command: "cmd.exe" },
        "claude.ai Atlassian": { url: "https://mcp.atlassian.com" }, // space + dot -> dropped
        "bad name!": { command: "x" }, // unsafe -> dropped
      },
    }),
    "utf8"
  );

  const tools = mcpAllowedToolsFromConfig(cfgPath);
  assert(tools.includes("mcp__hevy"), "includes a plain local server (mcp__hevy)");
  assert(tools.includes("mcp__home-assistant"), "includes a hyphenated server (mcp__home-assistant)");
  assert(tools.includes("mcp__asus-router") && tools.includes("mcp__Roblox_Studio"), "includes the other tool-safe servers");
  assert(!tools.some((t) => /claude\.ai|Atlassian| /.test(t)), "drops the remote 'claude.ai X' server (space/dot key)");
  assert(!tools.some((t) => t.includes("bad name")), "drops an unsafe key");
  assert(tools.length === 4, `exactly the 4 tool-safe servers (got ${tools.length}: ${JSON.stringify(tools)})`);
  assert(tools.every((t) => t.startsWith("mcp__")), "every entry is an mcp__ allowedTools token");

  // Missing / malformed config -> [] (best-effort, never throws).
  assert(Array.isArray(mcpAllowedToolsFromConfig(path.join(tmp, "nope.json"))) && mcpAllowedToolsFromConfig(path.join(tmp, "nope.json")).length === 0, "a missing config reads as []");
  fs.writeFileSync(path.join(tmp, "junk.json"), "{ not json", "utf8");
  assert(mcpAllowedToolsFromConfig(path.join(tmp, "junk.json")).length === 0, "a corrupt config reads as [] (never throws)");
  fs.writeFileSync(path.join(tmp, "empty.json"), JSON.stringify({ other: 1 }), "utf8");
  assert(mcpAllowedToolsFromConfig(path.join(tmp, "empty.json")).length === 0, "no mcpServers key -> []");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(exit === 0 ? "VERIFY OK: user MCP servers -> mcp__<key> allowedTools, tool-safe only." : "VERIFY FAILED.");
process.exit(exit);
