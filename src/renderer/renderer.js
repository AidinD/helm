const STATUS_LABEL = { waiting: "Needs you", active: "Working", idle: "Idle", archived: "Archived" };

let state = { sessions: [], config: { groups: [], viewMode: "simple" }, quota: null };
let searchTerm = "";
let selectedSessionId = null;
let focusedPaneIndex = 0;
let dragSessionId = null;
const paneLaunchMap = new Map(); // launchId -> paneIndex, cleared once a launch finishes
// Separate, never-cleared map so a late-arriving async event (the model-fit
// judge finishes well after "done") can still find its way back to the right
// pane even after paneLaunchMap already dropped that launchId.
const launchPaneHistory = new Map();
// App-wide, not per-pane — a background Task-tool subagent's lifecycle
// (task_started -> task_progress* -> task_updated/task_done), keyed by taskId.
// Schema verified via spike/test-task-events-shape.mjs before building this.
const backgroundTasks = new Map();
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed"]);
// Ad-hoc listeners for a specific launchId that isn't tied to a pane's normal
// display flow — used by "Summarize & carry over" to capture a resumed
// session's summary reply without it needing to occupy a visible pane.
const pendingLaunchCallbacks = new Map();

// Each pane: { sessionId, cliSessionId, cwd, title, turns, hiddenCount, loading,
//              busy, currentLaunchId, isOrchestrator, pendingImages }
let panes = [freshPane()];

function freshPane() {
  return {
    sessionId: null,
    cliSessionId: null,
    cwd: "",
    title: "New session",
    turns: [],
    hiddenCount: 0,
    loading: false,
    busy: false,
    currentLaunchId: null,
    stopRequested: false,
    isOrchestrator: false,
    pendingImages: [], // [{ path, name }] — pasted images attached to the next send
  };
}

function relTime(ts) {
  if (!ts) {
    return "unknown";
  }
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) {
    return "just now";
  }
  if (min < 60) {
    return `${min}m ago`;
  }
  const hr = Math.round(min / 60);
  if (hr < 24) {
    return `${hr}h ago`;
  }
  return `${Math.round(hr / 24)}d ago`;
}

function sortByAttention(list) {
  return [...list].sort((a, b) => {
    const s = (b.attentionScore || 0) - (a.attentionScore || 0);
    return s !== 0 ? s : b.lastActivityAt - a.lastActivityAt;
  });
}

function matchesSearch(session) {
  if (!searchTerm) {
    return true;
  }
  return session.title.toLowerCase().includes(searchTerm);
}

function sessionById(id) {
  return state.sessions.find((s) => s.sessionId === id);
}

// Sessions matched to the "Orchestrator" Jot list are Maestro-building work
// itself — tagged distinctly so it's never confused with regular project
// chats. The Jot-name match is fragile (breaks if that list is renamed), so
// it can also be set manually via right-click, independent of Jot.
function isOrchestratorSession(session) {
  const manual = state.config.manualMaestroSessions || [];
  return session.jot?.category === "Orchestrator" || manual.includes(session.sessionId);
}

// "Delete" a session from Maestro's own view — never touches the desktop
// app's real session files (that would risk destroying real conversation
// history). Purely hides it from the sidebar via config; restorable by
// editing config.json's hiddenSessions array.
async function removeFromMaestro(session) {
  const hidden = [...(state.config.hiddenSessions || []), session.sessionId];
  state.config = await window.maestro.setConfig({ hiddenSessions: hidden });
  refresh();
}

// Real archiving: flips isArchived in the desktop app's OWN local_*.json
// file (unlike removeFromMaestro, which only ever touches Maestro's config).
// Always a direct response to an explicit click — either the manual context
// menu action, or the user clicking a suggested-archive pill — never fired
// on a timer or any other unattended trigger.
async function archiveSession(session) {
  const res = await window.maestro.archiveSession(session.sessionId, true);
  if (!res.ok) {
    console.error("[maestro] archive failed:", res.error);
    showToast(`Couldn't archive "${session.title}": ${res.error}`);
    return;
  }
  refresh();
}

// Small transient message for failures with no natural home (e.g. no pane to
// write into) — not for routine feedback, just so a failure is never silent.
function showToast(text) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => el.remove(), 4000);
}

// Exclusive (radio-button, not checkbox) — per "shouldn't there just be ONE
// Maestro chat?" Marking a new one replaces any previous manual pick. The
// Jot-category auto-match can still independently tag more than one session
// (that reflects real list membership, not a manual choice), so this only
// governs the manual override.
async function toggleManualMaestroTag(session) {
  const current = state.config.manualMaestroSessions || [];
  const next = current.includes(session.sessionId) ? [] : [session.sessionId];
  state.config = await window.maestro.setConfig({ manualMaestroSessions: next });
  refresh();
}

// ============================== Context menu ==============================

function closeContextMenu() {
  document.getElementById("contextMenu").classList.add("hidden");
}

// Custom dropdown button reusing the context-menu popup, instead of a native
// <select> — Chromium's native select popup rendered white-on-white in this
// Electron build despite color-scheme:dark set three different ways, so this
// sidesteps it entirely by never using a native popup at all.
function dropdownPill(initialValue, options, onSelect) {
  const btn = document.createElement("button");
  btn.className = "meta-pill";
  btn.dataset.hasMenu = "1";
  btn.type = "button";

  const setValue = (value) => {
    btn.dataset.value = value;
    const opt = options.find((o) => o.value === value);
    btn.textContent = opt ? opt.label : value;
  };
  setValue(initialValue);

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const rect = btn.getBoundingClientRect();
    showContextMenu(
      rect.left,
      rect.bottom + 4,
      options.map((o) => ({
        label: o.label,
        onClick: () => {
          setValue(o.value);
          onSelect(o.value);
        },
      }))
    );
  });

  return { el: btn, setValue, get value() { return btn.dataset.value; } };
}

function showContextMenu(x, y, items) {
  const menu = document.getElementById("contextMenu");
  menu.innerHTML = "";
  menu.append(buildMenuItems(items));
  menu.classList.remove("hidden");
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + "px";
  menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + "px";
}

function buildMenuItems(items) {
  const frag = document.createDocumentFragment();
  for (const it of items) {
    if (it.sep) {
      const sep = document.createElement("div");
      sep.className = "sep";
      frag.append(sep);
      continue;
    }
    const el = document.createElement("div");
    el.className = "item" + (it.danger ? " danger" : "");
    el.textContent = it.label;
    if (it.submenu) {
      const sub = document.createElement("div");
      sub.className = "submenu";
      sub.append(buildMenuItems(it.submenu));
      el.append(sub);
    } else if (it.onClick) {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        closeContextMenu();
        it.onClick();
      });
    }
    frag.append(el);
  }
  return frag;
}

document.addEventListener("click", closeContextMenu);
document.addEventListener("contextmenu", (e) => {
  if (!e.target.closest("[data-has-menu]")) {
    closeContextMenu();
  }
});

// ============================== Category CRUD ==============================
//
// window.prompt()/confirm() turned out to be unreliable in this Electron
// build (renaming silently failed, and the OS cursor got stuck once). Rename
// is now inline double-click editing everywhere, and delete is a two-step
// context-menu confirm — no native synchronous dialogs anywhere.

function nextCategoryLabel() {
  const existing = new Set((state.config.groups || []).map((g) => g.label));
  if (!existing.has("New category")) {
    return "New category";
  }
  let n = 2;
  while (existing.has(`New category ${n}`)) {
    n++;
  }
  return `New category ${n}`;
}

async function createCategory() {
  const groups = [...(state.config.groups || []), { label: nextCategoryLabel(), sessionIds: [], collapsed: false }];
  state.config = await window.maestro.setConfig({ groups });
  renderSidebar();
}

async function renameCategoryTo(oldLabel, newLabel) {
  if (!newLabel || !newLabel.trim() || newLabel === oldLabel) {
    return;
  }
  const groups = (state.config.groups || []).map((g) => (g.label === oldLabel ? { ...g, label: newLabel.trim() } : g));
  state.config = await window.maestro.setConfig({ groups });
  renderSidebar();
}

async function deleteCategory(label) {
  const groups = (state.config.groups || []).filter((g) => g.label !== label);
  state.config = await window.maestro.setConfig({ groups });
  renderSidebar();
}

// Display-only rename — never writes to the desktop app's own session files,
// so it can't corrupt live state there; it just overrides what Maestro shows.
async function renameSessionTo(session, newTitle) {
  if (!newTitle || !newTitle.trim() || newTitle === session.title) {
    return;
  }
  const titleOverrides = { ...(state.config.titleOverrides || {}), [session.sessionId]: newTitle.trim() };
  state.config = await window.maestro.setConfig({ titleOverrides });
  refresh();
}

// Replaces `labelEl` with a text input pre-filled with its current text.
// Enter/blur commits via onCommit(value); Escape cancels. Restores the
// original element afterward either way — this never leaves a stray input.
function makeInlineEditable(labelEl, currentValue, onCommit) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "inline-edit";
  input.value = currentValue;
  labelEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (commit) => {
    if (done) {
      return;
    }
    done = true;
    input.replaceWith(labelEl);
    if (commit) {
      onCommit(input.value.trim());
    }
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      finish(true);
    } else if (e.key === "Escape") {
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("dblclick", (e) => e.stopPropagation());
}

