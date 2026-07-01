const STATUS_LABEL = { waiting: "Needs you", active: "Working", idle: "Idle", archived: "Archived" };

let state = { sessions: [], config: { groups: [], viewMode: "simple" }, quota: null };
let searchTerm = "";
let selectedSessionId = null;
let focusedPaneIndex = 0;
let dragSessionId = null;
const paneLaunchMap = new Map(); // launchId -> paneIndex

// Each pane: { sessionId, cliSessionId, cwd, title, turns, hiddenCount, loading }
let panes = [freshPane()];

function freshPane() {
  return { sessionId: null, cliSessionId: null, cwd: "", title: "New session", turns: [], hiddenCount: 0, loading: false };
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

// ============================== Context menu ==============================

function closeContextMenu() {
  document.getElementById("contextMenu").classList.add("hidden");
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

async function createCategory() {
  const label = window.prompt("New category name:");
  if (!label || !label.trim()) {
    return;
  }
  const groups = [...(state.config.groups || []), { label: label.trim(), sessionIds: [], collapsed: false }];
  state.config = await window.maestro.setConfig({ groups });
  renderSidebar();
}

async function renameCategory(oldLabel) {
  const label = window.prompt("Rename category:", oldLabel);
  if (!label || !label.trim() || label === oldLabel) {
    return;
  }
  const groups = (state.config.groups || []).map((g) => (g.label === oldLabel ? { ...g, label: label.trim() } : g));
  state.config = await window.maestro.setConfig({ groups });
  renderSidebar();
}

async function deleteCategory(label) {
  if (!window.confirm(`Delete category "${label}"? Sessions move to Unsorted.`)) {
    return;
  }
  const groups = (state.config.groups || []).filter((g) => g.label !== label);
  state.config = await window.maestro.setConfig({ groups });
  renderSidebar();
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

  row.addEventListener("click", () => openSessionInPane(session, focusedPaneIndex));

  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const groupLabels = (state.config.groups || []).map((g) => g.label);
    showContextMenu(e.clientX, e.clientY, [
      { label: "Open here", onClick: () => openSessionInPane(session, focusedPaneIndex) },
      { label: "Open in split pane", onClick: () => openSessionInPane(session, focusedPaneIndex === 0 ? 1 : 0, true) },
      { sep: true },
      {
        label: "Move to category",
        submenu: [
          ...groupLabels.map((label) => ({ label, onClick: () => moveSessionToGroup(session.sessionId, label) })),
          { label: "Unsorted", onClick: () => moveSessionToGroup(session.sessionId, null) },
        ],
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

function openSessionInPane(session, paneIndex, forceSplit) {
  focusedPaneIndex = paneIndex;
  selectedSessionId = session.sessionId;
  const addedPane = forceSplit && panes.length < 2;
  if (addedPane) {
    panes.push(freshPane());
  }
  panes[paneIndex] = {
    sessionId: session.sessionId,
    cliSessionId: session.cliSessionId || session.sessionId,
    cwd: session.cwd || "",
    title: session.title,
    turns: [],
    hiddenCount: 0,
    loading: true,
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

  const head = document.createElement("div");
  head.className = "section-head" + (pinned ? " attention-head" : "") + (collapsed ? " collapsed" : "");
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
    sortByAttention(sessions).forEach((s) => list.append(rowEl(s)));
  }

  head.addEventListener("click", () => {
    head.classList.toggle("collapsed");
    list.classList.toggle("hidden");
    if (isCategory) {
      persistCollapsed(label, head.classList.contains("collapsed"));
    }
  });

  if (isCategory) {
    head.dataset.hasMenu = "1";
    head.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, [
        { label: "Rename category", onClick: () => renameCategory(label) },
        { label: "Delete category", danger: true, onClick: () => deleteCategory(label) },
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

  const visible = state.sessions.filter((s) => !s.isArchived).filter(matchesSearch);

  const attention = visible.filter((s) => s.needsAttention);
  if (attention.length > 0) {
    body.append(
      sectionEl({ label: "Needs your attention", sessions: attention, collapsed: false, pinned: true, droppable: false })
    );
  }

  const groups = state.config.groups || [];
  const grouped = new Set();
  for (const group of groups) {
    const members = (group.sessionIds || [])
      .map(sessionById)
      .filter(Boolean)
      .filter((s) => !s.isArchived)
      .filter(matchesSearch);
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

function turnEl(turn) {
  if (turn.kind === "tool_use") {
    const el = document.createElement("div");
    el.className = "turn-tool";
    el.textContent = `🔧 ${turn.toolName}${turn.toolInput ? " · " + turn.toolInput : ""}`;
    return el;
  }
  if (turn.kind === "tool_result") {
    const el = document.createElement("div");
    el.className = "turn-tool-result";
    el.textContent = turn.text;
    return el;
  }
  const wrap = document.createElement("div");
  wrap.className = "turn " + turn.role;
  const bubble = document.createElement("div");
  bubble.className = "turn-bubble";
  bubble.textContent = turn.text;
  wrap.append(bubble);
  return wrap;
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
    pane.turns.forEach((t) => scroll.append(turnEl(t)));
  }
  scroll.scrollTop = scroll.scrollHeight;
}

function paneHeaderEl(index) {
  const pane = panes[index];
  const header = document.createElement("div");
  header.className = "pane-header";
  const title = document.createElement("span");
  title.textContent = pane.title || "New session";
  header.append(title);
  if (pane.cwd) {
    const sub = document.createElement("span");
    sub.className = "pane-sub";
    sub.textContent = pane.cwd;
    header.append(sub);
  }
  if (index === 1) {
    const close = document.createElement("button");
    close.className = "pane-close icon-btn";
    close.textContent = "✕";
    close.title = "Close split";
    close.addEventListener("click", () => {
      panes = [panes[0]];
      document.getElementById("workspace").classList.remove("split");
      renderWorkspace();
    });
    header.append(close);
  }
  return header;
}

function paneComposerEl(index) {
  const pane = panes[index];
  const wrap = document.createElement("div");
  wrap.className = "pane-composer";

  const banner = document.createElement("div");
  banner.className = "resume-banner" + (pane.sessionId ? "" : " hidden");
  banner.innerHTML = `Continuing <strong>${escapeHtml(pane.title || "")}</strong>`;
  const newBtn = document.createElement("button");
  newBtn.textContent = "✕ new session instead";
  newBtn.addEventListener("click", () => {
    panes[index] = freshPane();
    if (selectedSessionId === pane.sessionId) {
      selectedSessionId = null;
    }
    renderSinglePane(index);
    renderSidebar();
  });
  banner.append(newBtn);
  wrap.append(banner);

  const folderRow = document.createElement("div");
  folderRow.className = "folder-row";
  const cwdInput = document.createElement("input");
  cwdInput.type = "text";
  cwdInput.placeholder = "D:\\Repo\\...";
  cwdInput.value = pane.cwd || "";
  cwdInput.addEventListener("input", (e) => {
    pane.cwd = e.target.value;
  });
  const pickBtn = document.createElement("button");
  pickBtn.textContent = "Pick…";
  pickBtn.addEventListener("click", async () => {
    const folder = await window.maestro.pickFolder();
    if (folder) {
      pane.cwd = folder;
      cwdInput.value = folder;
    }
  });
  folderRow.append(cwdInput, pickBtn);
  wrap.append(folderRow);

  const promptEl = document.createElement("textarea");
  promptEl.rows = 3;
  promptEl.placeholder = pane.sessionId ? `Continue "${pane.title}"…` : "What should this session do?";
  wrap.append(promptEl);

  const suggestRow = document.createElement("div");
  suggestRow.className = "suggest-row";
  const badge = document.createElement("span");
  badge.className = "suggest-badge";
  badge.textContent = "Suggested: —";
  const modelSel = document.createElement("select");
  ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5-20251001"].forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m.replace("claude-", "");
    modelSel.append(opt);
  });
  const effortSel = document.createElement("select");
  ["low", "medium", "high", "xhigh", "max"].forEach((eff) => {
    const opt = document.createElement("option");
    opt.value = eff;
    opt.textContent = eff;
    if (eff === "medium") {
      opt.selected = true;
    }
    effortSel.append(opt);
  });
  suggestRow.append(badge, modelSel, effortSel);
  wrap.append(suggestRow);

  let suggestTimer = null;
  promptEl.addEventListener("input", () => {
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(async () => {
      const suggestion = await window.maestro.suggestModelEffort(promptEl.value);
      badge.textContent = `Suggested: ${suggestion.model.replace("claude-", "")} · ${suggestion.effort}`;
      badge.title = suggestion.reason;
      modelSel.value = suggestion.model;
      effortSel.value = suggestion.effort;
    }, 300);
  });

  const sendBtn = document.createElement("button");
  sendBtn.className = "primary";
  sendBtn.textContent = pane.sessionId ? "Continue" : "Start session";
  sendBtn.addEventListener("click", () => sendFromPane(index, { cwdInput, promptEl, modelSel, effortSel, sendBtn }));
  wrap.append(sendBtn);

  promptEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      sendFromPane(index, { cwdInput, promptEl, modelSel, effortSel, sendBtn });
    }
  });

  return wrap;
}

async function sendFromPane(index, els) {
  const pane = panes[index];
  const cwd = els.cwdInput.value.trim();
  const prompt = els.promptEl.value.trim();
  const model = els.modelSel.value;
  const effort = els.effortSel.value;
  if (!cwd || !prompt) {
    return;
  }
  pane.cwd = cwd;
  pane.turns.push({ role: "user", kind: "text", text: prompt });
  els.promptEl.value = "";
  els.sendBtn.disabled = true;
  renderPane(index);

  const res = await window.maestro.startSession({
    cwd,
    prompt,
    model,
    effort,
    resumeSessionId: pane.cliSessionId,
  });
  els.sendBtn.disabled = false;
  if (!res.ok) {
    pane.turns.push({ role: "assistant", kind: "text", text: "⚠ Failed to start: " + res.error });
    renderPane(index);
    return;
  }
  paneLaunchMap.set(res.launchId, index);
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

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
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
  renderSidebar();
  renderQuota(state.quota);
}

function applyViewMode() {
  document.body.classList.toggle("advanced", state.config.viewMode === "advanced");
  document.querySelectorAll(".view-toggle button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === (state.config.viewMode || "simple"));
  });
}

document.getElementById("search").addEventListener("input", (e) => {
  searchTerm = e.target.value.trim().toLowerCase();
  renderSidebar();
});

document.getElementById("newCategory").addEventListener("click", createCategory);

document.getElementById("viewToggle").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (!btn) {
    return;
  }
  state.config = await window.maestro.setConfig({ viewMode: btn.dataset.mode });
  applyViewMode();
});

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

window.maestro.onSessionEvent((evt) => {
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
    case "assistant":
      pane.turns.push({ role: "assistant", kind: "text", text: evt.text });
      renderPane(index);
      break;
    case "quota":
      renderQuota(evt.quota);
      break;
    case "error":
      pane.turns.push({ role: "assistant", kind: "text", text: "⚠ " + evt.message });
      renderPane(index);
      break;
    case "done":
      paneLaunchMap.delete(evt.launchId);
      loadTranscriptInto(index).then(refresh);
      break;
    default:
      break;
  }
});

renderWorkspace();
refresh();
setInterval(refresh, 30000);
