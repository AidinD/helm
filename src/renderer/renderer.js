const STATUS_LABEL = { waiting: "Needs you", active: "Working", idle: "Idle", archived: "Archived" };

let state = { sessions: [], config: { groups: [], viewMode: "simple" }, quota: null };
let searchTerm = "";
let archiveSearchTerm = ""; // filters the Archive page's two lists by title/folder
let selectedSessionId = null;
let focusedPaneIndex = 0;
let dragSessionId = null;
// The single source of truth for a drag-reorder: set on every dragover and
// read verbatim by drop, so the drop lands exactly where the indicator was
// shown (the old code recomputed position from a live rect at drop time,
// which disagreed with the shown indicator once layout had shifted).
// { row: HTMLElement, before: boolean } | null.
let dropTarget = null;
// Same pattern, separate state — reordering CATEGORIES (dragging a section's
// header) is a distinct drag payload type ("text/category-label", never
// "text/session-id") from reordering sessions, so it needs its own drop
// target rather than sharing/overloading `dropTarget` above.
// { wrap: HTMLElement, label: string, before: boolean } | null.
let categoryDropTarget = null;
// Timestamp a category drag started (null when not dragging). The 30s
// refresh() timer — or any session event — otherwise rebuilds the sidebar
// mid-drag, visibly undoing the drag-collapse and destroying the dragged
// header. refresh() skips the sidebar rebuild while this is set. A timestamp
// (not a bool) so a drag that somehow never ends self-heals after 30s rather
// than freezing the sidebar forever — dragend clears it in every normal case.
let categoryDragStartedAt = null;
const CATEGORY_DRAG_STALE_MS = 30000;

function categoryDragInProgress() {
  return categoryDragStartedAt !== null && Date.now() - categoryDragStartedAt < CATEGORY_DRAG_STALE_MS;
}
// launchId -> { index, pane, startedAt }. The ONE map every launch-scoped
// event (session/tool_use/assistant/error/done/modelFit) is routed through,
// always gated on `panes[index] === pane` before being applied. Storing the
// pane OBJECT (not just its index) is what makes that check meaningful: if
// the user resets/reopens that pane slot before a launch's events arrive,
// `panes[index]` no longer IS this object, and the (now orphaned) event is
// correctly dropped instead of bleeding into an unrelated session. A prior
// version used a second map (paneLaunchMap) for the common-case lookup
// WITHOUT this identity check, plus its own separate, leak-prone cleanup —
// removed in favor of this single map used everywhere.
const launchPaneHistory = new Map();
// App-wide, not per-pane — a background Task-tool subagent's lifecycle
// (task_started -> task_progress* -> task_updated/task_done), keyed by taskId.
// Schema verified via spike/test-task-events-shape.mjs before building this.
const backgroundTasks = new Map();
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed"]);
// A long session can spawn many subagents; the only removal path used to be
// the manual "Clear finished" click, so a session that never clicks it
// grows this map forever. Mirrors pruneStaleLaunchHistory's shape.
const BACKGROUND_TASK_MAX_AGE_MS = 60 * 60 * 1000;
// Ad-hoc listeners for a specific launchId that isn't tied to a pane's normal
// display flow — used by "Summarize & carry over" to capture a resumed
// session's summary reply without it needing to occupy a visible pane.
const pendingLaunchCallbacks = new Map();

// Browser-style back/forward between chats opened in a given pane SLOT.
// Keyed by pane index, not stored on the pane object itself — openSessionInPane
// replaces the whole pane object on every navigation, which would wipe
// history stored there. { stack: [sessionId, ...], position: number }.
const paneNavHistory = new Map();

// Each pane: { sessionId, cliSessionId, cwd, title, turns, hiddenCount, loading,
//              busy, currentLaunchId, isOrchestrator, pendingAttachments }
let panes = [freshPane()];

function freshPane() {
  return {
    sessionId: null,
    cliSessionId: null,
    cwd: "",
    title: "New session",
    turns: [],
    hiddenCount: 0,
    transcriptTruncated: false, // true when the loaded view is missing earlier turns (gates rewind)
    contextTokens: null, // estimated context tokens in use, for the pane-header gauge
    loading: false,
    busy: false,
    currentLaunchId: null,
    stopRequested: false,
    isOrchestrator: false,
    pendingAttachments: [], // [{ path, name }] — pasted images attached to the next send
    queuedPrompt: null, // text to auto-send once the current busy run finishes
    els: null, // the currently-live composer's element refs, set by paneComposerEl
  };
}

