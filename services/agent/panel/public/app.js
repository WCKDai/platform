const $ = (id) => document.getElementById(id);
const VIEWS = ["overview", "chat", "workspaces", "bots", "integrations", "usage", "settings"];
const CHANNELS = ["telegram", "discord", "slack", "email", "signal", "matrix", "whatsapp"];
let csrf = "";
let busy = false;
let timer = 0;
let selectedSession = "";
let threads = [];
let bots = [];
let settings = {};
let overview = {};

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

const when = (seconds) => {
  if (!seconds) return "—";
  const date = new Date(Number(seconds) * 1000);
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

const number = (value) => {
  const n = Number(value || 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
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

function value(section) {
  return section && section.value && !unavailable(section) ? section.value : null;
}

function showView(name) {
  if (!VIEWS.includes(name)) name = "overview";
  for (const view of document.querySelectorAll(".view")) view.hidden = view.dataset.view !== name;
  for (const tab of document.querySelectorAll("#tabs button")) tab.classList.toggle("active", tab.dataset.view === name);
  if (location.hash.slice(1) !== name) history.replaceState(null, "", name === "overview" ? location.pathname : `#${name}`);
}

function renderGateway(gateway) {
  const models = value(gateway?.models)?.data || [];
  const node = value(gateway?.node) || {};
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
          return `<div class="model"><span><strong>${esc(model.id)}</strong><span class="meta"> · ${esc(info.tier || "node")}${info.context ? ` · ${esc(info.context)} ctx` : ""}${info.data_policy ? ` · ${esc(info.data_policy)}` : ""}</span></span><span class="${info.healthy === false ? "down" : "ok"}">${info.healthy === false ? "down" : "ready"}</span></div>`;
        })
        .join("")
    : `<p class="muted">No models reported.</p>`;
}

function renderAgent(agent) {
  const info = value(agent?.info) || {};
  const stats = value(agent?.stats) || {};
  $("agent-state").textContent = unavailable(agent?.info) ? "offline" : "online";
  $("agent-state").className = `badge${unavailable(agent?.info) ? " bad" : ""}`;
  $("stat-tasks").textContent = stats.tasks ?? "—";
  $("stat-sessions").textContent = stats.open_sessions ?? "—";
  $("stat-waiting").textContent = stats.waiting ?? "—";
  $("agent-info").textContent = unavailable(agent?.info)
    ? "The agent did not answer."
    : `autobot ${info.version || "?"} · ${info.bots?.length || 0} bot(s) · ${info.model || "auto"}`;
}

function renderToday(agent) {
  const today = value(agent?.usage)?.today || {};
  $("today-turns").textContent = today.turns ?? "—";
  $("today-calls").textContent = today.calls ?? "—";
  $("today-cost").textContent = today.cost == null ? "—" : `$${Number(today.cost).toFixed(4)}`;
  $("today-tokens").textContent =
    today.calls == null
      ? "no usage yet"
      : `${number(today.input)} in · ${number(today.output)} out${today.cached ? ` · ${number(today.cached)} cached` : ""}${today.cloud_calls ? ` · ${today.cloud_calls} cloud` : " · all local"}`;
}

function renderApprovals(agent) {
  const approvals = value(agent?.approvals)?.approvals || [];
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
}

function renderSessions(agent) {
  const sessions = value(agent?.sessions)?.sessions || [];
  $("sessions").innerHTML = sessions.length
    ? sessions
        .slice(0, 50)
        .map(
          (session) =>
            `<tr data-session="${esc(session.id)}" class="${session.id === selectedSession ? "active" : ""}"><td class="mono">${esc(session.id)}</td><td>${esc(session.bot || "default")}</td><td class="muted">${esc(when(session.modified))}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="3" class="muted">No conversations yet.</td></tr>`;
}

function messageBubble(message) {
  const role = message.role || "message";
  const body = text(message.content);
  if (role === "user") return `<div class="bubble user">${esc(body)}</div>`;
  if (role === "assistant") {
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    return (
      `${body ? `<div class="bubble assistant">${esc(body)}</div>` : ""}` +
      calls
        .map((call) => {
          const name = call.function?.name || call.name || "tool";
          const args = call.function?.arguments || call.arguments || "";
          return `<div class="bubble tool">› ${esc(name)} ${esc(String(args).slice(0, 400))}</div>`;
        })
        .join("")
    );
  }
  if (role === "tool") {
    return `<details class="bubble tool"><summary>tool result ${esc(message.tool_call_id || "")}</summary><pre>${esc(body.slice(0, 4000))}</pre></details>`;
  }
  if (message.autobot === "summary") return `<div class="bubble note">summary · ${esc(body)}</div>`;
  return `<div class="bubble note">${esc(role)}: ${esc(body)}</div>`;
}

function renderChat(messages) {
  const chat = $("chat");
  if (!messages || !messages.length) {
    chat.innerHTML = `<p class="muted">No messages yet. Say what Autobot should do.</p>`;
    return;
  }
  chat.innerHTML = messages.slice(-60).map(messageBubble).join("");
  chat.scrollTop = chat.scrollHeight;
}

function appendBubble(kind, content) {
  const chat = $("chat");
  if (chat.querySelector(".muted") && chat.children.length === 1) chat.innerHTML = "";
  const node = document.createElement("div");
  node.className = `bubble ${kind}`;
  node.textContent = content;
  chat.append(node);
  chat.scrollTop = chat.scrollHeight;
}

async function loadHistory(id) {
  selectedSession = id;
  $("chat-session").value = id;
  $("chat-title").textContent = id;
  $("chat").innerHTML = `<p class="muted">Loading ${esc(id)}…</p>`;
  try {
    const response = await api(`/api/history/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`history ${response.status}`);
    const data = await response.json();
    renderChat(data.messages || []);
  } catch (error) {
    $("chat").innerHTML = `<p class="bubble error">${esc(error.message || error)}</p>`;
  }
}

function handleStreamEvent(event) {
  if (!event) return;
  if (event.type === "tool") appendBubble("tool", `› ${event.text || "tool"}`);
  else if (event.type === "refused") appendBubble("note", `refused: ${event.text || ""}`);
  else if (event.type === "receipt") {
    appendBubble("receipt", `receipt ${String(event.id || "").slice(0, 8)}${event.model ? ` · ${event.model}` : ""}${event.tier ? ` · ${event.tier}` : ""}`);
  } else if (event.type === "answer") appendBubble("assistant", event.text || "(no answer)");
  else if (event.type === "error") appendBubble("error", event.text || "error");
  else if (event.type === "member") appendBubble("note", `${event.agent || "member"}: ${event.text || ""}`);
  else if (event.type === "kept") appendBubble("note", `kept: ${event.text || ""}`);
}

async function runChat(event) {
  event.preventDefault();
  if (busy) return;
  const input = $("chat-text");
  const textValue = input.value.trim();
  if (!textValue) return;
  const session = $("chat-session").value.trim();
  const button = $("chat-send");
  busy = true;
  button.disabled = true;
  appendBubble("user", textValue);
  input.value = "";
  try {
    const response = await api("/api/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: textValue, session }),
    });
    const assigned = response.headers.get("X-Session-Id");
    if (assigned) {
      selectedSession = assigned;
      $("chat-session").value = assigned;
      $("chat-title").textContent = assigned;
    }
    if (!response.ok || !response.body) {
      const body = await response.text();
      throw new Error(body || `the agent answered ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let at;
      while ((at = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            handleStreamEvent(JSON.parse(line.slice(5).trim()));
          } catch {
            appendBubble("note", line.slice(5).trim());
          }
        }
      }
    }
  } catch (error) {
    appendBubble("error", error.message || String(error));
  } finally {
    busy = false;
    button.disabled = false;
    await refresh();
  }
}

function newChat() {
  selectedSession = "";
  $("chat-session").value = "";
  $("chat-title").textContent = "new conversation";
  $("chat").innerHTML = `<p class="muted">Pick a conversation, or start a new one.</p>`;
  showView("chat");
  $("chat-text").focus();
}

function renderThreads(section) {
  threads = value(section)?.threads || [];
  $("threads").innerHTML = threads.length
    ? threads
        .map((thread) => {
          const state = !thread.worktree_exists
            ? `<span class="thread-state gone">worktree gone</span>`
            : `<span class="thread-state ${thread.dirty ? "dirty" : "clean"}">${thread.dirty ? "changes" : "clean"}</span><span class="muted"> · ${esc(thread.head || "?")}${thread.ahead ? ` · ${thread.ahead} ahead` : ""}</span>`;
          const pr = thread.pr_url
            ? `<a class="mini" href="${esc(thread.pr_url)}" target="_blank" rel="noopener">PR</a>`
            : thread.compare_url
              ? `<a class="mini" href="${esc(thread.compare_url)}" target="_blank" rel="noopener">compare</a>`
              : `<span class="muted">—</span>`;
          return `<tr><td><span class="mono">${esc(thread.id)}</span><div class="muted">${esc(thread.name || thread.base)}</div></td><td class="mono">${esc(thread.branch)}</td><td>${state}</td><td>${pr}</td><td><div class="thread-actions"><button class="mini" data-thread="use" data-id="${esc(thread.id)}">Use</button><button class="mini" data-thread="diff" data-id="${esc(thread.id)}">Diff</button><button class="mini" data-thread="pr" data-id="${esc(thread.id)}">PR</button><button class="mini no" data-thread="remove" data-id="${esc(thread.id)}">Remove</button></div></td></tr>`;
        })
        .join("")
    : `<tr><td colspan="5" class="muted">No threads yet. Start one above; it gets its own worktree and branch.</td></tr>`;
}

async function newThread(event) {
  event.preventDefault();
  const name = $("thread-name").value.trim();
  const base = $("thread-base").value.trim();
  try {
    const response = await api("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, base: base || null }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || result.error || `HTTP ${response.status}`);
    $("thread-output").textContent = `thread ${result.id}\nworktree  ${result.worktree}\nbranch    ${result.branch} from ${result.base}\n\nUse it in Chat (session ${result.session}), then Diff and PR here.`;
    $("thread-name").value = "";
    $("thread-base").value = "";
    await refresh();
  } catch (error) {
    $("thread-output").textContent = String(error.message || error);
  }
}

async function threadAction(action, id) {
  if (action === "use") {
    const thread = threads.find((item) => item.id === id);
    selectedSession = thread?.session || id;
    $("chat-session").value = selectedSession;
    $("chat-title").textContent = selectedSession;
    showView("chat");
    await loadHistory(selectedSession);
    return;
  }
  if (action === "diff") {
    showView("workspaces");
    $("thread-output").textContent = "Reading the diff…";
    try {
      const response = await api(`/api/threads/${encodeURIComponent(id)}/diff`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || result.error || `HTTP ${response.status}`);
      $("thread-output").textContent = result.diff || "no changes";
    } catch (error) {
      $("thread-output").textContent = String(error.message || error);
    }
    return;
  }
  if (action === "pr") {
    const thread = threads.find((item) => item.id === id);
    const title = prompt("Pull request title", thread?.name || `Autobot: ${thread?.branch || id}`);
    if (title === null) return;
    const body = prompt("Pull request body (optional)", "");
    if (body === null) return;
    $("thread-output").textContent = "Committing and pushing…";
    try {
      const response = await api(`/api/threads/${encodeURIComponent(id)}/pr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || result.error || `HTTP ${response.status}`);
      $("thread-output").textContent = [
        `branch  ${result.branch}`,
        result.commit ? `commit  ${result.commit}` : "",
        `pushed  ${result.pushed}`,
        result.pr_url ? `pull request  ${result.pr_url}` : "",
        result.compare_url ? `compare  ${result.compare_url}` : "",
        result.message || "",
      ]
        .filter(Boolean)
        .join("\n");
      await refresh();
    } catch (error) {
      $("thread-output").textContent = String(error.message || error);
    }
    return;
  }
  if (action === "remove") {
    if (!confirm(`Remove thread ${id}, its worktree and its branch? Uncommitted changes are discarded.`)) return;
    try {
      const response = await api(`/api/threads/${encodeURIComponent(id)}?force=1`, { method: "DELETE" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || result.error || `HTTP ${response.status}`);
      $("thread-output").textContent = `removed ${id}`;
      await refresh();
    } catch (error) {
      $("thread-output").textContent = String(error.message || error);
    }
  }
}

function fillBotSelects(list) {
  const options = [`<option value="">default</option>`]
    .concat(list.filter((bot) => !bot.default).map((bot) => `<option value="${esc(bot.name)}">${esc(bot.name)}</option>`))
    .join("");
  for (const id of ["secret-bot", "config-bot"]) {
    const select = $(id);
    if (!select) continue;
    const keep = select.value;
    select.innerHTML = options;
    if ([...select.options].some((option) => option.value === keep)) select.value = keep;
  }
}

function renderBots(section) {
  bots = value(section)?.bots || [];
  fillBotSelects(bots);
  $("bots").innerHTML = bots.length
    ? bots
        .map((bot) => {
          const channels = (bot.channels || []).filter((channel) => channel.kind !== "api");
          const channelText = channels.length ? channels.map((channel) => `${esc(channel.kind)}${channel.status && channel.status !== "connected" ? ` (${esc(channel.status)})` : ""}`).join(" · ") : `<span class="muted">none</span>`;
          const status = bot.status || (bot.enabled ? "stopped" : "stopped");
          return `<tr class="bot-row"><td><strong>${esc(bot.name)}</strong>${bot.default ? ` <span class="badge quiet">default</span>` : ""}<div class="muted">${esc(bot.persona || bot.description || "")}</div></td><td class="mono">${esc(bot.model || "—")}</td><td>${esc(bot.approvals || "—")}</td><td><span class="bot-status ${esc(status)}">${esc(status)}</span>${bot.error ? `<div class="muted">${esc(bot.error)}</div>` : ""}</td><td>${channelText}</td><td>${esc(bot.sessions ?? "—")}</td><td><div class="thread-actions"><button class="mini" data-bot-action="${status === "running" ? "disable" : "enable"}" data-name="${esc(bot.name)}">${status === "running" ? "Disable" : "Enable"}</button><button class="mini" data-bot-action="settings" data-name="${esc(bot.name)}">Settings</button></div></td></tr>`;
        })
        .join("")
    : `<tr><td colspan="7" class="muted">No bots.</td></tr>`;
}

async function addBot(event) {
  event.preventDefault();
  const name = $("bot-name").value.trim();
  const description = $("bot-description").value.trim();
  const model = $("bot-model").value.trim();
  const approvals = $("bot-approvals").value;
  const tools = $("bot-tools").value.split(",").map((tool) => tool.trim()).filter(Boolean);
  const workdir = $("bot-workdir").value.trim();
  const soul = $("bot-soul").value.trim();
  if (!name) return;
  try {
    const response = await api("/api/bots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        description,
        model: model || null,
        approvals: approvals || null,
        tools: tools.length ? tools : null,
        workdir: workdir || null,
        soul: soul || null,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || result.error || `HTTP ${response.status}`);
    $("bot-output").textContent = `added ${result.name}\n${result.path || ""}${result.warning ? `\nwarning: ${result.warning}` : ""}`;
    $("bot-form").reset();
    await refresh();
  } catch (error) {
    $("bot-output").textContent = String(error.message || error);
  }
}

async function botAction(action, name) {
  if (action === "settings") {
    $("config-bot").value = name === "default" ? "" : name;
    $("secret-bot").value = name === "default" ? "" : name;
    showView("settings");
    return;
  }
  try {
    const response = await api(`/api/bots/${encodeURIComponent(name)}/${action}`, { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || result.error || `HTTP ${response.status}`);
    $("bot-output").textContent = `${action}d ${name}${result.error ? `: ${result.error}` : ""}`;
    await refresh();
  } catch (error) {
    $("bot-output").textContent = String(error.message || error);
  }
}

function renderConnectors(section) {
  const list = value(section)?.bots || [];
  $("connectors").innerHTML = list.length
    ? list
        .map((bot) => {
          const on = new Set((bot.channels || []).filter((channel) => channel.kind !== "api").map((channel) => channel.kind));
          const cells = CHANNELS.map((channel) => {
            const active = on.has(channel);
            const detail = (bot.channels || []).find((item) => item.kind === channel);
            const status = detail && detail.status && detail.status !== "connected" ? ` (${detail.status})` : "";
            return `<td><button class="mini ${active ? "yes" : "no"}" data-connector="${channel}" data-bot="${esc(bot.default ? "" : bot.name)}" data-on="${active ? "1" : "0"}">${active ? `on${esc(status)}` : "off"}</button></td>`;
          }).join("");
          return `<tr><td><strong>${esc(bot.name)}</strong></td>${cells}</tr>`;
        })
        .join("")
    : `<tr><td colspan="8" class="muted">No bots.</td></tr>`;
}

async function toggleConnector(channel, bot, on) {
  try {
    const response = await api("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bot, key: `${channel}.enabled`, value: on ? "false" : "true", literal: false }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || result.error || `HTTP ${response.status}`);
    await refresh();
  } catch (error) {
    $("secret-output").textContent = String(error.message || error);
  }
}

async function saveSecret(event) {
  event.preventDefault();
  const bot = $("secret-bot").value;
  const file = $("secret-file").value.trim();
  const secret = $("secret-value").value;
  if (!file || !secret) return;
  try {
    const response = await api("/api/secrets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bot, file, value: secret }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || result.error || `HTTP ${response.status}`);
    $("secret-output").textContent = `wrote ${result.file} (mode 0600); enable the channel with a connector toggle.`;
    $("secret-value").value = "";
    await refresh();
  } catch (error) {
    $("secret-output").textContent = String(error.message || error);
  }
}

function renderMcp() {
  const names = settings.mcp || [];
  $("mcp").innerHTML = names.length
    ? names.map((name) => `<div class="insight"><strong>${esc(name)}</strong><span>configured</span></div>`).join("")
    : `<p class="muted">None configured.</p>`;
}

function renderUsage(agent, audit) {
  const usage = value(agent?.usage);
  const today = usage?.today || {};
  const insights = value(agent?.insights) || {};
  $("usage").innerHTML = [
    ["turns", today.turns ?? "—"],
    ["model calls", today.calls ?? "—"],
    ["tokens in", number(today.input)],
    ["tokens out", number(today.output)],
    ["cost", today.cost == null ? "—" : `$${Number(today.cost).toFixed(4)}`],
    ["cloud calls", today.cloud_calls ?? 0],
  ]
    .map(([label, value]) => `<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`)
    .join("");
  $("usage-note").textContent =
    today.calls == null
      ? "No usage recorded yet."
      : `${today.turns || 0} turn(s) today · ${today.cloud_calls ? `${today.cloud_calls} cloud call(s)` : "all local"}${today.unpriced?.length ? ` · unpriced: ${today.unpriced.join(", ")}` : ""}`;
  const models = insights.models || [];
  const tools = insights.tools || [];
  const failures = insights.failures || {};
  const rows = [];
  for (const model of models) {
    rows.push(`<div class="insight"><strong>${esc(model.model)}</strong><span>${esc(model.calls)} calls · ${number(model.tokens)} tokens · ${model.cloud ? "cloud" : "node"}</span></div>`);
  }
  for (const tool of tools) {
    rows.push(`<div class="insight"><strong>${esc(tool.name)}</strong><span>${esc(tool.count)} use(s)</span></div>`);
  }
  rows.push(`<div class="insight"><strong>failures</strong><span>${esc(failures.errors || 0)} errors · ${esc(failures.stopped || 0)} stopped · ${esc(failures.tool_errors || 0)} tool errors · ${esc(failures.refused || 0)} refused</span></div>`);
  $("insights").innerHTML = rows.join("");
  renderAudit(audit);
}

function renderAudit(audit) {
  const entries = value(audit)?.entries || [];
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

function renderProviders(gateway, agent, settingsValue) {
  const models = value(gateway?.models)?.data || [];
  const current = settingsValue?.gateway?.model || value(agent?.info)?.model || "auto";
  $("providers").innerHTML = models.length
    ? models
        .map((model) => {
          const info = model.invincible || {};
          return `<div class="provider"><span><strong>${esc(model.id)}</strong><span class="meta"> · ${esc(info.tier || "node")}${info.context ? ` · ${esc(info.context)} ctx` : ""} · ${esc(info.data_policy || "policy unknown")}</span></span><span class="${info.healthy === false ? "down" : "ok"}">${info.healthy === false ? "down" : "ready"}</span></div>`;
        })
        .join("")
    : `<p class="muted">No models reported.</p>`;
  const select = $("model-select");
  const options = [`<option value="auto">auto (the gateway chooses)</option>`]
    .concat(models.map((model) => `<option value="${esc(model.id)}">${esc(model.id)}</option>`))
    .join("");
  select.innerHTML = options;
  select.value = current;
  $("provider-note").textContent = `The gateway serves these models at ${settingsValue?.gateway?.url || "the configured URL"}. Provider keys stay in the gateway (Coolify's environment or the node's config); the panel never sees them.`;
}

function renderSettings(section, agent, gateway) {
  const data = value(section);
  if (!data) {
    $("agent-settings").textContent = "This agent does not expose settings (it may be an older Autobot).";
    $("tools").innerHTML = `<p class="muted">No settings.</p>`;
    return;
  }
  settings = data;
  $("approvals-select").value = data.approvals?.mode || "ask";
  $("agent-settings").innerHTML = [
    ["bot", data.bot + (data.default ? " (default)" : "")],
    ["workdir", data.agent?.workdir],
    ["sandbox", data.agent?.sandbox],
    ["max steps", data.agent?.max_steps],
    ["context", data.agent?.context_kib ? `${data.agent.context_kib} KiB` : "default"],
    ["serve", data.serve],
  ]
    .map(([label, value]) => `<div class="insight"><strong>${esc(label)}</strong><span>${esc(value ?? "—")}</span></div>`)
    .join("");
  $("tools").innerHTML = (data.agent?.tools || [])
    .map(
      (group) =>
        `<div class="insight"><strong>${esc(group.group)}</strong><span>${group.on ? "on" : "off"} · <button class="mini" data-tool-group="${esc(group.group)}" data-on="${group.on ? "1" : "0"}">${group.on ? "Turn off" : "Turn on"}</button></span></div>`,
    )
    .join("");
  renderProviders(gateway, agent, data);
  renderMcp();
}

async function setModel() {
  const model = $("model-select").value;
  try {
    const response = await api("/api/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || result.error || `HTTP ${response.status}`);
    $("config-output").textContent = result.said || `model set to ${model}`;
    await refresh();
  } catch (error) {
    $("config-output").textContent = String(error.message || error);
  }
}

async function setApprovals() {
  const mode = $("approvals-select").value;
  try {
    const response = await api("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "approvals.mode", value: mode, literal: true }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || result.error || `HTTP ${response.status}`);
    $("config-output").textContent = `approvals.mode = ${result.value || mode}`;
    await refresh();
  } catch (error) {
    $("config-output").textContent = String(error.message || error);
  }
}

async function toggleToolGroup(group, on) {
  try {
    const response = await api("/api/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: group, on: on === "1" ? false : true }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || result.error || `HTTP ${response.status}`);
    await refresh();
  } catch (error) {
    $("config-output").textContent = String(error.message || error);
  }
}

async function setConfig(event) {
  event.preventDefault();
  const bot = $("config-bot").value;
  const key = $("config-key").value.trim();
  const valueText = $("config-value").value;
  if (!key) return;
  try {
    const response = await api("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bot, key, value: valueText, literal: $("config-literal").checked }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || result.error || `HTTP ${response.status}`);
    $("config-output").textContent = `${key} = ${result.value ?? valueText}${result.from ? ` (${result.from})` : ""}${result.warning ? `\nwarning: ${result.warning}` : ""}`;
    $("config-value").value = "";
    await refresh();
  } catch (error) {
    $("config-output").textContent = String(error.message || error);
  }
}

async function answerApproval(id, answer) {
  try {
    await api(`/api/approvals/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer }),
    });
    await refresh();
  } catch (error) {
    setStatus("offline", error.message);
  }
}

