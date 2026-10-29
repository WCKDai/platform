const $ = (id) => document.getElementById(id);
const VIEWS = ["overview", "chat", "mission", "workspaces", "delegations", "bots", "studio", "gpu", "project", "providers", "secrets", "variables", "subscriptions", "integrations", "usage", "settings"];
const CHANNELS = ["telegram", "discord", "slack", "email", "signal", "matrix", "whatsapp"];
const PAGE_META = {
  overview: ["Overview", "The node, the agent, and what needs you."],
  chat: ["Chat", "A conversation with Autobot. Tools, receipts and approvals stay in the transcript."],
  mission: ["Mission", "Brief, plan, worktrees and delegated runs in one place."],
  workspaces: ["Workspaces", "Parallel worktrees, diffs and pull requests."],
  delegations: ["Delegations", "Tasks that outlive a usage limit, and where they stand."],
  bots: ["Botmode", "Status, channels, and what each bot is working on."],
  studio: ["Studio", "Image, video and audio jobs. Keys stay on the node."],
  gpu: ["GPU", "EU rentals. Confirm the price before anything starts."],
  project: ["Project", "The standing brief for a large repository."],
  providers: ["Providers", "Gateway models and the agent CLIs installed on this machine."],
  secrets: ["Secrets", "Write-only credentials for connectors and hooks."],
  variables: ["Variables", "Non-secret context added to every turn."],
  subscriptions: ["Subscriptions", "Plans, renewals and monthly spend."],
  integrations: ["Integrations", "Channels, MCP servers and incoming webhooks."],
  usage: ["Usage", "Tokens, cost, models, tools and gateway receipts."],
  settings: ["Settings", "Approval policy, tools and advanced configuration."],
};
let csrf = "";
let busy = false;
let timer = 0;
let selectedSession = "";
let live = null;
let threads = [];
let bots = [];
let settings = {};
let overview = {};
let variables = [];
let subscriptions = [];
let delegationData = {};
let providerList = [];
let gatewayProviders = [];
let adapters = [];
let secretList = [];
let paletteIndex = 0;
let currentView = "overview";
let navSync = false;
let chatQuery = "";
let transcriptQuery = "";
let attachments = [];
let boardTasks = [];
let studioJobs = [];
let studioKind = "image";
let rentOffer = null;
let gpuSessions = [];
let gpuTimer = 0;

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
  navSync = true;
  for (const item of document.querySelectorAll("#nav wa-tree-item[data-view]")) item.selected = item.dataset.view === name;
  navSync = false;
  currentView = name;
  const [title, subtitle] = PAGE_META[name] || PAGE_META.overview;
  $("page-title").textContent = title;
  $("page-subtitle").textContent = subtitle;
  document.title = `${title} · Invincible Control`;
  if (location.hash.slice(1) !== name) history.replaceState(null, "", name === "overview" ? location.pathname : `#${name}`);
  if (name === "providers") {
    loadProviders();
    loadProviderAdmin();
  }
  if (name === "project") {
    fillProjectSelect();
    loadProject($("project-select").value);
  }
  if (name === "chat") layoutChat();
  if (name === "mission") loadMission();
  if (name === "studio") loadStudio();
  if (name === "gpu") loadGpu();
  window.scrollTo({ top: 0, behavior: "instant" });
}

