const { contextBridge, ipcRenderer, webUtils } = require("electron");

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
  // Project skills are per PROJECT, not per focused pane - the renderer passes the
  // project folders it knows sessions in.
  listSkills: (projectRoots) => ipcRenderer.invoke("skills:list", { projectRoots }),
  listSlashItems: (cwd) => ipcRenderer.invoke("slash:list", cwd),
  trackUsage: (event) => ipcRenderer.invoke("usage:track", event),
  getHelmUsage: () => ipcRenderer.invoke("usage:helmSummary"),
  getReviewActionSummary: () => ipcRenderer.invoke("usage:reviewActions"),
  getAuthStatus: () => ipcRenderer.invoke("auth:status"),
  startAuthLogin: () => ipcRenderer.invoke("auth:login"),
  onAuthLoginOutput: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("auth:loginOutput", handler);
    return () => ipcRenderer.removeListener("auth:loginOutput", handler);
  },
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
  // Review queue (task ce2d19ab): what is in review, judgment items first, each
  // with its evidence and test steps. Records are AUTHORED by the agent that did
  // the work, never from the UI - but the UI can sign off (setReviewStatus) and
  // run the record's declared checks, whose real exit codes are the half of the
  // evidence the author doesn't get to write.
  // opts.maxAgeMs lets a caller that only needs the COUNT accept a recent result
  // instead of paying for a fresh one - the queue costs a git spawn per project in the
  // main process, measured at up to 2 seconds (see reviews:list). The review PAGE
  // passes nothing and always recomputes.
  listReviews: (opts) => ipcRenderer.invoke("reviews:list", opts || {}),
  acknowledgeNoRecord: (taskId) => ipcRenderer.invoke("reviews:acknowledgeNoRecord", { taskId }),
  setReviewStatus: (taskId, status, note) => ipcRenderer.invoke("reviews:setStatus", { taskId, status, note }),
  // Send a review back to in-progress with optional images (task 1116b7ef).
  // images: [{ base64, ext }].
  sendReviewBack: (taskId, note, images) => ipcRenderer.invoke("reviews:sendBack", { taskId, note, images }),
  runReviewChecks: (taskId) => ipcRenderer.invoke("reviews:runChecks", { taskId }),
  // The change behind a review item: its commits' patch, read-only.
  getReviewDiff: (taskId, projectPath) => ipcRenderer.invoke("reviews:diff", { taskId, projectPath }),
  // Renders the WHOLE review as a standalone HTML page and opens it in the OS browser.
  presentReview: (taskId) => ipcRenderer.invoke("reviews:presentReview", { taskId }),
  // The same page for a commit with no Jot task - git's facts, and a plain statement
  // that no record exists.
  presentCommitReview: (projectPath, sha) => ipcRenderer.invoke("reviews:presentCommit", { projectPath, sha }),
  // The released app version a fix is out in (null if not yet in a tagged release).
  getShippedVersion: (taskId) => ipcRenderer.invoke("reviews:shippedVersion", { taskId }),
  // Commit-centric review (work with no Jot task): a single commit's patch, and
  // acknowledging a commit (advances the project's review watermark past it).
  getCommitDiff: (projectPath, sha) => ipcRenderer.invoke("reviews:commitDiff", { projectPath, sha }),
  acknowledgeCommit: (projectPath, sha, shas) => ipcRenderer.invoke("reviews:acknowledgeCommit", { projectPath, sha, shas }),
  // Author, date, the full commit message and the change's size - the body a commit
  // row has instead of a review record.
  getCommitDetail: (projectPath, sha) => ipcRenderer.invoke("reviews:commitDetail", { projectPath, sha }),
  // What an independent reviewer would be sent in on, recommended from the change.
  // `sample` is the task's own prose - main reads the review's language off it.
  getReviewerPlan: (taskId, sample, projectPath) => ipcRenderer.invoke("reviews:reviewerPlan", { taskId, sample, projectPath }),
  // The same, for a commit with no task (no record to start from, so size only).
  getCommitReviewerPlan: (projectPath, sha) => ipcRenderer.invoke("reviews:commitReviewerPlan", { projectPath, sha }),
  // The reviewer's own verdict, once it has written one.
  getIndependentNote: (taskId) => ipcRenderer.invoke("reviews:independentNote", { taskId }),
  onReviewsChanged: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("reviews:changed", handler);
    return () => ipcRenderer.removeListener("reviews:changed", handler);
  },
  // Scheduled prompts (task 7d9d2188): queue a prompt for later, or for whenever
  // the quota window resets. `when` is absolute ms or the string "quota-reset".
  listScheduledPrompts: () => ipcRenderer.invoke("scheduledPrompts:list"),
  addScheduledPrompt: (spec) => ipcRenderer.invoke("scheduledPrompts:add", spec),
  cancelScheduledPrompt: (id) => ipcRenderer.invoke("scheduledPrompts:cancel", { id }),
  // Dismiss the notice about a scheduled prompt that failed to reach the model.
  acknowledgeScheduledPrompt: (id) => ipcRenderer.invoke("scheduledPrompts:acknowledge", { id }),
  onScheduledPromptsChanged: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("scheduledPrompts:changed", handler);
    return () => ipcRenderer.removeListener("scheduledPrompts:changed", handler);
  },
  // Repo scripts (task 8bfae7a0): run a bound repo's package.json scripts
  // directly, with no model turn - output streams over "repo:scriptEvent".
  listRepoScripts: (cwd) => ipcRenderer.invoke("repo:listScripts", { cwd }),
  runRepoScript: (cwd, script, runId) => ipcRenderer.invoke("repo:runScript", { cwd, script, runId }),
  stopRepoScript: (runId) => ipcRenderer.invoke("repo:stopScript", { runId }),
  onRepoScriptEvent: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("repo:scriptEvent", handler);
    return () => ipcRenderer.removeListener("repo:scriptEvent", handler);
  },
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
  // Model-freshness indicator: getModelFreshness() returns the last check's
  // result (see runModelFreshnessCheck in main.js); onModelFreshnessUpdate
  // fires only when the set of newly-seen model ids actually changes.
  getModelFreshness: () => ipcRenderer.invoke("models:freshnessStatus"),
  onModelFreshnessUpdate: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("models:freshnessUpdate", listener);
    return () => ipcRenderer.removeListener("models:freshnessUpdate", listener);
  },
  // Fired when a setting could not be saved. setConfig cannot report this in its
  // return value - the renderer assigns that straight into state.config in ~40
  // places - so the failure comes back on its own channel instead of vanishing.
  onConfigWriteFailed: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("config:writeFailed", listener);
    return () => ipcRenderer.removeListener("config:writeFailed", listener);
  },
  // Auto-captain (ea0546d1): OFF by default. runAutoCaptainNow({force:true}) runs a
  // single pass even while the toggle is off - the deliberate "watch the first live
  // run" path, rather than flipping it on and waiting for a timer.
  pruneStaleArchivedFleetNodes: () => ipcRenderer.invoke("secondMates:pruneStaleArchived"),
  autoCaptainStatus: () => ipcRenderer.invoke("autoCaptain:status"),
  setAutoCaptainEnabled: (enabled) => ipcRenderer.invoke("autoCaptain:setEnabled", { enabled }),
  runAutoCaptainNow: (opts) => ipcRenderer.invoke("autoCaptain:runNow", opts || {}),
  pickFolder: () => ipcRenderer.invoke("dialog:pickFolder"),
  pickFiles: () => ipcRenderer.invoke("dialog:pickFiles"),
  // The absolute path of a DROPPED file, so dragging one onto the composer can attach it
  // the same way the paperclip does (task c24f18b8 - dropping worked for images only).
  // File.path is deprecated in Electron and gone in later majors; webUtils.getPathForFile
  // is the supported way and has to be called HERE, in the preload, because the renderer
  // has no access to it. Returns "" for a file that has no path on disk (dragged out of a
  // browser, an archive, or synthesised in a test) - the caller must say so rather than
  // attaching an empty path.
  pathForFile: (file) => {
    try {
      return webUtils?.getPathForFile ? webUtils.getPathForFile(file) || "" : file?.path || "";
    } catch {
      return "";
    }
  },
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
  addMate: () => ipcRenderer.invoke("mates:add"),
  removeMate: (mateId) => ipcRenderer.invoke("mates:remove", { mateId }),
  renameMate: (mateId, name) => ipcRenderer.invoke("mates:rename", { mateId, name }),
  rethemeMates: (fromTheme, toTheme) => ipcRenderer.invoke("mates:retheme", { fromTheme, toTheme }),
  retireMate: (mateId, handoff, persona, keepPersona) => ipcRenderer.invoke("mates:retire", { mateId, handoff, persona, keepPersona }),
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
  // Which of these worktree paths still exist on disk (Fleet archive guard, a827cc95).
  existingWorktrees: (paths) => ipcRenderer.invoke("goal:existingWorktrees", { paths }),
  // Report-back "Done + clean up": remove the worktree + delete the branch only
  // if it's merged (unmerged branches are kept). Keeps the run record.
  cleanupGoalRun: (opts) => ipcRenderer.invoke("goal:cleanupRun", opts),
  // Housekeeping sweep across ALL finished runs: the report from the sweep that
  // ran at startup, and a way to run one now. Only removes what provably loses
  // nothing; whatever it kept comes back with a reason to show.
  getWorktreeSweepReport: () => ipcRenderer.invoke("worktrees:sweepReport"),
  sweepWorktrees: () => ipcRenderer.invoke("worktrees:sweep"),
  // Coach: commits since a project's PLAN.md/DECISIONS.md were last touched
  // (pane-header staleness nudge).
  docsStaleness: (cwd) => ipcRenderer.invoke("docs:staleness", { cwd }),
  staleProjects: (opts) => ipcRenderer.invoke("docs:staleProjects", opts || {}),
  parkDocsProject: (projectPath, parked) => ipcRenderer.invoke("docs:parkProject", { path: projectPath, parked }),
  parkedDocsProjects: () => ipcRenderer.invoke("docs:parkedProjects"),
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
