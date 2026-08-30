import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { desktopConfigPath } from "./paths.js";
import { writeJsonAtomicSync } from "./atomicWrite.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// HELM_CONFIG_PATH is a test/packaged-app seam (see main.js's packagedPaths.js,
// which points this at Electron's userData dir in a packaged build, since
// app.asar is read-only there); dev and unit tests leave it unset and use the
// plain JSON file beside the app, like every other Helm store.
const configPath = process.env.HELM_CONFIG_PATH || path.join(__dirname, "..", "..", "config.json");

const DEFAULT_CONFIG = {
  sort: "attention", // attention | recent | title
  hideArchived: true,
  viewMode: "simple", // simple | advanced
  attentionWindowHours: 24, // assistant-ended sessions older than this are "idle", not "waiting"
  // Display-only session title overrides — never writes to the desktop app's
  // own session files, so "renaming a chat" can't corrupt live app state.
  titleOverrides: {}, // { "<sessionId>": "Custom title" }
  manualHelmSessions: [], // sessionIds tagged "◆ Helm" by hand, independent of Jot category matching
  theme: "dark", // active app theme id; matches a :root[data-theme="<id>"] block in style.css
  hiddenSessions: [], // sessionIds removed from Helm's view (restore by editing this array)
  // Terminal goal/Autopilot runs the captain has marked "done" from a
  // report-back row. Non-destructive (the run stays in goal-run-history + the
  // Goal page) - it only removes the run from the report-back glance surfaces
  // (Dashboard report-back + a first mate's card roll-up). Mirrors
  // acknowledgedSessions' "I'm done looking at this" for a run instead of a
  // session. Array of goalRunIds; restore by removing the id. See tiered
  // report-back in docs/orchestration-model.md.
  acknowledgedGoalRuns: [],
  // Helm's OWN archive overlay: sessionIds Helm has archived. Applied in
  // readAllSessions (forces isArchived=true). Authoritative because it lives
  // here on D:\, NOT in the desktop app's local_*.json - that app owns and
  // rewrites those files, dropping an isArchived Helm wrote there (the "archive
  // keeps coming back" bug). Unarchive removes the id. Distinct from
  // hiddenSessions (a permanent "remove from view"); archived stays listed on
  // the Archive page and is restorable.
  archivedSessions: [],
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
  // session that comes back to life. The captain's own words: "jag hoppas fas 3
  // orkestratorn löser detta men man kanske också ska stoppa en manuell check
  // på varje svar" — this IS that manual check, ahead of the Fas 3 automation.
  acknowledgedSessions: {}, // { "<sessionId>": lastActivityAtMs }
  // Fas 3's periodic session-status classifier (PLAN.md "orchestrator
  // helper"). Off by default — it's a recurring background cost (one cheap
  // Haiku call per eligible session per sweep), same opt-in posture as
  // archiveSuggestions. Its output only ever sharpens an existing suggestion
  // (the archive-suggest pill) — never acts on its own.
  //
  // The model-fit judge used to be named here as the other example of that posture. It
  // was removed on 2026-08-30 for costing 24,100 tokens of input per run against a
  // 778-byte prompt - which is the warning this comment should now carry instead: "a
  // cheap Haiku call" is a claim about a model, not about a call, and only a measurement
  // tells you which.
  orchestratorHelper: { enabled: false },
  // Fas 3 auto-compact: when on, the same periodic sweep runs the CLI's
  // built-in /compact on idle/waiting sessions whose estimated context has
  // grown past thresholdTokens. Off by default and separately toggled from
  // orchestratorHelper — unlike the read-only classifier, this MUTATES what
  // a resumed session sees (lossy summary; the original stays in the
  // append-only transcript). The captain chose automatic (not propose-a-pill) for
  // this one, matching the original "kör en /compact när ... idle" ask.
  // idleMinutes: how long a session must sit with NO activity before it's
  // eligible — the captain's refinement: don't compact mid-work, but a session
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
  // it's checked (periodically vs. only when the captain opens the page), never
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
  // Defaulted to 1M to match the captain's current environment.
  contextWindowTokens: 1000000,
  // Language the composer's mic button transcribes voice input as (see
  // src/lib/voice.js). A single global setting, not per-pane (overkill for
  // v1). "swedish" preserves the pre-picker forced-Swedish behavior as the
  // default (the captain's primary language). Value is the full lowercase English
  // language NAME that transformers.js expects ("swedish"/"english"/etc.), or
  // "auto" to let Whisper auto-detect the language per utterance.
  voiceLanguage: "swedish",
  // Which transcription backend the mic button uses (see src/lib/voice.js
  // and src/lib/whisperCpp.js). "whispercpp" is the default: a whisper.cpp +
  // CUDA subprocess, ~10-20x faster than the transformers.js path on the captain's
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
  // Auto-captain (task ea0546d1): the automated dispatcher that picks up tasks
  // tagged "auto" and dispatches them to crew. OFF by default - a consequential
  // feature (it spawns work) stays opt-in; nothing auto-fires until enabled.
  autoCaptain: {
    enabled: false,
  },
  // Widget dashboard (task 4bf2421c): the Dashboard is a drag-and-drop grid of
  // widgets. The old fixed section stack ("classic layout") was removed once the
  // widget view had been in daily use (task 337895ce), so this is now the only
  // dashboard - `enabled` is vestigial (the render path no longer reads it to
  // choose a layout) and defaults true; `layout` is the real state.
  // layout: ordered [{ id, type, span, mateId? }]; null = seed the default set.
  dashboardWidgets: {
    enabled: true,
    layout: null,
  },
  jot: {
    enabled: true,
    // null = resolve portably (JOT_DATA_DIR, else the OS Jot data dir) via
    // jotDataDir.js - no hardcoded machine path (task b89aa99b). A user who sets
    // an explicit path in their config still overrides this.
    path: null,
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
      archiveSuggestions: { ...DEFAULT_CONFIG.archiveSuggestions, ...parsed.archiveSuggestions },
      orchestratorHelper: { ...DEFAULT_CONFIG.orchestratorHelper, ...parsed.orchestratorHelper },
      autoCompact: { ...DEFAULT_CONFIG.autoCompact, ...parsed.autoCompact },
      autoCaptain: { ...DEFAULT_CONFIG.autoCaptain, ...parsed.autoCaptain },
      dashboardWidgets: { ...DEFAULT_CONFIG.dashboardWidgets, ...parsed.dashboardWidgets },
      suggestionAccuracyCheck: { ...DEFAULT_CONFIG.suggestionAccuracyCheck, ...parsed.suggestionAccuracyCheck },
      jot: { ...DEFAULT_CONFIG.jot, ...parsed.jot },
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function writeConfig(config) {
  // Shared atomic write with the locked-file retry (task efcaf486). config.json
  // was missed when the other eight stores were converted - and it is the most
  // frequently written of them all (quota readings, archive overlays, widget
  // layout), so a torn or lost write here loses settings rather than a queue
  // entry. Found on 2026-08-02 while chasing an unrelated test failure.
  //
  // Still THROWS on failure, as the plain write did: every caller here treats a
  // config write as must-succeed, and quietly returning would turn "your setting
  // didn't save" into silence.
  const res = writeJsonAtomicSync(configPath, config);
  if (!res.ok) {
    throw new Error(`Could not write config.json: ${res.error}`);
  }
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