function renderGateway(gateway) {
  const models = value(gateway?.models)?.data || [];
  const node = value(gateway?.node) || {};
  const ok = !unavailable(gateway?.models) && !unavailable(gateway?.node);
  $("gateway-state").textContent = ok ? "online" : "offline";
  $("gateway-state").className = `badge${ok ? "" : " bad"}`;
  if (ok) {
    const bits = [`${models.length} model(s)`];
    if ((node.speech || []).length) bits.push(`${node.speech.length} speech`);
    if ((node.images || []).length) bits.push(`${node.images.length} image`);
    $("gateway-node").textContent = `${node.name || "node"} · ${bits.join(" · ")}`;
  } else {
    $("gateway-node").textContent = "The gateway did not answer.";
  }
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
    : `${info.name || "Autobot"} · ${info.bots?.length || 0} bot(s) · ${info.model || "auto"}`;
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
  const filtered = sessions.filter((session) => {
    if (!chatQuery) return true;
    const hay = `${session.id} ${session.bot || ""}`.toLowerCase();
    return hay.includes(chatQuery);
  });
  $("sessions").innerHTML = filtered.length
    ? filtered
        .slice(0, 50)
        .map(
          (session) =>
            `<button type="button" class="conversation ${session.id === selectedSession ? "active" : ""}" data-session="${esc(session.id)}"><span class="name">${esc(session.id)}</span><span class="sub">${esc(session.bot || "default")} · ${esc(when(session.modified))}</span></button>`,
        )
        .join("")
    : `<p class="empty"><strong>${chatQuery ? "No matches." : "No conversations yet."}</strong><span>${chatQuery ? "Try another id or bot name." : "Send a task to start one."}</span></p>`;
  $("recent").innerHTML = sessions.length
    ? sessions
        .slice(0, 6)
        .map(
          (session) =>
            `<div class="row-item"><button type="button" class="linkish" data-session="${esc(session.id)}">${esc(session.id)}</button><span class="meta">${esc(session.bot || "default")} · ${esc(when(session.modified))}</span></div>`,
        )
        .join("")
    : `<p class="muted">No conversations yet.</p>`;
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

function renderPlan(plan) {
  const box = $("chat-plan");
  const items = plan?.items || [];
  if (!items.length) {
    box.hidden = true;
    box.open = false;
    $("chat-plan-items").innerHTML = "";
    return;
  }
  box.hidden = false;
  $("chat-plan-count").textContent = `${plan.done ?? 0} of ${plan.total ?? items.length} done`;
  $("chat-plan-items").innerHTML = items
    .map((item) => {
      const status = item.status || "pending";
      return `<li class="plan-${esc(status)}" title="${esc(status)}"><span class="mark" aria-hidden="true"></span><span>${esc(item.text)}</span></li>`;
    })
    .join("");
  box.open = items.some((item) => item.status !== "done");
}

async function loadPlan() {
  if (!selectedSession) {
    renderPlan(null);
    return;
  }
  try {
    const response = await api(`/api/plan?session=${encodeURIComponent(selectedSession)}`);
    if (!response.ok) return;
    renderPlan(await response.json());
  } catch {}
}

function renderChat(messages) {
  const chat = $("chat");
  if (!messages || !messages.length) {
    chat.innerHTML = `<p class="empty"><strong>No messages yet.</strong><span>Say what Autobot should do.</span></p>`;
    return;
  }
  chat.innerHTML = messages.slice(-60).map(messageBubble).join("");
  applyTranscriptQuery();
  chat.scrollTop = chat.scrollHeight;
}

function applyTranscriptQuery() {
  if (!transcriptQuery) return;
  const chat = $("chat");
  const needle = transcriptQuery.toLowerCase();
  for (const node of chat.querySelectorAll(".bubble")) {
    if (!node.textContent.toLowerCase().includes(needle)) node.hidden = true;
  }
}

function appendBubble(kind, content) {
  const chat = $("chat");
  if (chat.querySelector(".muted") && chat.children.length === 1) chat.innerHTML = "";
  const node = document.createElement("div");
  node.className = `bubble ${kind}`;
  node.textContent = content;
  chat.append(node);
  chat.scrollTop = chat.scrollHeight;
  return node;
}

function liveBubble() {
  if (!live) {
    live = appendBubble("assistant live", "");
  }
  const chat = $("chat");
  chat.scrollTop = chat.scrollHeight;
  return live;
}

function clearLive() {
  if (live) {
    live.classList.remove("live");
    if (!live.textContent) live.remove();
  }
  live = null;
}

function appendDetails(summary, text, kind = "tool") {
  const chat = $("chat");
  if (chat.querySelector(".muted") && chat.children.length === 1) chat.innerHTML = "";
  const node = document.createElement("details");
  node.className = `bubble ${kind}`;
  const title = document.createElement("summary");
  title.textContent = summary;
  const body = document.createElement("pre");
  body.textContent = text;
  node.append(title, body);
  chat.append(node);
  chat.scrollTop = chat.scrollHeight;
}

function appendApproval(event) {
  live = null;
  const chat = $("chat");
  if (chat.querySelector(".muted") && chat.children.length === 1) chat.innerHTML = "";
  const node = document.createElement("div");
  node.className = "bubble approval-card";
  const text = document.createElement("strong");
  text.textContent = event.text || "Approval requested";
  const actions = document.createElement("div");
  actions.className = "actions";
  for (const answer of ["once", "always", "deny"]) {
    const button = document.createElement("button");
    button.className = `mini ${answer === "deny" ? "no" : "yes"}`;
    button.dataset.answer = answer;
    button.dataset.id = event.id || "";
    button.textContent = answer[0].toUpperCase() + answer.slice(1);
    actions.append(button);
  }
  node.append(text, actions);
  chat.append(node);
  chat.scrollTop = chat.scrollHeight;
}

async function loadHistory(id) {
  selectedSession = id;
  live = null;
  $("chat-session").value = id;
  $("chat-title").textContent = id;
  $("chat-session-label").textContent = "saved";
  $("chat").innerHTML = `<p class="muted">Loading ${esc(id)}…</p>`;
  try {
    const response = await api(`/api/history/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`history ${response.status}`);
    const data = await response.json();
    renderChat(data.messages || []);
    renderPlan(data.plan);
  } catch (error) {
    $("chat").innerHTML = `<p class="bubble error">${esc(error.message || error)}</p>`;
  }
}

function handleStreamEvent(event) {
  if (!event) return;
  if (event.type === "turn.started") {
    setStatus("online", "working…");
    return;
  }
  if (event.type === "text") {
    liveBubble().textContent += event.delta || "";
    $("chat").scrollTop = $("chat").scrollHeight;
    return;
  }
  if (event.type === "reasoning") {
    const text = event.delta || event.text || "";
    if (!text) return;
    let node = $("chat").querySelector("[data-reasoning]");
    if (!node) {
      node = document.createElement("wa-details");
      node.dataset.reasoning = "1";
      node.className = "bubble tool";
      const summary = document.createElement("span");
      summary.slot = "summary";
      summary.textContent = "Reasoning";
      const body = document.createElement("pre");
      node.append(summary, body);
      $("chat").append(node);
    }
    node.querySelector("pre").textContent += text;
    $("chat").scrollTop = $("chat").scrollHeight;
    return;
  }
  if (event.type === "tool") {
    live = null;
    appendBubble("tool", `› ${event.text || "tool"}`);
    return;
  }
  if (event.type === "tool_output") {
    appendDetails(`tool output · ${event.name || "tool"}`, event.text || "");
    return;
  }
  if (event.type === "diff") {
    appendDetails("diff", event.text || "");
    return;
  }
  if (event.type === "change") {
    appendBubble("note", `changed ${event.path || "a file"} (${event.after_bytes ?? "?"} bytes)`);
    return;
  }
  if (event.type === "usage") return;
  if (event.type === "approval") {
    appendApproval(event);
    return;
  }
  if (event.type === "answer") {
    if (live) {
      live.textContent = event.text || live.textContent;
      live = null;
    } else {
      appendBubble("assistant", event.text || "(no answer)");
    }
    return;
  }
  if (event.type === "error") {
    live = null;
    appendBubble("error", event.text || "error");
    return;
  }
  if (event.type === "delegate.started") {
    const how = event.questions === "owner" ? "questions go to you" : `up to ${event.max_nudges ?? 0} nudges`;
    appendBubble("note", `delegated: ${how}, approvals declined${event.until ? ` · ${event.until}` : ""}`);
    return;
  }
  if (event.type === "delegate.nudge") {
    live = null;
    appendBubble("note", `delegated nudge ${event.number}/${event.of} · ${event.reason || "continue"}`);
    return;
  }
  if (event.type === "delegate.declined") {
    live = null;
    appendDetails("delegated · approval declined", event.text || "");
    return;
  }
  if (event.type === "delegate.stalled") {
    live = null;
    appendBubble("note", `delegated: stalled after ${event.seconds ?? "?"}s`);
    return;
  }
  if (event.type === "delegate.waiting") {
    live = null;
    appendBubble("note", `delegated: usage limit; waiting ${event.seconds ?? "?"}s`);
    return;
  }
  if (event.type === "delegate.paused") {
    live = null;
    const job = event.job_id ? ` · job ${String(event.job_id).slice(0, 10)}` : "";
    const when = event.auto_resume ? "it resumes automatically" : "resume it from Delegations";
    appendBubble("note", `delegated: paused until ${event.retry_at_local || "the limit clears"} · ${when}${job}`);
    return;
  }
  if (event.type === "delegate.finished") {
    clearLive();
    appendBubble("note", `delegated: ${event.nudges ?? 0} nudges, ${event.declined ?? 0} declined${event.waiting_on_owner ? " · waiting for you" : ""}`);
    return;
  }
  if (event.type === "delegate.stopped") {
    live = null;
    appendBubble("note", `delegated stopped: ${event.reason || "stopped"}`);
    return;
  }
  if (event.type === "refused") appendBubble("note", `refused: ${event.text || ""}`);
  else if (event.type === "receipt") {
    appendBubble("receipt", `receipt ${String(event.id || "").slice(0, 8)}${event.model ? ` · ${event.model}` : ""}${event.tier ? ` · ${event.tier}` : ""}`);
  } else if (event.type === "member") appendBubble("note", `${event.agent || "member"}: ${event.text || ""}`);
  else if (event.type === "kept") appendBubble("note", `kept: ${event.text || ""}`);
}

async function runChat(event) {
  event.preventDefault();
  if (busy) return;
  const input = $("chat-text");
  const textValue = input.value.trim();
  const images = attachments.filter((file) => file.image);
  const files = attachments.filter((file) => !file.image);
  const folded = files.map((file) => `\n\n[${file.name}]\n${file.text}`).join("");
  const message = `${textValue}${folded}`.trim();
  if (!message && !images.length) return;
  if (message.length > 8000) {
    toast("That message is longer than 8000 characters", "bad");
    return;
  }
  const session = $("chat-session").value.trim();
  const keepGoing = $("chat-delegate").checked;
  const bot = $("chat-bot").value;
  const button = $("chat-send");
  busy = true;
  button.disabled = true;
  live = null;
  const bubble = appendBubble("user", message || "(image)");
  for (const image of images) {
    const pic = document.createElement("img");
    pic.alt = image.name;
    pic.src = image.url;
    bubble.append(pic);
  }
  input.value = "";
  attachments = [];
  renderAttachments();
  try {
    const body = { text: message, session, images: images.map((image) => ({ type: "image_url", image_url: { url: image.url } })) };
    if (bot) body.bot = bot;
    if (keepGoing) body.delegated = { max_nudges: 2 };
    const response = await api("/api/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const assigned = response.headers.get("X-Session-Id");
    if (assigned) {
      selectedSession = assigned;
      $("chat-session").value = assigned;
      $("chat-title").textContent = assigned;
      $("chat-session-label").textContent = "saved";
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
    live = null;
    try {
      await refresh();
      await loadPlan();
    } finally {
      button.disabled = false;
    }
  }
}

function newChat() {
  selectedSession = "";
  live = null;
  $("chat-session").value = "";
  $("chat-title").textContent = "New conversation";
  $("chat-session-label").textContent = "not saved yet";
  $("chat").innerHTML = `<p class="muted">Pick a conversation, or ask Autobot to do something.</p>`;
  renderPlan(null);
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
  fillAdapterThreads();
  fillProjectSelect();
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
    const drafted = await askPr(thread?.name || `Autobot: ${thread?.branch || id}`, "");
    if (!drafted) return;
    const title = drafted.title;
    const body = drafted.body;
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
    if (!(await askConfirm(`Remove thread ${id}, its worktree and its branch? Uncommitted changes are discarded.`, "Remove"))) return;
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
  const options = [`<wa-option value="">default</wa-option>`]
    .concat(list.filter((bot) => !bot.default).map((bot) => `<wa-option value="${esc(bot.name)}">${esc(bot.name)}</wa-option>`))
    .join("");
  for (const id of ["secret-bot", "config-bot", "chat-bot"]) {
    const select = $(id);
    if (!select) continue;
    const keep = select.value;
    select.innerHTML = options;
    if ([...select.querySelectorAll("wa-option")].some((option) => option.value === keep)) select.value = keep;
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
          const work = workForBot(bot.name);
          return `<tr class="bot-row"><td><strong>${esc(bot.name)}</strong>${bot.default ? ` <span class="badge quiet">default</span>` : ""}<div class="muted">${esc(bot.persona || bot.description || "")}</div></td><td class="mono">${esc(bot.model || "—")}</td><td>${esc(bot.approvals || "—")}</td><td><span class="bot-status ${esc(status)}">${esc(status)}</span>${bot.error ? `<div class="muted">${esc(bot.error)}</div>` : ""}</td><td>${channelText}</td><td>${esc(bot.sessions ?? "—")}</td><td>${work}</td><td><div class="thread-actions"><wa-button size="s" variant="neutral" data-bot-action="talk" data-name="${esc(bot.name)}">Talk</wa-button><wa-button size="s" variant="${status === "running" ? "danger" : "brand"}" appearance="outlined" data-bot-action="${status === "running" ? "disable" : "enable"}" data-name="${esc(bot.name)}">${status === "running" ? "Disable" : "Enable"}</wa-button><wa-button size="s" variant="neutral" appearance="plain" data-bot-action="settings" data-name="${esc(bot.name)}">Settings</wa-button></div></td></tr>`;
        })
        .join("")
    : `<tr><td colspan="8" class="muted">No bots.</td></tr>`;
  renderBotCards(bots);
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
  if (action === "talk") {
    const bot = bots.find((item) => item.name === name);
    selectedSession = "";
    $("chat-session").value = "";
    $("chat-title").textContent = `New chat · ${name}`;
    $("chat-session-label").textContent = "not saved yet";
    $("chat-bot").value = bot?.default ? "" : name;
    $("chat").innerHTML = `<p class="empty"><strong>Talking to ${esc(name)}.</strong><span>The next message starts a conversation with this bot.</span></p>`;
    showView("chat");
    $("chat-text").focus();
    return;
  }
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
    toast(`${result.file} saved`, "good");
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
  const options = [`<wa-option value="auto">auto (the gateway chooses)</wa-option>`]
    .concat(models.map((model) => `<wa-option value="${esc(model.id)}">${esc(model.id)}</wa-option>`))
    .join("");
  select.innerHTML = options;
  select.value = current;
  $("provider-note").textContent = `The gateway serves these models at ${settingsValue?.gateway?.url || "the configured URL"}. Provider keys are written by the form below; the gateway keeps them and never sends a key back to this browser.`;
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
  $("check-command").value = data.agent?.check || "";
  $("agent-settings").innerHTML = [
    ["bot", data.bot + (data.default ? " (default)" : "")],
    ["workdir", data.agent?.workdir],
    ["sandbox", data.agent?.sandbox],
    ["max steps", data.agent?.max_steps],
    ["check", data.agent?.check || "none"],
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
    toast(result.said || `Model set to ${model}`, "good");
    await refresh();
  } catch (error) {
    $("config-output").textContent = String(error.message || error);
  }
}

async function saveCheck() {
  try {
    await write("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "agent.check", value: $("check-command").value.trim(), literal: true }),
    });
    toast("Verification check saved", "good");
    await refresh();
  } catch (error) {
    toast(String(error.message || error), "bad");
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

async function write(path, options = {}) {
  const response = await api(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.error || data.message || `HTTP ${response.status}`);
  return data;
}

function toast(message, kind = "") {
  const variant = kind === "bad" ? "danger" : kind === "good" ? "success" : "neutral";
  const stack = $("toasts");
  if (stack?.create) {
    stack.create(String(message), { variant, duration: 4500 });
    return;
  }
  const node = document.createElement("div");
  node.className = `toast ${kind}`;
  node.textContent = message;
  stack.append(node);
  setTimeout(() => node.remove(), 4500);
}

function money(amount, currency = "USD") {
  return `${currency || "USD"} ${Number(amount || 0).toFixed(2)}`;
}

function bytes(size) {
  const n = Number(size || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

function renderVariables(section) {
  variables = value(section)?.variables || [];
  $("variables").innerHTML = variables.length
    ? variables
        .map(
          (variable) =>
            `<tr><td class="mono">${esc(variable.key)}</td><td>${esc(String(variable.value || "").slice(0, 160))}</td><td class="muted">${esc(variable.description || "—")}</td><td class="muted">${esc(when(variable.updated_at))}</td><td><button class="mini no" type="button" data-variable="${esc(variable.key)}">Remove</button></td></tr>`,
        )
        .join("")
    : `<tr><td colspan="5" class="muted">No variables. Add project names, hosts or conventions above.</td></tr>`;
}

async function addVariable(event) {
  event.preventDefault();
  const key = $("variable-key").value.trim();
  const valueText = $("variable-value").value;
  const description = $("variable-description").value.trim();
  if (!key || !valueText.trim()) return;
  try {
    await write("/api/variables", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value: valueText, description }),
    });
    $("variable-form").reset();
    $("variable-output").textContent = "";
    toast(`Variable ${key} saved`, "good");
    await refresh();
  } catch (error) {
    $("variable-output").textContent = String(error.message || error);
  }
}

async function removeVariable(key) {
  if (!(await askConfirm(`Remove variable ${key}?`, "Remove"))) return;
  try {
    await write(`/api/variables/${encodeURIComponent(key)}`, { method: "DELETE" });
    toast(`Variable ${key} removed`, "good");
    await refresh();
  } catch (error) {
    toast(String(error.message || error), "bad");
  }
}

function renderSubscriptionOverview(section) {
  const data = value(section);
  if (!data || !(data.subscriptions || []).length) {
    $("subscription-overview").innerHTML = `<p class="muted">No plans recorded.</p>`;
    return;
  }
  const totals = (data.totals || []).map((total) => money(total.monthly, total.currency)).join(" · ") || "—";
  const next = (data.upcoming || [])[0];
  $("subscription-overview").innerHTML = [
    `<div class="insight"><strong>Monthly</strong><span>${esc(totals)}</span></div>`,
    `<div class="insight"><strong>Plans</strong><span>${esc(data.active ?? 0)} active · ${esc(data.all ?? 0)} total</span></div>`,
    `<div class="insight"><strong>Renewals</strong><span>${next ? `${esc(next.name)} in ${esc(next.days)} d` : "none in 30 days"}</span></div>`,
  ].join("");
}

let projectData = {};

function fillProjectSelect() {
  const select = $("project-select");
  if (!select) return;
  const keep = select.value;
  select.innerHTML = [`<wa-option value="">This agent's project</wa-option>`]
    .concat(
      threads.map(
        (thread) =>
          `<wa-option value="${esc(thread.id)}">${esc(thread.name || thread.id)} · ${esc(thread.branch)}</wa-option>`,
      ),
    )
    .join("");
  if ([...select.querySelectorAll("wa-option")].some((option) => option.value === keep)) select.value = keep;
}

async function loadProject(thread = "") {
  const status = $("project-status");
  status.textContent = "Reading…";
  try {
    const response = await api(`/api/project${thread ? `?thread=${encodeURIComponent(thread)}` : ""}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || data.error || `HTTP ${response.status}`);
    projectData = data;
    $("project-root").value = data.root || "";
    $("project-check").value = data.check || "not set";
    $("project-brief").value = data.brief || "";
    status.textContent = data.updated_at
      ? `Saved ${when(data.updated_at)} · ${data.characters} characters`
      : "No brief for this project yet.";
    $("project-output").textContent = "";
  } catch (error) {
    status.textContent = String(error.message || error);
    $("project-output").textContent = "";
  }
}

async function saveProject() {
  const thread = $("project-select").value;
  const brief = $("project-brief").value;
  if (brief.length > 64000) {
    toast("The brief is longer than 64000 characters", "bad");
    return;
  }
  const status = $("project-status");
  status.textContent = "Saving…";
  try {
    const data = await write("/api/project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brief, thread: thread || null }),
    });
    projectData = data;
    $("project-brief").value = data.brief || "";
    status.textContent = data.updated_at
      ? `Saved ${when(data.updated_at)} · ${data.characters} characters`
      : "No brief for this project yet.";
    $("project-output").textContent = data.root || "";
    toast(brief.trim() ? "Project brief saved" : "Project brief removed", "good");
  } catch (error) {
    status.textContent = String(error.message || error);
    toast(String(error.message || error), "bad");
  }
}

async function removeProject() {
  if (!(await askConfirm("Remove the brief for this project? The repository's files are untouched.", "Remove"))) return;
  const thread = $("project-select").value;
  try {
    await write(`/api/project${thread ? `?thread=${encodeURIComponent(thread)}` : ""}`, { method: "DELETE" });
    $("project-brief").value = "";
    toast("Project brief removed", "good");
    await loadProject(thread);
  } catch (error) {
    toast(String(error.message || error), "bad");
  }
}

function renderDelegations(section) {
  const data = value(section) || {};
  delegationData = data;
  const jobs = data.delegations || [];
  $("delegation-summary").innerHTML = [
    ["paused", data.paused ?? 0],
    ["running", data.running ?? 0],
    ["kept", jobs.length],
    ["auto resume", `up to ${data.max_resumes ?? 5}`],
  ]
    .map(([label, valueText]) => `<div><span>${esc(label)}</span><strong>${esc(valueText)}</strong></div>`)
    .join("");
  $("delegations").innerHTML = jobs.length
    ? jobs
        .map((job) => {
          const tone = job.state === "paused" ? "quiet" : job.state === "running" ? "" : job.state === "done" ? "" : "bad";
          const retry = job.state === "paused" ? when(job.retry_at) : "—";
          const result = job.last_error || job.final_text || "—";
          const actions =
            job.state === "paused"
              ? `<div class="thread-actions"><button class="mini" type="button" data-delegation-resume="${esc(job.id)}">Resume now</button><button class="mini no" type="button" data-delegation-cancel="${esc(job.id)}">Cancel</button></div>`
              : `<button class="mini" type="button" data-session="${esc(job.session)}">Open</button>`;
          return `<tr><td><strong>${esc(job.task || job.session)}</strong><div class="muted mono">${esc(job.bot)} · ${esc(job.session)}</div></td><td><span class="badge ${tone}">${esc(job.state)}</span>${job.owner_controls ? `<div class="muted">owner controls</div>` : ""}</td><td class="mono">${esc(job.resumes)} / ${esc(job.max_resumes)}</td><td class="muted">${esc(retry)}</td><td class="muted">${esc(String(result).slice(0, 240))}</td><td>${actions}</td></tr>`;
        })
        .join("")
    : `<tr><td colspan="6" class="muted">No delegated runs have paused. Start one from Chat with delegated mode on.</td></tr>`;
}

async function delegationAction(id, action) {
  if (action === "cancel" && !(await askConfirm(`Cancel paused delegation ${id}? Its conversation and worktree stay.`, "Cancel run"))) return;
  try {
    await write(`/api/delegations/${encodeURIComponent(id)}/${action}`, { method: "POST" });
    $("delegation-output").textContent =
      action === "resume" ? `resuming ${id} now` : `cancelled ${id}`;
    toast(action === "resume" ? "Delegation resuming" : "Delegation cancelled", "good");
    await refresh();
  } catch (error) {
    $("delegation-output").textContent = String(error.message || error);
    toast(String(error.message || error), "bad");
  }
}

function renderSubscriptions(section) {
  const data = value(section) || {};
  subscriptions = data.subscriptions || [];
  const totals = (data.totals || []).map((total) => money(total.monthly, total.currency)).join(" · ") || "—";
  const upcoming = data.upcoming || [];
  $("subscription-summary").innerHTML = [
    ["active", data.active ?? 0],
    ["plans", data.all ?? subscriptions.length],
    ["monthly", totals],
    ["renewing", upcoming.length ? `${upcoming.length} in 30d` : "none"],
  ]
    .map(([label, valueText]) => `<div><span>${esc(label)}</span><strong>${esc(valueText)}</strong></div>`)
    .join("");
  $("subscriptions").innerHTML = subscriptions.length
    ? subscriptions
        .map((subscription) => {
          const tone = subscription.status === "active" ? "" : subscription.status === "cancelled" ? "bad" : "quiet";
          return `<tr><td><strong>${esc(subscription.name)}</strong>${subscription.plan ? `<div class="muted">${esc(subscription.plan)}</div>` : ""}</td><td>${esc(subscription.provider || "—")}</td><td><span class="badge ${tone}">${esc(subscription.status)}</span></td><td class="mono">${esc(money(subscription.monthly_cost, subscription.currency))}</td><td class="muted">${esc(subscription.renews_on || "—")}</td><td>${esc(subscription.seats || 1)}</td><td><div class="thread-actions"><button class="mini" type="button" data-subscription-edit="${esc(subscription.id)}">Edit</button><button class="mini no" type="button" data-subscription-delete="${esc(subscription.id)}">Remove</button></div></td></tr>`;
        })
        .join("")
    : `<tr><td colspan="7" class="muted">No subscriptions. Add the plans you pay for to see the real monthly cost.</td></tr>`;
  $("subscription-upcoming").innerHTML = upcoming.length
    ? upcoming
        .map(
          (item) =>
            `<div class="insight"><strong>${esc(item.name)}</strong><span>${esc(item.renews_on)} · in ${esc(item.days)} d</span></div>`,
        )
        .join("")
    : `<p class="muted">No renewals in the next 30 days.</p>`;
  renderSubscriptionOverview(section);
}

function editSubscription(id) {
  const subscription = subscriptions.find((item) => item.id === id);
  if (!subscription) return;
  $("subscription-id").value = subscription.id;
  $("subscription-name").value = subscription.name || "";
  $("subscription-provider").value = subscription.provider || "";
  $("subscription-plan").value = subscription.plan || "";
  $("subscription-status").value = subscription.status || "active";
  $("subscription-cost").value = subscription.monthly_cost ?? 0;
  $("subscription-currency").value = subscription.currency || "USD";
  $("subscription-renew").value = subscription.renews_on || "";
  $("subscription-seats").value = subscription.seats || 1;
  $("subscription-url").value = subscription.url || "";
  $("subscription-notes").value = subscription.notes || "";
  $("subscription-form-title").textContent = "Edit subscription";
  $("subscription-cancel").hidden = false;
  $("subscription-name").focus();
}

function resetSubscriptionForm() {
  $("subscription-form").reset();
  $("subscription-id").value = "";
  $("subscription-currency").value = "USD";
  $("subscription-status").value = "active";
  $("subscription-seats").value = 1;
  $("subscription-form-title").textContent = "Add a subscription";
  $("subscription-cancel").hidden = true;
  $("subscription-output").textContent = "";
}

async function saveSubscription(event) {
  event.preventDefault();
  const payload = {
    id: $("subscription-id").value,
    name: $("subscription-name").value.trim(),
    provider: $("subscription-provider").value.trim(),
    plan: $("subscription-plan").value.trim(),
    status: $("subscription-status").value,
    monthly_cost: Number($("subscription-cost").value || 0),
    currency: $("subscription-currency").value.trim().toUpperCase(),
    renews_on: $("subscription-renew").value || null,
    seats: Number($("subscription-seats").value || 1),
    url: $("subscription-url").value.trim() || null,
    notes: $("subscription-notes").value.trim(),
  };
  if (!payload.name) return;
  try {
    await write("/api/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    resetSubscriptionForm();
    toast(payload.id ? "Subscription updated" : "Subscription added", "good");
    await refresh();
  } catch (error) {
    $("subscription-output").textContent = String(error.message || error);
  }
}

async function removeSubscription(id) {
  const subscription = subscriptions.find((item) => item.id === id);
  if (!(await askConfirm(`Remove ${subscription?.name || id}?`, "Remove"))) return;
  try {
    await write(`/api/subscriptions/${encodeURIComponent(id)}`, { method: "DELETE" });
    if ($("subscription-id").value === id) resetSubscriptionForm();
    toast("Subscription removed", "good");
    await refresh();
  } catch (error) {
    toast(String(error.message || error), "bad");
  }
}

function renderSecrets(section) {
  secretList = value(section)?.secrets || [];
  $("secrets").innerHTML = secretList.length
    ? secretList
        .map(
          (secret) =>
            `<tr><td class="mono">${esc(secret.name)}</td><td><span class="badge quiet">${esc(secret.kind)}</span></td><td class="muted">${esc(bytes(secret.bytes))}</td><td class="muted">${esc(when(secret.updated_at))}</td><td><button class="mini no" type="button" data-secret-delete="${esc(secret.name)}">Remove</button></td></tr>`,
        )
        .join("")
    : `<tr><td colspan="5" class="muted">No secret files yet. Add a connector token or a named secret on the right.</td></tr>`;
}

async function removeSecret(name) {
  if (!(await askConfirm(`Remove secret file ${name}?`, "Remove"))) return;
  try {
    await write(`/api/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
    toast(`${name} removed`, "good");
    await refresh();
  } catch (error) {
    toast(String(error.message || error), "bad");
  }
}

function setSelectValue(select, value) {
  if (![...select.querySelectorAll("wa-option")].some((option) => option.value === value)) {
    const option = document.createElement("wa-option");
    option.value = value;
    option.textContent = value;
    select.append(option);
  }
  select.value = value;
}

function renderGatewayProviders(data) {
  const providers = data?.providers || [];
  gatewayProviders = providers;
  $("gateway-providers").innerHTML = providers.length
    ? providers
        .map((provider) => {
          const tone = provider.loaded ? (provider.healthy ? "" : "bad") : "quiet";
          const status = provider.loaded ? (provider.healthy ? "ready" : "down") : "not loaded";
          const key = provider.key === "environment" ? "environment" : provider.key === "set" ? "set" : "missing";
          return `<tr><td><strong>${esc(provider.id)}</strong></td><td class="mono">${esc(provider.upstream_model || "—")}</td><td class="muted">${esc(provider.host || provider.base_url || "—")}</td><td><span class="badge quiet">${esc(provider.data_policy || "unknown")}</span></td><td class="mono">${esc(key)}</td><td><span class="badge ${tone}">${esc(status)}</span></td><td><div class="thread-actions"><button class="mini" type="button" data-provider-edit="${esc(provider.id)}">Edit</button><button class="mini no" type="button" data-provider-remove="${esc(provider.id)}">Remove</button></div></td></tr>`;
        })
        .join("")
    : `<tr><td colspan="7" class="muted">No cloud providers. Add one below; the gateway hot-loads it.</td></tr>`;
  const bits = [`egress ${data?.egress || "unknown"}`, `network ${data?.network || "unknown"}`];
  if (data?.egress === "never") bits.push("cloud providers are configured but egress is never; the gateway will refuse them until [node] egress is ask or auto");
  $("provider-output").textContent = bits.join(" · ");
}

async function loadProviderAdmin() {
  try {
    const response = await api("/api/providers");
    if (!response.ok) throw new Error(`providers ${response.status}`);
    renderGatewayProviders(await response.json());
  } catch (error) {
    $("gateway-providers").innerHTML = `<tr><td colspan="7" class="muted">${esc(error.message || error)}</td></tr>`;
  }
}

const PROVIDER_PRESETS = {
  anthropic: { url: "https://api.anthropic.com/v1", model: "claude-sonnet-5-5", context: 200000, policy: "retention:30" },
  openai: { url: "https://api.openai.com/v1", model: "", context: 128000, policy: "retention:30" },
  deepseek: { url: "https://api.deepseek.com/v1", model: "deepseek-chat", context: 64000, policy: "trains" },
  openrouter: { url: "https://openrouter.ai/api/v1", model: "", context: "", policy: "unknown" },
};

function applyProviderPreset() {
  const preset = PROVIDER_PRESETS[$("provider-preset").value];
  if (!preset) return;
  $("provider-url").value = preset.url;
  $("provider-model").value = preset.model;
  $("provider-context").value = preset.context ?? "";
  $("provider-policy").value = preset.policy;
  if (!$("provider-id").value) $("provider-id").value = $("provider-preset").value;
}

function resetProviderForm() {
  $("provider-form").reset();
  $("provider-edit-id").value = "";
  $("provider-id").disabled = false;
  $("provider-form-title").textContent = "Add a provider";
  $("provider-cancel").hidden = true;
  $("provider-key").placeholder = "Required for a new provider";
  $("provider-form-output").textContent = "";
  $("provider-form-status").textContent = "The key is never returned to this browser.";
}

function editProvider(id) {
  const provider = gatewayProviders.find((item) => item.id === id);
  if (!provider) return;
  $("provider-edit-id").value = provider.id;
  $("provider-preset").value = "custom";
  $("provider-id").value = provider.id;
  $("provider-id").disabled = true;
  $("provider-model").value = provider.upstream_model || "";
  $("provider-url").value = provider.base_url || "";
  $("provider-key").value = "";
  $("provider-key").placeholder = "Leave blank to keep the current key";
  $("provider-context").value = provider.context || "";
  setSelectValue($("provider-policy"), provider.data_policy || "unknown");
  $("provider-vision").value = provider.vision === true ? "true" : provider.vision === false ? "false" : "";
  $("provider-form-title").textContent = `Edit ${provider.id}`;
  $("provider-cancel").hidden = false;
  $("provider-form-output").textContent = "";
  $("provider-form-status").textContent = "Saving replaces this provider and hot-loads the change.";
}

async function saveProvider(event) {
  event.preventDefault();
  const edit = $("provider-edit-id").value;
  const id = edit || $("provider-id").value.trim();
  if (!id) {
    toast("Give the provider an id", "bad");
    return;
  }
  const key = $("provider-key").value.trim();
  const vision = $("provider-vision").value;
  const payload = {
    id,
    provider: $("provider-preset").value,
    upstream_model: $("provider-model").value.trim() || null,
    base_url: $("provider-url").value.trim() || null,
    context: Number($("provider-context").value) || null,
    data_policy: $("provider-policy").value,
    vision: vision === "" ? null : vision === "true",
  };
  if (key) payload.api_key = key;
  $("provider-form-status").textContent = "Saving…";
  try {
    const saved = await write("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    $("provider-form-output").textContent = `${saved.id} · ${saved.upstream_model} at ${saved.base_url}
key ${saved.key} · ${saved.loaded ? "loaded now" : "not loaded"}`;
    $("provider-key").value = "";
    resetProviderForm();
    $("provider-form-output").textContent = `${saved.id} saved and loaded by the gateway.`;
    toast(key ? "Provider saved with its key" : "Provider saved", "good");
    await loadProviderAdmin();
    await refresh();
  } catch (error) {
    $("provider-form-status").textContent = String(error.message || error);
    $("provider-form-output").textContent = String(error.message || error);
    toast(String(error.message || error), "bad");
  }
}

async function removeProvider(id) {
  if (!(await askConfirm(`Remove provider ${id}? Its key file is deleted and the gateway stops routing to it.`, "Remove"))) return;
  try {
    await write(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
    toast(`${id} removed`, "good");
    await loadProviderAdmin();
    await refresh();
  } catch (error) {
    toast(String(error.message || error), "bad");
  }
}

async function loadProviders() {
  try {
    const response = await api("/api/adapters");
    if (!response.ok) throw new Error(`adapters ${response.status}`);
    const data = await response.json();
    renderAgentProviders(data.adapters || []);
  } catch (error) {
    $("agent-providers").innerHTML = `<tr><td colspan="5" class="muted">${esc(error.message || error)}</td></tr>`;
  }
}

function renderAgentProviders(providers) {
  providerList = providers || [];
  adapters = providerList;
  $("agent-providers").innerHTML = providerList.length
    ? providerList
        .map((provider) => {
          const status = !provider.installed
            ? `<span class="bot-status">not found</span>`
            : provider.runnable === false
              ? `<span class="bot-status">native</span>`
              : `<span class="bot-status running">installed</span>`;
          return `<tr><td><strong>${esc(provider.label || provider.name)}</strong><div class="muted mono">${esc(provider.path || provider.command)}</div></td><td class="mono">${esc(provider.version || "—")}</td><td>${esc(provider.auth)}${provider.login ? `<div class="muted">${esc(provider.login)}</div>` : ""}</td><td>${(provider.capabilities || []).map((capability) => `<span class="badge quiet">${esc(capability)}</span>`).join(" ")}</td><td>${status}</td></tr>`;
        })
        .join("")
    : `<tr><td colspan="5" class="muted">No providers reported.</td></tr>`;
  fillAdapterSelects();
}

function fillAdapterThreads() {
  const select = $("adapter-thread");
  if (!select) return;
  const keep = select.value;
  select.innerHTML = threads.length
    ? threads
        .map((thread) => `<wa-option value="${esc(thread.id)}">${esc(thread.name || thread.id)} · ${esc(thread.branch)}</wa-option>`)
        .join("")
    : `<wa-option value="">Start a thread in Workspaces first</wa-option>`;
  if ([...select.querySelectorAll("wa-option")].some((option) => option.value === keep)) select.value = keep;
}

function fillAdapterSelects() {
  const select = $("adapter-name");
  if (!select) return;
  const usable = adapters.filter((adapter) => adapter.installed && adapter.runnable);
  const keep = select.value;
  select.innerHTML = usable.length
    ? usable.map((adapter) => `<wa-option value="${esc(adapter.name)}">${esc(adapter.label || adapter.name)}</wa-option>`).join("")
    : `<wa-option value="">No external adapter installed</wa-option>`;
  if ([...select.querySelectorAll("wa-option")].some((option) => option.value === keep)) select.value = keep;
  const button = $("adapter-run");
  if (button) button.disabled = !usable.length || !$("adapter-thread")?.value;
  if (!usable.length) $("adapter-status").textContent = "No external adapter is installed on this node.";
}

async function runAdapter() {
  const name = $("adapter-name").value;
  const thread = $("adapter-thread").value;
  const task = $("adapter-task").value.trim();
  if (!name || !thread || !task) {
    toast("Choose a thread, an adapter and a task", "bad");
    return;
  }
  const button = $("adapter-run");
  const output = $("adapter-output");
  const status = $("adapter-status");
  button.disabled = true;
  status.textContent = `Checking ${name}…`;
  output.textContent = "";
  const append = (text) => {
    output.textContent += text;
    if (output.textContent.length > 200_000) output.textContent = output.textContent.slice(-160_000);
    output.scrollTop = output.scrollHeight;
  };
  try {
    const response = await api(`/api/adapters/${encodeURIComponent(name)}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread, task, stream: true }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error?.message || data.error || `HTTP ${response.status}`);
    }
    if ((response.headers.get("content-type") || "").includes("application/json")) {
      const data = await response.json();
      append(`exit ${data.exit_code} · ${data.seconds}s${data.truncated ? " · output truncated" : ""}\n\n${data.stdout || "(no stdout)"}${data.stderr ? `\n\n— stderr —\n${data.stderr}` : ""}`);
      status.textContent = `Finished in ${data.seconds}s; the thread has the changes.`;
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let exit = null;
    let seconds = 0;
    let truncated = false;
    let failure = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut = buffer.indexOf("\n\n");
      while (cut !== -1) {
        const line = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        if (line.startsWith("data: ")) {
          let event;
          try {
            event = JSON.parse(line.slice(6));
          } catch {
            event = null;
          }
          if (event?.type === "adapter.started") status.textContent = `${event.label || name} is running in ${event.workdir || "its worktree"}…`;
          else if (event?.type === "adapter.output") append(event.delta);
          else if (event?.type === "adapter.finished") {
            exit = event.exit_code;
            seconds = event.seconds || 0;
            truncated = Boolean(event.truncated);
          } else if (event?.type === "adapter.error") failure = event.text || "the adapter failed";
        }
        cut = buffer.indexOf("\n\n");
      }
    }
    if (failure) throw new Error(failure);
    const tail = `\n— exit ${exit ?? "?"} · ${seconds}s${truncated ? " · output truncated" : ""} —\n`;
    append(tail);
    status.textContent = exit === 0 ? `Finished in ${seconds}s; the thread has the changes.` : "The adapter stopped with a non-zero exit code.";
    toast(`${name} finished (exit ${exit})`, exit === 0 ? "good" : "bad");
    await refresh();
  } catch (error) {
    append(`\n${String(error.message || error)}`);
    status.textContent = "The adapter stopped with an error.";
    toast(String(error.message || error), "bad");
  } finally {
    button.disabled = false;
  }
}

function renderPalette(filter = "") {
  const items = VIEWS.map((view) => ({ kind: "view", view, label: PAGE_META[view][0], hint: "Section" }));
  items.push(
    { kind: "action", action: "new-chat", label: "New chat", hint: "Action" },
    { kind: "action", action: "refresh", label: "Refresh data", hint: "Action" },
  );
  const query = filter.trim().toLowerCase();
  const matches = items.filter((item) => `${item.label} ${item.hint}`.toLowerCase().includes(query));
  if (paletteIndex >= matches.length) paletteIndex = Math.max(0, matches.length - 1);
  $("palette-list").innerHTML = matches.length
    ? matches
        .map(
          (item, index) =>
            `<button type="button" class="${index === paletteIndex ? "active" : ""}" data-palette-kind="${item.kind}" data-palette-view="${esc(item.view || "")}" data-palette-action="${esc(item.action || "")}"><span>${esc(item.label)}</span><span>${esc(item.hint)}</span></button>`,
        )
        .join("")
    : `<p class="muted" style="padding: 12px">No matches.</p>`;
}

function openPalette() {
  paletteIndex = 0;
  $("palette-input").value = "";
  renderPalette("");
  $("palette-modal").show();
  $("palette-input").focus();
}

function closePalette() {
  if ($("palette-modal").open) $("palette-modal").hide();
}

function paletteChoose(button) {
  if (!button) return;
  if (button.dataset.paletteView) showView(button.dataset.paletteView);
  else if (button.dataset.paletteAction === "new-chat") newChat();
  else if (button.dataset.paletteAction === "refresh") refresh();
  closePalette();
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
    bots = value(data.bots)?.bots || [];
    await loadBoards();
    renderBots(data.bots);
    renderConnectors(data.bots);
    renderVariables(data.variables);
    renderDelegations(data.delegations);
    renderSubscriptions(data.subscriptions);
    renderSecrets(data.secrets);
    renderUsage(data.agent, data.audit);
    renderSettings(data.settings, data.agent, data.gateway);
    const online = !unavailable(data.gateway?.models) && !unavailable(data.agent?.info);
    setStatus(online ? "online" : "offline", online ? "online" : "degraded");
    $("updated").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    $("footer-status").textContent = online ? "all systems answer" : "one service is not answering";
    if (currentView === "providers") {
      loadProviders();
      loadProviderAdmin();
    }
    if (currentView === "mission") loadMission();
    if (currentView === "studio") refreshStudio();
    if (currentView === "gpu") refreshGpuSessions();
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
  $("nav-slot").append($("nav"));
  $("nav").addEventListener("wa-selection-change", (event) => {
    if (navSync) return;
    const item = event.detail?.selection?.[0];
    if (item?.dataset.view) showView(item.dataset.view);
  });
  $("menu").addEventListener("click", (event) => {
    event.stopPropagation();
    $("nav-drawer").append($("nav"));
    // Open after this click finishes, or light-dismiss treats it as a click outside.
    setTimeout(() => $("nav-drawer").show(), 0);
  });
  $("nav-drawer").addEventListener("wa-after-hide", () => $("nav-slot").append($("nav")));
  $("chat-form").addEventListener("submit", runChat);
  $("chat-find").addEventListener("input", (event) => {
    chatQuery = event.target.value.trim().toLowerCase();
    renderSessions(overview.agent);
  });
  $("transcript-find").addEventListener("input", (event) => {
    transcriptQuery = event.target.value.trim().toLowerCase();
    for (const node of $("chat").querySelectorAll(".bubble")) node.hidden = false;
    applyTranscriptQuery();
  });
  $("chat-attach").addEventListener("click", () => $("chat-file").click());
  $("chat-file").addEventListener("change", addAttachments);
  $("studio-form").addEventListener("submit", submitStudio);
  $("studio-tabs").addEventListener("wa-tab-show", (event) => {
    studioKind = event.detail.name;
    syncStudioFields();
  });
  $("gpu-load").addEventListener("click", loadOffers);
  $("mission-thread").addEventListener("change", () => loadMission());
  $("mission-open").addEventListener("click", openMissionChat);
  $("logout-mobile").addEventListener("click", logout);
  $("chat-new").addEventListener("click", newChat);
  $("thread-form").addEventListener("submit", newThread);
  $("bot-form").addEventListener("submit", addBot);
  $("secret-form").addEventListener("submit", saveSecret);
  $("variable-form").addEventListener("submit", addVariable);
  $("subscription-form").addEventListener("submit", saveSubscription);
  $("subscription-cancel").addEventListener("click", resetSubscriptionForm);
  $("config-form").addEventListener("submit", setConfig);
  $("model-save").addEventListener("click", setModel);
  $("provider-form").addEventListener("submit", saveProvider);
  $("provider-cancel").addEventListener("click", resetProviderForm);
  $("provider-preset").addEventListener("change", applyProviderPreset);
  $("approvals-save").addEventListener("click", setApprovals);
  $("check-save").addEventListener("click", saveCheck);
  $("project-select").addEventListener("change", () => loadProject($("project-select").value));
  $("project-save").addEventListener("click", saveProject);
  $("project-remove").addEventListener("click", removeProject);
  $("adapter-run").addEventListener("click", runAdapter);
  $("refresh").addEventListener("click", refresh);
  $("palette").addEventListener("click", openPalette);
  $("logout").addEventListener("click", logout);
  $("palette-input").addEventListener("input", (event) => {
    paletteIndex = 0;
    renderPalette(event.target.value);
  });
  $("palette-modal").addEventListener("click", (event) => {
    if (event.target.id === "palette-modal") closePalette();
  });
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

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if ($("palette-modal").open) closePalette();
      else openPalette();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && currentView === "chat" && event.composedPath().includes($("chat-text"))) {
      event.preventDefault();
      $("chat-form").requestSubmit();
      return;
    }
    if (!$("palette-modal").open) return;
    if (event.key === "Escape") {
      closePalette();
      return;
    }
    const buttons = [...$("palette-list").querySelectorAll("button")];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (buttons.length) {
        paletteIndex = (paletteIndex + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length;
        renderPalette($("palette-input").value);
      }
    }
    if (event.key === "Enter") {
      event.preventDefault();
      paletteChoose($("palette-list .active") || buttons[0]);
    }
  });

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button, wa-button");
    if (!button) return;
    if (button.dataset.answer) answerApproval(button.dataset.id, button.dataset.answer);
    else if (button.dataset.session) {
      loadHistory(button.dataset.session);
      showView("chat");
    } else if (button.dataset.thread) threadAction(button.dataset.thread, button.dataset.id);
    else if (button.dataset.botAction) botAction(button.dataset.botAction, button.dataset.name);
    else if (button.dataset.connector) toggleConnector(button.dataset.connector, button.dataset.bot, button.dataset.on === "1");
    else if (button.dataset.toolGroup) toggleToolGroup(button.dataset.toolGroup, button.dataset.on);
    else if (button.dataset.variable) removeVariable(button.dataset.variable);
    else if (button.dataset.providerEdit) editProvider(button.dataset.providerEdit);
    else if (button.dataset.providerRemove) removeProvider(button.dataset.providerRemove);
    else if (button.dataset.delegationResume) delegationAction(button.dataset.delegationResume, "resume");
    else if (button.dataset.delegationCancel) delegationAction(button.dataset.delegationCancel, "cancel");
    else if (button.dataset.subscriptionEdit) editSubscription(button.dataset.subscriptionEdit);
    else if (button.dataset.subscriptionDelete) removeSubscription(button.dataset.subscriptionDelete);
    else if (button.dataset.secretDelete) removeSecret(button.dataset.secretDelete);
    else if (button.dataset.paletteView || button.dataset.paletteAction) paletteChoose(button);
    else if (button.dataset.viewJump) showView(button.dataset.viewJump);
    else if (button.dataset.rent) quoteRent(button.dataset.rent);
    else if (button.dataset.gpuStop) stopRent(button.dataset.gpuStop, button.dataset.force === "1");
    else if (button.dataset.studioDrop) dropJob(button.dataset.studioDrop);
    else if (button.dataset.dropFile != null) {
      attachments.splice(Number(button.dataset.dropFile), 1);
      renderAttachments();
    }
  });
}

