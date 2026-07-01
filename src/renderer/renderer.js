const STATUS_LABEL = { waiting: "Needs you", active: "Working", idle: "Idle", archived: "Archived" };

let state = { sessions: [], config: { groups: [], viewMode: "simple" }, quota: null };
let searchTerm = "";
let selectedSessionId = null;

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

// --- Row rendering ---
function rowEl(session) {
  const row = document.createElement("div");
  row.className = "row" + (session.sessionId === selectedSessionId ? " selected" : "");
  row.draggable = true;
  row.dataset.sessionId = session.sessionId;

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

  row.addEventListener("click", () => selectSession(session));
  row.addEventListener("dragstart", (e) => {
    row.classList.add("dragging");
    e.dataTransfer.setData("text/session-id", session.sessionId);
    e.dataTransfer.effectAllowed = "move";
  });
  row.addEventListener("dragend", () => row.classList.remove("dragging"));

  return row;
}

function spanEl(text) {
  const el = document.createElement("span");
  el.textContent = text;
  return el;
}

function selectSession(session) {
  selectedSessionId = session.sessionId;
  document.getElementById("cwd").value = session.cwd || "";
  document.getElementById("prompt").value = "";
  document.getElementById("prompt").placeholder = `Continue "${session.title}"…`;
  document.getElementById("prompt").dataset.resumeId = session.cliSessionId || session.sessionId;
  document.getElementById("resumeTitle").textContent = session.title;
  document.getElementById("resumeBanner").classList.remove("hidden");
  renderSidebar();
}

function clearResume() {
  selectedSessionId = null;
  const promptEl = document.getElementById("prompt");
  delete promptEl.dataset.resumeId;
  promptEl.placeholder = "What should this session do?";
  document.getElementById("resumeBanner").classList.add("hidden");
  renderSidebar();
}

document.getElementById("cancelResume").addEventListener("click", clearResume);

// --- Drop zone wiring (shared by group lists + unsorted) ---
function wireDropZone(el, onDrop) {
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    el.classList.add("drag-over");
  });
  el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("drag-over");
    const sessionId = e.dataTransfer.getData("text/session-id");
    if (sessionId) {
      onDrop(sessionId);
    }
  });
}

async function moveSessionToGroup(sessionId, targetLabel) {
  const groups = (state.config.groups || []).map((g) => ({
    ...g,
    sessionIds: (g.sessionIds || []).filter((id) => id !== sessionId),
  }));
  if (targetLabel) {
    const target = groups.find((g) => g.label === targetLabel);
    if (target) {
      target.sessionIds.push(sessionId);
    }
  }
  state.config = await window.maestro.setConfig({ groups });
  renderSidebar();
}

function sectionEl({ id, label, sessions, collapsed, pinned, droppable, emptyHint }) {
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
    if (id) {
      persistCollapsed(id, head.classList.contains("collapsed"));
    }
  });

  if (droppable) {
    wireDropZone(list, (sessionId) => moveSessionToGroup(sessionId, droppable === "unsorted" ? null : label));
  }

  wrap.append(head, list);
  return wrap;
}

async function persistCollapsed(groupLabel, collapsed) {
  const groups = (state.config.groups || []).map((g) =>
    g.label === groupLabel ? { ...g, collapsed } : g
  );
  state.config = await window.maestro.setConfig({ groups });
}

function renderSidebar() {
  const body = document.getElementById("sidebarBody");
  body.innerHTML = "";

  const visible = state.sessions.filter((s) => !s.isArchived).filter(matchesSearch);

  const attention = visible.filter((s) => s.needsAttention);
  if (attention.length > 0) {
    body.append(
      sectionEl({ id: null, label: "Needs your attention", sessions: attention, collapsed: false, pinned: true, droppable: false })
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
        id: group.label,
        label: group.label,
        sessions: members,
        collapsed: !!group.collapsed,
        droppable: true,
        emptyHint: "Drag or move sessions here",
      })
    );
  }

  const unsorted = visible.filter((s) => !grouped.has(s.sessionId));
  body.append(
    sectionEl({
      id: "Unsorted",
      label: "Unsorted",
      sessions: unsorted,
      collapsed: false,
      droppable: "unsorted",
    })
  );
}

// --- Quota ---
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

// --- Data refresh ---
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

document.getElementById("viewToggle").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (!btn) {
    return;
  }
  state.config = await window.maestro.setConfig({ viewMode: btn.dataset.mode });
  applyViewMode();
});

// --- Model/effort suggestion (inline, computed as you type) ---
let suggestTimer = null;
document.getElementById("prompt").addEventListener("input", (e) => {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(async () => {
    const suggestion = await window.maestro.suggestModelEffort(e.target.value);
    const badge = document.getElementById("suggestBadge");
    badge.textContent = `Suggested: ${suggestion.model.replace("claude-", "")} · ${suggestion.effort} — ${suggestion.reason}`;
    document.getElementById("model").value = suggestion.model;
    document.getElementById("effort").value = suggestion.effort;
  }, 300);
});

// --- Launcher ---
const logEl = () => document.getElementById("log");

function log(text, cls) {
  const line = document.createElement("div");
  if (cls) {
    line.className = cls;
  }
  line.textContent = text;
  logEl().append(line);
  logEl().scrollTop = logEl().scrollHeight;
}

document.getElementById("pick").addEventListener("click", async () => {
  const folder = await window.maestro.pickFolder();
  if (folder) {
    document.getElementById("cwd").value = folder;
  }
});

document.getElementById("start").addEventListener("click", async () => {
  const cwd = document.getElementById("cwd").value.trim();
  const model = document.getElementById("model").value;
  const effort = document.getElementById("effort").value;
  const promptEl = document.getElementById("prompt");
  const prompt = promptEl.value.trim();
  const resumeSessionId = promptEl.dataset.resumeId || null;
  if (!cwd || !prompt) {
    log("Need both a repo folder and a prompt.", "err");
    return;
  }
  logEl().innerHTML = "";
  log(
    resumeSessionId
      ? `Resuming session in ${cwd} (${model}, ${effort})…`
      : `Starting session in ${cwd} (${model}, ${effort})…`
  );
  const res = await window.maestro.startSession({ cwd, prompt, model, effort, resumeSessionId });
  if (!res.ok) {
    log("Failed to start: " + res.error, "err");
  }
});

window.maestro.onSessionEvent((evt) => {
  switch (evt.kind) {
    case "session":
      log("session id: " + evt.sessionId);
      break;
    case "assistant":
      log(evt.text, "assistant");
      break;
    case "quota":
      renderQuota(evt.quota);
      break;
    case "result":
      log(`result: ${evt.subtype || ""} · ${evt.numTurns || "?"} turns`);
      break;
    case "stderr":
      log(evt.text.trim(), "err");
      break;
    case "error":
      log("error: " + evt.message, "err");
      break;
    case "done":
      log("✓ done", "ok");
      refresh();
      break;
    default:
      break;
  }
});

refresh();
setInterval(refresh, 30000);
