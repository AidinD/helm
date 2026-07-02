import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { desktopConfigPath } from "./paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, "..", "..", "config.json");

const DEFAULT_CONFIG = {
  sort: "attention", // attention | recent | title
  hideArchived: true,
  viewMode: "simple", // simple | advanced
  sidebarMode: "smart", // smart (attention + categories) | list (flat, all sessions)
  attentionWindowHours: 24, // assistant-ended sessions older than this are "idle", not "waiting"
  // Display-only session title overrides — never writes to the desktop app's
  // own session files, so "renaming a chat" can't corrupt live app state.
  titleOverrides: {}, // { "<sessionId>": "Custom title" }
  manualMaestroSessions: [], // sessionIds tagged "◆ Maestro" by hand, independent of Jot category matching
  hiddenSessions: [], // sessionIds removed from Maestro's view (restore by editing this array)
  // Runs a cheap Haiku judge after every completed prompt to flag whether the
  // model/effort choice was too weak/too strong (~$0.015-0.02 extra per run,
  // after stripping MCP/tool defs the judge doesn't need). User-requested;
  // set enabled:false here to turn it off if the recurring cost isn't worth it.
  modelFitJudge: { enabled: true },
  notifyOnComplete: true, // native OS notification (+ its default sound) when a prompt finishes
  // Off by default: manual "Archive" (context menu) is always available.
  // When on, idle sessions with no open Jot work get a "Suggest: archive"
  // affordance in the sidebar row — still a manual click to confirm, never
  // an automatic write. This is the "orchestrator proposes, I approve" path.
  archiveSuggestions: { enabled: false },
  jot: {
    enabled: true,
    path: "D:\\Dropbox\\jot\\todos.json",
    overrides: {}, // { "local_<sessionId>": "CategoryName" } for matches the name heuristic misses
    weights: {}, // override DEFAULT_WEIGHTS from sessions.js (waiting/active/review/inProgress/open)
  },
  groups: [],
};

/**
 * Loads the user's config. If none exists yet, seeds one from the Claude
 * desktop app's own group clusters so the dashboard starts out mirroring the
 * grouping the user already has (with placeholder labels they can rename).
 */
export function loadConfig() {
  if (!fs.existsSync(configPath)) {
    const seeded = seedFromDesktopConfig();
    writeConfig(seeded);
    return seeded;
  }
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function writeConfig(config) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export function configFilePath() {
  return configPath;
}

/**
 * Reads customGroupOrder from the desktop app config. Those clusters key
 * sessionIds as "code:local_..." and group them under cg-<uuid> ids. We turn
 * each cluster into a group with a placeholder label the user can rename.
 */
function seedFromDesktopConfig() {
  const config = { ...DEFAULT_CONFIG, groups: [] };
  config.attentionWindowHours = DEFAULT_CONFIG.attentionWindowHours;
  config.jot = { ...DEFAULT_CONFIG.jot };
  let clusters;
  try {
    const raw = fs.readFileSync(desktopConfigPath, "utf8");
    const parsed = JSON.parse(raw);
    clusters =
      parsed?.preferences?.epitaxyPrefs?.["dframe-local-slice"]?.customGroupOrder;
  } catch {
    clusters = null;
  }
  if (!clusters || typeof clusters !== "object") {
    return config;
  }
  let index = 1;
  for (const cgId of Object.keys(clusters)) {
    const members = Array.isArray(clusters[cgId]) ? clusters[cgId] : [];
    const sessionIds = members
      .map((m) => String(m).replace(/^code:/, ""))
      .filter((id) => id.startsWith("local_"));
    if (sessionIds.length === 0) {
      continue;
    }
    config.groups.push({
      label: `Group ${index}`,
      sessionIds,
      collapsed: false,
    });
    index += 1;
  }
  return config;
}