// Converts a Windows absolute path to a file:// URL an <img> can load —
// forward slashes, percent-encoded per path segment (handles spaces and any
// other special characters e.g. in "D:\Dropbox\Mina Dokument\..."). The
// drive-letter segment ("D:") is left un-encoded — encodeURIComponent would
// turn it into "D%3A", which Chromium does NOT decode back to a drive letter,
// silently breaking every single local-file image load.
function toFileUrl(winPath) {
  const normalized = winPath.replace(/\\/g, "/");
  const encoded = normalized
    .split("/")
    .map((segment) => (/^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join("/");
  return "file:///" + encoded;
}

// Full-size click-to-enlarge view for an attached image — dismissed by
// clicking anywhere (including the image itself) or pressing Escape.
function showImageLightbox(fileUrl) {
  const overlay = document.createElement("div");
  overlay.className = "image-lightbox";
  const img = document.createElement("img");
  img.src = fileUrl;
  overlay.append(img);
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      close();
    }
  };
  overlay.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
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

// Short deadline label for the sidebar chip, or "" when the deadline is too
// far off to be worth showing (matches sessions.js's 7-day deadlineBoost
// cutoff — beyond that it doesn't affect sorting, so it shouldn't clutter
// the row either). null/non-number → "".
function deadlineChipText(ms) {
  if (typeof ms !== "number") {
    return "";
  }
  const DAY = 24 * 60 * 60 * 1000;
  const msLeft = ms - Date.now();
  if (msLeft < 0) {
    return "overdue";
  }
  if (msLeft < DAY) {
    return "due today";
  }
  const days = Math.round(msLeft / DAY);
  if (days <= 7) {
    return `due in ${days}d`;
  }
  return "";
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

// Context-window size for a pane's session: prefer the real window Maestro
// learned for that session's model (from the CLI's result events, stored in
// config.modelContextWindows), fall back to the configurable default for a
// model not yet seen. Used to turn the token estimate into the gauge's %.
function contextWindowForPane(pane) {
  const model = sessionById(pane.sessionId)?.model;
  const learned = state.config.modelContextWindows || {};
  return (model && learned[model]) || state.config.contextWindowTokens || 1000000;
}

// state.sessions is only refreshed by the 30s poll / explicit refresh() —
// it does NOT update live as a run streams. Without this, a reply that
// streams in mid-conversation renders against the SESSION's stale
// lastActivityAt, which can still exactly equal an earlier
// acknowledgedSessions timestamp — making wireDoneButtonOnLastReply's
// isAcked check wrongly true and the Done checkmark "follow along" onto a
// brand new reply it was never actually placed on (caught by Aidin: "om jag
// sen fortsätter prompta tillkommer nya saker och då ska inte checkmarken
// följa med"). Bumping this the moment new content actually streams in
// invalidates the stale match immediately, without waiting for a poll.
function bumpSessionActivity(sessionId) {
  const session = sessionById(sessionId);
  if (session) {
    session.lastActivityAt = Date.now();
  }
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
// history). Purely hides it from the sidebar via config; restorable from
// the Archive page.
async function removeFromMaestro(session) {
  const hidden = [...(state.config.hiddenSessions || []), session.sessionId];
  state.config = await window.maestro.setConfig({ hiddenSessions: hidden });
  refresh();
}

async function restoreToMaestro(session) {
  const hidden = (state.config.hiddenSessions || []).filter((id) => id !== session.sessionId);
  state.config = await window.maestro.setConfig({ hiddenSessions: hidden });
  await refresh();
  refreshArchivePageIfVisible();
}

// refresh() only ever re-renders the sidebar — Analysis/Settings/Archive are
// pull-based (re-rendered on tab switch), which would otherwise leave a
// just-restored/unarchived row stale on screen if you're currently ON the
// Archive page when you click its own action button.
function refreshArchivePageIfVisible() {
  if (!document.getElementById("archivePage").classList.contains("hidden")) {
    renderArchivePage();
  }
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

// From the Archive page — flips isArchived back to false so the session
// reappears both in Maestro's sidebar and in the real desktop app.
async function unarchiveSession(session) {
  const res = await window.maestro.archiveSession(session.sessionId, false);
  if (!res.ok) {
    console.error("[maestro] unarchive failed:", res.error);
    showToast(`Couldn't unarchive "${session.title}": ${res.error}`);
    return;
  }
  await refresh();
  refreshArchivePageIfVisible();
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

// Context-size + quota popover, opened from the composer's context gauge —
// the combined readout Aidin wanted (like Claude Code: click the context
// meter, see both context and quota). Only one is ever open; a second click
// or an outside click closes it (closeContextPopover is wired into the
// document click handler alongside closeContextMenu).
function closeContextPopover() {
  document.querySelectorAll(".context-popover").forEach((el) => el.remove());
}

function cpopBarRow(labelText, valueText, pct, high) {
  const row = document.createElement("div");
  row.className = "cpop-row";
  const top = document.createElement("div");
  top.className = "cpop-row-top";
  const l = document.createElement("span");
  l.textContent = labelText;
  const v = document.createElement("span");
  v.className = "cpop-val";
  v.textContent = valueText;
  top.append(l, v);
  const bar = document.createElement("span");
  bar.className = "ctx-bar";
  const fill = document.createElement("span");
  fill.className = "ctx-fill" + (high ? " high" : "");
  fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  bar.append(fill);
  row.append(top, bar);
  return row;
}

function toggleContextPopover(anchor, pane) {
  const existing = document.querySelector(".context-popover");
  closeContextPopover();
  if (existing) {
    return; // it was open under this or another gauge — toggle shut
  }
  const pop = document.createElement("div");
  pop.className = "context-popover";
  pop.addEventListener("click", (e) => e.stopPropagation()); // clicks inside don't close it

  const windowTokens = contextWindowForPane(pane);
  const fmtK = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
  const fmtWindow = windowTokens >= 1000000 ? `${(windowTokens / 1000000).toFixed(windowTokens % 1000000 === 0 ? 0 : 1)}M` : `${Math.round(windowTokens / 1000)}k`;

  if (typeof pane.contextTokens === "number") {
    const pct = Math.round((pane.contextTokens / windowTokens) * 100);
    pop.append(cpopBarRow("Context window", `${fmtK(pane.contextTokens)} / ${fmtWindow} (${pct}%)`, pct, pct >= 85));
  }

  const q = state.quota;
  if (q) {
    const qpct = Math.round((q.utilization || 0) * 100);
    pop.append(cpopBarRow(`Quota · ${q.rateLimitType || "limit"}`, `${qpct}% used`, qpct, qpct >= 80));
  } else {
    const none = document.createElement("div");
    none.className = "cpop-empty";
    none.textContent = "Quota: — (no data yet)";
    pop.append(none);
  }

  // Anchor above the gauge, right-aligned to it.
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(8, r.right - pop.offsetWidth)}px`;
  pop.style.top = `${r.top - pop.offsetHeight - 6}px`;
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
      // The submenu opens at left:100% of its parent item by default —
      // right-clicking a row near the right edge of the window (a very
      // normal thing to do) pushed it off-screen with no way to reach its
      // items. Estimate against the submenu's own min-width (160px, set in
      // CSS) rather than measuring the real rect, since it's display:none
      // until hover and measuring a hidden element just returns zeros.
      el.addEventListener("mouseenter", () => {
        const itemRect = el.getBoundingClientRect();
        const submenuMinWidth = 160;
        sub.classList.toggle("flip-left", itemRect.right + submenuMinWidth > window.innerWidth);
      });
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

document.addEventListener("click", () => {
  closeContextMenu();
  closeContextPopover();
});
document.addEventListener("contextmenu", (e) => {
  if (!e.target.closest("[data-has-menu]")) {
    closeContextMenu();
  }
});
// The menu previously only closed on an outside click — no keyboard way to
// dismiss it at all, matching the image lightbox's own Escape handling.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeContextMenu();
    closeContextPopover();
  }
});

// Mouse side buttons (back = button 3, forward = button 4) drive the focused
// pane's chat history the same as the ←/→ header buttons — Aidin asked for
// the physical back/forward buttons to work too. Uses mouseup (fires for
// these buttons in Chromium) and guards focusedPaneIndex being a live pane.
document.addEventListener("mouseup", (e) => {
  if (e.button !== 3 && e.button !== 4) {
    return;
  }
  e.preventDefault();
  if (!panes[focusedPaneIndex]) {
    return;
  }
  navigateHistory(focusedPaneIndex, e.button === 3 ? -1 : 1);
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

// Clears the drop indicator everywhere so only one row is ever marked. The
// indicator is a CSS class drawing an absolutely-positioned pseudo-element
// line — NOT a real element in the list flow — so toggling it never shifts
// layout and never moves the rects the position math depends on.
function clearDropIndicators() {
  document
    .querySelectorAll(".row.drop-before, .row.drop-after")
    .forEach((el) => el.classList.remove("drop-before", "drop-after"));
}

function clearCategoryDropIndicators() {
  document
    .querySelectorAll(".section.drop-before, .section.drop-after")
    .forEach((el) => el.classList.remove("drop-before", "drop-after"));
}

// Reorders state.config.groups by moving draggedLabel to just before/after
// targetLabel. Splice-based, same shape as moveSessionToGroup's reorder.
async function reorderCategory(draggedLabel, targetLabel, before) {
  const groups = [...(state.config.groups || [])];
  const draggedIdx = groups.findIndex((g) => g.label === draggedLabel);
  if (draggedIdx === -1) {
    return;
  }
  const [dragged] = groups.splice(draggedIdx, 1);
  const targetIdx = groups.findIndex((g) => g.label === targetLabel);
  if (targetIdx === -1) {
    groups.push(dragged);
  } else {
    groups.splice(before ? targetIdx : targetIdx + 1, 0, dragged);
  }
  state.config = await window.maestro.setConfig({ groups });
  renderSidebar();
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

    // Deadline chip — only when close enough to actually matter for sorting
    // (within a week or overdue), matching the deadlineBoost tiers in
    // sessions.js. Makes the deadline-aware ordering legible: it explains
    // why a session with little other activity is sitting near the top.
    const deadlineText = deadlineChipText(session.jot.nearestDeadline);
    if (deadlineText) {
      const d = document.createElement("div");
      d.className = "row-deadline" + (session.jot.nearestDeadline < Date.now() ? " overdue" : "");
      d.textContent = "⏰ " + deadlineText;
      row.append(d);
    }
  }

  // "Orchestrator proposes, you approve" — only ever a suggestion. Clicking
  // this pill IS the approval step; nothing archives without it. Only shown
  // for genuinely idle sessions with no open Jot work, and never for a
  // Maestro-building session (idle between long autonomous stretches doesn't
  // mean done).
  const hasOpenJotWork =
    session.jot && (session.jot.review > 0 || session.jot.inProgress > 0 || session.jot.open > 0);
  // Fas 3 orchestrator-helper tag — a periodic Haiku classifier's read of
  // the actual conversation content (see main.js's runOrchestratorSweep,
  // PLAN.md Phase 3). Shown whenever present so its judgment is auditable,
  // not a black box (the full visualizer is deliberately deferred until
  // there's real behavior to design around — this is the minimal version:
  // just show what it concluded and why, right on the row it's about).
  if (session.orchestratorTag) {
    const tag = document.createElement("div");
    tag.className = "row-orchestrator-tag";
    tag.title = "Orchestrator helper's read of this session's content (a proposal, never acts on its own).";
    tag.textContent = `◎ ${session.orchestratorTag.reason}`;
    row.append(tag);
  }
  // Auto-compact note — the helper compacted this session automatically (per
  // Aidin's choice of automatic-not-propose for compaction). Shown so a
  // silent background compaction is at least visible after the fact, until
  // the next real activity clears it (main.js gates that on transcript size).
  if (session.autoCompacted) {
    const c = document.createElement("div");
    c.className = "row-orchestrator-tag";
    c.title = "The orchestrator helper auto-compacted this session's context (the full history is still on disk).";
    const pre = session.autoCompacted.preTokens;
    const post = session.autoCompacted.postTokens;
    const fmt = (n) => (typeof n === "number" ? `${Math.round(n / 1000)}k` : "?");
    c.textContent = post !== null ? `⊟ Auto-compacted (${fmt(pre)} → ${fmt(post)} tokens)` : "⊟ Auto-compacted";
    row.append(c);
  }
  // "Orchestrator proposes, you approve" — only ever a suggestion. Clicking
  // this pill IS the approval step; nothing archives without it. Sessions
  // still sitting in "waiting" (inside the attention window) but that the
  // helper has actually READ and concluded are genuinely done skip the wait
  // for the window to expire into "idle" — this is what "replaces the idle
  // proxy with something that's actually read the content" (PLAN.md) means
  // in practice. Never shown for a Maestro-building session (idle between
  // long autonomous stretches doesn't mean done).
  const classifierSaysDone = session.orchestratorTag?.statusTag === "done_not_archived";
  if (
    state.config.archiveSuggestions?.enabled === true &&
    (session.status === "idle" || classifierSaysDone) &&
    !hasOpenJotWork &&
    !isOrchestratorSession(session)
  ) {
    const suggest = document.createElement("button");
    suggest.type = "button";
    suggest.className = "archive-suggest-pill";
    suggest.textContent = "Archive?";
    suggest.title = classifierSaysDone
      ? "Suggested: the orchestrator helper read this conversation and concluded it's done. Click to archive."
      : "Suggested: this session looks idle with no open Jot work. Click to archive.";
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
    clearDropIndicators();
    dropTarget = null;
  });

  // VS Code-style: hovering the top/bottom half of a row marks that edge.
  // The marker is a pure CSS class (absolutely-positioned pseudo-element,
  // zero layout impact), and the exact {row, before} shown here is stashed
  // in dropTarget so the drop handler acts on the SAME decision — no second,
  // independently-recomputed measurement that could disagree with it.
  row.addEventListener("dragover", (e) => {
    e.preventDefault();
    // A category being dragged (reordering the lists themselves) has no
    // business showing a session-row drop indicator — this row would never
    // actually receive that drop (its own drop handler below no-ops on a
    // missing "text/session-id"), so without this guard it falsely promised
    // a valid target. Found in review, alongside the same drag also being
    // able to leave a stale .section indicator AND a stale .row indicator
    // visible at once, since neither handler cleared the other's markers.
    if (e.dataTransfer.types.includes("text/category-label")) {
      return;
    }
    e.stopPropagation();
    // No indicator on the row being dragged — dropping onto yourself is a
    // no-op, and marking it would just be visual noise.
    if (row.classList.contains("dragging")) {
      clearDropIndicators();
      dropTarget = null;
      return;
    }
    const rect = row.getBoundingClientRect();
    const before = e.clientY - rect.top < rect.height / 2;
    if (dropTarget && dropTarget.row === row && dropTarget.before === before) {
      return; // unchanged since last event — nothing to redraw
    }
    dropTarget = { row, before };
    clearDropIndicators();
    row.classList.add(before ? "drop-before" : "drop-after");
  });
  row.addEventListener("drop", (e) => {
    e.preventDefault();
    // Same reasoning as the dragover guard above — a category drop landing
    // here isn't for this row at all.
    if (e.dataTransfer.types.includes("text/category-label")) {
      return;
    }
    e.stopPropagation();
    // Dropping onto the row being dragged is a no-op (dragover cleared
    // dropTarget for it) — bail before it degenerates into an append.
    if (row.classList.contains("dragging")) {
      clearDropIndicators();
      dropTarget = null;
      return;
    }
    const list = row.parentElement;
    const groupLabel = list.dataset.groupLabel;
    // Read the position from the indicator that was actually shown, not a
    // fresh rect measurement — guarantees the drop lands where you saw it.
    const insertBeforeId = groupLabel ? insertBeforeIdFromDropTarget() : null;
    clearDropIndicators();
    dropTarget = null;
    const sid = e.dataTransfer.getData("text/session-id");
    if (sid) {
      moveSessionToGroup(sid, groupLabel || null, insertBeforeId);
    }
  });

  return row;
}

// Translates the shown {row, before} indicator into the sessionId to insert
// in front of (null = append to end). "After row X" means "before whatever
// follows X" — and a following .dragging row is skipped so dropping just
// below the item you're dragging isn't a confusing no-op-that-looks-like-move.
function insertBeforeIdFromDropTarget() {
  if (!dropTarget) {
    return null;
  }
  const { row, before } = dropTarget;
  if (before) {
    return row.dataset.sessionId;
  }
  let next = row.nextElementSibling;
  while (next && next.classList.contains("dragging")) {
    next = next.nextElementSibling;
  }
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

// If a summarize launch's "done"/"error" event never arrives (a crashed main
// process, a dropped IPC message), the callback registered below would
// otherwise wait forever — the caller's `await summarizeSession(...)` never
// resolves and the pane's status line stays stuck on "Summarizing…"
// indefinitely. This bounds the wait; a real Sonnet summarization of even a
// very long conversation should finish well under this.
const SUMMARIZE_TIMEOUT_MS = 5 * 60 * 1000;

function summarizeSession(session) {
  return new Promise(async (resolve) => {
    const res = await window.maestro.startSession({
      cwd: session.cwd,
      prompt: CARRY_OVER_PROMPT,
      model: "claude-sonnet-5",
      effort: "medium",
      resumeSessionId: session.cliSessionId || session.sessionId,
      // Maestro-internal launch (the hidden carry-over summary), not a real
      // user turn — keeps it out of the usage log, the "prompt finished"
      // notification, and the model-fit judge, which would otherwise spend a
      // real judge call on it AND contaminate the By-model / Model-fit /
      // Suggestion-accuracy analytics with a synthetic run the user never
      // initiated (model forced to sonnet-5, a hidden prompt).
      internal: true,
    });
    if (!res.ok) {
      resolve({ error: res.error });
      return;
    }
    const timeoutId = setTimeout(() => {
      pendingLaunchCallbacks.delete(res.launchId);
      resolve({ error: "Timed out waiting for the summary." });
    }, SUMMARIZE_TIMEOUT_MS);
    pendingLaunchCallbacks.set(res.launchId, {
      assistantText: "",
      onDone: (text, error) => {
        clearTimeout(timeoutId);
        resolve(error ? { error } : { text });
      },
    });
  });
}

// Prefers an existing empty pane over forcing a new split, so this doesn't
// clutter the workspace when one is already free. `avoidIndex` is a pane
// that must NOT be auto-clobbered — used by "Summarize & carry over", whose
// all-panes-full fallback would otherwise overwrite the pane you're looking
// at. (Rewind does NOT use this — it deliberately targets its own source
// pane via openFreshDraftInPane's forceIndex.) The chosen pane's in-memory
// view is replaced, but the replaced session's transcript on disk is
// untouched and still reopenable from the sidebar.
function pickDraftTargetPane(avoidIndex) {
  const emptyIndex = panes.findIndex((p) => !p.sessionId && p.turns.length === 0 && !p.busy);
  if (emptyIndex !== -1) {
    return { index: emptyIndex, addedPane: false };
  }
  if (panes.length < 2) {
    panes.push(freshPane());
    return { index: panes.length - 1, addedPane: true };
  }
  // Both panes full: use the one that ISN'T the source, so the pane the
  // action came from stays intact. Only fall back to avoidIndex if there's
  // genuinely no other pane (avoidIndex undefined, or a future 1-pane edge).
  const alternative = panes.findIndex((_, i) => i !== avoidIndex);
  return { index: alternative !== -1 ? alternative : focusedPaneIndex, addedPane: false };
}

// opts.forceIndex — drop the draft into THIS exact pane, replacing whatever's
// there (used by rewind: Aidin wants it in the SAME pane, feeling like going
// back in the current conversation, not a new pane popping up). opts.avoidIndex
// — a pane that must NOT be auto-picked (summarize's safety so it doesn't
// clobber the pane you're looking at). With neither, pickDraftTargetPane
// prefers an empty/new pane. Either way the target pane's in-memory view is
// replaced by a fresh draft; the replaced session's transcript on disk is
// untouched and reopenable from the sidebar.
function openFreshDraftInPane(cwd, draftText, opts = {}) {
  let index;
  let addedPane = false;
  if (typeof opts.forceIndex === "number") {
    index = opts.forceIndex;
  } else {
    ({ index, addedPane } = pickDraftTargetPane(opts.avoidIndex));
  }
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

// fromHistoryNav is true only when THIS call originated from clicking the
// back/forward buttons — it skips the history push below so navigating
// backward doesn't itself get recorded as a new forward step.
function openSessionInPane(session, paneIndex, forceSplit, fromHistoryNav) {
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
  if (!fromHistoryNav) {
    pushNavHistory(paneIndex, session.sessionId);
  }
  if (addedPane) {
    renderWorkspace(); // pane count changed — full rebuild is unavoidable here
  } else {
    renderSinglePane(paneIndex); // leaves any typing in the other pane intact
  }
  renderSidebar();
  loadTranscriptInto(paneIndex);
}

function pushNavHistory(paneIndex, sessionId) {
  let entry = paneNavHistory.get(paneIndex);
  if (!entry) {
    entry = { stack: [], position: -1 };
    paneNavHistory.set(paneIndex, entry);
  }
  // Same as a browser tab: navigating to something new after having gone
  // back drops whatever forward history existed past this point.
  entry.stack = entry.stack.slice(0, entry.position + 1);
  entry.stack.push(sessionId);
  entry.position = entry.stack.length - 1;
}

function canNavigateHistory(paneIndex, delta) {
  const entry = paneNavHistory.get(paneIndex);
  if (!entry) {
    return false;
  }
  const target = entry.position + delta;
  return target >= 0 && target < entry.stack.length;
}

function navigateHistory(paneIndex, delta) {
  const entry = paneNavHistory.get(paneIndex);
  if (!entry) {
    return;
  }
  // Walk in the requested direction until a still-existing session is
  // found, rather than committing to the first entry regardless — a
  // session in history can have been archived/removed since. Committing
  // `position` on a dead entry before confirming it exists left the
  // pointer silently advanced with nothing opened, desyncing the ←/→
  // buttons' disabled state from what was actually still navigable.
  let candidate = entry.position + delta;
  while (candidate >= 0 && candidate < entry.stack.length) {
    const session = sessionById(entry.stack[candidate]);
    if (session) {
      entry.position = candidate;
      openSessionInPane(session, paneIndex, false, true);
      return;
    }
    candidate += delta;
  }
  // Nothing valid in that direction — re-render so the buttons reflect
  // reality even though nothing changed.
  renderSinglePane(paneIndex);
}

async function loadTranscriptInto(paneIndex) {
  const pane = panes[paneIndex];
  if (!pane || !pane.cliSessionId) {
    return;
  }
  const { turns, hiddenCount, truncated, contextTokens } = await window.maestro.getTranscript({
    cliSessionId: pane.cliSessionId,
    sessionId: pane.sessionId,
  });
  if (panes[paneIndex] !== pane) {
    return; // pane was reassigned while loading
  }
  pane.turns = turns;
  pane.hiddenCount = hiddenCount || 0;
  pane.contextTokens = typeof contextTokens === "number" ? contextTokens : null;
  // The composer was built before this async load finished, so its gauge
  // rendered empty — refresh it now that we have the number.
  pane.els?.renderContextGauge?.();
  // Whether this view is missing earlier turns (turn-cap or byte-tail cap).
  // Rewind needs the full transcript from turn 0 — the rendered index it
  // passes to the fork counts from the first shown bubble, but the fork
  // counts from the file's absolute start, so a truncated view would cut at
  // the wrong message. Rewind is only offered when this is false.
  pane.transcriptTruncated = !!truncated;
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
    // Reordering categories themselves — only sessions could be dragged
    // before (found in review: category order had no drag handle at all).
    // A distinct dataTransfer type ("text/category-label", never
    // "text/session-id") keeps this from ever being confused with a
    // session drag — the existing session handlers already guard on
    // getData(...) being non-empty, so a category-type drag landing on a
    // session row's handlers is a harmless no-op. Only the header itself is
    // draggable, not the whole (often much taller, session-count-dependent)
    // section — a small fixed-size handle is far easier to aim than
    // splitting a tall section into "top half vs bottom half."
    head.draggable = true;
    head.addEventListener("dragstart", (e) => {
      e.stopPropagation();
      // dataTransfer is only writable synchronously inside dragstart, so
      // these two MUST stay here.
      e.dataTransfer.setData("text/category-label", label);
      e.dataTransfer.effectAllowed = "move";
      categoryDragStartedAt = Date.now();
      // Collapse every session list to just its header for the duration of a
      // category drag (Aidin's ask) — with sessions expanded, reordering
      // categories means dragging past long lists and losing sight of the
      // order; header-only makes the target position obvious.
      //
      // Deferred to the next tick, NOT done synchronously here: hiding the
      // .section-list elements mid-dragstart reflows the drag SOURCE, which
      // Chromium/Electron treats as grounds to cancel the drag outright —
      // that's the "can't drag a list anymore" regression this feature
      // introduced. Letting dragstart finish first, then collapsing, keeps
      // the drag alive. requestAnimationFrame over setTimeout(0) so the
      // collapse paints on the very next frame with no visible flicker.
      requestAnimationFrame(() => {
        // Guard: the drag may have already ended (a very fast click-release)
        // by the time this fires — don't collapse if we're no longer dragging.
        if (categoryDragStartedAt !== null) {
          wrap.classList.add("dragging");
          document.getElementById("sidebarBody").classList.add("dragging-category");
        }
      });
    });
    head.addEventListener("dragend", () => {
      wrap.classList.remove("dragging");
      document.getElementById("sidebarBody").classList.remove("dragging-category");
      categoryDragStartedAt = null;
      clearCategoryDropIndicators();
      categoryDropTarget = null;
    });

    // Dropping a SESSION directly on the header appends it to the end of
    // that category (existing behavior). Dropping a CATEGORY shows a
    // before/after indicator on the whole section instead — same header,
    // branched on drag type via dataTransfer.types (readable during
    // dragover; getData itself is only reliably readable at drop in some
    // browsers).
    head.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer.types.includes("text/category-label")) {
        clearDropIndicators(); // no leftover session-row marker while reordering categories
        dropTarget = null;
        if (wrap.classList.contains("dragging")) {
          clearCategoryDropIndicators();
          categoryDropTarget = null;
          return; // dropping a category onto itself is a no-op, mirroring the row pattern
        }
        const rect = head.getBoundingClientRect();
        const before = e.clientY - rect.top < rect.height / 2;
        if (categoryDropTarget && categoryDropTarget.wrap === wrap && categoryDropTarget.before === before) {
          return;
        }
        categoryDropTarget = { wrap, label, before };
        clearCategoryDropIndicators();
        wrap.classList.add(before ? "drop-before" : "drop-after");
        return;
      }
      head.classList.add("drag-over");
      // Hovering the header means "append here", not "between two rows" —
      // clear any row edge-marker left over from passing over rows.
      clearDropIndicators();
      dropTarget = null;
    });
    head.addEventListener("dragleave", () => head.classList.remove("drag-over"));
    head.addEventListener("drop", (e) => {
      e.preventDefault();
      head.classList.remove("drag-over");
      const draggedLabel = e.dataTransfer.getData("text/category-label");
      if (draggedLabel) {
        const target = categoryDropTarget;
        clearCategoryDropIndicators();
        categoryDropTarget = null;
        if (draggedLabel !== label) {
          reorderCategory(draggedLabel, label, target ? target.before : true);
        }
        return;
      }
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
    // Same reasoning as the row/header guards: a category-reorder drag has
    // no business highlighting a session list's empty space as a drop
    // target it will never actually use.
    if (e.dataTransfer.types.includes("text/category-label")) {
      return;
    }
    if (e.target === el) {
      el.classList.add("drag-over");
      // Over the list's own empty space (not a row) = append; drop any
      // leftover row edge-marker so the two indicators don't both show.
      clearDropIndicators();
      dropTarget = null;
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
  const pinned = document.getElementById("sidebarPinned");
  body.innerHTML = "";
  pinned.innerHTML = "";
  // Defensive: the category-drag "collapse lists to headers" class lives on
  // this persistent element, cleared on dragend. If dragend ever fails to
  // fire (odd HTML5-drag cancel path), a full re-render must not leave every
  // session list stuck hidden.
  body.classList.remove("dragging-category");

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
  // Lives in its own #sidebarPinned slot, a sibling of the scrollable
  // #sidebarBody rather than its first child — appending it INSIDE the
  // scrolling body meant it scrolled out of view with everything else,
  // defeating the point of "always visible."
  const maestroSessions = visible.filter(isOrchestratorSession);
  const maestroIds = new Set(maestroSessions.map((s) => s.sessionId));
  if (maestroSessions.length > 0) {
    pinned.append(orchestratorCardEl(sortByAttention(maestroSessions)[0]));
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

// Splits a table row on "|" the way GFM actually requires: a pipe inside an
// inline code span (`...`) or escaped as "\|" is literal cell content, not a
// column delimiter. A naive line.split("|") mangles any cell containing
// either — e.g. a cell showing `Set-Cookie: a|b` would split into two
// columns instead of one, misaligning the whole row.
function tableCells(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let current = "";
  let inCode = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "\\" && trimmed[i + 1] === "|") {
      current += "|";
      i++;
      continue;
    }
    if (ch === "`") {
      inCode = !inCode;
      current += ch;
      continue;
    }
    if (ch === "|" && !inCode) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
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

const isListLine = (line) => /^\s*[-*]\s+/.test(line);

// Walks from idx in the given direction (-1 back, +1 forward), skipping
// blank separator lines, and returns the nearest actual content line (or ""
// if the text runs out first). A plain "lines[idx-1]"/"lines[idx+1]" check
// only sees ONE line away — with two-or-more consecutive blank lines
// between a list and the next paragraph (or vice versa), that only catches
// the single blank immediately touching the list, leaving the rest to
// render as ordinary empty lines and reintroduce the doubled-gap problem
// this whole block exists to avoid.
function nearestContentLine(lines, idx, direction) {
  for (let i = idx + direction; i >= 0 && i < lines.length; i += direction) {
    if (lines[i].trim() !== "") {
      return lines[i];
    }
  }
  return "";
}

function renderInlineLines(container, text) {
  const lines = text.split("\n");
  lines.forEach((line, idx) => {
    const nextLine = lines[idx + 1];
    const isBlank = line.trim() === "";
    const isList = isListLine(line);

    // A blank line whose only job in the source markdown is separating list
    // items isn't content — rendering it (an empty <span> + a trailing <br>)
    // both doubled the visible gap AND sat between the two .md-li divs,
    // breaking their sibling adjacency so ".md-li + .md-li" (meant to
    // tighten spacing between bullets) never actually matched anything.
    // Checks the nearest CONTENT line in each direction, not just one line
    // away — two or more consecutive blank lines between a list and the
    // next paragraph would otherwise leave every blank past the first to
    // render as an ordinary empty line, reintroducing the doubled gap.
    if (isBlank && (isListLine(nearestContentLine(lines, idx, -1)) || isListLine(nearestContentLine(lines, idx, 1)))) {
      return;
    }

    if (isList) {
      const listMatch = /^\s*[-*]\s+(.*)$/.exec(line);
      const li = document.createElement("div");
      li.className = "md-li";
      li.append(document.createTextNode("• "), ...inlineFormat(listMatch[1]));
      container.append(li);
    } else {
      const lineSpan = document.createElement("span");
      // The transition INTO a list gets a deliberate gap (.md-li's own
      // margin-top). The transition OUT of one got nothing — a plain <span>
      // has no margin rule at all, so the line right after the last bullet
      // sat flush against it with only incidental line-height between them,
      // reading as "tight"/inconsistent next to every other spaced
      // transition. This class gives it the matching gap.
      if (isListLine(nearestContentLine(lines, idx, -1))) {
        lineSpan.className = "md-after-list";
      }
      lineSpan.append(...inlineFormat(line));
      container.append(lineSpan);
    }

    // A list item is already display:block and self-breaks onto its own
    // line — a <br> touching one on either side is exactly what broke
    // .md-li adjacency above. Only insert one between two plain lines.
    if (idx < lines.length - 1 && !isList && !isListLine(nextLine || "")) {
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
  if (turn.kind === "compact_boundary") {
    return compactBoundaryEl(turn);
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
    // Icon-only, shown on hover (was an always-visible "Copy" text button —
    // per feedback that read as too loud sitting under every single reply).
    const copyBtn = document.createElement("button");
    copyBtn.className = "copy-btn";
    copyBtn.title = "Copy";
    copyBtn.textContent = "⧉";
    copyBtn.addEventListener("click", () => {
      window.maestro.copyToClipboard(turn.text);
      copyBtn.textContent = "✓";
      copyBtn.classList.add("copied");
      setTimeout(() => {
        copyBtn.textContent = "⧉";
        copyBtn.classList.remove("copied");
      }, 1200);
    });
    // A row, not a column — so a "Done" button (added later, only on the
    // LAST reply, by wireDoneButtonOnLastReply) sits BESIDE copy, not
    // stacked under it. Every reply gets this row; only the last one ever
    // gets a second button in it.
    const actions = document.createElement("div");
    actions.className = "turn-actions";
    actions.append(copyBtn);
    wrap.append(actions);
  }

  return wrap;
}

// A run of consecutive tool calls collapses into ONE plain, unboxed
// "Used N tools" line — matching the desktop app's flat "Used 3 tools ›" /
// "Searched code ›" style — instead of a separate bordered box per call
// (which read as heavy/boxy per feedback comparing the two side by side).
// A background task/subagent completion, delivered as raw <task-notification>
// XML — shown as a compact expandable line (like a tool call), not as a
// normal chat bubble, since Aidin didn't actually type this.
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

// A centered divider marking where the conversation was compacted — shown
// for ANY compaction found in the transcript: the CLI's own auto-compact
// when the window fills (trigger "auto"), Maestro's Fas 3 auto-compact, or a
// manual /compact (both "manual"). Mirrors the desktop app showing where
// context was summarized. Aidin's ask: "skriv även ut i chatten med en pill
// att compacting skett."
function compactBoundaryEl(turn) {
  const wrap = document.createElement("div");
  wrap.className = "compact-boundary";
  const pill = document.createElement("span");
  pill.className = "compact-boundary-pill";
  const triggerLabel = turn.trigger === "auto" ? "auto" : "manual";
  const fmt = (n) => (typeof n === "number" ? `${Math.round(n / 1000)}k` : "?");
  const sizePart =
    typeof turn.preTokens === "number" && typeof turn.postTokens === "number"
      ? ` · ${fmt(turn.preTokens)} → ${fmt(turn.postTokens)} tokens`
      : "";
  pill.textContent = `⊟ Context compacted (${triggerLabel})${sizePart}`;
  pill.title = "The conversation before this point was summarized to free up context. The full history is still on disk.";
  wrap.append(pill);
  return wrap;
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
      const { turns, hiddenCount, truncated } = await window.maestro.getTranscript({
        cliSessionId: pane.cliSessionId,
        sessionId: pane.sessionId,
      });
      pane.turns = turns;
      // Reflect the reload's ACTUAL state rather than hardcoding 0 — on a
      // genuinely huge session the reload can still be byte-capped, and
      // pretending it's complete would wrongly re-enable rewind (which needs
      // a from-turn-0 view to index correctly).
      pane.hiddenCount = hiddenCount || 0;
      pane.transcriptTruncated = !!truncated;
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
    wireDoneButtonOnLastReply(index, scroll);
  }
  wireScrollToBottomButton(scroll);
  scroll.scrollTop = scroll.scrollHeight;
}

// A floating "↓" button that appears once the user has manually scrolled
// away from the bottom (e.g. to reread earlier history) and disappears once
// they're back at the bottom. renderPane rebuilds .pane-scroll's innerHTML
// on every call, so this — like the other wireX helpers — has to be
// re-attached every render, not wired once. Deliberately a sticky, zero-
// height wrapper as the LAST child of .pane-scroll rather than an
// absolutely-positioned sibling of the scroll container: it needs to sit
// pinned to the bottom of the SCROLLED viewport (following the user as they
// scroll), not to the pane's own fixed bottom edge.
function wireScrollToBottomButton(scroll) {
  const wrap = document.createElement("div");
  wrap.className = "scroll-to-bottom-wrap";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "scroll-to-bottom-btn";
  btn.title = "Scroll to bottom";
  // Inline SVG rather than the "↓" text glyph — text arrows have asymmetric
  // font metrics that no amount of flex-centering fixes (it kept looking
  // slightly high). A viewBox'd SVG is geometrically symmetric, so it
  // centers perfectly.
  btn.innerHTML =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg>';
  btn.addEventListener("click", () => {
    scroll.scrollTo({ top: scroll.scrollHeight, behavior: "smooth" });
  });
  wrap.append(btn);
  scroll.append(wrap);

  // `scroll` (.pane-scroll) is the SAME persistent DOM node across renders —
  // only its innerHTML gets cleared, not the element itself — so a plain
  // addEventListener here would pile up one more "scroll" listener on every
  // single renderPane call (every streamed chunk, every poll-triggered
  // update...) forever, each stale one still referencing its own
  // now-detached `wrap` from a past render. Removing the previous listener
  // (stashed on the element) before attaching the new one keeps exactly one
  // live listener at a time.
  if (scroll._scrollToBottomListener) {
    scroll.removeEventListener("scroll", scroll._scrollToBottomListener);
  }
  const SHOW_THRESHOLD_PX = 80;
  const listener = () => {
    const distanceFromBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
    wrap.classList.toggle("visible", distanceFromBottom > SHOW_THRESHOLD_PX);
  };
  scroll.addEventListener("scroll", listener);
  scroll._scrollToBottomListener = listener;
}

// Double-click ANY past user message to copy it back into the prompt box for
// editing + resend. Does not alter history — the CLI can't retract a turn via
// --resume, so this is "edit and send again" (appends as a new turn), not a
// true rewind/branch like the desktop app's retry icon.
//
// The real "rewind to here" (mirroring the desktop app's own icon) is the
// separate button added below: it replaces the CURRENT pane in place with a
// fresh draft that replays the conversation up to (not including) this
// message, then the message itself. Per Aidin's review it stays in the same
// pane (feels like going back in this conversation, not a new pane popping
// up) — but underneath it's a fresh forked session, because --resume can't
// retract turns, so this is the only way to genuinely drop future context
// rather than just hide it.
function wireEditableUserTurns(index, scroll) {
  const pane = panes[index];
  // Correlates 1:1 and in DOM order with ".turn.user .turn-bubble" elements:
  // turnEl() only gives a user turn that plain bubble treatment when its
  // kind is "text" (a tool_result gets a separate .turn-tool-result div, and
  // a task_notification is role "system", not "user").
  const userTextTurns = pane.turns.filter((t) => t.role === "user" && t.kind === "text");
  scroll.querySelectorAll(".turn.user .turn-bubble").forEach((bubble, i) => {
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

    const turn = userTextTurns[i];
    const wrap = bubble.parentElement;
    if (!turn || !wrap) {
      return;
    }
    // `i` is exactly this message's index among real user messages — the same
    // count the main-process fork uses to find the truncation point. Only
    // offer rewind on a real (resumable) session AND when the FULL transcript
    // is loaded from turn 0 — on a truncated (tail-capped) view the rendered
    // index wouldn't match the fork's absolute count, so it'd cut at the
    // wrong message.
    if (pane.cliSessionId && !pane.transcriptTruncated) {
      const rewindBtn = document.createElement("button");
      rewindBtn.className = "copy-btn rewind-btn";
      rewindBtn.title = "Rewind to here — go back to this point, dropping everything after it";
      rewindBtn.textContent = "⤺";
      rewindBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        rewindToTurn(index, i, turn.text);
      });
      wrap.append(rewindBtn);
    }
  });
}

// Manual "I'm done with this" — Aidin's ask: a session can end with a real
// answer (e.g. "here's what to tell your colleagues") that needs nothing
// further, but still sits in "Needs you" until the attention window expires.
// Per his correction, this lives ON the reply itself ("per svar, inte per
// session") rather than as a sidebar-row pill — only the LAST assistant
// reply gets the button, since that's the one whose ack actually matters
// (session status is derived from the last message's role/age; acking an
// older reply that already has a newer one after it wouldn't change
// anything). Reuses the same config.acknowledgedSessions mechanism as
// before — only the affordance's location changed, not the backend.
function wireDoneButtonOnLastReply(index, scroll) {
  const pane = panes[index];
  const session = sessionById(pane.sessionId);
  if (!session) {
    return;
  }
  // isAcked is an EXACT match against the timestamp stored at ack time (see
  // main.js's status-override loop, which uses >= for the same comparison —
  // exact equality here is the more precise check for "is the reply I'm
  // currently drawing the specific one that got acknowledged," since the ack
  // value can never exceed the current lastActivityAt unless new activity
  // moved it forward, at which point this is correctly false again).
  const isAcked = state.config.acknowledgedSessions?.[session.sessionId] === session.lastActivityAt;
  if (session.status !== "waiting" && !isAcked) {
    return;
  }
  const bubbles = scroll.querySelectorAll(".turn.assistant .turn-bubble");
  const lastBubble = bubbles[bubbles.length - 1];
  const actions = lastBubble?.parentElement.querySelector(".turn-actions");
  if (!actions) {
    return;
  }
  const done = document.createElement("button");
  done.type = "button";
  // "copy-btn" gives it the same hover-only reveal as the Copy button beside
  // it (Aidin's ask: "en check ikon bredvid copy ikonen som endast dyker upp
  // på hover"). ".acked" overrides that to always-visible + accent-colored —
  // a persistent checkmark on the reply itself ("när den är checkad dyker en
  // checkmark upp på svaret"), not just a transient hover flash. Toggleable
  // (Aidin: "checkmarken bör gå att ta bort också, eller?") — a checkbox you
  // can't uncheck would be an odd affordance, and un-acking is exactly
  // "actually, this does need attention again," the same real state
  // acknowledgedSessions already models.
  let acked = isAcked;
  const applyAckedVisual = () => {
    done.classList.toggle("acked", acked);
    done.title = acked ? "Marked done — click to undo" : "Nothing left to do here — mark done (comes back automatically if new activity happens).";
  };
  done.className = "copy-btn done-btn";
  done.textContent = "✓";
  applyAckedVisual();
  done.addEventListener("click", async (e) => {
    e.stopPropagation();
    // Instant local feedback, same pattern as the copy button's own
    // immediate icon swap, ahead of the async round-trip settling for real.
    acked = !acked;
    applyAckedVisual();
    const acknowledgedSessions = { ...(state.config.acknowledgedSessions || {}) };
    if (acked) {
      acknowledgedSessions[session.sessionId] = session.lastActivityAt;
    } else {
      delete acknowledgedSessions[session.sessionId];
    }
    state.config = await window.maestro.setConfig({ acknowledgedSessions });
    refresh();
  });
  // prepend, not append: Done sits BEFORE Copy in the row. With append, the
  // acked (always-visible) checkmark would sit to the RIGHT of Copy's
  // hover-only slot — so on an acked reply, hovering makes Copy pop in to
  // its LEFT, shifting the checkmark sideways. Leading position keeps the
  // checkmark's spot fixed regardless of hover state.
  actions.prepend(done);
}

// Real "rewind to here" via transcript forking (verified in
// spike/test-rewind-fork.mjs): ask main to fork the session's transcript
// truncated to just before user message #userMsgIndex, then load that fork
// IN THE SAME pane. The result is exactly the desktop app's behavior —
// messages before the rewind point stay as real rendered history (they're
// in the forked transcript), everything after is genuinely gone (the model
// never sees it on resume), and the clicked message drops into the composer
// to edit and re-send. `messageText` prefills that composer.
//
// Known limitation: the fork has no desktop local_*.json metadata, so it
// won't appear in the sidebar's session list — it's a working branch,
// resumable in this pane but not (yet) catalogued.
async function rewindToTurn(index, userMsgIndex, messageText) {
  const pane = panes[index];
  const sourcePane = pane; // identity-check the async result against this
  const res = await window.maestro.forkSession(pane.cliSessionId, userMsgIndex);
  if (!res.ok) {
    showToast(`Couldn't rewind: ${res.error}`);
    return;
  }
  // Pane may have been reset/reused during the await — don't hijack whatever
  // now occupies this slot.
  if (panes[index] !== sourcePane) {
    return;
  }
  panes[index] = {
    ...freshPane(),
    sessionId: res.forkId,
    cliSessionId: res.forkId,
    cwd: sourcePane.cwd,
    title: sourcePane.title, // same conversation, just rewound
    loading: true,
  };
  focusedPaneIndex = index;
  renderSinglePane(index); // builds header + empty composer + scroll
  // Prefill the composer with the rewound message to edit/re-send. Safe to
  // do synchronously right after renderSinglePane — loadTranscriptInto below
  // only rebuilds .pane-scroll, never the composer.
  const promptEl = document.querySelector(`.pane[data-pane="${index}"] .pane-composer textarea`);
  if (promptEl) {
    promptEl.value = messageText || "";
    promptEl.focus();
    promptEl.dispatchEvent(new Event("input"));
  }
  loadTranscriptInto(index); // renders the truncated prior history as real bubbles
}

// paneHeaderEl builds `.pane-sub` (the folder path next to the title) ONCE,
// but renderPane() only ever rebuilds the SCROLL area, never the header — so
// picking a new folder, typing one, or completing a root-folder switch never
// updated the visible path (caught via Aidin's "path bredvid titeln
// ändrades aldrig" observation). Queries the live DOM for the header's own
// pane-sub span and updates/creates/removes it directly, without touching
// anything else in the header.
function updatePaneSubText(index, cwd) {
  const paneEl = document.querySelector(`.pane[data-pane="${index}"]`);
  const header = paneEl?.querySelector(".pane-header");
  if (!header) {
    return;
  }
  let sub = header.querySelector(".pane-sub");
  if (!cwd) {
    sub?.remove();
    return;
  }
  if (!sub) {
    sub = document.createElement("span");
    sub.className = "pane-sub";
    header.append(sub);
  }
  sub.textContent = cwd;
}

function paneHeaderEl(index) {
  const pane = panes[index];
  const header = document.createElement("div");
  header.className = "pane-header";

  const navBack = document.createElement("button");
  navBack.className = "icon-btn";
  navBack.textContent = "←";
  navBack.title = "Previous chat in this pane";
  navBack.disabled = !canNavigateHistory(index, -1);
  navBack.addEventListener("click", () => navigateHistory(index, -1));

  const navForward = document.createElement("button");
  navForward.className = "icon-btn";
  navForward.textContent = "→";
  navForward.title = "Next chat in this pane";
  navForward.disabled = !canNavigateHistory(index, 1);
  navForward.addEventListener("click", () => navigateHistory(index, 1));

  header.append(navBack, navForward);

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
      // Same reasoning as the sidebar's "+ New chat" button — a fresh chat
      // is a new browsing context for this slot.
      paneNavHistory.delete(index);
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
      // If this pane has a live launch, stop it before discarding the pane
      // — otherwise the process keeps running with no UI left able to show
      // its completion or stop it. No map entry to clean up here: once
      // `panes = [panes[0]]` below drops this slot, launchPaneHistory's own
      // identity check (`panes[index] === pane`) naturally rejects any of
      // this launch's late events on its own.
      const closingPane = panes[1];
      if (closingPane?.busy && closingPane.currentLaunchId) {
        window.maestro.stopSession(closingPane.currentLaunchId);
      }
      // A future split reusing slot 1 is a new browsing context — don't let
      // it inherit back/forward history from whatever used to live there.
      paneNavHistory.delete(1);
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

  // Attachment chips (pasted images + picked files), shown between the
  // textarea and the control row. Cleared on send.
  const attachmentsEl = document.createElement("div");
  attachmentsEl.className = "composer-attachments";
  shell.append(attachmentsEl);
  function renderAttachments() {
    attachmentsEl.innerHTML = "";
    attachmentsEl.style.display = pane.pendingAttachments.length ? "flex" : "none";
    pane.pendingAttachments.forEach((att, i) => {
      const chip = document.createElement("span");
      chip.className = "attachment-chip";
      if (att.isImage) {
        const thumb = document.createElement("img");
        thumb.className = "attachment-thumb";
        thumb.src = toFileUrl(att.path);
        thumb.title = "Click to enlarge";
        thumb.addEventListener("click", () => showImageLightbox(thumb.src));
        chip.append(thumb);
      } else {
        chip.append(document.createTextNode("📎 "));
      }
      chip.append(document.createTextNode(att.name));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "attachment-remove";
      remove.textContent = "×";
      remove.title = "Remove attachment";
      remove.addEventListener("click", () => {
        pane.pendingAttachments.splice(i, 1);
        renderAttachments();
      });
      chip.append(remove);
      attachmentsEl.append(chip);
    });
  }
  renderAttachments();

  // "Flika in vs efteråt" scenario 2: queue a follow-up prompt to run
  // automatically once the CURRENT run finishes, for when you're stepping
  // away and want to be sure the next thing you wanted done actually
  // happens. (Scenario 1 — inject info into the run that's happening RIGHT
  // NOW — needs the persistent-process architecture, still an open
  // decision; this half doesn't, since it's just "the next -p call.")
  const queuedEl = document.createElement("div");
  queuedEl.className = "queued-prompt";
  shell.append(queuedEl);
  function renderQueuedPrompt() {
    queuedEl.innerHTML = "";
    if (!pane.queuedPrompt) {
      queuedEl.style.display = "none";
      return;
    }
    queuedEl.style.display = "flex";
    const label = document.createElement("span");
    label.textContent = `⏭ Queued: ${pane.queuedPrompt}`;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "attachment-remove";
    cancel.textContent = "×";
    cancel.title = "Cancel queued prompt";
    cancel.addEventListener("click", () => {
      pane.queuedPrompt = null;
      renderQueuedPrompt();
    });
    queuedEl.append(label, cancel);
  }
  renderQueuedPrompt();

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
        pane.pendingAttachments.push({ path: res.path, name: file.name || `pasted.${ext}`, isImage: true });
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
    updatePaneSubText(index, e.target.value);
  });
  const pickBtn = document.createElement("button");
  pickBtn.className = "icon-btn";
  pickBtn.textContent = "…";
  pickBtn.title = "Pick repo folder";
  pickBtn.addEventListener("click", async () => {
    const folder = await window.maestro.pickFolder();
    // The dialog can stay open indefinitely — same guard as the attach-file
    // and paste-image handlers, so a folder pick doesn't land on a pane that
    // was reset/reused while the dialog was up.
    if (folder && panes[index] === pane) {
      pane.cwd = folder;
      cwdInput.value = folder;
      cwdInput.title = folder;
      updatePaneSubText(index, folder);
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
  // this environment and it did not (Aidin's existing broad allowlists let
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

  // Same mechanism as pasting an image, just picked via a dialog instead of
  // the clipboard — a plain file (any type) attached by path. Read tool
  // handles whatever it can from there; Maestro doesn't need to know the type.
  const attachBtn = document.createElement("button");
  attachBtn.className = "icon-btn";
  attachBtn.textContent = "📎";
  attachBtn.title = "Attach a file";
  attachBtn.addEventListener("click", async () => {
    const filePaths = await window.maestro.pickFiles();
    // The dialog is modal and can sit open a long time — the pane may have
    // been reset while it was up. Same guard as the paste handler.
    if (!filePaths?.length || panes[index] !== pane) {
      return;
    }
    for (const filePath of filePaths) {
      const name = filePath.split(/[\\/]/).pop();
      pane.pendingAttachments.push({ path: filePath, name, isImage: /\.(png|jpe?g|gif|webp|bmp)$/i.test(name) });
    }
    renderAttachments();
  });

  const sendBtn = document.createElement("button");
  sendBtn.className = "send-btn";
  sendBtn.textContent = "➤";
  sendBtn.title = pane.sessionId ? "Continue (Enter)" : "Start session (Enter)";

  controls.append(pickBtn, cwdInput, attachBtn, permissionDD.el, modelDD.el, effortDD.el, sendBtn);
  shell.append(controls);

  // Context-size gauge — a bar + %, under the model/effort row (Aidin's
  // placement). Clicking it opens a popover with the context detail AND the
  // quota, mirroring Claude Code's combined readout. Its own render closure
  // because the composer is built once but pane.contextTokens arrives later,
  // async, from loadTranscriptInto (which calls this to fill it in).
  const contextGauge = document.createElement("button");
  contextGauge.type = "button";
  contextGauge.className = "composer-context";
  const renderContextGauge = () => {
    if (typeof pane.contextTokens !== "number") {
      contextGauge.style.display = "none";
      return;
    }
    contextGauge.style.display = "";
    const windowTokens = contextWindowForPane(pane);
    const pct = Math.min(100, Math.round((pane.contextTokens / windowTokens) * 100));
    contextGauge.innerHTML = "";
    const bar = document.createElement("span");
    bar.className = "ctx-bar";
    const fill = document.createElement("span");
    fill.className = "ctx-fill" + (pct >= 85 ? " high" : "");
    fill.style.width = `${pct}%`;
    bar.append(fill);
    const label = document.createElement("span");
    label.className = "ctx-label";
    label.textContent = `${pct}%`;
    contextGauge.append(bar, label);
    contextGauge.title = "Context in use for this session — click for detail + quota";
  };
  renderContextGauge();
  contextGauge.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleContextPopover(contextGauge, pane);
  });

  // Visible reasoning, not just a hover tooltip — a suggestion nobody reads
  // isn't a suggestion. Explicitly says so even when it just confirms your
  // current pick, per "always decide, and if it's already right, say so."
  const suggestHint = document.createElement("div");
  suggestHint.className = "suggest-hint";

  // Aidin's ask: put the suggestion hint and the context gauge on the SAME
  // row instead of stacking them (they were two separate full-width lines).
  const metaRow = document.createElement("div");
  metaRow.className = "composer-meta-row";
  metaRow.append(suggestHint, contextGauge);
  shell.append(metaRow);
  wrap.append(shell);

  // Model-fit judge verdict lives here, under the composer — not in the chat
  // scrollback — per Aidin's ask, and to keep the conversation itself
  // uncluttered. Cleared on each new send, filled in once the judge resolves.
  const modelFitLine = document.createElement("div");
  modelFitLine.className = "model-fit-line";
  wrap.append(modelFitLine);

  const els = { cwdInput, promptEl, modelDD, effortDD, permissionDD, sendBtn, renderAttachments, renderQueuedPrompt, renderContextGauge };
  // Lets the "done" event handler (which only has the pane object, not this
  // composer's closure) trigger a queued prompt through the exact same send
  // path — reusing sendFromPane's cwd/attachment/suggestion handling instead
  // of duplicating it. Rebuilt every time this composer is (re)created, so
  // it always points at the currently-live set of elements.
  pane.els = els;
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
  // While busy, Enter can't "send" (there's no live channel mid-turn — see
  // the interject architecture note above) — but it can QUEUE the typed
  // text to auto-send once the current run finishes. Previously, typing
  // here and hitting Enter while busy silently discarded the text AND
  // stopped the run (handleSendOrStop ignores promptEl.value entirely while
  // busy) — an easy way to accidentally kill a long run. Stop now only ever
  // happens via an explicit click on the button.
  promptEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey) {
      return;
    }
    e.preventDefault();
    if (pane.busy) {
      const text = promptEl.value.trim();
      if (text) {
        pane.queuedPrompt = text;
        promptEl.value = "";
        renderQueuedPrompt();
      }
      return;
    }
    handleSendOrStop();
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
  if (!typedText && pane.pendingAttachments.length === 0) {
    return;
  }
  // Image attachments become plain file-path mentions ahead of the typed
  // text — Claude Code's own Read tool fetches them from there (see
  // spike/test-image-via-path.mjs). This is what actually gets sent AND what
  // gets shown in history, so the turn matches what the model received.
  const attachmentPrefix = pane.pendingAttachments
    .map((att) => `[Attached ${att.isImage ? "image" : "file"}: ${att.path}]`)
    .join("\n");
  const prompt = attachmentPrefix ? `${attachmentPrefix}\n\n${typedText}` : typedText;
  pane.pendingAttachments = [];
  els.renderAttachments();
  pane.cwd = cwd;
  updatePaneSubText(index, cwd);
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

  // "Switch root folder" (Aidin's question about the "…" picker on an
  // EXISTING session — it silently broke the next send with "No conversation
  // found," since --resume scopes lookup by cwd; see DECISIONS.md). If this
  // is a resumed session and the folder was changed since it was opened,
  // copy the transcript into the new folder's project dir FIRST so --resume
  // can actually find it there.
  if (pane.cliSessionId && sessionById(pane.sessionId)?.cwd && sessionById(pane.sessionId).cwd !== cwd) {
    const switchRes = await window.maestro.switchSessionRootFolder(pane.cliSessionId, pane.sessionId, cwd);
    if (!switchRes.ok) {
      if (panes[index] === pane) {
        pane.busy = false;
        setPaneBusyUI(index, "");
        pane.turns.push({ role: "assistant", kind: "text", text: "⚠ Couldn't switch to the new folder: " + switchRes.error });
        bumpSessionActivity(pane.sessionId);
        renderPane(index);
      }
      return;
    }
    // Same guard every other await boundary in this function uses (the
    // failure branch above, the startSession failure branch below) — the
    // pane may have been reset ("+" new chat) or reassigned during the
    // switch's await. Caught in review for consistency: without it, a
    // resumed-but-abandoned pane would still spawn a real CLI process using
    // stale model/effort/session values.
    if (panes[index] !== pane) {
      return;
    }
  }

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
      bumpSessionActivity(pane.sessionId);
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
  // Stores the pane OBJECT, not just the index — every launch-scoped event
  // (session/tool_use/assistant/error/done/modelFit) is routed through this
  // one map with an identity check, so a pane reused before a late event
  // arrives can never have that event misattributed to it.
  launchPaneHistory.set(res.launchId, { index, pane, startedAt: Date.now() });
}

// Fires a prompt queued while the pane was busy (see the Enter-key handler
// in paneComposerEl), through the exact same sendFromPane path used for a
// normal manual send — no duplicated cwd/attachment/suggestion logic. Called
// synchronously from the "done" case, so `panes[index] === pane` is still
// guaranteed true here (no await has happened since the identity check at
// the top of the event switch).
function fireQueuedPromptIfAny(index, pane) {
  if (!pane.queuedPrompt || !pane.els) {
    return;
  }
  const queued = pane.queuedPrompt;
  pane.queuedPrompt = null;
  pane.els.renderQueuedPrompt();
  pane.els.promptEl.value = queued;
  sendFromPane(index, pane.els);
}

// Left pane's share of the split, 0..1. Module-level (not per-pane, not
// persisted) so it survives split toggles within a session but resets on
// restart — a reasonable v1; persisting to config is a possible follow-up.
let splitRatio = 0.5;
const MIN_SPLIT_RATIO = 0.2;
const MAX_SPLIT_RATIO = 0.8;

function applySplitRatio() {
  const workspace = document.getElementById("workspace");
  workspace.style.setProperty("--left-fr", `${splitRatio}fr`);
  workspace.style.setProperty("--right-fr", `${1 - splitRatio}fr`);
}

// Rebuilds every pane's DOM. Only call this when the NUMBER of panes changes
// (split on/off) — it discards any in-progress typing in every pane.
function renderWorkspace() {
  const workspace = document.getElementById("workspace");
  const split = panes.length > 1;
  workspace.classList.toggle("split", split);
  workspace.innerHTML = "";
  const makePane = (index) => {
    const paneEl = document.createElement("section");
    paneEl.className = "pane";
    paneEl.dataset.pane = String(index);
    paneEl.addEventListener("click", () => {
      focusedPaneIndex = index;
    });
    workspace.append(paneEl);
    renderSinglePane(index);
  };
  makePane(0);
  if (split) {
    workspace.append(paneDividerEl());
    applySplitRatio();
    makePane(1);
  } else {
    // Clear any leftover split sizing so a future single-pane layout isn't
    // constrained by stale fr variables.
    workspace.style.removeProperty("--left-fr");
    workspace.style.removeProperty("--right-fr");
  }
}

// Draggable divider between the two split panes — adjusts their relative
// width. Pointer events (not mouse) so a capture keeps tracking even if the
// cursor briefly leaves the thin divider mid-drag.
function paneDividerEl() {
  const divider = document.createElement("div");
  divider.className = "pane-divider";
  divider.title = "Drag to resize";
  divider.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const workspace = document.getElementById("workspace");
    divider.setPointerCapture(e.pointerId);
    divider.classList.add("dragging");
    const onMove = (ev) => {
      const rect = workspace.getBoundingClientRect();
      if (rect.width <= 0) {
        return;
      }
      const raw = (ev.clientX - rect.left) / rect.width;
      splitRatio = Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, raw));
      applySplitRatio();
    };
    const onUp = () => {
      divider.classList.remove("dragging");
      divider.removeEventListener("pointermove", onMove);
      divider.removeEventListener("pointerup", onUp);
      divider.removeEventListener("pointercancel", onUp);
    };
    divider.addEventListener("pointermove", onMove);
    divider.addEventListener("pointerup", onUp);
    divider.addEventListener("pointercancel", onUp);
  });
  return divider;
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