// ============================== Drag and drop (VS Code style) ==============================

async function moveSessionToGroup(sessionId, targetLabel, insertBeforeId) {
  const groups = (state.config.groups || []).map((g) => ({
    ...g,
    sessionIds: (g.sessionIds || []).filter((id) => id !== sessionId),
  }));
  if (targetLabel) {
    const target = groups.find((g) => g.label === targetLabel);
    if (target) {
      const idx = insertBeforeId ? target.sessionIds.indexOf(insertBeforeId) : -1;
      if (idx === -1) {
        target.sessionIds.push(sessionId);
      } else {
        target.sessionIds.splice(idx, 0, sessionId);
      }
    }
  }
  state.config = await window.maestro.setConfig({ groups });
  renderSidebar();
}

function clearInsertionLines(container) {
  container.querySelectorAll(".insertion-line").forEach((el) => el.remove());
}

// ============================== Row + section rendering ==============================

// The orchestrator's own chat — one static, prominent card, not a row inside
// an accordion. Per feedback: it's special, always exists, and you shouldn't
// need to think about which group it's in.
function orchestratorCardEl(session) {
  const card = document.createElement("div");
  card.className = "orchestrator-card" + (session.sessionId === selectedSessionId ? " selected" : "");

  const titleLine = document.createElement("div");
  titleLine.className = "orchestrator-card-title-line";
  const badge = document.createElement("span");
  badge.className = "orchestrator-card-badge";
  badge.textContent = "◆";
  const title = document.createElement("span");
  title.className = "orchestrator-card-title";
  title.textContent = session.title;
  const dot = document.createElement("span");
  dot.className = `status-dot ${session.status}`;
  titleLine.append(badge, title, dot);
  card.append(titleLine);

  if (session.jot) {
    const meta = document.createElement("div");
    meta.className = "orchestrator-card-meta";
    const parts = [];
    if (session.jot.review > 0) {
      parts.push(`${session.jot.review} review`);
    }
    if (session.jot.inProgress > 0) {
      parts.push(`${session.jot.inProgress} wip`);
    }
    if (session.jot.open > 0) {
      parts.push(`${session.jot.open} open`);
    }
    meta.textContent = parts.length ? parts.join(" · ") : "up to date";
    card.append(meta);
  }

  card.addEventListener("click", () => openSessionInPane(session, focusedPaneIndex));
  title.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    makeInlineEditable(title, session.title, (v) => renameSessionTo(session, v));
  });
  card.dataset.hasMenu = "1";
  card.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, [
      { label: "Open here", onClick: () => openSessionInPane(session, focusedPaneIndex) },
      { label: "Open in split pane", onClick: () => openSessionInPane(session, focusedPaneIndex === 0 ? 1 : 0, true) },
      { label: "Rename chat (or double-click it)", onClick: () => makeInlineEditable(title, session.title, (v) => renameSessionTo(session, v)) },
      { sep: true },
      { label: "Unmark as Maestro chat", onClick: () => toggleManualMaestroTag(session) },
    ]);
  });

  return card;
}

function rowEl(session) {
  const row = document.createElement("div");
  row.className = "row" + (session.sessionId === selectedSessionId ? " selected" : "");
  row.draggable = true;
  row.dataset.sessionId = session.sessionId;
  row.dataset.hasMenu = "1";

  const titleLine = document.createElement("div");
  titleLine.className = "row-title-line";
  const dot = document.createElement("span");
  dot.className = `status-dot ${session.status}`;
  const title = document.createElement("span");
  title.className = "row-title";
  title.textContent = session.title;
  title.title = session.title;
  titleLine.append(dot, title);
  if (isOrchestratorSession(session)) {
    const tag = document.createElement("span");
    tag.className = "maestro-tag";
    tag.textContent = "◆";
    tag.title = "Maestro orchestrator work";
    titleLine.append(tag);
  }
  row.append(titleLine);

  const meta = document.createElement("div");
  meta.className = "row-meta";
  meta.append(spanEl(STATUS_LABEL[session.status] || session.status), spanEl(relTime(session.lastActivityAt)));
  if (session.model) {
    meta.append(spanEl(session.model.replace("claude-", "")));
  }
  row.append(meta);

  if (session.jot) {
    const j = document.createElement("div");
    j.className = "row-jot" + (session.jot.review > 0 ? " review" : "");
    const parts = [];
    if (session.jot.review > 0) {
      parts.push(`${session.jot.review} review`);
    }
    if (session.jot.inProgress > 0) {
      parts.push(`${session.jot.inProgress} wip`);
    }
    if (session.jot.open > 0) {
      parts.push(`${session.jot.open} open`);
    }
    j.textContent = parts.length ? `${session.jot.category} · ${parts.join(" · ")}` : session.jot.category;
    row.append(j);
  }

  // "Orchestrator proposes, you approve" — only ever a suggestion. Clicking
  // this pill IS the approval step; nothing archives without it. Only shown
  // for genuinely idle sessions with no open Jot work, and never for a
  // Maestro-building session (idle between long autonomous stretches doesn't
  // mean done).
  const hasOpenJotWork =
    session.jot && (session.jot.review > 0 || session.jot.inProgress > 0 || session.jot.open > 0);
  if (
    state.config.archiveSuggestions?.enabled === true &&
    session.status === "idle" &&
    !hasOpenJotWork &&
    !isOrchestratorSession(session)
  ) {
    const suggest = document.createElement("button");
    suggest.type = "button";
    suggest.className = "archive-suggest-pill";
    suggest.textContent = "Archive?";
    suggest.title = "Suggested: this session looks idle with no open Jot work. Click to archive.";
    suggest.addEventListener("click", (e) => {
      e.stopPropagation();
      archiveSession(session);
    });
    row.append(suggest);
  }

  // Single click opens the session, but only after a short delay so a second
  // click (making this a double-click) can cancel it in favor of renaming.
  row.addEventListener("click", () => {
    clearTimeout(row._openTimer);
    row._openTimer = setTimeout(() => openSessionInPane(session, focusedPaneIndex), 250);
  });
  title.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    clearTimeout(row._openTimer);
    makeInlineEditable(title, session.title, (v) => renameSessionTo(session, v));
  });

  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const x = e.clientX;
    const y = e.clientY;
    const groupLabels = (state.config.groups || []).map((g) => g.label);
    showContextMenu(x, y, [
      { label: "Open here", onClick: () => openSessionInPane(session, focusedPaneIndex) },
      { label: "Open in split pane", onClick: () => openSessionInPane(session, focusedPaneIndex === 0 ? 1 : 0, true) },
      { label: "Rename chat (or double-click it)", onClick: () => makeInlineEditable(title, session.title, (v) => renameSessionTo(session, v)) },
      {
        label: isOrchestratorSession(session) ? "Unmark as Maestro chat" : "Mark as Maestro chat",
        onClick: () => toggleManualMaestroTag(session),
      },
      {
        label: "Summarize & carry over to new chat",
        onClick: () => summarizeAndCarryOver(session),
      },
      { sep: true },
      {
        label: "Move to category",
        submenu: [
          ...groupLabels.map((label) => ({ label, onClick: () => moveSessionToGroup(session.sessionId, label) })),
          { label: "Unsorted", onClick: () => moveSessionToGroup(session.sessionId, null) },
        ],
      },
      { sep: true },
      {
        label: "Archive session",
        danger: true,
        onClick: () => {
          // Re-opens with an explicit confirm step (no native window.confirm()
          // — unreliable in this build) since this writes to the desktop
          // app's OWN session file, not just Maestro's local config.
          showContextMenu(x, y, [
            { label: `Confirm archive "${session.title}"`, danger: true, onClick: () => archiveSession(session) },
          ]);
        },
      },
      {
        label: "Remove from Maestro",
        danger: true,
        onClick: () => removeFromMaestro(session),
      },
    ]);
  });

  row.addEventListener("dragstart", (e) => {
    dragSessionId = session.sessionId;
    row.classList.add("dragging");
    e.dataTransfer.setData("text/session-id", session.sessionId);
    e.dataTransfer.effectAllowed = "move";
  });
  row.addEventListener("dragend", () => {
    row.classList.remove("dragging");
    document.querySelectorAll(".insertion-line").forEach((el) => el.remove());
  });

  // VS Code-style: hovering the top/bottom half of a row shows an insertion
  // line there instead of just highlighting the whole list.
  row.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const list = row.parentElement;
    clearInsertionLines(list);
    const rect = row.getBoundingClientRect();
    const before = e.clientY - rect.top < rect.height / 2;
    const line = document.createElement("div");
    line.className = "insertion-line";
    if (before) {
      row.before(line);
    } else {
      row.after(line);
    }
  });
  row.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const list = row.parentElement;
    const groupLabel = list.dataset.groupLabel;
    const insertBeforeId = list.dataset.groupLabel ? nextRowSessionId(row, e) : null;
    clearInsertionLines(list);
    const sid = e.dataTransfer.getData("text/session-id");
    if (sid) {
      moveSessionToGroup(sid, groupLabel || null, insertBeforeId);
    }
  });

  return row;
}

