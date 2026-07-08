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
  getJotBoardSummary: (projectPaths) => ipcRenderer.invoke("jot:boardSummary", { projectPaths }),
  // A session's in-flight sub-agents (Task tool), for showing them as crew.
  getLiveSubAgents: (sessions) => ipcRenderer.invoke("session:liveSubAgents", { sessions }),
  addJotSubtask: (parentId, text) => ipcRenderer.invoke("jot:addSubtask", { parentId, text }),
  getTranscript: (ids) => ipcRenderer.invoke("transcript:get", ids),
  listSkills: (cwd) => ipcRenderer.invoke("skills:list", cwd),
  openSkill: (opts) => ipcRenderer.invoke("skills:open", opts),
  openGlobalClaudeMd: () => ipcRenderer.invoke("claudeMd:openGlobal"),
  openProjectClaudeMd: (cwd) => ipcRenderer.invoke("claudeMd:openProject", cwd),
  projectClaudeMdExists: (cwd) => ipcRenderer.invoke("claudeMd:projectExists", cwd),
  listContext: (cwd) => ipcRenderer.invoke("context:list", cwd),
  openContext: (opts) => ipcRenderer.invoke("context:open", opts),
  captureNote: (cwd, text) => ipcRenderer.invoke("context:capture", { cwd, text }),
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
  retireMate: (mateId, handoff) => ipcRenderer.invoke("mates:retire", { mateId, handoff }),
  consumeMateHandoff: (mateId) => ipcRenderer.invoke("mates:consumeHandoff", { mateId }),
  // Links the CLI session currently embodying a mate, so "jump in" resumes it.
  bindMateSession: (mateId, sessionId) => ipcRenderer.invoke("mates:bindSession", { mateId, sessionId }),
  // Second mates: per-(firstMate,project) sessions derived from dispatched runs.
  listSecondMates: () => ipcRenderer.invoke("secondMates:list"),
  bindSecondMateSession: (secondMateId, sessionId) => ipcRenderer.invoke("secondMates:bindSession", { secondMateId, sessionId }),
  renameSecondMate: (secondMateId, name) => ipcRenderer.invoke("secondMates:rename", { secondMateId, name }),
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
  onGoalEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("goal:event", listener);
    return () => ipcRenderer.removeListener("goal:event", listener);
  },
  // Routines page (read-only) - lists Claude Code's own scheduled tasks from
  // ~/.claude/scheduled-tasks/. No scheduler lives in Helm; this just reads.
  listRoutines: () => ipcRenderer.invoke("routines:list"),
});
