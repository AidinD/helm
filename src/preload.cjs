const { contextBridge, ipcRenderer } = require("electron");

// Minimal, explicit API surface exposed to the renderer. No Node access leaks.
contextBridge.exposeInMainWorld("helm", {
  getSessions: () => ipcRenderer.invoke("sessions:get"),
  setConfig: (patch) => ipcRenderer.invoke("config:set", patch),
  // Away-from-desk attention delivery: notifyAttention fires an OS
  // notification (main.js gates it on window focus + config); setAttentionCount
  // best-effort sets the taskbar badge count.
  notifyAttention: (payload) => ipcRenderer.invoke("attention:notify", payload),
  setAttentionCount: (n) => ipcRenderer.invoke("attention:setCount", n),
  suggestModelEffort: (prompt) => ipcRenderer.invoke("suggest:modelEffort", prompt),
  getJotGoals: () => ipcRenderer.invoke("jot:goals"),
  // Embedded Jot tab (one Jot, two mounts).
  jotPaths: () => ipcRenderer.invoke("jot:paths"),
  jotMount: () => ipcRenderer.invoke("jot:mount"),
  getJotBoardSummary: (projectPaths) => ipcRenderer.invoke("jot:boardSummary", { projectPaths }),
  // A session's in-flight sub-agents (Task tool), for showing them as crew.
  getLiveSubAgents: (sessions) => ipcRenderer.invoke("session:liveSubAgents", { sessions }),
  // Last-known context size per session, for the Fleet context gauge on every mate.
  getContextTokens: (sessions) => ipcRenderer.invoke("session:contextTokens", { sessions }),
  addJotSubtask: (parentId, text) => ipcRenderer.invoke("jot:addSubtask", { parentId, text }),
  getTranscript: (ids) => ipcRenderer.invoke("transcript:get", ids),
  listSkills: (cwd) => ipcRenderer.invoke("skills:list", cwd),
  listSlashItems: (cwd) => ipcRenderer.invoke("slash:list", cwd),
  trackUsage: (event) => ipcRenderer.invoke("usage:track", event),
  getHelmUsage: () => ipcRenderer.invoke("usage:helmSummary"),
  openSkill: (opts) => ipcRenderer.invoke("skills:open", opts),
  readSkill: (opts) => ipcRenderer.invoke("skills:read", opts),
  openGlobalClaudeMd: () => ipcRenderer.invoke("claudeMd:openGlobal"),
  openProjectClaudeMd: (cwd) => ipcRenderer.invoke("claudeMd:openProject", cwd),
  projectClaudeMdExists: (cwd) => ipcRenderer.invoke("claudeMd:projectExists", cwd),
  listContext: (cwd) => ipcRenderer.invoke("context:list", cwd),
  openContext: (opts) => ipcRenderer.invoke("context:open", opts),
  readContext: (opts) => ipcRenderer.invoke("context:read", opts),
  captureNote: (cwd, text) => ipcRenderer.invoke("context:capture", { cwd, text }),
  // Handoffs go here (OVERWRITE, latest-only) - not into DECISIONS.md (append),
  // which they used to bloat with transient session narrative.
  // title feeds the topic-keyed store's classifier + header (task 663ab4b6);
  // category forces a topic instead of classifying (an override).
  saveHandoff: (cwd, text, title, category) => ipcRenderer.invoke("context:saveHandoff", { cwd, text, title, category }),
  copyToClipboard: (text) => ipcRenderer.invoke("clipboard:write", text),
  saveImage: (base64Data, ext) => ipcRenderer.invoke("image:save", { base64Data, ext }),
  transcribeVoice: (samples, language) => ipcRenderer.invoke("voice:transcribe", { samples, language }),
  // True real-time streaming transcription (continuous voice input via
  // whisper-stream.exe, see src/lib/whisperStream.js). startVoiceStream
  // resolves with { ok, streamId } (or { ok: false, error } if the binary/
  // model isn't installed); onVoiceStreamEvent fires { streamId, kind:
  // "partial" | "committed" | "error" | "exit", text? } as they arrive.
  startVoiceStream: (language) => ipcRenderer.invoke("voice:streamStart", { language }),
  stopVoiceStream: (streamId) => ipcRenderer.invoke("voice:streamStop", { streamId }),
  onVoiceStreamEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("voice:streamEvent", listener);
    return () => ipcRenderer.removeListener("voice:streamEvent", listener);
  },
  archiveSession: (sessionId, archived) => ipcRenderer.invoke("session:archive", { sessionId, archived }),
  forkSession: (cliSessionId, userMsgIndex) => ipcRenderer.invoke("session:fork", { cliSessionId, userMsgIndex }),
  switchSessionRootFolder: (cliSessionId, sessionId, newCwd) =>
    ipcRenderer.invoke("session:switchRootFolder", { cliSessionId, sessionId, newCwd }),
  getUsageSummary: () => ipcRenderer.invoke("usage:summary"),
  getVersion: () => ipcRenderer.invoke("app:version"),
  isDevBuild: () => ipcRenderer.invoke("app:isDev"),
  continueOnMobile: (payload) => ipcRenderer.invoke("session:continueOnMobile", payload),
  // Phase-2 orchestration guardrails (Slice 0): kill switch + budget.
  resumeGoalRun: (goalRunId) => ipcRenderer.invoke("goal:resume", { goalRunId }),
  resumeFleet: (mateId) => ipcRenderer.invoke("orchestration:resumeFleet", { mateId }),
  killOrchestration: () => ipcRenderer.invoke("orchestration:killTree"),
  resumeOrchestration: () => ipcRenderer.invoke("orchestration:resume"),
  getOrchestrationBudget: () => ipcRenderer.invoke("orchestration:budget"),
  setOrchestrationCeiling: (ceilingUsd) => ipcRenderer.invoke("orchestration:setCeiling", { ceilingUsd }),
  getOrchestratorInfo: () => ipcRenderer.invoke("orchestrator:info"),
  // Stale-build indicator: getBuildStatus() returns the running build's own
  // identity plus whatever the last periodic on-disk check found; onBuildStaleUpdate
  // fires only when that check's result actually changes (see runStaleBuildCheck
  // in main.js), not on every tick.
  getBuildStatus: () => ipcRenderer.invoke("build:status"),
  // Orchestrator sweep liveness readout (Settings page) — { lastRunAt, ok,
  // classifiedCount, error }. Read once when Settings renders, no polling.
  getSweepStatus: () => ipcRenderer.invoke("orchestrator:sweepStatus"),
  onBuildStaleUpdate: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("build:staleUpdate", listener);
    return () => ipcRenderer.removeListener("build:staleUpdate", listener);
  },
  pickFolder: () => ipcRenderer.invoke("dialog:pickFolder"),
  pickFiles: () => ipcRenderer.invoke("dialog:pickFiles"),
  // Non-repo "life-domain" projects (PLAN.md) — plain folders (gym, cycling,
  // kombucha, etc) registered as first-class projects alongside git repos.
  listDomains: () => ipcRenderer.invoke("domains:list"),
  registerDomain: (opts) => ipcRenderer.invoke("domains:register", opts),
  removeDomain: (id) => ipcRenderer.invoke("domains:remove", id),
  pickDomainFolder: () => ipcRenderer.invoke("dialog:pickDomainFolder"),
  // Lavish (interactive-plan) v1 — read an HTML artifact file by path, wrap
  // it into an SDK-injected srcdoc, and format collected annotations to text.
  readArtifactFile: (filePath) => ipcRenderer.invoke("lavish:readFile", filePath),
  buildArtifactSrcdoc: (artifactHtml) => ipcRenderer.invoke("lavish:buildSrcdoc", artifactHtml),
  formatAnnotations: (annotations, domSnapshot) =>
    ipcRenderer.invoke("lavish:formatPrompt", { annotations, domSnapshot }),
  // Open a generated mockup straight in the Plan view for annotation. Main
  // sends "plan:openMockup" with { filePath } or { html }; the renderer builds
  // the sandboxed artifact and switches to Plan. The hook the artifact-
  // generation-during-planning flow will call (nothing sends it yet).
  onOpenMockup: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("plan:openMockup", listener);
    return () => ipcRenderer.removeListener("plan:openMockup", listener);
  },
  startSession: (opts) => ipcRenderer.invoke("session:start", opts),
  stopSession: (launchId) => ipcRenderer.invoke("session:stop", { launchId }),
  // Named mates: the two fixed first-mate slots. listMates -> { active, all };
  // renameMate/retireMate mutate (retire discards + respawns a fresh one).
  listMates: () => ipcRenderer.invoke("mates:list"),
  renameMate: (mateId, name) => ipcRenderer.invoke("mates:rename", { mateId, name }),
  rethemeMates: (fromTheme, toTheme) => ipcRenderer.invoke("mates:retheme", { fromTheme, toTheme }),
  retireMate: (mateId, handoff, persona) => ipcRenderer.invoke("mates:retire", { mateId, handoff, persona }),
  setMatePersona: (mateId, persona) => ipcRenderer.invoke("mates:setPersona", { mateId, persona }),
  listPersonas: () => ipcRenderer.invoke("personas:list"),
  consumeMateHandoff: (mateId) => ipcRenderer.invoke("mates:consumeHandoff", { mateId }),
  // Links the CLI session currently embodying a mate, so "jump in" resumes it.
  bindMateSession: (mateId, sessionId) => ipcRenderer.invoke("mates:bindSession", { mateId, sessionId }),
  // Second mates: per-(firstMate,project) sessions derived from dispatched runs.
  listSecondMates: () => ipcRenderer.invoke("secondMates:list"),
  bindSecondMateSession: (secondMateId, sessionId) => ipcRenderer.invoke("secondMates:bindSession", { secondMateId, sessionId }),
  renameSecondMate: (secondMateId, name) => ipcRenderer.invoke("secondMates:rename", { secondMateId, name }),
  archiveSecondMate: (id) => ipcRenderer.invoke("secondMates:archive", { id }),
  onSessionEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("session:event", listener);
    return () => ipcRenderer.removeListener("session:event", listener);
  },
  // Fas 3 Point 11 — autonomous goal orchestrator. runGoal starts a run and
  // resolves with { ok, goalRunId }; progress arrives over onGoalEvent (its
  // own channel, parallel to session events); cancelGoal flips the run's
  // cancel flag so it stops between iterations. `opts` is passed straight
  // through to the "goal:run" handler, including the optional
  // `escalationConfig` (Point 12 Phase-0 escalation, opt-in — see
  // goalOrchestrator.js's runGoal doc comment); onGoalEvent also receives an
  // `{ kind: "escalation", escalation }` event when a run pauses on a signal.
  runGoal: (opts) => ipcRenderer.invoke("goal:run", opts),
  suggestVerifyCommand: (projectPath) => ipcRenderer.invoke("goal:suggestVerifyCommand", { projectPath }),
  cancelGoal: (goalRunId) => ipcRenderer.invoke("goal:cancel", { goalRunId }),
  // Persisted goal-run index (survives app restarts) - read once on startup
  // to rehydrate the Goal page's in-memory goalRuns Map with past runs.
  getGoalRunHistory: () => ipcRenderer.invoke("goal:history"),
  // Per-run worktree cleanup (Goal page). openWorktree just opens the folder
  // in the OS file explorer; deleteWorktree removes the worktree via
  // lib/worktree.js's removeWorktree (branch is left alone by design) and,
  // on success, drops the persisted history record too.
  openGoalWorktree: (worktreePath) => ipcRenderer.invoke("goal:openWorktree", { worktreePath }),
  deleteGoalWorktree: (opts) => ipcRenderer.invoke("goal:deleteWorktree", opts),
  // Report-back "Done + clean up": remove the worktree + delete the branch only
  // if it's merged (unmerged branches are kept). Keeps the run record.
  cleanupGoalRun: (opts) => ipcRenderer.invoke("goal:cleanupRun", opts),
  // Coach: commits since a project's PLAN.md/DECISIONS.md were last touched
  // (pane-header staleness nudge).
  docsStaleness: (cwd) => ipcRenderer.invoke("docs:staleness", { cwd }),
  onGoalEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("goal:event", listener);
    return () => ipcRenderer.removeListener("goal:event", listener);
  },
  // Fires when a dispatched run reports back (main writes the report). Lets the
  // renderer surface the crew report under its first-mate card immediately,
  // rather than waiting up to a full poll tick for the fleet section to repaint.
  onDispatchReport: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("dispatch:report", listener);
    return () => ipcRenderer.removeListener("dispatch:report", listener);
  },
  // Routines page (read-only) - lists Claude Code's own scheduled tasks from
  // ~/.claude/scheduled-tasks/. No scheduler lives in Helm; this just reads.
  listRoutines: () => ipcRenderer.invoke("routines:list"),
  createRoutine: (spec) => ipcRenderer.invoke("routines:create", spec),
  updateRoutine: (id, patch) => ipcRenderer.invoke("routines:update", { id, patch }),
  removeRoutine: (id) => ipcRenderer.invoke("routines:remove", { id }),
  runRoutineNow: (id) => ipcRenderer.invoke("routines:runNow", { id }),
  proposeAutopilotConfig: (projectPath, goal) => ipcRenderer.invoke("autopilot:proposeConfig", { projectPath, goal }),
});