function nextRowSessionId(row, e) {
  const rect = row.getBoundingClientRect();
  const before = e.clientY - rect.top < rect.height / 2;
  if (before) {
    return row.dataset.sessionId;
  }
  const next = row.nextElementSibling;
  return next && next.dataset.sessionId ? next.dataset.sessionId : null;
}

function spanEl(text) {
  const el = document.createElement("span");
  el.textContent = text;
  return el;
}

// ============================== Fas 2: summarize & carry over ==============================
// Lets a session be archived without losing the thread: resume it once with a
// hidden "summarize yourself" prompt, then seed a fresh session's composer
// with that summary. Never touches the original session or any real file —
// purely additive (one more turn on the old session, one new draft prompt).

const CARRY_OVER_PROMPT =
  "Please write a concise handoff summary of this entire conversation so a " +
  "brand-new session could pick up seamlessly: current state, key decisions " +
  "made and why, and concrete next steps. This will be pasted as the opening " +
  "message of a new session, so write it as context FOR that new session, " +
  "not as a message to me.";

function summarizeSession(session) {
  return new Promise(async (resolve) => {
    const res = await window.maestro.startSession({
      cwd: session.cwd,
      prompt: CARRY_OVER_PROMPT,
      model: "claude-sonnet-5",
      effort: "medium",
      resumeSessionId: session.cliSessionId || session.sessionId,
    });
    if (!res.ok) {
      resolve({ error: res.error });
      return;
    }
    pendingLaunchCallbacks.set(res.launchId, {
      assistantText: "",
      onDone: (text, error) => resolve(error ? { error } : { text }),
    });
  });
}

// Prefers an existing empty pane over forcing a new split, so this doesn't
// clutter the workspace when one is already free.
function pickDraftTargetPane() {
  const emptyIndex = panes.findIndex((p) => !p.sessionId && p.turns.length === 0 && !p.busy);
  if (emptyIndex !== -1) {
    return { index: emptyIndex, addedPane: false };
  }
  if (panes.length < 2) {
    panes.push(freshPane());
    return { index: panes.length - 1, addedPane: true };
  }
  return { index: focusedPaneIndex, addedPane: false };
}

function openFreshDraftInPane(cwd, draftText) {
  const { index, addedPane } = pickDraftTargetPane();
  panes[index] = { ...freshPane(), cwd: cwd || "" };
  focusedPaneIndex = index;
  if (addedPane) {
    renderWorkspace(); // handles the .split class itself; pane count changed
  } else {
    renderSinglePane(index);
  }
  const paneEl = document.querySelector(`.pane[data-pane="${index}"]`);
  const promptEl = paneEl?.querySelector(".pane-composer textarea");
  if (promptEl) {
    promptEl.value = draftText;
    promptEl.focus();
    promptEl.dispatchEvent(new Event("input"));
  }
  return index;
}

async function summarizeAndCarryOver(session) {
  const statusIndex = focusedPaneIndex;
  const statusPane = panes[statusIndex]; // identity check below: focus/reset can change during the await
  setPaneBusyUIRaw(statusIndex, `● Summarizing "${session.title}"…`);
  const result = await summarizeSession(session);
  if (panes[statusIndex] === statusPane) {
    setPaneBusyUIRaw(statusIndex, "");
  }
  if (result.error) {
    openFreshDraftInPane(session.cwd, `⚠ Failed to summarize: ${result.error}`);
    return;
  }
  const draft = `Continuing from "${session.title}". Summary of prior context:\n\n${result.text.trim()}\n\nPlease continue from here.`;
  openFreshDraftInPane(session.cwd, draft);
}

// Sets just the status text on whichever pane is currently focused, without
// requiring that pane to be running its own launch (setPaneBusyUI assumes
// pane.busy reflects THIS pane's own send, which isn't true while summarizing
// happens via a detached background launch).
function setPaneBusyUIRaw(index, statusText) {
  const paneEl = document.querySelector(`.pane[data-pane="${index}"]`);
  const status = paneEl?.querySelector(".pane-status");
  if (status) {
    status.textContent = statusText || "";
  }
}

function openSessionInPane(session, paneIndex, forceSplit) {
  focusedPaneIndex = paneIndex;
  selectedSessionId = session.sessionId;
  const addedPane = forceSplit && panes.length < 2;
  if (addedPane) {
    panes.push(freshPane());
  }
  panes[paneIndex] = {
    ...freshPane(),
    sessionId: session.sessionId,
    cliSessionId: session.cliSessionId || session.sessionId,
    cwd: session.cwd || "",
    title: session.title,
    loading: true,
    isOrchestrator: isOrchestratorSession(session),
  };
  if (addedPane) {
    renderWorkspace(); // pane count changed — full rebuild is unavoidable here
  } else {
    renderSinglePane(paneIndex); // leaves any typing in the other pane intact
  }
  renderSidebar();
  loadTranscriptInto(paneIndex);
}

async function loadTranscriptInto(paneIndex) {
  const pane = panes[paneIndex];
  if (!pane || !pane.cliSessionId) {
    return;
  }
  const { turns, hiddenCount } = await window.maestro.getTranscript({
    cliSessionId: pane.cliSessionId,
    sessionId: pane.sessionId,
  });
  if (panes[paneIndex] !== pane) {
    return; // pane was reassigned while loading
  }
  pane.turns = turns;
  pane.hiddenCount = hiddenCount || 0;
  pane.loading = false;
  renderPane(paneIndex);
}

// ============================== Sidebar sections ==============================

function sectionEl({ label, sessions, collapsed, pinned, droppable, emptyHint, isCategory }) {
  const wrap = document.createElement("div");
  wrap.className = "section";

  const hasActiveSession = sessions.some((s) => s.sessionId === selectedSessionId);
  const head = document.createElement("div");
  head.className =
    "section-head" +
    (pinned ? " attention-head" : "") +
    (collapsed ? " collapsed" : "") +
    (isCategory && hasActiveSession ? " active-category" : "");
  const caret = document.createElement("span");
  caret.className = "caret";
  caret.textContent = "▾";
  const name = document.createElement("span");
  name.textContent = label;
  const count = document.createElement("span");
  count.className = "section-count";
  count.textContent = sessions.length;
  head.append(caret, name, count);

  const list = document.createElement("div");
  list.className = "section-list" + (collapsed ? " hidden" : "");
  if (droppable && droppable !== "unsorted") {
    list.dataset.groupLabel = label;
  }

  if (sessions.length === 0 && emptyHint) {
    const hint = document.createElement("div");
    hint.className = "empty-hint";
    hint.textContent = emptyHint;
    list.append(hint);
  } else {
    // Categories keep whatever order the user dragged them into (the actual
    // bug: this used to always re-sort by attention, so a manual reorder
    // changed the underlying data but the display silently overrode it every
    // render). Only the computed spotlight/list views sort by attention.
    const ordered = isCategory ? sessions : sortByAttention(sessions);
    ordered.forEach((s) => list.append(rowEl(s)));
  }

  // Same click-then-dblclick-cancels debounce as session rows, so a double
  // click on the label renames instead of just toggling collapse twice.
  head.addEventListener("click", () => {
    clearTimeout(head._toggleTimer);
    head._toggleTimer = setTimeout(() => {
      head.classList.toggle("collapsed");
      list.classList.toggle("hidden");
      if (isCategory) {
        persistCollapsed(label, head.classList.contains("collapsed"));
      }
    }, 250);
  });

  if (isCategory) {
    name.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      clearTimeout(head._toggleTimer);
      makeInlineEditable(name, label, (v) => renameCategoryTo(label, v));
    });
    head.dataset.hasMenu = "1";
    head.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const x = e.clientX;
      const y = e.clientY;
      showContextMenu(x, y, [
        { label: "Rename category (or double-click it)", onClick: () => makeInlineEditable(name, label, (v) => renameCategoryTo(label, v)) },
        {
          label: "Delete category",
          danger: true,
          onClick: () => {
            // Re-opens the menu with an explicit confirm step instead of a
            // native window.confirm() dialog (unreliable in this build).
            showContextMenu(x, y, [
              { label: `Confirm delete "${label}"`, danger: true, onClick: () => deleteCategory(label) },
            ]);
          },
        },
      ]);
    });
    // Dropping directly on the header appends to the end of that category.
    head.addEventListener("dragover", (e) => {
      e.preventDefault();
      head.classList.add("drag-over");
    });
    head.addEventListener("dragleave", () => head.classList.remove("drag-over"));
    head.addEventListener("drop", (e) => {
      e.preventDefault();
      head.classList.remove("drag-over");
      const sid = e.dataTransfer.getData("text/session-id");
      if (sid) {
        moveSessionToGroup(sid, label, null);
      }
    });
  }

  if (droppable) {
    wireListDropZone(list, droppable === "unsorted" ? null : label);
  }

  wrap.append(head, list);
  return wrap;
}

function wireListDropZone(el, targetLabel) {
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (e.target === el) {
      el.classList.add("drag-over");
    }
  });
  el.addEventListener("dragleave", (e) => {
    if (e.target === el) {
      el.classList.remove("drag-over");
    }
  });
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("drag-over");
    if (e.target !== el) {
      return; // a row's own drop handler already dealt with it
    }
    const sid = e.dataTransfer.getData("text/session-id");
    if (sid) {
      moveSessionToGroup(sid, targetLabel, null);
    }
  });
}