// Quota moved out of the header into the context-gauge popover (Aidin's ask:
// "flytta ner quota menyn dit också"). state.quota still flows via refresh();
// the popover reads it directly on open. This is now just a defensive no-op
// kept so the existing refresh() call site doesn't need touching / can't
// throw if the header element is gone.
function renderQuota() {
  // intentionally empty — see comment above
}

// A cheap summary of exactly the fields renderSidebar()'s output depends on
// (session identity/status/model/archived + the Jot badge fields it reads,
// plus the config knobs that affect grouping/visibility). Comparing this
// string is far cheaper than the full innerHTML="" + rebuild it guards —
// found in a performance audit: the 30s poll below was rebuilding the whole
// sidebar every tick even when nothing had changed (audit: "performance +
// token usage granskning"). Deliberately NOT a full JSON.stringify of the
// whole sessions/config payload — most fields on a session (turns, cwd,
// etc.) don't affect the sidebar row at all, so including them would cause
// false-positive "changed" on unrelated backend churn.
function computeSidebarFingerprint(sessions, config) {
  const sessionsPart = sessions
    .map((s) =>
      [
        s.sessionId,
        s.title,
        s.status,
        s.lastActivityAt,
        s.model,
        s.isArchived,
        s.jot?.review,
        s.jot?.inProgress,
        s.jot?.open,
        s.jot?.category,
        s.jot?.nearestDeadline,
        s.orchestratorTag?.statusTag,
        s.orchestratorTag?.reason,
        s.autoCompacted?.preTokens,
        s.autoCompacted?.postTokens,
      ].join(":")
    )
    .join("|");
  const configPart = JSON.stringify(config.groups) + "|" + config.sidebarMode + "|" + config.archiveSuggestions?.enabled + "|" + config.hideArchived;
  return sessionsPart + "##" + configPart;
}
let lastSidebarFingerprint = null;