function askConfirm(message, okLabel = "Confirm") {
  return new Promise((resolve) => {
    const dialog = $("confirm-dialog");
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dialog.hide();
      resolve(value);
    };
    $("confirm-body").textContent = message;
    $("confirm-ok").textContent = okLabel;
    $("confirm-ok").onclick = () => finish(true);
    $("confirm-cancel").onclick = () => finish(false);
    dialog.addEventListener("wa-hide", () => finish(false), { once: true });
    dialog.show();
  });
}

function askPr(title, body) {
  return new Promise((resolve) => {
    const dialog = $("pr-dialog");
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dialog.hide();
      resolve(value);
    };
    $("pr-title").value = title;
    $("pr-body").value = body;
    $("pr-ok").onclick = () => finish({ title: $("pr-title").value.trim(), body: $("pr-body").value });
    $("pr-cancel").onclick = () => finish(null);
    dialog.addEventListener("wa-hide", () => finish(null), { once: true });
    dialog.show();
    $("pr-title").focus();
  });
}

function renderAttachments() {
  $("chat-files").innerHTML = attachments
    .map(
      (file, index) =>
        `<span class="chip">${file.image ? `<img alt="" src="${file.url}">` : ""}<span>${esc(file.name)}</span><wa-button size="s" variant="neutral" appearance="plain" type="button" data-drop-file="${index}">Remove</wa-button></span>`,
    )
    .join("");
}