async function persistCollapsed(groupLabel, collapsed) {
  const groups = (state.config.groups || []).map((g) => (g.label === groupLabel ? { ...g, collapsed } : g));
  state.config = await window.maestro.setConfig({ groups });
}

function renderSidebar() {
  const body = document.getElementById("sidebarBody");
  body.innerHTML = "";

  const hiddenIds = new Set(state.config.hiddenSessions || []);
  const visible = state.sessions
    .filter((s) => !s.isArchived)
    .filter((s) => !hiddenIds.has(s.sessionId))
    .filter(matchesSearch);

  if ((state.config.sidebarMode || "smart") === "list") {
    body.append(
      sectionEl({ label: "All sessions", sessions: visible, collapsed: false, droppable: false })
    );
    return;
  }

  // The orchestrator chat is special, not just another group: one static,
  // prominent card at the top — never duplicated into Needs-attention, its
  // original category, or Unsorted (per feedback that a plain accordion
  // section made it look like it belonged in multiple places at once).
  const maestroSessions = visible.filter(isOrchestratorSession);
  const maestroIds = new Set(maestroSessions.map((s) => s.sessionId));
  if (maestroSessions.length > 0) {
    body.append(orchestratorCardEl(sortByAttention(maestroSessions)[0]));
  }

  const attention = visible.filter((s) => s.needsAttention && !maestroIds.has(s.sessionId));
  if (attention.length > 0) {
    body.append(
      sectionEl({ label: "Needs your attention", sessions: attention, collapsed: false, pinned: true, droppable: false })
    );
  }

  const groups = state.config.groups || [];
  const grouped = new Set(maestroIds);
  for (const group of groups) {
    const members = (group.sessionIds || [])
      .map(sessionById)
      .filter(Boolean)
      .filter((s) => !s.isArchived)
      .filter(matchesSearch)
      .filter((s) => !maestroIds.has(s.sessionId));
    (group.sessionIds || []).forEach((id) => grouped.add(id));
    body.append(
      sectionEl({
        label: group.label,
        sessions: members,
        collapsed: !!group.collapsed,
        droppable: true,
        isCategory: true,
        emptyHint: "Drag or move sessions here",
      })
    );
  }

  const unsorted = visible.filter((s) => !grouped.has(s.sessionId));
  body.append(sectionEl({ label: "Unsorted", sessions: unsorted, collapsed: false, droppable: "unsorted" }));
}

// ============================== Workspace (panes) ==============================

// Minimal, safe markdown: bold, inline code, fenced code blocks, "- " lists.
// Never uses innerHTML with model text — everything goes through
// createElement/textContent so there is no injection surface.
function renderMarkdownInto(container, text) {
  const segments = text.split(/```([\s\S]*?)```/);
  segments.forEach((segment, i) => {
    if (i % 2 === 1) {
      const pre = document.createElement("pre");
      pre.className = "md-code-block";
      pre.textContent = segment.replace(/^[ \t]*\S*\n/, "");
      container.append(pre);
    } else if (segment) {
      renderTextBlock(container, segment);
    }
  });
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

// Splits a non-code segment into GFM table blocks (rendered as real <table>
// elements, matching the desktop app) and plain lines.
function renderTextBlock(container, text) {
  const lines = text.split("\n");
  let i = 0;
  let plainRun = [];
  const flushPlain = () => {
    if (plainRun.length) {
      renderInlineLines(container, plainRun.join("\n"));
      plainRun = [];
    }
  };
  while (i < lines.length) {
    if (TABLE_ROW.test(lines[i]) && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1])) {
      flushPlain();
      const tableLines = [lines[i]];
      let j = i + 2;
      while (j < lines.length && TABLE_ROW.test(lines[j])) {
        tableLines.push(lines[j]);
        j++;
      }
      container.append(tableEl(lines[i], tableLines.slice(1)));
      i = j;
    } else {
      plainRun.push(lines[i]);
      i++;
    }
  }
  flushPlain();
}

function tableCells(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function tableEl(headerLine, bodyLines) {
  const table = document.createElement("table");
  table.className = "md-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  tableCells(headerLine).forEach((cell) => {
    const th = document.createElement("th");
    th.append(...inlineFormat(cell));
    headRow.append(th);
  });
  thead.append(headRow);
  const tbody = document.createElement("tbody");
  bodyLines.forEach((line) => {
    const tr = document.createElement("tr");
    tableCells(line).forEach((cell) => {
      const td = document.createElement("td");
      td.append(...inlineFormat(cell));
      tr.append(td);
    });
    tbody.append(tr);
  });
  table.append(thead, tbody);
  return table;
}

function renderInlineLines(container, text) {
  const lines = text.split("\n");
  lines.forEach((line, idx) => {
    const listMatch = /^\s*[-*]\s+(.*)$/.exec(line);
    if (listMatch) {
      const li = document.createElement("div");
      li.className = "md-li";
      li.append(document.createTextNode("• "), ...inlineFormat(listMatch[1]));
      container.append(li);
    } else {
      const lineSpan = document.createElement("span");
      lineSpan.append(...inlineFormat(line));
      container.append(lineSpan);
    }
    if (idx < lines.length - 1) {
      container.append(document.createElement("br"));
    }
  });
}

function inlineFormat(text) {
  const nodes = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let m;
  while ((m = regex.exec(text))) {
    if (m.index > lastIndex) {
      nodes.push(document.createTextNode(text.slice(lastIndex, m.index)));
    }
    const token = m[0];
    if (token.startsWith("**")) {
      const b = document.createElement("strong");
      b.textContent = token.slice(2, -2);
      nodes.push(b);
    } else {
      const c = document.createElement("code");
      c.textContent = token.slice(1, -1);
      nodes.push(c);
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    nodes.push(document.createTextNode(text.slice(lastIndex)));
  }
  return nodes;
}

const MODEL_FIT_ICON = { too_weak: "⬆", appropriate: "⚖", too_strong: "⬇" };
const MODEL_FIT_LABEL = { too_weak: "Underpowered", appropriate: "Good fit", too_strong: "Overkill" };

function turnEl(turn) {
  if (turn.kind === "tool_result") {
    const el = document.createElement("div");
    el.className = "turn-tool-result";
    el.textContent = turn.text;
    return el;
  }
  if (turn.kind === "task_notification") {
    return taskNotificationEl(turn.text);
  }
  const wrap = document.createElement("div");
  wrap.className = "turn " + turn.role;
  const bubble = document.createElement("div");
  bubble.className = "turn-bubble";
  if (turn.role === "assistant") {
    renderMarkdownInto(bubble, turn.text);
  } else {
    bubble.textContent = turn.text;
  }
  wrap.append(bubble);

  if (turn.role === "assistant") {
    const copyBtn = document.createElement("button");
    copyBtn.className = "copy-btn";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", () => {
      window.maestro.copyToClipboard(turn.text);
      copyBtn.textContent = "Copied";
      copyBtn.classList.add("copied");
      setTimeout(() => {
        copyBtn.textContent = "Copy";
        copyBtn.classList.remove("copied");
      }, 1200);
    });
    wrap.append(copyBtn);
  }

  return wrap;
}

// A run of consecutive tool calls collapses into ONE plain, unboxed
// "Used N tools" line — matching the desktop app's flat "Used 3 tools ›" /
// "Searched code ›" style — instead of a separate bordered box per call
// (which read as heavy/boxy per feedback comparing the two side by side).
// A background task/subagent completion, delivered as raw <task-notification>
// XML — shown as a compact expandable line (like a tool call), not as a
// normal chat bubble, since the captain didn't actually type this.
function taskNotificationEl(rawText) {
  const summaryMatch = /<summary>([\s\S]*?)<\/summary>/.exec(rawText);
  const statusMatch = /<status>([\s\S]*?)<\/status>/.exec(rawText);
  const status = statusMatch ? statusMatch[1].trim() : "unknown";
  const summaryText = summaryMatch ? summaryMatch[1].trim() : "Background task";
  const icon = status === "completed" ? "✓" : status === "failed" ? "✗" : "◔";

  const details = document.createElement("details");
  details.className = "tool-group";
  const summary = document.createElement("summary");
  summary.textContent = `${icon} Background task: ${truncateText(summaryText, 100)}`;
  details.append(summary);
  const pre = document.createElement("pre");
  pre.className = "tool-call-output";
  pre.textContent = rawText;
  details.append(pre);
  return details;
}