async function refresh() {
  try {
    const response = await api("/api/overview");
    if (!response.ok) throw new Error(`overview ${response.status}`);
    const data = await response.json();
    overview = data;
    renderGateway(data.gateway);
    renderAgent(data.agent);
    renderToday(data.agent);
    renderApprovals(data.agent);
    renderSessions(data.agent);
    renderThreads(data.threads);
    renderBots(data.bots);
    renderConnectors(data.bots);
    renderUsage(data.agent, data.audit);
    renderSettings(data.settings, data.agent, data.gateway);
    const online = !unavailable(data.gateway?.models) && !unavailable(data.agent?.info);
    setStatus(online ? "online" : "offline", online ? "gateway + agent online" : "degraded");
    $("updated").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    $("footer-status").textContent = online ? "all systems answer" : "one service is not answering";
  } catch (error) {
    setStatus("offline", error.message || "unreachable");
  }
}

async function logout() {
  try {
    await api("/api/logout", { method: "POST" });
  } finally {
    location.href = "/login";
  }
}

function bind() {
  for (const tab of document.querySelectorAll("#tabs button")) {
    tab.addEventListener("click", () => showView(tab.dataset.view));
  }
  $("chat-form").addEventListener("submit", runChat);
  $("chat-new").addEventListener("click", newChat);
  $("thread-form").addEventListener("submit", newThread);
  $("bot-form").addEventListener("submit", addBot);
  $("secret-form").addEventListener("submit", saveSecret);
  $("config-form").addEventListener("submit", setConfig);
  $("model-save").addEventListener("click", setModel);
  $("approvals-save").addEventListener("click", setApprovals);
  $("bots-reload").addEventListener("click", async () => {
    try {
      const response = await api("/api/bots/reload", { method: "POST" });
      const result = await response.json();
      $("bot-output").textContent = JSON.stringify(result, null, 2);
      await refresh();
    } catch (error) {
      $("bot-output").textContent = String(error.message || error);
    }
  });
  $("logout").addEventListener("click", logout);

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.answer) answerApproval(button.dataset.id, button.dataset.answer);
    else if (button.dataset.session) loadHistory(button.dataset.session);
    else if (button.dataset.thread) threadAction(button.dataset.thread, button.dataset.id);
    else if (button.dataset.botAction) botAction(button.dataset.botAction, button.dataset.name);
    else if (button.dataset.connector) toggleConnector(button.dataset.connector, button.dataset.bot, button.dataset.on === "1");
    else if (button.dataset.toolGroup) toggleToolGroup(button.dataset.toolGroup, button.dataset.on);
  });
  document.addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-session]");
    if (!row) return;
    loadHistory(row.dataset.session);
    showView("chat");
  });
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
  bind();
  showView(location.hash.slice(1) || "overview");
  await refresh();
  timer = setInterval(() => {
    if (!busy) refresh();
  }, 15000);
}

start();