async function addAttachments(event) {
  const files = [...event.target.files];
  event.target.value = "";
  for (const file of files) {
    if (attachments.length >= 4) {
      toast("At most 4 attachments", "bad");
      break;
    }
    if (file.type.startsWith("image/")) {
      if (file.size > 8 * 1024 * 1024) {
        toast(`${file.name} is larger than 8 MiB`, "bad");
        continue;
      }
      const url = await readFileUrl(file);
      attachments.push({ name: file.name, image: true, url });
    } else {
      const text = (await file.text()).slice(0, 6000);
      attachments.push({ name: file.name, image: false, text });
    }
  }
  renderAttachments();
}

function readFileUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function workForBot(name) {
  const runs = (delegationData.delegations || []).filter((job) => job.bot === name && (job.state === "running" || job.state === "paused"));
  const tasks = boardTasks.filter((task) => task.agent === name && (task.status === "running" || task.status === "todo" || task.status === "blocked"));
  const bits = [
    ...runs.map((job) => `${job.state}: ${String(job.task || job.session).slice(0, 80)}`),
    ...tasks.map((task) => `${task.status}: ${String(task.goal || "").slice(0, 80)}`),
  ];
  return bits.length ? esc(bits.slice(0, 3).join(" · ")) : `<span class="muted">idle</span>`;
}