function truncateText(text, max) {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function toolGroupEl(pairs) {
  const details = document.createElement("details");
  details.className = "tool-group";
  const summary = document.createElement("summary");
  const names = pairs.map((p) => p.useTurn.toolName);
  const shown = names.slice(0, 3).join(", ");
  const extra = names.length > 3 ? ` +${names.length - 3} more` : "";
  summary.textContent =
    (pairs.length === 1 ? "Used 1 tool" : `Used ${pairs.length} tools`) + `: ${shown}${extra}`;
  details.append(summary);

  const list = document.createElement("div");
  list.className = "tool-group-list";
  pairs.forEach(({ useTurn, resultTurn }) => {
    const item = document.createElement("details");
    item.className = "tool-call-item";
    const itemSummary = document.createElement("summary");
    itemSummary.textContent = `${useTurn.toolName}${useTurn.toolInput ? " · " + useTurn.toolInput : ""}`;
    item.append(itemSummary);
    if (resultTurn) {
      const pre = document.createElement("pre");
      pre.className = "tool-call-output";
      pre.textContent = resultTurn.text;
      item.append(pre);
    }
    list.append(item);
  });
  details.append(list);
  return details;
}

function appendTurns(scroll, turns) {
  let i = 0;
  while (i < turns.length) {
    if (turns[i].kind === "tool_use") {
      const pairs = [];
      while (i < turns.length && turns[i].kind === "tool_use") {
        const useTurn = turns[i];
        const next = turns[i + 1];
        const resultTurn = next && next.kind === "tool_result" ? next : null;
        pairs.push({ useTurn, resultTurn });
        i += resultTurn ? 2 : 1;
      }
      scroll.append(toolGroupEl(pairs));
    } else {
      scroll.append(turnEl(turns[i]));
      i++;
    }
  }
}

function renderPane(index) {
  const paneEl = document.querySelector(`.pane[data-pane="${index}"]`);
  if (!paneEl) {
    return;
  }
  const pane = panes[index];
  const scroll = paneEl.querySelector(".pane-scroll");
  scroll.innerHTML = "";

  if (pane.loading) {
    const loading = document.createElement("div");
    loading.className = "pane-empty";
    loading.textContent = "Loading history…";
    scroll.append(loading);
    return;
  }

  if (pane.hiddenCount > 0) {
    const btn = document.createElement("button");
    btn.className = "load-earlier";
    btn.textContent = `Show ${pane.hiddenCount} earlier messages`;
    btn.addEventListener("click", async () => {
      const { turns } = await window.maestro.getTranscript({
        cliSessionId: pane.cliSessionId,
        sessionId: pane.sessionId,
      });
      pane.turns = turns;
      pane.hiddenCount = 0;
      renderPane(index);
    });
    scroll.append(btn);
  }

  if (pane.turns.length === 0 && pane.hiddenCount === 0) {
    const empty = document.createElement("div");
    empty.className = "pane-empty";
    empty.textContent = "No history yet — start typing below.";
    scroll.append(empty);
  } else {
    appendTurns(scroll, pane.turns);
    wireEditableUserTurns(index, scroll);
  }
  scroll.scrollTop = scroll.scrollHeight;
}

// Double-click ANY past user message to copy it back into the prompt box for
// editing + resend. Does not alter history — the CLI can't retract a turn via
// --resume, so this is "edit and send again" (appends as a new turn), not a
// true rewind/branch like the desktop app's retry icon.
function wireEditableUserTurns(index, scroll) {
  scroll.querySelectorAll(".turn.user .turn-bubble").forEach((bubble) => {
    bubble.classList.add("editable");
    bubble.title = "Double-click to edit and resend";
    bubble.addEventListener("dblclick", () => {
      const paneEl = document.querySelector(`.pane[data-pane="${index}"]`);
      const promptEl = paneEl?.querySelector(".pane-composer textarea");
      if (promptEl) {
        promptEl.value = bubble.textContent;
        promptEl.focus();
        promptEl.dispatchEvent(new Event("input"));
      }
    });
  });
}

function paneHeaderEl(index) {
  const pane = panes[index];
  const header = document.createElement("div");
  header.className = "pane-header";
  const title = document.createElement("span");
  title.textContent = pane.title || "New session";
  header.append(title);
  if (pane.isOrchestrator) {
    const tag = document.createElement("span");
    tag.className = "maestro-tag";
    tag.textContent = "◆ Maestro";
    tag.title = "This is Maestro-building work, not a regular project chat";
    header.append(tag);
  }
  if (pane.cwd) {
    const sub = document.createElement("span");
    sub.className = "pane-sub";
    sub.textContent = pane.cwd;
    header.append(sub);
  }
  const actions = document.createElement("span");
  actions.className = "pane-actions";
  if (pane.sessionId) {
    const resetBtn = document.createElement("button");
    resetBtn.className = "icon-btn";
    resetBtn.textContent = "+";
    resetBtn.title = "Start a new chat in this pane";
    resetBtn.addEventListener("click", () => {
      panes[index] = freshPane();
      if (selectedSessionId === pane.sessionId) {
        selectedSessionId = null;
      }
      renderSinglePane(index);
      renderSidebar();
    });
    actions.append(resetBtn);
  }
  if (index === 1) {
    const close = document.createElement("button");
    close.className = "pane-close icon-btn";
    close.textContent = "✕";
    close.title = "Close split";
    close.addEventListener("click", () => {
      // If this pane has a live launch, stop it and drop its map entries
      // before discarding the pane — otherwise the process keeps running
      // with no UI left able to show its completion or stop it.
      const closingPane = panes[1];
      if (closingPane?.busy && closingPane.currentLaunchId) {
        window.maestro.stopSession(closingPane.currentLaunchId);
        paneLaunchMap.delete(closingPane.currentLaunchId);
      }
      panes = [panes[0]];
      document.getElementById("workspace").classList.remove("split");
      renderWorkspace();
    });
    actions.append(close);
  }
  header.append(actions);
  return header;
}

function paneComposerEl(index) {
  const pane = panes[index];
  const wrap = document.createElement("div");
  wrap.className = "pane-composer";

  // Status lives right above the composer (was in the header, easy to miss
  // while your eyes are on the prompt box) — visible exactly where you're
  // already looking while waiting for a reply.
  const status = document.createElement("div");
  status.className = "pane-status";
  wrap.append(status);

  // One unified rounded "shell" (textarea on top, controls below), closer to
  // the desktop app's single-pill composer instead of stacked separate fields.
  const shell = document.createElement("div");
  shell.className = "composer-shell";

  const promptEl = document.createElement("textarea");
  promptEl.rows = 2;
  promptEl.placeholder = pane.sessionId ? `Continue "${pane.title}"…` : "What should this session do?";
  shell.append(promptEl);

  // Pasted-image chips, shown between the textarea and the control row.
  // Populated by the paste handler below, cleared on send.
  const attachmentsEl = document.createElement("div");
  attachmentsEl.className = "composer-attachments";
  shell.append(attachmentsEl);
  function renderAttachments() {
    attachmentsEl.innerHTML = "";
    attachmentsEl.style.display = pane.pendingImages.length ? "flex" : "none";
    pane.pendingImages.forEach((img, i) => {
      const chip = document.createElement("span");
      chip.className = "attachment-chip";
      chip.textContent = "🖼 " + img.name;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "attachment-remove";
      remove.textContent = "×";
      remove.title = "Remove attachment";
      remove.addEventListener("click", () => {
        pane.pendingImages.splice(i, 1);
        renderAttachments();
      });
      chip.append(remove);
      attachmentsEl.append(chip);
    });
  }
  renderAttachments();

  // Saves a pasted image to disk and attaches its path — Claude Code's own
  // Read tool picks up an image from a plain file-path mention in the prompt
  // text, verified in spike/test-image-via-path.mjs. No base64-in-stream-json,
  // no SDK migration; the existing -p/--resume flow is untouched.
  promptEl.addEventListener("paste", async (e) => {
    const items = e.clipboardData?.items;
    if (!items) {
      return;
    }
    const imageItems = Array.from(items).filter((it) => it.type && it.type.startsWith("image/"));
    if (imageItems.length === 0) {
      return;
    }
    e.preventDefault();
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) {
        continue;
      }
      const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const base64 = dataUrl.split(",")[1] || "";
      const res = await window.maestro.saveImage(base64, ext);
      // Pane may have been reset/reused while the save round-tripped through
      // main — don't attach a stale paste to whatever now occupies this slot.
      if (res.ok && panes[index] === pane) {
        pane.pendingImages.push({ path: res.path, name: file.name || `pasted.${ext}` });
        renderAttachments();
      }
    }
  });

  const controls = document.createElement("div");
  controls.className = "composer-controls";

  const cwdInput = document.createElement("input");
  cwdInput.type = "text";
  cwdInput.className = "cwd-input";
  cwdInput.placeholder = "Repo folder (required to send)";
  cwdInput.value = pane.cwd || "";
  cwdInput.title = pane.cwd || "Repo folder this session roots in";
  cwdInput.addEventListener("input", (e) => {
    pane.cwd = e.target.value;
    cwdInput.title = e.target.value;
    cwdInput.classList.remove("cwd-missing");
  });
  const pickBtn = document.createElement("button");
  pickBtn.className = "icon-btn";
  pickBtn.textContent = "…";
  pickBtn.title = "Pick repo folder";
  pickBtn.addEventListener("click", async () => {
    const folder = await window.maestro.pickFolder();
    if (folder) {
      pane.cwd = folder;
      cwdInput.value = folder;
      cwdInput.title = folder;
    }
  });

  // "Auto" lets Maestro pick per-prompt (resolved at send time from the
  // current text); picking a specific value locks it in and stops the
  // suggestion from silently overriding your choice.
  const modelDD = dropdownPill(
    "auto",
    [
      { value: "auto", label: "Auto" },
      { value: "claude-sonnet-5", label: "Sonnet 5" },
      { value: "claude-opus-4-8", label: "Opus 4.8" },
      { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
    ],
    () => {}
  );
  const effortDD = dropdownPill(
    "auto",
    [
      { value: "auto", label: "Auto" },
      { value: "low", label: "low" },
      { value: "medium", label: "medium" },
      { value: "high", label: "high" },
      { value: "xhigh", label: "xhigh" },
      { value: "max", label: "max" },
    ],
    () => {}
  );

  // Matches the desktop app's mode picker (Ask permissions / Accept edits /
  // Plan mode / Auto mode / Bypass permissions). Maestro's -p invocation has
  // no live channel to answer an interactive approval prompt, so a mode that
  // genuinely needs to ask mid-run could still stall — tested "default" in
  // this environment and it did not (the captain's existing broad allowlists let
  // tools through), but that is not a general guarantee for every setup.
  // Note: this "auto" is a literal CLI permission mode name, unrelated to the
  // model/effort "Auto" above (let Maestro pick) — they just share the word.
  const permissionDD = dropdownPill(
    "auto",
    [
      { value: "default", label: "Ask permissions" },
      { value: "acceptEdits", label: "Accept edits" },
      { value: "plan", label: "Plan mode" },
      { value: "auto", label: "Auto mode" },
      { value: "bypassPermissions", label: "Bypass permissions" },
    ],
    () => {}
  );

  const sendBtn = document.createElement("button");
  sendBtn.className = "send-btn";
  sendBtn.textContent = "➤";
  sendBtn.title = pane.sessionId ? "Continue (Enter)" : "Start session (Enter)";

  controls.append(pickBtn, cwdInput, permissionDD.el, modelDD.el, effortDD.el, sendBtn);
  shell.append(controls);

  // Visible reasoning, not just a hover tooltip — a suggestion nobody reads
  // isn't a suggestion. Explicitly says so even when it just confirms your
  // current pick, per "always decide, and if it's already right, say so."
  const suggestHint = document.createElement("div");
  suggestHint.className = "suggest-hint";
  shell.append(suggestHint);
  wrap.append(shell);

  // Model-fit judge verdict lives here, under the composer — not in the chat
  // scrollback — per the captain's ask, and to keep the conversation itself
  // uncluttered. Cleared on each new send, filled in once the judge resolves.
  const modelFitLine = document.createElement("div");
  modelFitLine.className = "model-fit-line";
  wrap.append(modelFitLine);

  const els = { cwdInput, promptEl, modelDD, effortDD, permissionDD, sendBtn, renderAttachments };
  const handleSendOrStop = async () => {
    if (pane.busy) {
      if (pane.currentLaunchId) {
        pane.stopRequested = true;
        setPaneBusyUI(index, "● Stopping…");
        const res = await window.maestro.stopSession(pane.currentLaunchId);
        // The process may have finished naturally in the tiny window between
        // the click and this call landing in main — its "done" event is then
        // already queued and will clear busy shortly, but don't leave the
        // button stuck on "Stopping…" waiting for that if it does not.
        if (!res.ok && panes[index] === pane && pane.busy) {
          pane.busy = false;
          pane.stopRequested = false;
          pane.currentLaunchId = null;
          setPaneBusyUI(index, "");
        }
      }
    } else {
      sendFromPane(index, els);
    }
  };
  sendBtn.addEventListener("click", handleSendOrStop);

  // This is a text-pattern heuristic (keywords + length), not a real reading
  // of the task — the label says "Suggesting," not "Analyzed and decided,"
  // on purpose. Only updates the hint text; it never overwrites a manual
  // model/effort pick anymore (that silently discarding your choice was the
  // actual bug — "auto" is now its own explicit option instead).
  let suggestTimer = null;
  promptEl.addEventListener("input", () => {
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(async () => {
      const suggestion = await window.maestro.suggestModelEffort(promptEl.value);
      const modelLabel = suggestion.model.replace("claude-", "");
      const usingAuto = modelDD.value === "auto" && effortDD.value === "auto";
      suggestHint.textContent = usingAuto
        ? `→ Auto-picking ${modelLabel} · ${suggestion.effort} — ${suggestion.reason}`
        : `Heuristic guess: ${modelLabel} · ${suggestion.effort} — ${suggestion.reason} (using your manual pick instead)`;
    }, 300);
  });

  // Enter sends; Shift+Enter inserts a newline (matches the desktop app).
  promptEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendOrStop();
    }
  });

  if (pane.busy) {
    sendBtn.textContent = "■";
    sendBtn.title = "Stop";
    sendBtn.classList.add("stopping");
  }

  return wrap;
}

