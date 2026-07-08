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
  manualHelmSessions: [], // sessionIds tagged "◆ Helm" by hand, independent of Jot category matching
  hiddenSessions: [], // sessionIds removed from Helm's view (restore by editing this array)
  // Helm's OWN session index, for sessions Helm CREATES via launcher.js. The
  // headless `claude -p` variant launcher.js uses never writes a Desktop
  // local_*.json (verified), so these sessions were structurally invisible to
  // readAllSessions (which reads only the Desktop app's dir) - the root cause
  // of "a session started inside Helm never shows in Direct/Fleet". We record
  // our own metadata here (on D:\, never the %APPDATA% MSIX overlay, and never
  // writing into Anthropic's private schema) and merge it in readAllSessions.
  // Keyed by sessionId. Shape mirrors what buildSession() reads from a Desktop
  // meta: { sessionId, cliSessionId, cwd, model, effort, permissionMode, title,
  // createdAt, lastActivityAt, isArchived }.
  helmSessions: {},
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
  // Manual "I'm done with this" for a session sitting in "waiting" (needs
  // attention) that genuinely has nothing left to do — e.g. it ended with an
  // answer to a question, not an open loop. Maps sessionId -> the
  // lastActivityAt it was acknowledged at; a session whose lastActivityAt has
  // since moved past that value (new activity happened) is treated as
  // unacknowledged again automatically, so this can't permanently hide a
  // session that comes back to life. Aidin's own words: "jag hoppas fas 3
  // orkestratorn löser detta men man kanske också ska stoppa en manuell check
  // på varje svar" — this IS that manual check, ahead of the Fas 3 automation.
  acknowledgedSessions: {}, // { "<sessionId>": lastActivityAtMs }
  // Fas 3's periodic session-status classifier (PLAN.md "orchestrator
  // helper"). Off by default — it's a recurring background cost (one cheap
  // Haiku call per eligible session per sweep), same opt-in posture as
  // modelFitJudge/archiveSuggestions. Its output only ever sharpens an
  // existing suggestion (the archive-suggest pill) — never acts on its own.
  orchestratorHelper: { enabled: false },
  // Fas 3 auto-compact: when on, the same periodic sweep runs the CLI's
  // built-in /compact on idle/waiting sessions whose estimated context has
  // grown past thresholdTokens. Off by default and separately toggled from
  // orchestratorHelper — unlike the read-only classifier, this MUTATES what
  // a resumed session sees (lossy summary; the original stays in the
  // append-only transcript). Aidin chose automatic (not propose-a-pill) for
  // this one, matching the original "kör en /compact när ... idle" ask.
  // idleMinutes: how long a session must sit with NO activity before it's
  // eligible — Aidin's refinement: don't compact mid-work, but a session
  // left idle over lunch with half-full context should get tidied. This
  // time-since-last-activity gate (not the coarse waiting/idle status) is
  // both what he asked for and inherently safe — 30+ min of silence means
  // it's definitely not mid-turn.
  autoCompact: { enabled: false, thresholdTokens: 150000, idleMinutes: 10 },
  // Fas 3's proactive model/effort suggestion-accuracy check (PLAN.md Phase
  // 3, "the model/effort suggestion-accuracy review"). Folded into the same
  // periodic sweep as orchestratorHelper/autoCompact rather than a third
  // timer (2026-07-02 decision, "infogas i Fas 3:s orkestrator-helper istället
  // för en egen separat loop"). Off by default, same opt-in posture as the
  // other sweep features. Reuses the EXACT metric the on-demand "Suggestion
  // accuracy" report on the Analysis page already computes (see
  // usage.js's computeSuggestionAccuracyVerdict) — this only changes WHEN
  // it's checked (periodically vs. only when Aidin opens the page), never
  // what's computed. lastCheckedAt* remember the data volume as of the last
  // check so the sweep only re-checks after enough new judged runs have
  // accumulated to possibly change the verdict, not on every sweep tick.
  suggestionAccuracyCheck: { enabled: false, lastCheckedFollowedTotal: 0, lastCheckedOverriddenTotal: 0 },
  // The proactive finding surfaced on the Analysis page, dismissed the same
  // way acknowledgedSessions dismisses a per-session row: keyed on the data
  // volume it was computed from, so a dismissal only sticks until enough new
  // judged runs arrive to possibly change the verdict (mirrors
  // acknowledgedSessions' lastActivityAt staleness check, just for a global
  // finding instead of a per-session one).
  suggestionAccuracyNotice: null, // { message, diffPoints, totalAtCheck, dismissed }
  // Fallback context-window size for the gauge's %, used only for a model
  // Helm hasn't yet learned a real window for (see modelContextWindows).
  // Defaulted to 1M to match Aidin's current environment.
  contextWindowTokens: 1000000,
  // Language the composer's mic button transcribes voice input as (see
  // src/lib/voice.js). A single global setting, not per-pane (overkill for
  // v1). "swedish" preserves the pre-picker forced-Swedish behavior as the
  // default (Aidin's primary language). Value is the full lowercase English
  // language NAME that transformers.js expects ("swedish"/"english"/etc.), or
  // "auto" to let Whisper auto-detect the language per utterance.
  voiceLanguage: "swedish",
  // Which transcription backend the mic button uses (see src/lib/voice.js
  // and src/lib/whisperCpp.js). "whispercpp" is the default: a whisper.cpp +
  // CUDA subprocess, ~10-20x faster than the transformers.js path on Aidin's
  // RTX 3070 (see docs/transcription-research.md) while using the same
  // Swedish-specialized KB-Whisper model family, just in GGML format instead
  // of ONNX. "transformers" is the original @huggingface/transformers path,
  // kept as a fallback for machines without the .whisper/ binary+model
  // installed (voiceWorker.js also auto-falls-back to it if whisper.cpp is
  // requested but missing, so this value mainly matters as an explicit
  // opt-out).
  voiceEngine: "whispercpp",
  // model name -> real context-window size, LEARNED from the CLI's own
  // result events (evt.modelUsage[model].contextWindow) as sessions run
  // through Helm. Authoritative per model; the gauge prefers this over
  // the contextWindowTokens fallback. Grows as new models are used.
  modelContextWindows: {},
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
    // A plain {...DEFAULT_CONFIG, ...parsed} is a SHALLOW merge — a
    // config.json with only a partial nested object (e.g. {"jot":
    // {"enabled":false}}) would replace the whole default `jot`, silently
    // dropping `path`/`overrides`/`weights`. Only these three keys are
    // nested objects with their own defaults worth protecting individually;
    // everything else in DEFAULT_CONFIG is a primitive or an array, where a
    // shallow overwrite is exactly the right behavior.
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      modelFitJudge: { ...DEFAULT_CONFIG.modelFitJudge, ...parsed.modelFitJudge },
      archiveSuggestions: { ...DEFAULT_CONFIG.archiveSuggestions, ...parsed.archiveSuggestions },
      orchestratorHelper: { ...DEFAULT_CONFIG.orchestratorHelper, ...parsed.orchestratorHelper },
      autoCompact: { ...DEFAULT_CONFIG.autoCompact, ...parsed.autoCompact },
      suggestionAccuracyCheck: { ...DEFAULT_CONFIG.suggestionAccuracyCheck, ...parsed.suggestionAccuracyCheck },
      jot: { ...DEFAULT_CONFIG.jot, ...parsed.jot },
    };
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