function renderBotCards(list) {
  const grid = $("bot-grid");
  if (!grid) return;
  grid.innerHTML = list.length
    ? list
        .map((bot) => {
          const status = bot.status || "stopped";
          const channels = (bot.channels || []).filter((channel) => channel.kind !== "api");
          return `<article class="bot-card"><div class="card-head"><h2>${esc(bot.name)}</h2><span class="badge ${status === "running" ? "" : "quiet"}">${esc(status)}</span></div><p class="small">${esc(bot.persona || bot.description || "No persona yet.")}</p><p class="small mono">${esc(bot.model || "auto")} · ${esc(bot.approvals || "ask")}</p><p class="small">${channels.length ? channels.map((channel) => esc(channel.kind)).join(" · ") : "No channels"}</p><p class="small">${workForBot(bot.name)}</p><div class="row"><wa-button size="s" variant="brand" type="button" data-bot-action="talk" data-name="${esc(bot.name)}">Talk</wa-button></div></article>`;
        })
        .join("")
    : `<p class="empty"><strong>No bots.</strong><span>Add one below. The default agent is included when the node answers.</span></p>`;
}

async function loadBoards() {
  const names = bots.length ? bots : [];
  if (!names.length) {
    boardTasks = [];
    return;
  }
  const lists = await Promise.all(
    names.slice(0, 8).map(async (bot) => {
      const query = bot.default ? "" : `?bot=${encodeURIComponent(bot.name)}`;
      try {
        const response = await api(`/api/board${query}`);
        if (!response.ok) return [];
        const data = await response.json();
        return (data.tasks || []).map((task) => ({ ...task, bot: task.agent || bot.name }));
      } catch {
        return [];
      }
    }),
  );
  const seen = new Set();
  boardTasks = lists.flat().filter((task) => {
    if (!task.id || seen.has(task.id)) return false;
    seen.add(task.id);
    return true;
  });
}