// Toggles the Send/Stop button + status text for a pane without rebuilding
// its DOM (which would drop typed-but-unsent text in that pane).
function setPaneBusyUI(index, statusText) {
  const paneEl = document.querySelector(`.pane[data-pane="${index}"]`);
  if (!paneEl) {
    return;
  }
  const pane = panes[index];
  const btn = paneEl.querySelector(".pane-composer .send-btn");
  const status = paneEl.querySelector(".pane-status");
  if (btn) {
    btn.textContent = pane.busy ? "■" : "➤";
    btn.title = pane.busy ? "Stop" : pane.sessionId ? "Continue (Enter)" : "Start session (Enter)";
    btn.classList.toggle("stopping", pane.busy);
  }
  if (status) {
    status.textContent = statusText || "";
  }
}

function setModelFitLine(index, text, verdict) {
  const paneEl = document.querySelector(`.pane[data-pane="${index}"]`);
  const line = paneEl?.querySelector(".model-fit-line");
  if (!line) {
    return;
  }
  line.textContent = text || "";
  line.className = "model-fit-line" + (verdict ? ` model-fit-${verdict}` : "");
}

async function sendFromPane(index, els) {
  const pane = panes[index];
  const cwd = els.cwdInput.value.trim();
  const typedText = els.promptEl.value.trim();
  if (pane.busy) {
    return;
  }
  if (!cwd) {
    // Was a SILENT no-op before — indistinguishable from "sending is broken".
    // Make the block visible instead of dropping the click on the floor.
    els.cwdInput.classList.add("cwd-missing");
    els.cwdInput.focus();
    return;
  }
  if (!typedText && pane.pendingImages.length === 0) {
    return;
  }
  // Image attachments become plain file-path mentions ahead of the typed
  // text — Claude Code's own Read tool fetches them from there (see
  // spike/test-image-via-path.mjs). This is what actually gets sent AND what
  // gets shown in history, so the turn matches what the model received.
  const imagePrefix = pane.pendingImages.map((img) => `[Attached image: ${img.path}]`).join("\n");
  const prompt = imagePrefix ? `${imagePrefix}\n\n${typedText}` : typedText;
  pane.pendingImages = [];
  els.renderAttachments();
  pane.cwd = cwd;
  pane.turns.push({ role: "user", kind: "text", text: prompt });
  els.promptEl.value = "";
  pane.busy = true;
  setPaneBusyUI(index, "● Working…");
  setModelFitLine(index, "");
  renderPane(index);

  // Resolved fresh from the FINAL prompt text at send time (not the debounced
  // background suggestion, which could be stale) — used to fill in any "Auto"
  // picks, and always logged as the suggestion regardless of whether you
  // followed it, so usage-log's followedSuggestion stays meaningful.
  const suggestion = await window.maestro.suggestModelEffort(prompt);
  const model = els.modelDD.value === "auto" ? suggestion.model : els.modelDD.value;
  const effort = els.effortDD.value === "auto" ? suggestion.effort : els.effortDD.value;

  const res = await window.maestro.startSession({
    cwd,
    prompt,
    model,
    effort,
    permissionMode: els.permissionDD.value,
    resumeSessionId: pane.cliSessionId,
    suggestedModel: suggestion.model,
    suggestedEffort: suggestion.effort,
  });
  if (!res.ok) {
    if (panes[index] === pane) {
      pane.busy = false;
      setPaneBusyUI(index, "");
      pane.turns.push({ role: "assistant", kind: "text", text: "⚠ Failed to start: " + res.error });
      renderPane(index);
    }
    return;
  }
  // The pane slot may have been reset/reused during the two awaits above
  // (e.g. the user hit "+" for a new chat before the round-trip finished).
  // Don't wire this launch's live events to whatever now occupies `index` —
  // that would bleed the orphaned launch's reply into the unrelated new
  // session. The underlying process keeps running and completes on its own
  // (still logged/judged main-process side); it's just not shown live.
  if (panes[index] !== pane) {
    return;
  }
  pane.currentLaunchId = res.launchId;
  paneLaunchMap.set(res.launchId, index);
  // Stores the pane OBJECT, not just the index — if the user opens a
  // different session in this same pane slot before a late event (the judge)
  // arrives, panes[index] will no longer be this object, and we can tell not
  // to misattribute the result to the new session.
  launchPaneHistory.set(res.launchId, { index, pane, startedAt: Date.now() });
}

// Rebuilds every pane's DOM. Only call this when the NUMBER of panes changes
// (split on/off) — it discards any in-progress typing in every pane.
function renderWorkspace() {
  const workspace = document.getElementById("workspace");
  workspace.classList.toggle("split", panes.length > 1);
  workspace.innerHTML = "";
  panes.forEach((_, index) => {
    const paneEl = document.createElement("section");
    paneEl.className = "pane";
    paneEl.dataset.pane = String(index);
    paneEl.addEventListener("click", () => {
      focusedPaneIndex = index;
    });
    workspace.append(paneEl);
    renderSinglePane(index);
  });
}

