const STATUS_LABEL = { waiting: "Needs you", active: "Working", idle: "Idle", archived: "Archived" };
const STATUS_RANK = { waiting: 0, active: 1, idle: 2, archived: 3 };

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

function cardEl(s) {
  const card = document.createElement("div");
  card.className = `card ${s.status}`;

  const title = document.createElement("div");
  title.className = "card-title";
  title.textContent = s.title;
  card.append(title);

  const meta = document.createElement("div");
  meta.className = "card-meta";
  meta.append(span(STATUS_LABEL[s.status] || s.status), span(relTime(s.lastActivityAt)));
  if (s.model) {
    meta.append(span(s.model.replace("claude-", "")));
  }
  card.append(meta);

  if (s.jot) {
    const j = document.createElement("div");
    j.className = "jot" + (s.jot.review > 0 ? " review" : "");
    const parts = [];
    if (s.jot.review > 0) {
      parts.push(`${s.jot.review} review`);
    }
    if (s.jot.inProgress > 0) {
      parts.push(`${s.jot.inProgress} wip`);
    }
    if (s.jot.open > 0) {
      parts.push(`${s.jot.open} open`);
    }
    j.textContent = parts.length ? `${s.jot.category} · ${parts.join(" · ")}` : s.jot.category;
    card.append(j);
  }
  return card;
}

function span(text) {
  const el = document.createElement("span");
  el.textContent = text;
  return el;
}

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
  const visible = data.sessions.filter((s) => !s.isArchived);

  const attentionEl = document.getElementById("attention");
  const allEl = document.getElementById("all");
  attentionEl.innerHTML = "";
  allEl.innerHTML = "";

  const attention = sortByAttention(visible.filter((s) => s.needsAttention));
  if (attention.length > 0) {
    const h2 = document.createElement("h2");
    h2.textContent = `Needs your attention · ${attention.length}`;
    const cards = document.createElement("div");
    cards.className = "cards";
    attention.forEach((s) => cards.append(cardEl(s)));
    attentionEl.append(h2, cards);
  }

  const rest = sortByAttention(visible);
  const h2 = document.createElement("h2");
  h2.textContent = `All sessions · ${visible.length}`;
  const cards = document.createElement("div");
  cards.className = "cards";
  rest.forEach((s) => cards.append(cardEl(s)));
  allEl.append(h2, cards);

  renderQuota(data.quota);
}

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
  const prompt = document.getElementById("prompt").value.trim();
  if (!cwd || !prompt) {
    log("Need both a repo folder and a prompt.", "err");
    return;
  }
  logEl().innerHTML = "";
  log(`Starting session in ${cwd} (${model})…`);
  const res = await window.maestro.startSession({ cwd, prompt, model });
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
