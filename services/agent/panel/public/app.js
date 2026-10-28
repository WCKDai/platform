const $ = (id) => document.getElementById(id);
let csrf = "";
let busy = false;
let timer = 0;

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

const when = (seconds) => {
  if (!seconds) return "—";
  const date = new Date(Number(seconds) * 1000);
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

const text = (value) => {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join("\n");
  if (typeof value === "object") {
    for (const key of ["text", "message", "summary", "question", "content"]) {
      if (value[key] != null) return String(value[key]);
    }
    return JSON.stringify(value);
  }
  return String(value);
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.headers || {}), "X-CSRF-Token": csrf },
  });
  if (response.status === 401) {
    location.href = "/login";
    throw new Error("signed out");
  }
  return response;
}

function setStatus(kind, label) {
  const node = $("status");
  node.className = `status ${kind}`;
  node.textContent = label;
}

function unavailable(section) {
  return !section || section.status === 0 || section.status >= 400;
}

function renderGateway(gateway) {
  const models = gateway?.models?.value?.data || [];
  const node = gateway?.node?.value || {};
  const ok = !unavailable(gateway?.models) && !unavailable(gateway?.node);
  $("gateway-state").textContent = ok ? "online" : "offline";
  $("gateway-state").className = `badge${ok ? "" : " bad"}`;
  $("gateway-node").textContent = ok
    ? `${node.name || "node"} · network ${node.network || "?"} · egress ${node.egress || "?"}`
    : "The gateway did not answer.";
  $("models").innerHTML = models.length
    ? models
        .map((model) => {
          const info = model.invincible || {};
          return `<div class="model"><span><strong>${esc(model.id)}</strong><span class="meta"> · ${esc(info.tier || "node")}${info.context ? ` · ${esc(info.context)} ctx` : ""}</span></span><span class="${info.healthy === false ? "down" : "ok"}">${info.healthy === false ? "down" : "ready"}</span></div>`;
        })
        .join("")
    : `<p class="muted">No models reported.</p>`;
}

function renderAgent(agent) {
  const info = agent?.info?.value || {};
  const stats = agent?.stats?.value || {};
  $("agent-state").textContent = unavailable(agent?.info) ? "offline" : "online";
  $("agent-state").className = `badge${unavailable(agent?.info) ? " bad" : ""}`;
  $("stat-tasks").textContent = stats.tasks ?? "—";
  $("stat-sessions").textContent = stats.open_sessions ?? "—";
  $("stat-waiting").textContent = stats.waiting ?? "—";
  $("agent-info").textContent = unavailable(agent?.info)
    ? "The agent did not answer."
    : `autobot ${info.version || "?"}${info.bots ? ` · ${info.bots} bot(s)` : ""}${info.name ? ` · ${info.name}` : ""}`;
}