// Rebuilds ONE pane's header/scroll/composer in place. Use this for anything
// that doesn't add or remove a pane (opening a session, resetting to new),
// so typing in the OTHER pane is left untouched.
function renderSinglePane(index) {
  const paneEl = document.querySelector(`.pane[data-pane="${index}"]`);
  if (!paneEl) {
    return;
  }
  paneEl.innerHTML = "";
  paneEl.append(paneHeaderEl(index), scrollContainer(), paneComposerEl(index));
  renderPane(index);
}

function scrollContainer() {
  const div = document.createElement("div");
  div.className = "pane-scroll";
  return div;
}

// ============================== Quota + top controls ==============================

function renderQuota(quota) {
  const el = document.getElementById("quota");
  if (!quota) {
    el.textContent = "quota: —";
    return;
  }
  const pct = Math.round((quota.utilization || 0) * 100);
  el.textContent = `quota (${quota.rateLimitType || "?"}): ${pct}% used`;
  el.classList.toggle("warn", pct >= 80);
}

async function refresh() {
  const data = await window.maestro.getSessions();
  state.sessions = data.sessions;
  state.config = data.config;
  state.quota = data.quota;
  applyViewMode();
  applySidebarMode();
  renderSidebar();
  renderQuota(state.quota);
  pruneStaleLaunchHistory();
}

// The modelFit event is the normal way launchPaneHistory entries get cleaned
// up, but if the judge is disabled (config.modelFitJudge.enabled: false) or
// errors before emitting one, that never happens — this is the backstop so
// the map doesn't grow forever over a long-running session.
function pruneStaleLaunchHistory() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [launchId, entry] of launchPaneHistory) {
    if ((entry.startedAt || 0) < cutoff) {
      launchPaneHistory.delete(launchId);
    }
  }
}

function applyViewMode() {
  document.body.classList.toggle("advanced", state.config.viewMode === "advanced");
  // Scoped to #viewToggle specifically — a bare ".view-toggle button" also
  // matches the page tabs and sidebar mode toggle (same shared class), which
  // was wiping their active state every time this ran.
  document.querySelectorAll("#viewToggle button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === (state.config.viewMode || "simple"));
  });
}

document.getElementById("search").addEventListener("input", (e) => {
  searchTerm = e.target.value.trim().toLowerCase();
  renderSidebar();
});

document.getElementById("newCategory").addEventListener("click", createCategory);

document.getElementById("newChat").addEventListener("click", () => {
  panes[focusedPaneIndex] = freshPane();
  selectedSessionId = null;
  renderSinglePane(focusedPaneIndex);
  renderSidebar();
});

// ============================== Analysis page ==============================
// Replaces the earlier popup versions of Skills/Usage — those rendered via
// submenus that could overflow off-screen near the window edge, and the captain
// asked for a real page he can switch to rather than staying on the prompt
// page. Combines both into one page with simple hand-rolled bar charts (no
// charting dependency needed for this).

document.getElementById("pageToggle").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-page]");
  if (!btn) {
    return;
  }
  document.querySelectorAll("#pageToggle button").forEach((b) => b.classList.toggle("active", b === btn));
  const page = btn.dataset.page;
  document.getElementById("chatPage").classList.toggle("hidden", page !== "chat");
  document.getElementById("analysisPage").classList.toggle("hidden", page !== "analysis");
  document.getElementById("settingsPage").classList.toggle("hidden", page !== "settings");
  if (page === "analysis") {
    renderAnalysisPage();
  } else if (page === "settings") {
    renderSettingsPage();
  }
});

// ============================== Settings page ==============================

function settingsToggleRow(title, desc, checked, onChange) {
  const row = document.createElement("label");
  row.className = "settings-toggle-row";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = checked;
  checkbox.addEventListener("change", () => onChange(checkbox.checked));
  const labelText = document.createElement("div");
  labelText.className = "settings-toggle-text";
  const titleEl = document.createElement("div");
  titleEl.textContent = title;
  titleEl.className = "settings-toggle-title";
  const descEl = document.createElement("div");
  descEl.className = "settings-toggle-desc";
  descEl.textContent = desc;
  labelText.append(titleEl, descEl);
  row.append(checkbox, labelText);
  return row;
}

function renderSettingsPage() {
  const page = document.getElementById("settingsPage");
  page.innerHTML = "";

  const header = document.createElement("h2");
  header.textContent = "Settings";
  page.append(header);

  const block = document.createElement("div");
  block.className = "analysis-block settings-block";

  block.append(
    settingsToggleRow(
      "Model-fit judge",
      "Runs a cheap Haiku call after every completed prompt to flag whether the model/effort choice was too weak, too strong, or appropriate. Adds ~$0.015 per prompt. Shown under the composer, not in the chat history.",
      state.config.modelFitJudge?.enabled !== false,
      async (checked) => {
        state.config = await window.maestro.setConfig({
          modelFitJudge: { ...(state.config.modelFitJudge || {}), enabled: checked },
        });
      }
    )
  );

  block.append(
    settingsToggleRow(
      "Notify when a prompt finishes",
      "Shows a native Windows notification (with its default sound) when a session completes a run, so you can switch away while it works.",
      state.config.notifyOnComplete !== false,
      async (checked) => {
        state.config = await window.maestro.setConfig({ notifyOnComplete: checked });
      }
    )
  );

  block.append(
    settingsToggleRow(
      "Suggest archiving idle sessions",
      "Shows an \"Archive?\" pill on idle sessions with no open Jot review/in-progress/open work. Archiving still needs your click — this only surfaces the suggestion, it never archives on its own.",
      state.config.archiveSuggestions?.enabled === true,
      async (checked) => {
        state.config = await window.maestro.setConfig({
          archiveSuggestions: { ...(state.config.archiveSuggestions || {}), enabled: checked },
        });
        refresh();
      }
    )
  );

  page.append(block);
}

function barRow(label, count, max) {
  const row = document.createElement("div");
  row.className = "bar-row";
  const name = document.createElement("span");
  name.className = "bar-label";
  name.textContent = label;
  const track = document.createElement("span");
  track.className = "bar-track";
  const fill = document.createElement("span");
  fill.className = "bar-fill";
  fill.style.width = `${max ? Math.max(4, (count / max) * 100) : 0}%`;
  track.append(fill);
  const value = document.createElement("span");
  value.className = "bar-value";
  value.textContent = count;
  row.append(name, track, value);
  return row;
}

function skillListEl(title, names, origin, cwd) {
  const section = document.createElement("div");
  section.className = "analysis-block";
  const h = document.createElement("h3");
  h.textContent = `${title} · ${names.length}`;
  section.append(h);
  if (names.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pane-empty";
    empty.textContent = "None found.";
    section.append(empty);
  } else {
    const list = document.createElement("div");
    list.className = "skill-chip-list";
    names.forEach((n) => {
      const chip = document.createElement("button");
      chip.className = "skill-chip";
      chip.textContent = n;
      chip.title = "Open SKILL.md";
      chip.addEventListener("click", () => window.maestro.openSkill({ name: n, origin, cwd }));
      list.append(chip);
    });
    section.append(list);
  }
  return section;
}

function fitPill(kind, count) {
  const pill = document.createElement("span");
  pill.className = `fit-pill fit-pill-${kind}`;
  const shortLabel = { too_weak: "weak", appropriate: "ok", too_strong: "strong" }[kind];
  pill.textContent = `${count} ${shortLabel}`;
  return pill;
}