async function refresh() {
  const data = await window.maestro.getSessions();
  state.sessions = data.sessions;
  state.config = data.config;
  state.quota = data.quota;
  applyViewMode();
  applySidebarMode();
  // Don't rebuild the sidebar out from under an in-progress category drag —
  // innerHTML="" would destroy the dragged header and the drag-collapse
  // mid-gesture (jarring layout jump). State above is still refreshed; the
  // sidebar re-renders on the next tick once the drag ends (dragend clears
  // the flag; reorderCategory/openSessionInPane also re-render on their own).
  //
  // Also skip the rebuild entirely when nothing the sidebar actually
  // displays has changed since the last poll — every OTHER call site that
  // renders in response to a real user action (search, category CRUD,
  // opening a session, ...) calls renderSidebar() directly and is
  // unaffected by this cache; this only guards the unconditional 30s timer
  // tick from redoing identical work.
  const fingerprint = computeSidebarFingerprint(state.sessions, state.config);
  if (!categoryDragInProgress() && fingerprint !== lastSidebarFingerprint) {
    renderSidebar();
    lastSidebarFingerprint = fingerprint;
  }
  renderQuota(state.quota);
  pruneStaleLaunchHistory();
  pruneStaleBackgroundTasks();
  renderBackgroundTasksBadge();
}