function layoutChat() {
  const split = document.querySelector("wa-split-panel.chat-layout");
  if (!split) return;
  const narrow = window.matchMedia("(max-width: 800px)").matches;
  split.orientation = narrow ? "vertical" : "horizontal";
  split.position = narrow ? 34 : 28;
}

async function loadMission() {
  const select = $("mission-thread");
  const keep = select.value;
  select.innerHTML = [`<wa-option value="">Project brief</wa-option>`]
    .concat(threads.map((thread) => `<wa-option value="${esc(thread.id)}">${esc(thread.name || thread.id)} · ${esc(thread.branch)}</wa-option>`))
    .join("");
  if ([...select.querySelectorAll("wa-option")].some((option) => option.value === keep)) select.value = keep;
  const threadId = select.value;
  const thread = threads.find((item) => item.id === threadId);
  try {
    const response = await api(`/api/project${threadId ? `?thread=${encodeURIComponent(threadId)}` : ""}`);
    const data = await response.json();
    $("mission-brief").textContent = response.ok && data.brief ? data.brief : "No brief for this project yet.";
    $("mission-status").textContent = data.root ? data.root : "No project root reported.";
  } catch (error) {
    $("mission-brief").textContent = String(error.message || error);
  }
  let plan = null;
  const session = thread?.session || "";
  if (session) {
    try {
      const response = await api(`/api/plan?session=${encodeURIComponent(session)}`);
      if (response.ok) plan = await response.json();
    } catch {}
  }
  renderPlanBoard(plan);
  renderMissionBoard();
  const related = thread ? [thread] : threads.slice(0, 6);
  $("mission-work").innerHTML = related.length
    ? related
        .map(
          (item) =>
            `<div class="ticket"><strong>${esc(item.name || item.id)}</strong><p class="mono">${esc(item.branch)} · ${item.dirty ? "changes" : "clean"}${item.pr_url ? " · PR open" : ""}</p><div class="row"><wa-button size="s" variant="neutral" data-thread="use" data-id="${esc(item.id)}">Chat</wa-button><wa-button size="s" variant="neutral" appearance="plain" data-thread="diff" data-id="${esc(item.id)}">Diff</wa-button></div></div>`,
        )
        .join("")
    : `<p class="empty"><strong>No worktrees.</strong><span>Start a thread in Workspaces.</span></p>`;
  const runs = (delegationData.delegations || []).filter((job) => !session || job.session === session);
  $("mission-runs").innerHTML = runs.length
    ? runs
        .slice(0, 8)
        .map(
          (job) =>
            `<div class="ticket"><strong>${esc(job.state)}</strong><p>${esc(String(job.task || job.session).slice(0, 180))}</p><p class="mono">${esc(job.bot)} · ${esc(job.resumes)}/${esc(job.max_resumes)}</p></div>`,
        )
        .join("")
    : `<p class="empty"><strong>No delegated runs.</strong><span>Keep going in Chat when you want a run to outlive a usage limit.</span></p>`;
}