function renderApprovals(agent) {
  const approvals = agent?.approvals?.value?.approvals || [];
  if (!approvals.length) {
    $("approvals").innerHTML = `<p class="muted">Nothing waiting.</p>`;
    return;
  }
  $("approvals").innerHTML = approvals
    .map((approval) => {
      const id = esc(approval.id || approval.request_id || "");
      const title = esc(approval.action || approval.summary || approval.tool || "Approval requested");
      const detail = esc(text(approval.detail || approval.command || approval.question || approval));
      return `<div class="approval"><div class="q"><strong>${title}</strong><span title="${detail}">${detail}</span></div><div class="actions"><button class="mini yes" data-answer="once" data-id="${id}">Once</button><button class="mini yes" data-answer="always" data-id="${id}">Always</button><button class="mini no" data-answer="deny" data-id="${id}">Deny</button></div></div>`;
    })
    .join("");
  for (const button of document.querySelectorAll("[data-answer]")) {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await api(`/api/approvals/${encodeURIComponent(button.dataset.id)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answer: button.dataset.answer }),
        });
        await refresh();
      } catch (error) {
        setStatus("offline", error.message);
      }
    });
  }
}

function renderSessions(agent) {
  const sessions = agent?.sessions?.value?.sessions || [];
  $("sessions").innerHTML = sessions.length
    ? sessions
        .slice(0, 40)
        .map(
          (session) =>
            `<tr data-session="${esc(session.id)}"><td class="mono">${esc(session.id)}</td><td>${esc(session.bot || "default")}</td><td class="muted">${esc(when(session.modified))}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="3" class="muted">No conversations yet.</td></tr>`;
  for (const row of document.querySelectorAll("[data-session]")) {
    row.addEventListener("click", () => loadHistory(row.dataset.session));
  }
}

function renderAudit(audit) {
  const entries = (audit?.value || audit)?.entries || [];
  $("audit").innerHTML = entries.length
    ? entries
        .slice()
        .reverse()
        .map((entry) => {
          const decision = entry.receipt?.receipt?.decision || {};
          const action = decision.action || (entry.receipt?.receipt?.error ? "error" : "—");
          const detail = decision.reason || decision.model || (entry.receipt?.receipt?.error?.status ? `status ${entry.receipt.receipt.error.status}` : "");
          return `<tr><td class="mono">${esc(entry.api || "?")}</td><td>${esc(action)}${detail ? ` <span class="muted">· ${esc(detail)}</span>` : ""}</td><td class="muted">${esc(when(entry.at))}</td></tr>`;
        })
        .join("")
    : `<tr><td colspan="3" class="muted">No audit entries.</td></tr>`;
}

async function refresh() {
  try {
    const response = await api("/api/overview");
    const data = await response.json();
    renderGateway(data.gateway);
    renderAgent(data.agent);
    renderApprovals(data.agent);
    renderSessions(data.agent);
    renderAudit(data.audit);
    const online = !unavailable(data.gateway?.models) && !unavailable(data.agent?.info);
    setStatus(online ? "online" : "offline", online ? "gateway + agent online" : "degraded");
    $("updated").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    $("footer-status").textContent = online ? "all systems answer" : "one service is not answering";
  } catch (error) {
    setStatus("offline", error.message || "unreachable");
  }
}

async function loadHistory(id) {
  $("history-name").textContent = id;
  $("history").textContent = "Loading…";
  try {
    const response = await api(`/api/history/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`history ${response.status}`);
    const data = await response.json();
    const messages = data.messages || [];
    $("history").textContent = messages
      .map((message) => {
        const role = (message.role || "message").toUpperCase();
        return `[${role}]\n${text(message.content)}\n`;
      })
      .join("\n")
      .slice(0, 24000) || "No messages in this conversation.";
  } catch (error) {
    $("history").textContent = String(error.message || error);
  }
}

async function runTask(event) {
  event.preventDefault();
  if (busy) return;
  const input = $("task-text");
  const session = $("task-session").value.trim();
  const output = $("task-output");
  const button = $("task-run");
  busy = true;
  button.disabled = true;
  output.textContent = "Starting…\n";
  try {
    const response = await api("/api/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: input.value.trim(), session }),
    });
    const assigned = response.headers.get("X-Session-Id");
    if (assigned && !session) $("task-session").value = assigned;
    if (!response.body) throw new Error(`agent answered ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const consume = (line) => {
      if (!line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (!payload) return;
      try {
        const event = JSON.parse(payload);
        if (event.type === "text") output.textContent += event.text || "";
        else if (event.type === "tool") output.textContent += `\n› ${event.text || "tool"}\n`;
        else if (event.type === "answer") output.textContent += `\n${event.text || ""}\n`;
        else if (event.type === "receipt") output.textContent += `· receipt ${String(event.id || "").slice(0, 8)}${event.model ? ` ${event.model}` : ""}\n`;
        else if (event.type === "error") output.textContent += `\n[error] ${event.text || "error"}\n`;
      } catch {
        output.textContent += `${payload}\n`;
      }
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        consume(buffer.slice(0, at).trimEnd());
        buffer = buffer.slice(at + 1);
      }
      output.scrollTop = output.scrollHeight;
    }
    if (buffer.trim()) consume(buffer.trim());
    output.textContent += "\n";
  } catch (error) {
    output.textContent += `\n[error] ${error.message || error}\n`;
  } finally {
    busy = false;
    button.disabled = false;
    input.value = "";
    await refresh();
  }
}

async function logout() {
  try {
    await api("/api/logout", { method: "POST" });
  } finally {
    location.href = "/login";
  }
}

async function start() {
  try {
    const response = await fetch("/api/session");
    if (!response.ok) return (location.href = "/login");
    const data = await response.json();
    csrf = data.csrf;
  } catch {
    return (location.href = "/login");
  }
  $("task-form").addEventListener("submit", runTask);
  $("logout").addEventListener("click", logout);
  await refresh();
  timer = setInterval(() => {
    if (!busy) refresh();
  }, 5000);
}

start();