// First-load: after sessions are in, auto-open the most-recently-active
// orchestrator session in pane 0 (Aidin's ask — Maestro is his orchestration
// hub, so that session is almost always where he wants to land). Guarded so
// it only fires when pane 0 is still the untouched fresh pane, never
// clobbering anything the user has already opened, and only run once at
// startup (not on the 30s refresh).
async function startup() {
  await refresh();
  const pane0 = panes[0];
  if (!pane0 || pane0.sessionId || pane0.turns.length > 0) {
    return;
  }
  const orchestrator = state.sessions
    .filter((s) => isOrchestratorSession(s) && !s.isArchived)
    .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))[0];
  if (orchestrator) {
    openSessionInPane(orchestrator, 0);
  }
}

// The modelFit event is the normal way launchPaneHistory entries get cleaned
// up, but if the judge is disabled (config.modelFitJudge.enabled: false) or
// errors before emitting one, that never happens — this is the backstop so
// the map doesn't grow forever over a long-running session.
//
// This map is now also the ONLY routing table for every live event
// (session/tool_use/assistant/error/done), so pruning by age alone would be
// a real regression: a long xhigh-effort prompt can easily run past a fixed
// cutoff while still genuinely in progress, and pruning its entry mid-run
// would silently drop its remaining events. Only prune once the launch can
// no longer matter — either the attached pane is done with it (busy: false)
// or the pane was already reset/reused elsewhere (identity mismatch), in
// which case nothing could ever reach this entry again regardless of age.
function pruneStaleLaunchHistory() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [launchId, entry] of launchPaneHistory) {
    const stillAttachedAndBusy = panes[entry.index] === entry.pane && entry.pane.busy;
    if (stillAttachedAndBusy) {
      continue;
    }
    if ((entry.startedAt || 0) < cutoff) {
      launchPaneHistory.delete(launchId);
    }
  }
}