function renderPlanBoard(plan) {
  const items = plan?.items || [];
  $("mission-plan-count").textContent = items.length ? `${plan.done ?? 0}/${plan.total ?? items.length}` : "empty";
  const columns = [
    ["pending", "To do"],
    ["doing", "Doing"],
    ["done", "Done"],
  ];
  $("mission-plan").innerHTML = items.length
    ? columns
        .map(([status, label]) => {
          const rows = items.filter((item) => (item.status || "pending") === status || (status === "doing" && item.status === "in_progress"));
          return `<div class="column"><h3>${label}</h3>${rows.map((item) => `<div class="ticket"><strong>${esc(item.text)}</strong></div>`).join("") || `<p class="muted">None</p>`}</div>`;
        })
        .join("")
    : `<p class="empty"><strong>No plan on this conversation.</strong><span>The todo tool writes it. It shows above the chat once it exists.</span></p>`;
}

function renderMissionBoard() {
  const columns = [
    ["todo", "To do"],
    ["running", "Running"],
    ["blocked", "Waiting on you"],
    ["done", "Done"],
  ];
  const open = boardTasks.filter((task) => task.status !== "failed");
  $("mission-board").innerHTML = open.length
    ? columns
        .map(([status, label]) => {
          const rows = boardTasks.filter((task) => task.status === status);
          return `<div class="column"><h3>${label}</h3>${
            rows
              .map(
                (task) =>
                  `<div class="ticket"><strong>${esc(task.goal)}</strong><p>${esc(task.agent)} · ${esc(task.plan || "")}</p>${task.question ? `<p>${esc(task.question)}</p>` : ""}</div>`,
              )
              .join("") || `<p class="muted">None</p>`
          }</div>`;
        })
        .join("")
    : `<p class="empty"><strong>The team board is empty.</strong><span>Plans the lead assigns to other bots show up here, including questions waiting on you.</span></p>`;
}

function openMissionChat() {
  const thread = threads.find((item) => item.id === $("mission-thread").value);
  if (!thread) {
    showView("chat");
    return;
  }
  threadAction("use", thread.id);
}

function syncStudioFields() {
  $("studio-size").hidden = studioKind !== "image";
  $("studio-voice").hidden = studioKind !== "audio";
  $("studio-session").hidden = studioKind !== "video";
}

async function loadStudio() {
  syncStudioFields();
  try {
    const response = await api("/api/studio/capabilities");
    const data = await response.json();
    const backends = studioKind === "audio" ? data.speech || [] : data.images || [];
    const preset = $("studio-preset");
    const keep = preset.value;
    preset.innerHTML = [`<wa-option value="auto">auto</wa-option>`]
      .concat((backends || []).map((item) => `<wa-option value="${esc(item.id)}">${esc(item.id)}${item.healthy === false ? " · down" : ""}</wa-option>`))
      .join("");
    if (studioKind === "video") {
      preset.innerHTML = `<wa-option value="comfyui-minimax-h3">MiniMax H3</wa-option>`;
    }
    if ([...preset.querySelectorAll("wa-option")].some((option) => option.value === keep)) preset.value = keep;
    const names = (studioKind === "audio" ? data.speech : data.images) || [];
    $("studio-note").textContent =
      studioKind === "video"
        ? "Video runs on a rented ComfyUI session. Rent a GPU first if none is ready."
        : names.length
          ? `${names.length} ${studioKind} backend${names.length === 1 ? "" : "s"} on this node.`
          : `No ${studioKind} backend on this node yet.`;
  } catch (error) {
    $("studio-note").textContent = String(error.message || error);
  }
  await refreshGpuSessions();
  const session = $("studio-session");
  const keepSession = session.value;
  const ready = gpuSessions.filter((item) => item.phase === "ready" || item.phase === "hydrating");
  session.innerHTML = [`<wa-option value="">Any ready session</wa-option>`]
    .concat(ready.map((item) => `<wa-option value="${esc(item.id)}">${esc(item.preset_id || item.id)} · ${esc(item.phase)}</wa-option>`))
    .join("");
  if ([...session.querySelectorAll("wa-option")].some((option) => option.value === keepSession)) session.value = keepSession;
  await refreshStudio();
}

async function refreshStudio() {
  try {
    const response = await api("/api/studio/jobs");
    if (!response.ok) return;
    const data = await response.json();
    studioJobs = data.jobs || [];
    renderStudio();
  } catch {}
}

function renderStudio() {
  $("studio-jobs").innerHTML = studioJobs.length
    ? studioJobs
        .map(
          (job) =>
            `<article class="job"><div class="card-head"><h2>${esc(job.kind)}</h2><span class="badge ${job.status === "failed" ? "bad" : "quiet"}">${esc(job.status)}</span></div><p>${esc(job.prompt.slice(0, 180))}</p><wa-progress-bar class="meter" value="${Number(job.progress) || 0}" label="${esc(job.status)}"></wa-progress-bar><p class="meta">${esc(job.detail || "")}</p><wa-button size="s" variant="neutral" appearance="plain" data-studio-drop="${esc(job.id)}">Remove</wa-button></article>`,
        )
        .join("")
    : `<p class="empty"><strong>No jobs.</strong><span>Generate an image, a clip, or speech. Progress stays in this queue.</span></p>`;
  const done = studioJobs.filter((job) => job.media_id);
  $("studio-gallery").innerHTML = done.length
    ? done
        .map((job) => {
          const src = `/api/studio/media/${encodeURIComponent(job.media_id)}`;
          if ((job.media_type || "").startsWith("audio")) {
            return `<figure><audio controls src="${src}"></audio><figcaption>${esc(job.prompt.slice(0, 80))}</figcaption></figure>`;
          }
          if ((job.media_type || "").startsWith("video")) {
            return `<figure><video controls src="${src}"></video><figcaption>${esc(job.prompt.slice(0, 80))}</figcaption></figure>`;
          }
          return `<figure><img alt="${esc(job.prompt.slice(0, 80))}" src="${src}"><figcaption>${esc(job.prompt.slice(0, 80))}</figcaption></figure>`;
        })
        .join("")
    : "";
}

async function submitStudio(event) {
  event.preventDefault();
  const prompt = $("studio-prompt").value.trim();
  if (!prompt) return;
  $("studio-submit").disabled = true;
  try {
    const response = await api("/api/studio/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: studioKind,
        prompt,
        preset: $("studio-preset").value,
        size: $("studio-size").value,
        voice: $("studio-voice").value,
        session_id: $("studio-session").value,
      }),
    });
    const data = await response.json();
    if (!response.ok && !data.job) throw new Error(data.error?.message || data.error || `HTTP ${response.status}`);
    if (data.job?.status === "failed") toast(data.job.detail || "The job failed", "bad");
    else toast(data.job?.status === "done" ? "Ready" : "Job queued", data.job?.status === "done" ? "good" : "");
    if (data.job && (data.job.status === "running" || data.job.status === "waiting")) watchJob(data.job.id);
    await refreshStudio();
  } catch (error) {
    toast(String(error.message || error), "bad");
  } finally {
    $("studio-submit").disabled = false;
  }
}

async function watchJob(id) {
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      const response = await api(`/api/studio/jobs/${encodeURIComponent(id)}`);
      if (!response.ok) return;
      const data = await response.json();
      await refreshStudio();
      if (data.job?.status === "done" || data.job?.status === "failed") return;
    } catch {
      return;
    }
  }
}