async function renderAnalysisPage() {
  const page = document.getElementById("analysisPage");
  page.innerHTML = "";

  const cwd = panes[focusedPaneIndex]?.cwd || "";
  const [{ global, project }, summary] = await Promise.all([
    window.maestro.listSkills(cwd),
    window.maestro.getUsageSummary(),
  ]);

  const header = document.createElement("h2");
  header.textContent = "Analysis";
  page.append(header);

  const totals = document.createElement("div");
  totals.className = "analysis-totals";
  totals.textContent =
    `${summary.totalRuns} runs · $${summary.totalCostUsd.toFixed(2)} total` +
    (summary.judgeCostUsd ? ` · $${summary.judgeCostUsd.toFixed(2)} spent on model-fit judging` : "");
  page.append(totals);

  const grid = document.createElement("div");
  grid.className = "analysis-grid";

  const modelBlock = document.createElement("div");
  modelBlock.className = "analysis-block";
  const modelH = document.createElement("h3");
  modelH.textContent = "By model";
  modelBlock.append(modelH);
  const modelEntries = Object.entries(summary.byModel).sort((a, b) => b[1] - a[1]);
  const modelMax = modelEntries.length ? modelEntries[0][1] : 0;
  if (modelEntries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pane-empty";
    empty.textContent = "No data yet — usage logs as you use Maestro.";
    modelBlock.append(empty);
  } else {
    modelEntries.forEach(([m, c]) => modelBlock.append(barRow(m.replace("claude-", ""), c, modelMax)));
  }

  const toolBlock = document.createElement("div");
  toolBlock.className = "analysis-block";
  const toolH = document.createElement("h3");
  toolH.textContent = "Top tools used";
  toolBlock.append(toolH);
  const toolEntries = Object.entries(summary.byTool).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const toolMax = toolEntries.length ? toolEntries[0][1] : 0;
  if (toolEntries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pane-empty";
    empty.textContent = "No data yet.";
    toolBlock.append(empty);
  } else {
    toolEntries.forEach(([t, c]) => toolBlock.append(barRow(t, c, toolMax)));
  }

  const skillUsageBlock = document.createElement("div");
  skillUsageBlock.className = "analysis-block";
  const skillUsageH = document.createElement("h3");
  skillUsageH.textContent = "Skill usage (best-effort)";
  skillUsageH.title = 'Guessed from a leading "/skill-name" in the prompt text — not a real event from the CLI, so this misses skills invoked any other way.';
  skillUsageBlock.append(skillUsageH);
  const skillEntries = Object.entries(summary.bySkill).sort((a, b) => b[1] - a[1]);
  const skillMax = skillEntries.length ? skillEntries[0][1] : 0;
  if (skillEntries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pane-empty";
    empty.textContent = "No data yet — only counts prompts starting with /skill-name.";
    skillUsageBlock.append(empty);
  } else {
    skillEntries.forEach(([s, c]) => skillUsageBlock.append(barRow(s, c, skillMax)));
  }

  const fitBlock = document.createElement("div");
  fitBlock.className = "analysis-block";
  const fitH = document.createElement("h3");
  fitH.textContent = "Model fit (judged)";
  fitH.title = "A cheap Haiku judge reviews each completed prompt for whether the model/effort choice fit the task.";
  fitBlock.append(fitH);
  const fitModels = Object.keys(summary.modelFit || {});
  if (fitModels.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pane-empty";
    empty.textContent = "No verdicts yet.";
    fitBlock.append(empty);
  } else {
    fitModels.forEach((m) => {
      const counts = summary.modelFit[m];
      const row = document.createElement("div");
      row.className = "fit-row";
      const label = document.createElement("span");
      label.className = "fit-model-label";
      label.textContent = m.replace("claude-", "");
      row.append(label);
      row.append(fitPill("too_weak", counts.too_weak), fitPill("appropriate", counts.appropriate), fitPill("too_strong", counts.too_strong));
      fitBlock.append(row);
    });
  }

  grid.append(modelBlock, toolBlock, skillUsageBlock, fitBlock);
  grid.append(
    skillListEl("Global skills (~/.claude/skills)", global, "global", cwd),
    skillListEl(`This pane's project skills${cwd ? "" : " (no folder set on the focused pane)"}`, project, "project", cwd)
  );
  page.append(grid);
}

document.getElementById("viewToggle").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (!btn) {
    return;
  }
  state.config = await window.maestro.setConfig({ viewMode: btn.dataset.mode });
  applyViewMode();
});

document.getElementById("sidebarModeToggle").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (!btn) {
    return;
  }
  state.config = await window.maestro.setConfig({ sidebarMode: btn.dataset.mode });
  applySidebarMode();
  renderSidebar();
});

function applySidebarMode() {
  document.querySelectorAll("#sidebarModeToggle button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === (state.config.sidebarMode || "smart"));
  });
}

document.getElementById("splitToggle").addEventListener("click", () => {
  const workspace = document.getElementById("workspace");
  if (panes.length > 1) {
    panes = [panes[0]];
  } else {
    panes.push(freshPane());
  }
  workspace.classList.toggle("split", panes.length > 1);
  document.getElementById("splitToggle").classList.toggle("active", panes.length > 1);
  renderWorkspace();
});

// ============================== Background tasks (subagents) ==============================
// Matches the desktop app's "Background tasks" drawer, backed by real
// task_started/task_progress/task_updated/task_notification events (verified
// schema via spike/test-task-events-shape.mjs) rather than a hollow copy.

function renderBackgroundTasksBadge() {
  const btn = document.getElementById("backgroundTasksBtn");
  const running = [...backgroundTasks.values()].filter((t) => t.status === "running").length;
  btn.textContent = running > 0 ? `Background tasks (${running})` : "Background tasks";
  btn.classList.toggle("has-running", running > 0);
}

document.getElementById("backgroundTasksBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  const tasks = [...backgroundTasks.entries()];
  if (tasks.length === 0) {
    showContextMenu(e.clientX, e.clientY, [{ label: "No background tasks yet" }]);
    return;
  }
  const items = tasks
    .sort((a, b) => (b[1].startedAt || 0) - (a[1].startedAt || 0))
    .map(([taskId, t]) => {
      const statusIcon = t.status === "running" ? "◔" : t.status === "failed" ? "✗" : "✓";
      const detail = t.status === "running" && t.lastToolName ? ` · ${t.lastToolName}` : "";
      return { label: `${statusIcon} ${t.summary || t.description}${detail}` };
    });
  items.push(
    { sep: true },
    {
      label: "Clear finished",
      onClick: () => {
        for (const [taskId, t] of backgroundTasks) {
          if (t.status !== "running") {
            backgroundTasks.delete(taskId);
          }
        }
        renderBackgroundTasksBadge();
      },
    }
  );
  showContextMenu(e.clientX, e.clientY, items);
});

window.maestro.onSessionEvent((evt) => {
  // Ad-hoc one-off launch (e.g. a summarization call) not tied to any pane's
  // normal display — captured entirely here instead of routing further down.
  if (pendingLaunchCallbacks.has(evt.launchId)) {
    const cb = pendingLaunchCallbacks.get(evt.launchId);
    if (evt.kind === "assistant") {
      cb.assistantText += evt.text;
    } else if (evt.kind === "session") {
      cb.cliSessionId = evt.sessionId; // not used by summarizeSession today, but kept for future extension
    } else if (evt.kind === "done" || evt.kind === "error") {
      pendingLaunchCallbacks.delete(evt.launchId);
      cb.onDone(cb.assistantText, evt.kind === "error" ? evt.message : null);
    }
    return;
  }

  // Handled separately: the judge resolves well after "done" already cleared
  // paneLaunchMap, so this needs the longer-lived launchPaneHistory instead.
  if (evt.kind === "modelFit") {
    const entry = launchPaneHistory.get(evt.launchId);
    launchPaneHistory.delete(evt.launchId); // this is the only consumer; always one-shot
    if (!entry || panes[entry.index] !== entry.pane) {
      return; // pane was reused for a different session in the meantime
    }
    const text = `${MODEL_FIT_ICON[evt.verdict] || "⚖"} ${MODEL_FIT_LABEL[evt.verdict] || evt.verdict}: ${evt.reason}`;
    setModelFitLine(entry.index, text, evt.verdict);
    return;
  }

  // Background Task-tool subagents — app-wide, not tied to a single pane.
  if (evt.kind === "task_started") {
    backgroundTasks.set(evt.taskId, {
      description: evt.description || evt.subagentType || "Background task",
      status: "running",
      lastToolName: null,
      startedAt: Date.now(),
    });
    renderBackgroundTasksBadge();
    return;
  }
  if (evt.kind === "task_progress") {
    const t = backgroundTasks.get(evt.taskId);
    if (t) {
      t.lastToolName = evt.lastToolName || t.lastToolName;
      renderBackgroundTasksBadge();
    }
    return;
  }
  if (evt.kind === "task_updated") {
    const t = backgroundTasks.get(evt.taskId);
    // Ignore an out-of-order/delayed update trying to un-finish a task that
    // already reached a terminal state (e.g. via task_done) — a duplicate or
    // reordered IPC message shouldn't make a completed task look running again.
    if (t && !TERMINAL_TASK_STATUSES.has(t.status)) {
      t.status = evt.status || t.status;
      renderBackgroundTasksBadge();
    }
    return;
  }
  if (evt.kind === "task_done") {
    const t = backgroundTasks.get(evt.taskId);
    if (t) {
      t.status = evt.status || "completed";
      t.summary = evt.summary || t.description;
      renderBackgroundTasksBadge();
    }
    return;
  }

  const index = paneLaunchMap.get(evt.launchId);
  if (index === undefined) {
    return;
  }
  const pane = panes[index];
  if (!pane) {
    return;
  }
  switch (evt.kind) {
    case "session":
      pane.cliSessionId = evt.sessionId;
      break;
    case "tool_use":
      setPaneBusyUI(index, `● Working — ${evt.toolName}`);
      break;
    case "assistant":
      pane.turns.push({ role: "assistant", kind: "text", text: evt.text });
      renderPane(index);
      break;
    case "quota":
      renderQuota(evt.quota);
      break;
    case "error":
      pane.busy = false;
      pane.currentLaunchId = null;
      setPaneBusyUI(index, "");
      pane.turns.push({ role: "assistant", kind: "text", text: "⚠ " + evt.message });
      renderPane(index);
      break;
    case "done":
      pane.busy = false;
      pane.currentLaunchId = null;
      paneLaunchMap.delete(evt.launchId);
      setPaneBusyUI(index, "");
      if (pane.stopRequested) {
        // A killed process may not have flushed its in-progress turn to disk
        // yet — reloading the transcript here would silently drop whatever
        // text already streamed live. Keep what's on screen instead.
        pane.stopRequested = false;
        pane.turns.push({ role: "assistant", kind: "text", text: "⏹ Stopped." });
        renderPane(index);
      } else {
        loadTranscriptInto(index).then(refresh);
      }
      break;
    default:
      break;
  }
});

renderWorkspace();
renderBackgroundTasksBadge();
refresh();
setInterval(refresh, 30000);