// Backstop for backgroundTasks — "Clear finished" is the normal way entries
// go away, but a session that never clicks it (or forgets to) grows this map
// forever. Only removes tasks that already reached a terminal state and are
// old enough that nobody's still looking at them; a still-"running" task is
// never touched here regardless of age (its own task_updated/task_done will
// resolve it, or it'll age out once THAT lands).
function pruneStaleBackgroundTasks() {
  const cutoff = Date.now() - BACKGROUND_TASK_MAX_AGE_MS;
  for (const [taskId, t] of backgroundTasks) {
    if (TERMINAL_TASK_STATUSES.has(t.status) && (t.startedAt || 0) < cutoff) {
      backgroundTasks.delete(taskId);
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

// Collapse/expand ALL categories at once — the lightweight "list-sorting
// view" Aidin asked for: collapse everything to headers to see the whole
// category order at a glance (and reorder), then expand back. Toggles based
// on current state: if every category is already collapsed, expand all;
// otherwise collapse all. Persists via each group's `collapsed` flag, same
// as the per-header toggle.
document.getElementById("collapseAll").addEventListener("click", async () => {
  const groups = state.config.groups || [];
  if (groups.length === 0) {
    return;
  }
  const allCollapsed = groups.every((g) => g.collapsed);
  const next = groups.map((g) => ({ ...g, collapsed: !allCollapsed }));
  state.config = await window.maestro.setConfig({ groups: next });
  renderSidebar();
});

document.getElementById("newChat").addEventListener("click", () => {
  panes[focusedPaneIndex] = freshPane();
  // A brand-new chat is a new browsing context for this slot — without
  // this, ← immediately after "New chat" navigated back into whatever
  // session used to be here, which is exactly the inconsistency the
  // split-close handler already guards against for slot 1 (found in
  // review, was previously missing here and on the pane-header reset).
  paneNavHistory.delete(focusedPaneIndex);
  selectedSessionId = null;
  renderSinglePane(focusedPaneIndex);
  renderSidebar();
});

// ============================== Analysis page ==============================
// Replaces the earlier popup versions of Skills/Usage — those rendered via
// submenus that could overflow off-screen near the window edge, and Aidin
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
  document.getElementById("archivePage").classList.toggle("hidden", page !== "archive");
  document.getElementById("settingsPage").classList.toggle("hidden", page !== "settings");
  if (page === "analysis") {
    renderAnalysisPage();
  } else if (page === "archive") {
    renderArchivePage();
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

// A place to actually get sessions back — "Remove from Maestro" and
// "Archive" both used to be one-way (restorable only by hand-editing
// config.json / knowing to look). Reads the same state.sessions/state.config
// refresh() already keeps current; no separate IPC needed.
function renderArchivePage() {
  const page = document.getElementById("archivePage");
  page.innerHTML = "";

  const header = document.createElement("h2");
  header.textContent = "Archive";
  page.append(header);

  // Search box (with a clear button) — the archive can accumulate a lot of
  // sessions and there was no way to find one. Mirrors the sidebar search.
  const searchWrap = document.createElement("div");
  searchWrap.className = "archive-search";
  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.className = "search";
  searchInput.placeholder = "Search archived sessions…";
  searchInput.value = archiveSearchTerm;
  searchInput.addEventListener("input", (e) => {
    archiveSearchTerm = e.target.value.trim().toLowerCase();
    renderArchivePage();
    // Re-focus + restore caret to end after the re-render replaced the node.
    const fresh = document.querySelector(".archive-search input");
    if (fresh) {
      fresh.focus();
      fresh.setSelectionRange(fresh.value.length, fresh.value.length);
    }
  });
  searchWrap.append(searchInput);
  const clearBtn = document.createElement("button");
  clearBtn.className = "icon-btn";
  clearBtn.textContent = "✕";
  clearBtn.title = "Clear search";
  clearBtn.disabled = archiveSearchTerm === "";
  clearBtn.addEventListener("click", () => {
    archiveSearchTerm = "";
    renderArchivePage();
    const fresh = document.querySelector(".archive-search input");
    if (fresh) {
      fresh.focus();
    }
  });
  searchWrap.append(clearBtn);
  page.append(searchWrap);

  const matchesArchiveSearch = (s) => {
    if (!archiveSearchTerm) {
      return true;
    }
    return (
      (s.title || "").toLowerCase().includes(archiveSearchTerm) ||
      (s.cwd || "").toLowerCase().includes(archiveSearchTerm)
    );
  };

  const archived = state.sessions.filter((s) => s.isArchived).filter(matchesArchiveSearch);
  const hiddenIds = state.config.hiddenSessions || [];
  // Excludes anything also archived — the two flags are independent, so a
  // session could be both, and listing it (with two unrelated "get it back"
  // actions) in both sections at once would just be confusing. Archived is
  // the more definitive state; unarchiving it is enough to see it again here
  // even if it's still separately hidden from Maestro's own sidebar view.
  const hidden = hiddenIds
    .map(sessionById)
    .filter(Boolean)
    .filter((s) => !s.isArchived)
    .filter(matchesArchiveSearch);

  const grid = document.createElement("div");
  grid.className = "analysis-grid";
  grid.append(
    archiveSectionEl("Archived sessions", archived, "No archived sessions.", (session) =>
      archiveRowEl(session, "Unarchive", () => unarchiveSession(session))
    ),
    archiveSectionEl("Removed from Maestro", hidden, "Nothing hidden.", (session) =>
      archiveRowEl(session, "Restore", () => restoreToMaestro(session))
    )
  );
  page.append(grid);
}

function archiveSectionEl(title, sessions, emptyText, rowFactory) {
  const block = document.createElement("div");
  block.className = "analysis-block";
  const h = document.createElement("h3");
  h.textContent = `${title} · ${sessions.length}`;
  block.append(h);
  if (sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pane-empty";
    empty.textContent = emptyText;
    block.append(empty);
  } else {
    sortByAttention(sessions).forEach((s) => block.append(rowFactory(s)));
  }
  return block;
}

function archiveRowEl(session, actionLabel, onAction) {
  const row = document.createElement("div");
  row.className = "archive-row";
  const info = document.createElement("div");
  info.className = "archive-row-info";
  const title = document.createElement("div");
  title.className = "archive-row-title";
  title.textContent = session.title;
  const meta = document.createElement("div");
  meta.className = "archive-row-meta";
  meta.textContent = `${session.cwd || "no folder"} · last active ${relTime(session.lastActivityAt)}`;
  info.append(title, meta);
  const action = document.createElement("button");
  action.className = "text-btn";
  action.textContent = actionLabel;
  action.addEventListener("click", onAction);
  row.append(info, action);
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

  block.append(
    settingsToggleRow(
      "Orchestrator helper (Fas 3)",
      "Periodically reads recent messages in idle/waiting sessions (a cheap Haiku call, ~15 min intervals) to tell apart a real open question from a finished answer, or genuinely stuck from genuinely idle. Sharpens the archive suggestion above and shows its read as a small note on the session row. A proposal only — never archives or acts on its own.",
      state.config.orchestratorHelper?.enabled === true,
      async (checked) => {
        state.config = await window.maestro.setConfig({
          orchestratorHelper: { ...(state.config.orchestratorHelper || {}), enabled: checked },
        });
        refresh();
      }
    )
  );

  block.append(
    settingsToggleRow(
      "Auto-compact large idle sessions (Fas 3)",
      `Automatically runs /compact on a session left idle for ~${state.config.autoCompact?.idleMinutes || 10} min whose context has grown past ~${Math.round((state.config.autoCompact?.thresholdTokens || 150000) / 1000)}k tokens (checked on the ~15 min sweep). Time-based, so it won't fire mid-work — only after you've stepped away. Unlike everything else here this ACTS on its own — it summarizes the session's context (lossy, but the full history stays in the transcript on disk). A small note appears on the row after it happens.`,
      state.config.autoCompact?.enabled === true,
      async (checked) => {
        state.config = await window.maestro.setConfig({
          autoCompact: { ...(state.config.autoCompact || {}), enabled: checked },
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

  const accuracyBlock = document.createElement("div");
  accuracyBlock.className = "analysis-block";
  const accuracyH = document.createElement("h3");
  accuracyH.textContent = "Suggestion accuracy";
  accuracyH.title =
    "Joins each run's followed-vs-overridden auto-suggestion with the judge's verdict for that SAME run (by launchId) — not just a same-model coincidence. Runs from before this tracking existed, or with no judge verdict, are excluded rather than estimated.";
  accuracyBlock.append(accuracyH);
  const acc = summary.suggestionAccuracy || { followed: {}, overridden: {} };
  const followedTotal = (acc.followed.too_weak || 0) + (acc.followed.appropriate || 0) + (acc.followed.too_strong || 0);
  const overriddenTotal = (acc.overridden.too_weak || 0) + (acc.overridden.appropriate || 0) + (acc.overridden.too_strong || 0);
  if (followedTotal + overriddenTotal === 0) {
    const empty = document.createElement("div");
    empty.className = "pane-empty";
    empty.textContent = "No judged runs with a suggestion yet.";
    accuracyBlock.append(empty);
  } else {
    const followedRow = document.createElement("div");
    followedRow.className = "fit-row";
    const followedLabel = document.createElement("span");
    followedLabel.className = "fit-model-label";
    followedLabel.textContent = `Followed suggestion (${followedTotal})`;
    followedRow.append(followedLabel);
    followedRow.append(fitPill("too_weak", acc.followed.too_weak || 0), fitPill("appropriate", acc.followed.appropriate || 0), fitPill("too_strong", acc.followed.too_strong || 0));
    accuracyBlock.append(followedRow);

    const overriddenRow = document.createElement("div");
    overriddenRow.className = "fit-row";
    const overriddenLabel = document.createElement("span");
    overriddenLabel.className = "fit-model-label";
    overriddenLabel.textContent = `Overrode suggestion (${overriddenTotal})`;
    overriddenRow.append(overriddenLabel);
    overriddenRow.append(fitPill("too_weak", acc.overridden.too_weak || 0), fitPill("appropriate", acc.overridden.appropriate || 0), fitPill("too_strong", acc.overridden.too_strong || 0));
    accuracyBlock.append(overriddenRow);

    // A plain read of what the numbers say, not a persuasive spin — if
    // overriding does better, that's a real signal the heuristic in
    // suggest.js should change, not something to word around.
    const followedRate = followedTotal ? (acc.followed.appropriate || 0) / followedTotal : null;
    const overriddenRate = overriddenTotal ? (acc.overridden.appropriate || 0) / overriddenTotal : null;
    if (followedRate !== null && overriddenRate !== null) {
      const note = document.createElement("div");
      note.className = "suggest-hint";
      const diff = Math.round((followedRate - overriddenRate) * 100);
      note.textContent =
        diff >= 0
          ? `Following the suggestion was judged "appropriate" ${diff} points more often than overriding it.`
          : `Overriding the suggestion was judged "appropriate" ${Math.abs(diff)} points more often than following it — worth revisiting suggest.js's heuristic.`;
      accuracyBlock.append(note);
    }
  }

  grid.append(modelBlock, toolBlock, skillUsageBlock, fitBlock, accuracyBlock);
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

// task_progress/task_updated/task_done can arrive for a taskId this map
// hasn't seen yet — the underlying IPC/stream-json event stream has no
// delivery-order guarantee, so a dropped or reordered task_started is a
// real possibility, not just a theoretical one. Backfills a minimal
// placeholder rather than silently discarding the event.
function getOrCreateBackgroundTask(taskId) {
  let t = backgroundTasks.get(taskId);
  if (!t) {
    t = { description: "Background task", status: "running", lastToolName: null, startedAt: Date.now() };
    backgroundTasks.set(taskId, t);
  }
  return t;
}

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

  // Handled separately from the main switch below because this is the ONE
  // event kind that fully retires an entry — the judge resolves well after
  // "done" and is the last thing that will ever need this launchId.
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
    const existing = backgroundTasks.get(evt.taskId);
    // An out-of-order task_done/task_updated can arrive BEFORE task_started
    // and already backfill a terminal placeholder via getOrCreateBackgroundTask
    // below — unconditionally overwriting it here would un-finish an already-
    // completed task back to "running" with nothing left to ever fix it again.
    if (existing && TERMINAL_TASK_STATUSES.has(existing.status)) {
      return;
    }
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
    // progress/updated/done for a taskId with no prior task_started (a
    // dropped or reordered IPC message — this stream has no delivery
    // guarantee) used to be silently ignored, making that task permanently
    // invisible even though it's genuinely running. getOrCreateBackgroundTask
    // backfills a minimal placeholder instead, so it still shows up.
    const t = getOrCreateBackgroundTask(evt.taskId);
    t.lastToolName = evt.lastToolName || t.lastToolName;
    renderBackgroundTasksBadge();
    return;
  }
  if (evt.kind === "task_updated") {
    const t = getOrCreateBackgroundTask(evt.taskId);
    // Ignore an out-of-order/delayed update trying to un-finish a task that
    // already reached a terminal state (e.g. via task_done) — a duplicate or
    // reordered IPC message shouldn't make a completed task look running again.
    if (!TERMINAL_TASK_STATUSES.has(t.status)) {
      t.status = evt.status || t.status;
      renderBackgroundTasksBadge();
    }
    return;
  }
  if (evt.kind === "task_done") {
    const t = getOrCreateBackgroundTask(evt.taskId);
    t.status = evt.status || "completed";
    t.summary = evt.summary || t.description;
    renderBackgroundTasksBadge();
    return;
  }

  // App-wide, not tied to any one pane — must never be gated behind a pane
  // lookup (a stale/missing launch entry shouldn't also swallow quota news).
  if (evt.kind === "quota") {
    renderQuota(evt.quota);
    return;
  }

  // Routes purely via launchPaneHistory + an identity check, the same
  // pattern already used by the modelFit handler above. A separate
  // launchId->index map (paneLaunchMap) used to do this lookup WITHOUT the
  // identity check, which meant: send in a pane, hit "+" for a new chat
  // before the reply lands, and the orphaned launch's assistant text/done
  // would land in the unrelated NEW session now sitting at that index. That
  // map's own cleanup was also inconsistent (deleted on "done" but not on
  // "error", a genuine unbounded leak on every failed launch). Consolidating
  // on launchPaneHistory removes both problems: one map, one identity check,
  // used everywhere a launchId needs to find its way back to a pane.
  const entry = launchPaneHistory.get(evt.launchId);
  if (!entry || panes[entry.index] !== entry.pane) {
    return;
  }
  const { index, pane } = entry;
  switch (evt.kind) {
    case "session":
      pane.cliSessionId = evt.sessionId;
      break;
    case "tool_use":
      setPaneBusyUI(index, `● Working — ${evt.toolName}`);
      break;
    case "assistant":
      pane.turns.push({ role: "assistant", kind: "text", text: evt.text });
      bumpSessionActivity(pane.sessionId);
      renderPane(index);
      break;
    case "error":
      pane.busy = false;
      pane.currentLaunchId = null;
      setPaneBusyUI(index, "");
      pane.turns.push({ role: "assistant", kind: "text", text: "⚠ " + evt.message });
      bumpSessionActivity(pane.sessionId);
      renderPane(index);
      break;
    case "done":
      pane.busy = false;
      pane.currentLaunchId = null;
      setPaneBusyUI(index, "");
      // stopRequested alone isn't reliable: the process can finish naturally
      // in the small window between clicking Stop and that IPC call actually
      // landing, in which case it's not actually stopped, just a real
      // completion that happened to race a Stop click. evt.summary.sawResult
      // reflects whether the CLI itself produced a genuine result — only
      // treat this as a stop if it did NOT.
      if (pane.stopRequested && !evt.summary?.sawResult) {
        // A killed process may not have flushed its in-progress turn to disk
        // yet — reloading the transcript here would silently drop whatever
        // text already streamed live. Keep what's on screen instead.
        pane.stopRequested = false;
        pane.turns.push({ role: "assistant", kind: "text", text: "⏹ Stopped." });
        bumpSessionActivity(pane.sessionId);
        renderPane(index);
        // A queued prompt is deliberately NOT fired after an explicit stop —
        // you stopped this run for a reason, most likely to intervene, not
        // to have something else auto-fire right after.
      } else if (!evt.summary?.sawResult && evt.summary?.code !== 0) {
        // A genuine CLI failure (non-zero exit, no result ever produced) —
        // e.g. "No conversation found with session ID" when resuming from a
        // folder the session wasn't created in. Previously this vanished
        // completely: stderr was captured but nothing consumed it, so the
        // prompt just silently disappeared with the pane going back to idle
        // (caught via Aidin's "vad innebär pick repo folder på en befintlig
        // session" question). Surface it as a visible error turn instead of
        // reloading a transcript that never got the failed turn appended.
        pane.stopRequested = false;
        const cleaned = (evt.summary?.stderrText || "")
          .split("\n")
          .filter((l) => l.trim() && !l.startsWith("Warning: no stdin data received"))
          .join(" ")
          .trim();
        // A spawn-level failure (e.g. the claude binary couldn't be found)
        // resolves with {code:-1, error: err.message} and no stderrText at
        // all (launcher.js's separate child.on("error") path) — fall back to
        // that message rather than dropping it for the generic exit-code
        // text (caught in review).
        const message = cleaned || evt.summary?.error || `Run failed (exit code ${evt.summary?.code}).`;
        pane.turns.push({
          role: "assistant",
          kind: "text",
          text: "⚠ " + truncateText(message, 400),
        });
        bumpSessionActivity(pane.sessionId);
        renderPane(index);
      } else {
        pane.stopRequested = false;
        loadTranscriptInto(index).then(refresh);
        fireQueuedPromptIfAny(index, pane);
      }
      break;
    default:
      break;
  }
  // launchPaneHistory is intentionally NOT deleted here (unlike the old
  // paneLaunchMap on "done") — the model-fit judge fires well after "done"
  // and still needs this same entry; it does the one-shot delete itself.
  // Backstop: pruneStaleLaunchHistory() reclaims anything the judge never
  // consumes (disabled, errored launch, etc).
});

renderWorkspace();
renderBackgroundTasksBadge();
startup();
setInterval(refresh, 30000);

window.maestro.getVersion().then((v) => {
  document.getElementById("appVersion").textContent = v;
});