async function dropJob(id) {
  await api(`/api/studio/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
  await refreshStudio();
}

function showGpuOff(message) {
  $("gpu-state").textContent = "not connected";
  $("gpu-state").className = "badge quiet";
  $("gpu-banner").innerHTML = `<wa-callout variant="neutral" size="s"><strong>GPU rental not connected on this node</strong><br>${esc(message || "The gateway has no /v1/rent route yet.")}</wa-callout>`;
  $("gpu-offers").innerHTML = `<tr><td colspan="7" class="muted">GPU rental not connected on this node.</td></tr>`;
  $("gpu-sessions").innerHTML = `<p class="empty"><strong>GPU rental not connected on this node.</strong><span>Offers and sessions appear here when the gateway proxies /v1/rent.</span></p>`;
}

async function loadGpu() {
  try {
    const response = await api("/api/rent/health");
    const data = await response.json();
    if (data.connected === false) {
      showGpuOff(data.message);
      return;
    }
    $("gpu-state").textContent = "connected";
    $("gpu-state").className = "badge";
    $("gpu-banner").innerHTML = "";
    await refreshGpuSessions();
    await loadOffers();
  } catch (error) {
    showGpuOff(String(error.message || error));
  }
}

let rentOffers = [];

function rentProblem(data, status) {
  const error = data?.error;
  const code = error && typeof error === "object" ? error.code : "";
  const message = (error && typeof error === "object" ? error.message : error) || data?.message || "";
  if (status === 403 && code === "rent_cap") {
    const limit = error.limit ? ` (${error.limit})` : "";
    return `Over the rental cap${limit}. ${message || "Nothing was started, and a session over the cap is stopped."}`;
  }
  if (status === 400 && (code === "bad_request" || /region/i.test(String(message)))) {
    return message || "That region is outside what this node allows. Nothing was rented.";
  }
  return "";
}

async function loadOffers() {
  const preset = $("gpu-preset").value;
  const hours = $("gpu-hours").value;
  const region = $("gpu-region").value || "EU";
  $("gpu-output").textContent = "Loading EU offers…";
  try {
    const response = await api(`/api/rent/offers?preset=${encodeURIComponent(preset)}&hours=${encodeURIComponent(hours)}&require_regions=${encodeURIComponent(region)}`);
    const data = await response.json();
    if (data.connected === false) {
      showGpuOff(data.message);
      $("gpu-output").textContent = "";
      return;
    }
    const problem = rentProblem(data, response.status);
    if (problem) {
      $("gpu-output").textContent = problem;
      toast(problem, "bad");
      return;
    }
    if (!response.ok) throw new Error(data.error?.message || data.error || `HTTP ${response.status}`);
    rentOffers = data.offers || [];
    $("gpu-offers").innerHTML = rentOffers.length
      ? rentOffers
          .map(
            (offer) =>
              `<tr><td class="mono">${esc(offer.id)}</td><td>${esc(offer.name || offer.sku)}</td><td>${esc(offer.vram_gb ?? "—")}</td><td>${esc(offer.region || (offer.data_center_ids || []).join(", "))}</td><td class="mono">${offer.usd_per_hr == null ? "—" : `$${Number(offer.usd_per_hr).toFixed(2)}`}</td><td class="mono">${offer.estimate_usd == null ? "—" : `$${Number(offer.estimate_usd).toFixed(2)}`}</td><td><wa-button size="s" variant="brand" type="button" data-rent="${esc(offer.id)}">Review</wa-button></td></tr>`,
          )
          .join("")
      : `<tr><td colspan="7" class="muted">No EU offer matched this preset. Nothing was rented.</td></tr>`;
    $("gpu-output").textContent = `${rentOffers.length} offer(s). Review one to see the total before it starts.`;
  } catch (error) {
    $("gpu-output").textContent = String(error.message || error);
  }
}

async function quoteRent(offerId) {
  const payload = {
    preset_id: $("gpu-preset").value,
    hours: Number($("gpu-hours").value),
    offer_id: offerId,
    confirm: false,
    require_regions: [$("gpu-region").value || "EU"],
    project_id: "panel",
  };
  try {
    const response = await api("/api/rent/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (data.connected === false) {
      showGpuOff(data.message);
      return;
    }
    const problem = rentProblem(data, response.status);
    if (problem) {
      $("gpu-output").textContent = problem;
      toast(problem, "bad");
      return;
    }
    if (response.status !== 409) throw new Error(data.error?.message || data.error || `HTTP ${response.status}`);
    rentOffer = payload;
    const offer = data.offer || rentOffers.find((item) => item.id === offerId) || {};
    const rate = offer.usd_per_hr;
    const total = data.cost_estimate_usd ?? offer.estimate_usd;
    $("rent-summary").textContent = data.error?.message || "Confirm to rent this offer. Nothing has been created.";
    $("rent-facts").innerHTML = [
      ["Offer", offer.id || offerId],
      ["GPU", offer.name || offer.sku || "—"],
      ["Region", (data.require_regions || payload.require_regions).join(", ")],
      ["$/hr", rate == null ? "—" : `$${Number(rate).toFixed(2)}`],
      ["Hours", String(data.hours || payload.hours)],
      ["Estimated total", total == null ? "—" : `$${Number(total).toFixed(2)}`],
    ]
      .map(([label, fact]) => `<div class="insight"><strong>${esc(label)}</strong><span>${esc(fact)}</span></div>`)
      .join("");
    $("rent-ok").onclick = () => confirmRent();
    $("rent-cancel").onclick = () => $("rent-dialog").hide();
    $("rent-dialog").show();
  } catch (error) {
    toast(String(error.message || error), "bad");
  }
}

async function confirmRent() {
  if (!rentOffer) return;
  $("rent-ok").disabled = true;
  try {
    const response = await api("/api/rent/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...rentOffer, confirm: true }),
    });
    const data = await response.json();
    const problem = rentProblem(data, response.status);
    if (problem) {
      $("rent-summary").textContent = problem;
      $("gpu-output").textContent = problem;
      toast(problem, "bad");
      return;
    }
    if (!response.ok) throw new Error(data.error?.message || data.error || `HTTP ${response.status}`);
    $("rent-dialog").hide();
    toast("Rental started", "good");
    $("gpu-output").textContent = `session ${data.id || ""} · ${data.phase || "created"}`;
    await refreshGpuSessions();
  } catch (error) {
    toast(String(error.message || error), "bad");
  } finally {
    $("rent-ok").disabled = false;
  }
}

async function refreshGpuSessions() {
  try {
    const response = await api("/api/rent/sessions");
    const data = await response.json();
    if (data.connected === false) {
      if (currentView === "gpu") showGpuOff(data.message);
      gpuSessions = [];
      return;
    }
    gpuSessions = data.sessions || [];
    renderGpuSessions();
  } catch {}
}

function renderGpuSessions() {
  const node = $("gpu-sessions");
  if (!node) return;
  if (!gpuSessions.length) {
    node.innerHTML = `<p class="empty"><strong>No sessions.</strong><span>A confirmed rental shows the time left, the cost so far, and Stop.</span></p>`;
    return;
  }
  node.innerHTML = gpuSessions
    .map((session) => {
      const cost = sessionCost(session);
      const live = session.phase !== "terminated" && session.phase !== "failed";
      return `<article class="session-card"><div class="card-head"><h2>${esc(session.preset_id || "session")}</h2><span class="badge ${session.phase === "failed" ? "bad" : "quiet"}">${esc(session.phase || "unknown")}</span></div><p class="mono">${esc(session.id)}</p><p class="countdown" data-deadline="${esc(session.deadline_at || "")}">${esc(countdown(session.deadline_at))}</p><p class="cost">$${cost.toFixed(2)} so far · $${Number(session.cost_estimate_usd || 0).toFixed(2)} estimate</p><p class="small">${esc(session.data_center || session.offer?.region || "")}</p>${live ? `<div class="row"><wa-button size="s" variant="danger" appearance="outlined" data-gpu-stop="${esc(session.id)}">Stop</wa-button></div>` : ""}</article>`;
    })
    .join("");
  if (gpuTimer) clearInterval(gpuTimer);
  gpuTimer = setInterval(() => {
    if (currentView !== "gpu") return;
    for (const node of document.querySelectorAll("[data-deadline]")) node.textContent = countdown(node.dataset.deadline);
  }, 1000);
}

function countdown(deadline) {
  const end = Date.parse(deadline || "");
  if (!Number.isFinite(end)) return "—";
  const ms = end - Date.now();
  if (ms <= 0) return "ended";
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
}

function sessionCost(session) {
  if (session.cost_actual_usd != null) return Number(session.cost_actual_usd) || 0;
  const rate = Number(session.offer?.usd_per_hr);
  const start = Date.parse(session.created_at || "");
  if (!Number.isFinite(rate) || !Number.isFinite(start)) return 0;
  return Math.max(0, rate * ((Date.now() - start) / 3600000));
}

async function stopRent(id, force) {
  const session = gpuSessions.find((item) => item.id === id);
  if (!force) {
    const ok = await askConfirm(`Stop ${id}? The pod drains, then it is deleted. Cost so far is about $${sessionCost(session || {}).toFixed(2)}.`, "Stop");
    if (!ok) return;
  }
  try {
    const response = await api(`/api/rent/sessions/${encodeURIComponent(id)}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force }),
    });
    const data = await response.json();
    const problem = rentProblem(data, response.status);
    if (problem) {
      $("gpu-output").textContent = problem;
      toast(problem, "bad");
      return;
    }
    if (response.status === 409 && data.error?.code === "drain_failed") {
      const again = await askConfirm("Drain did not finish. Force stop deletes the pod anyway and can lose unsynced files.", "Force stop");
      if (again) return stopRent(id, true);
      return;
    }
    if (!response.ok) throw new Error(data.error?.message || data.error || `HTTP ${response.status}`);
    toast(force ? "Session force-stopped" : "Session stopped", "good");
    await refreshGpuSessions();
  } catch (error) {
    toast(String(error.message || error), "bad");
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
  bind();
  window.addEventListener("hashchange", () => showView(location.hash.slice(1) || "overview"));
  window.addEventListener("resize", () => {
    if (currentView === "chat") layoutChat();
  });
  showView(location.hash.slice(1) || "overview");
  await refresh();
  timer = setInterval(() => {
    if (!busy) refresh();
  }, 15000);
}

start();
