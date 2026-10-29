// WCKD agent control panel: one authenticated surface over Invincible and Autobot.
// No dependencies beyond Node 20+; all upstream credentials stay on this process.

import http from "node:http";
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRent } from "./rent.mjs";
import { createStudio } from "./studio.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(DIR, "public");
const VERSION = "0.2.1";
const PORT = Number(process.env.PORT || 7800);
const BIND = process.env.PANEL_BIND || "0.0.0.0";
const GATEWAY = (process.env.GATEWAY_HTTP_URL || process.env.GATEWAY_URL || "http://127.0.0.1:7777")
  .replace(/\/v1\/?$/, "")
  .replace(/\/+$/, "");
const AGENT = (process.env.AGENT_URL || "http://127.0.0.1:7792").replace(/\/+$/, "");
const TOKEN = (process.env.INVINCIBLE_TOKEN || tokenFromFile() || "").trim();
const SECRET = process.env.PANEL_SECRET || "";
const PASSWORD = process.env.PANEL_PASSWORD || "";
const PASSWORD_HASH = process.env.PANEL_PASSWORD_HASH || "";
const SECURE = /^(1|true|yes|on)$/i.test(process.env.PANEL_SECURE_COOKIES || "");
const SESSION_MS = 8 * 60 * 60 * 1000;
const MAX_BODY = 1024 * 1024;
const TASK_BODY = 12 * 1024 * 1024;
const LOGIN_WINDOW = 5 * 60 * 1000;
const LOGIN_LIMIT = 10;

if (!TOKEN) fail("INVINCIBLE_TOKEN is required");
if (!SECRET || SECRET.length < 32) fail("PANEL_SECRET must be at least 32 characters");
if (!PASSWORD && !PASSWORD_HASH) fail("PANEL_PASSWORD or PANEL_PASSWORD_HASH is required");

const HASH = PASSWORD_HASH || hashPassword(PASSWORD);
const sessions = new Map();
const attempts = new Map();
const MIME = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};
// The asset URL carries a content hash: a deploy gets a new URL, so neither Cloudflare nor a
// browser can keep serving the old panel after an update.
const ASSET_VERSION = createHash("sha256")
  .update(readFileSync(path.join(PUBLIC, "app.js")))
  .update(readFileSync(path.join(PUBLIC, "app.css")))
  .update(readFileSync(path.join(PUBLIC, "vendor/panel-kit.js")))
  .digest("hex")
  .slice(0, 12);

function tokenFromFile() {
  const file = process.env.INVINCIBLE_TOKEN_FILE;
  if (!file) return "";
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    fail(`cannot read INVINCIBLE_TOKEN_FILE ${file}: ${error.message}`);
  }
}

function fail(message) {
  console.error(`panel: ${message}`);
  process.exit(1);
}

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

function passwordOk(password) {
  const [kind, saltHex, hashHex] = HASH.split(":");
  if (kind !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function securityHeaders(res) {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; " +
      "img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  if (SECURE) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}

function send(res, status, body, type = "text/plain; charset=utf-8", extra = {}) {
  securityHeaders(res);
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...extra });
  res.end(body);
  return true;
}

function json(res, status, value) {
  return send(res, status, JSON.stringify(value), "application/json; charset=utf-8");
}

function redirect(res, location) {
  securityHeaders(res);
  res.writeHead(303, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

function cookies(request) {
  return Object.fromEntries(
    (request.headers.cookie || "")
      .split(";")
      .map((part) => part.trim().split("=").filter(Boolean))
      .filter((pair) => pair.length === 2)
      .map(([key, value]) => [key, decodeURIComponent(value)]),
  );
}

function sign(id) {
  return createHmac("sha256", SECRET).update(id).digest("base64url");
}

function current(request) {
  const cookie = cookies(request).panel_session;
  if (!cookie) return null;
  const at = cookie.lastIndexOf(".");
  if (at < 1) return null;
  const id = cookie.slice(0, at);
  const given = Buffer.from(cookie.slice(at + 1));
  const expected = Buffer.from(sign(id));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const session = sessions.get(id);
  if (!session) return null;
  if (session.expires < Date.now()) {
    sessions.delete(id);
    return null;
  }
  session.expires = Date.now() + SESSION_MS;
  return { token: id, ...session };
}

function startSession(res) {
  const id = randomBytes(32).toString("base64url");
  const csrf = randomBytes(24).toString("base64url");
  sessions.set(id, { csrf, expires: Date.now() + SESSION_MS });
  securityHeaders(res);
  res.setHeader(
    "Set-Cookie",
    `panel_session=${id}.${sign(id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${SECURE ? "; Secure" : ""}`,
  );
  return csrf;
}

function endSession(res, token) {
  if (token) sessions.delete(token);
  securityHeaders(res);
  res.setHeader("Set-Cookie", `panel_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${SECURE ? "; Secure" : ""}`);
}

async function body(request, limit = MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function validId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(id);
}

async function upstream(base, route, init = {}) {
  const { timeout = 20_000, raw = false, ...options } = init;
  const response = await fetch(base + route, {
    ...options,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(options.headers || {}) },
    signal: AbortSignal.timeout(timeout),
  });
  if (raw) {
    return {
      status: response.status,
      type: response.headers.get("content-type") || "",
      buf: Buffer.from(await response.arrayBuffer()),
    };
  }
  const text = await response.text();
  let value = text;
  try {
    value = JSON.parse(text);
  } catch {}
  return { status: response.status, value };
}

const SECRET_KEY = /api[_-]?key|secret|password|authorization|access[_-]?key|bearer|^token$|s3_/i;

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue;
    out[key] = scrub(item);
  }
  return out;
}

function publicFile(pathname) {
  let rel = pathname;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (rel.includes("\0")) return null;
  rel = rel.replace(/^[/\\]+/, "");
  if (rel !== "app.css" && rel !== "app.js" && rel !== "vendor/panel-kit.js" && !rel.startsWith("vendor/webawesome/")) return null;
  const root = path.resolve(PUBLIC);
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  if (!existsSync(resolved)) return null;
  const stat = statSync(resolved);
  if (!stat.isFile()) return null;
  const ext = path.extname(resolved);
  const type = MIME[ext];
  if (!type) return null;
  const chunk = rel.includes("/chunks/");
  return {
    body: readFileSync(resolved),
    type,
    cache: chunk ? "public, max-age=31536000, immutable" : "public, max-age=300",
  };
}

async function safely(base, route) {
  try {
    return await upstream(base, route);
  } catch (error) {
    return { status: 0, value: { error: String(error.message || error) } };
  }
}

const rent = createRent({
  upstream: (route, init) => upstream(GATEWAY, route, init),
  safely: (route) => safely(GATEWAY, route),
  scrub,
  json,
  readBody: body,
});

const studio = createStudio({
  upstream,
  safely,
  json,
  send,
  readBody: body,
  gateway: GATEWAY,
});

function loginPage(error = "") {
  return readFileSync(path.join(PUBLIC, "login.html"), "utf8")
    .replace("{{ERROR}}", error)
    .replaceAll("{{ASSET_VERSION}}", ASSET_VERSION);
}

function dashboardPage() {
  return readFileSync(path.join(PUBLIC, "index.html"), "utf8")
    .replace("{{VERSION}}", VERSION)
    .replaceAll("{{ASSET_VERSION}}", ASSET_VERSION);
}

function rateLimited(ip) {
  const now = Date.now();
  const current = attempts.get(ip);
  if (!current || current.reset < now) {
    attempts.set(ip, { count: 0, reset: now + LOGIN_WINDOW });
    return false;
  }
  return current.count >= LOGIN_LIMIT;
}

function loginFailed(ip) {
  const now = Date.now();
  const current = attempts.get(ip);
  if (!current || current.reset < now) attempts.set(ip, { count: 1, reset: now + LOGIN_WINDOW });
  else current.count += 1;
}

const server = http.createServer(async (request, response) => {
  securityHeaders(response);
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const ip = request.socket.remoteAddress || "unknown";

  try {
    if (url.pathname === "/healthz") return json(response, 200, { status: "ok", version: VERSION });

    if (url.pathname === "/login" && request.method === "GET") {
      if (current(request)) return redirect(response, "/");
      return send(response, 200, loginPage(), "text/html; charset=utf-8");
    }

    if (url.pathname === "/login" && request.method === "POST") {
      if (rateLimited(ip)) return send(response, 429, loginPage("Too many attempts. Try again in a few minutes."), "text/html; charset=utf-8");
      const form = new URLSearchParams(await body(request, 4096));
      if (!passwordOk(form.get("password") || "")) {
        loginFailed(ip);
        return send(response, 401, loginPage("That password is not right."), "text/html; charset=utf-8");
      }
      attempts.delete(ip);
      startSession(response);
      return redirect(response, "/");
    }

    const asset = publicFile(url.pathname);
    if (asset && (request.method === "GET" || request.method === "HEAD")) {
      securityHeaders(response);
      response.writeHead(200, { "Content-Type": asset.type, "Cache-Control": asset.cache });
      return response.end(request.method === "HEAD" ? undefined : asset.body);
    }

    const session = current(request);
    if (!session) {
      if (url.pathname.startsWith("/api/")) return json(response, 401, { error: "sign in first" });
      return redirect(response, "/login");
    }

    if (!["GET", "HEAD"].includes(request.method)) {
      if (request.headers["x-csrf-token"] !== session.csrf) return json(response, 403, { error: "bad csrf token" });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return send(response, 200, dashboardPage(), "text/html; charset=utf-8");
    }

    if (url.pathname === "/api/session") return json(response, 200, { csrf: session.csrf, version: VERSION });

    if (url.pathname === "/api/logout" && request.method === "POST") {
      endSession(response, session.token);
      return json(response, 200, { ok: true });
    }

    if (url.pathname === "/api/overview") {
      const [models, node, info, stats, conversations, approvals, usage, insights, audit, threads, bots, settings, variables, subscriptions, secrets, delegations] =
        await Promise.all([
          safely(GATEWAY, "/v1/models"),
          safely(GATEWAY, "/v1/node"),
          safely(AGENT, "/v1/agent"),
          safely(AGENT, "/v1/agent/stats"),
          safely(AGENT, "/v1/agent/sessions"),
          safely(AGENT, "/v1/agent/approvals"),
          safely(AGENT, "/v1/agent/usage"),
          safely(AGENT, "/v1/agent/insights?days=1"),
          safely(GATEWAY, "/v1/audit?limit=30"),
          safely(AGENT, "/v1/agent/threads"),
          safely(AGENT, "/v1/agent/bots"),
          safely(AGENT, "/v1/agent/settings"),
          safely(AGENT, "/v1/agent/variables"),
          safely(AGENT, "/v1/agent/subscriptions"),
          safely(AGENT, "/v1/agent/secrets"),
          safely(AGENT, "/v1/agent/delegations"),
        ]);
      return json(response, 200, {
        gateway: { models, node },
        agent: { info, stats, sessions: conversations, approvals, usage, insights },
        audit,
        threads,
        bots,
        settings,
        variables,
        subscriptions,
        secrets,
        delegations,
      });
    }

    if (url.pathname === "/api/threads" && request.method === "GET") {
      const result = await safely(AGENT, "/v1/agent/threads");
      return json(response, result.status || 502, result.value);
    }

    if (url.pathname === "/api/threads" && request.method === "POST") {
      const payload = JSON.parse(await body(request, 64 * 1024));
      const result = await upstream(AGENT, "/v1/agent/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: String(payload.name || ""), base: payload.base || null }),
      });
      return json(response, result.status, result.value);
    }

    const threadPath = url.pathname.match(/^\/api\/threads\/([^/]+)(?:\/(diff|pr))?$/);
    if (threadPath) {
      const id = decodeURIComponent(threadPath[1]);
      if (!validId(id)) return json(response, 400, { error: "not a thread id" });
      const action = threadPath[2];
      if (action === "diff" && request.method === "GET") {
        const result = await upstream(AGENT, `/v1/agent/threads/${encodeURIComponent(id)}/diff`);
        return json(response, result.status, result.value);
      }
      if (action === "pr" && request.method === "POST") {
        const payload = JSON.parse(await body(request, 64 * 1024));
        const result = await upstream(AGENT, `/v1/agent/threads/${encodeURIComponent(id)}/pr`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: payload.title || null, body: payload.body || null, base: payload.base || null }),
          timeout: 120_000,
        });
        return json(response, result.status, result.value);
      }
      if (!action && request.method === "DELETE") {
        const force = url.searchParams.get("force") ? "?force=1" : "";
        const result = await upstream(AGENT, `/v1/agent/threads/${encodeURIComponent(id)}${force}`, { method: "DELETE" });
        return json(response, result.status, result.value);
      }
    }

    if (url.pathname === "/api/settings" && request.method === "POST") {
      const payload = JSON.parse(await body(request, 64 * 1024));
      const bot = String(payload.bot || "").trim();
      const query = bot ? `?bot=${encodeURIComponent(bot)}` : "";
      const result = await upstream(AGENT, `/v1/agent/settings${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: String(payload.key || ""), value: String(payload.value ?? ""), literal: Boolean(payload.literal) }),
      });
      return json(response, result.status, result.value);
    }

    if (url.pathname === "/api/model" && request.method === "POST") {
      const payload = JSON.parse(await body(request, 64 * 1024));
      const bot = String(payload.bot || "").trim();
      const query = bot ? `?bot=${encodeURIComponent(bot)}` : "";
      const result = await upstream(AGENT, `/v1/agent/model${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: String(payload.model || "") }),
      });
      return json(response, result.status, result.value);
    }

    if (url.pathname === "/api/tools" && request.method === "POST") {
      const payload = JSON.parse(await body(request, 64 * 1024));
      const bot = String(payload.bot || "").trim();
      const query = bot ? `?bot=${encodeURIComponent(bot)}` : "";
      const result = await upstream(AGENT, `/v1/agent/tools${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: String(payload.target || ""), on: Boolean(payload.on) }),
      });
      return json(response, result.status, result.value);
    }

    if (url.pathname === "/api/secrets" && request.method === "POST") {
      const payload = JSON.parse(await body(request, 64 * 1024));
      const bot = String(payload.bot || "").trim();
      const query = bot ? `?bot=${encodeURIComponent(bot)}` : "";
      const result = await upstream(AGENT, `/v1/agent/secrets${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: String(payload.file || ""), value: String(payload.value || "") }),
      });
      return json(response, result.status, result.value);
    }

    if (url.pathname === "/api/bots" && request.method === "POST") {
      const payload = JSON.parse(await body(request, 64 * 1024));
      const result = await upstream(AGENT, "/v1/agent/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return json(response, result.status, result.value);
    }

    if (url.pathname === "/api/bots/reload" && request.method === "POST") {
      const result = await upstream(AGENT, "/v1/agent/bots/reload", { method: "POST" });
      return json(response, result.status, result.value);
    }

    const botPath = url.pathname.match(/^\/api\/bots\/([^/]+)\/(enable|disable)$/);
    if (botPath && request.method === "POST") {
      const name = decodeURIComponent(botPath[1]);
      if (!validId(name)) return json(response, 400, { error: "not a bot name" });
      const result = await upstream(AGENT, `/v1/agent/bots/${encodeURIComponent(name)}/${botPath[2]}`, { method: "POST" });
      return json(response, result.status, result.value);
    }

    if (url.pathname === "/api/variables" && request.method === "GET") {
      const result = await safely(AGENT, "/v1/agent/variables");
      return json(response, result.status || 502, result.value);
    }
    if (url.pathname === "/api/variables" && request.method === "POST") {
      const payload = JSON.parse(await body(request));
      const result = await upstream(AGENT, "/v1/agent/variables", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: String(payload.key || ""),
          value: String(payload.value || ""),
          description: String(payload.description || ""),
        }),
      });
      return json(response, result.status, result.value);
    }
    const variablePath = url.pathname.match(/^\/api\/variables\/([^/]+)$/);
    if (variablePath && request.method === "DELETE") {
      const key = decodeURIComponent(variablePath[1]);
      const result = await upstream(AGENT, `/v1/agent/variables/${encodeURIComponent(key)}`, { method: "DELETE" });
      return json(response, result.status, result.value);
    }

    if (url.pathname === "/api/subscriptions" && request.method === "GET") {
      const result = await safely(AGENT, "/v1/agent/subscriptions");
      return json(response, result.status || 502, result.value);
    }
    if (url.pathname === "/api/subscriptions" && request.method === "POST") {
      const payload = JSON.parse(await body(request));
      const result = await upstream(AGENT, "/v1/agent/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return json(response, result.status, result.value);
    }
    const subscriptionPath = url.pathname.match(/^\/api\/subscriptions\/([^/]+)$/);
    if (subscriptionPath && request.method === "DELETE") {
      const id = decodeURIComponent(subscriptionPath[1]);
      const result = await upstream(AGENT, `/v1/agent/subscriptions/${encodeURIComponent(id)}`, { method: "DELETE" });
      return json(response, result.status, result.value);
    }

    if (url.pathname === "/api/adapters" && request.method === "GET") {
      const result = await safely(AGENT, "/v1/agent/adapters");
      return json(response, result.status || 502, result.value);
    }
    const adapterRun = url.pathname.match(/^\/api\/adapters\/([^/]+)\/run$/);
    if (adapterRun && request.method === "POST") {
      const name = decodeURIComponent(adapterRun[1]);
      const payload = JSON.parse(await body(request, 64 * 1024));
      const task = String(payload.task || "").trim();
      const thread = String(payload.thread || "").trim();
      if (!task) return json(response, 400, { error: "the task is empty" });
      if (!thread) return json(response, 400, { error: "choose a thread" });
      const stream = Boolean(payload.stream);
      const bodyText = JSON.stringify({
        task,
        thread,
        timeout_seconds: Number(payload.timeout_seconds) || undefined,
        stream,
      });
      if (!stream) {
        const result = await upstream(AGENT, `/v1/agent/adapters/${encodeURIComponent(name)}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: bodyText,
          timeout: 60 * 60_000,
        });
        return json(response, result.status, result.value);
      }
      // SSE is relayed as it arrives: the CLI can talk for an hour, and buffering it would
      // make the panel's run button look frozen.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60 * 60_000);
      let upstreamResponse;
      try {
        upstreamResponse = await fetch(AGENT + `/v1/agent/adapters/${encodeURIComponent(name)}/run`, {
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
          body: bodyText,
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        return json(response, 502, { error: String(error.message || error) });
      }
      if (!upstreamResponse.ok || !upstreamResponse.body) {
        clearTimeout(timer);
        const text = await upstreamResponse.text();
        let value = text;
        try {
          value = JSON.parse(text);
        } catch {}
        return json(response, upstreamResponse.status, value);
      }
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      });
      response.on("close", () => {
        if (!response.writableEnded) controller.abort();
      });
      const reader = upstreamResponse.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          response.write(value);
        }
      } catch (error) {
        if (!response.writableEnded) response.write(`data: ${JSON.stringify({ v: 1, type: "adapter.error", text: String(error.message || error) })}\n\n`);
      } finally {
        clearTimeout(timer);
        response.end();
      }
      return;
    }

    const delegationAction = url.pathname.match(/^\/api\/delegations\/([^/]+)\/(resume|cancel)$/);
    if (delegationAction && request.method === "POST") {
      const id = decodeURIComponent(delegationAction[1]);
      const action = delegationAction[2];
      const result = await upstream(AGENT, `/v1/agent/delegations/${encodeURIComponent(id)}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      return json(response, result.status, result.value);
    }

    if (url.pathname === "/api/plan" && request.method === "GET") {
      const session = url.searchParams.get("session") || "";
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(session)) return json(response, 400, { error: "not a session id" });
      const result = await safely(AGENT, `/v1/agent/plan?session=${encodeURIComponent(session)}`);
      return json(response, result.status || 502, result.value);
    }

    if (url.pathname === "/api/project" && request.method === "GET") {
      const thread = url.searchParams.get("thread");
      const route = thread ? `/v1/agent/project?thread=${encodeURIComponent(thread)}` : "/v1/agent/project";
      const result = await safely(AGENT, route);
      return json(response, result.status || 502, result.value);
    }

    if (url.pathname === "/api/project" && request.method === "POST") {
      const payload = JSON.parse(await body(request, 128 * 1024));
      const result = await upstream(AGENT, "/v1/agent/project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brief: String(payload.brief ?? ""),
          thread: payload.thread ? String(payload.thread) : null,
        }),
      });
      return json(response, result.status, result.value);
    }

    if (url.pathname === "/api/project" && request.method === "DELETE") {
      const thread = url.searchParams.get("thread");
      const route = thread ? `/v1/agent/project?thread=${encodeURIComponent(thread)}` : "/v1/agent/project";
      const result = await upstream(AGENT, route, { method: "DELETE" });
      return json(response, result.status, result.value);
    }

    if (url.pathname === "/api/providers" && request.method === "GET") {
      const result = await safely(GATEWAY, "/v1/admin/providers");
      return json(response, result.status || 502, result.value);
    }

    if (url.pathname === "/api/providers" && request.method === "POST") {
      // The key is in this body once; it is forwarded to the gateway and never echoed.
      const payload = JSON.parse(await body(request, 64 * 1024));
      const result = await upstream(GATEWAY, "/v1/admin/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return json(response, result.status, result.value);
    }

    const providerPath = url.pathname.match(/^\/api\/providers\/([^/]+)$/);
    if (providerPath && request.method === "DELETE") {
      const id = decodeURIComponent(providerPath[1]);
      const result = await upstream(GATEWAY, `/v1/admin/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
      return json(response, result.status, result.value);
    }

    if (url.pathname === "/api/secrets" && request.method === "GET") {
      const result = await safely(AGENT, "/v1/agent/secrets");
      return json(response, result.status || 502, result.value);
    }
    const secretPath = url.pathname.match(/^\/api\/secrets\/([^/]+)$/);
    if (secretPath && request.method === "DELETE") {
      const name = decodeURIComponent(secretPath[1]);
      const result = await upstream(AGENT, `/v1/agent/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
      return json(response, result.status, result.value);
    }

    if (url.pathname === "/api/audit") {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 40)));
      const result = await safely(GATEWAY, `/v1/audit?limit=${limit}`);
      return json(response, result.status || 502, result.value);
    }

    if (url.pathname.startsWith("/api/history/") && request.method === "GET") {
      const id = decodeURIComponent(url.pathname.slice("/api/history/".length));
      if (!validId(id)) return json(response, 400, { error: "not a session id" });
      const result = await safely(AGENT, `/v1/agent/sessions/${encodeURIComponent(id)}`);
      return json(response, result.status || 502, result.value);
    }

    if (url.pathname.startsWith("/api/approvals/") && request.method === "POST") {
      const id = decodeURIComponent(url.pathname.slice("/api/approvals/".length));
      if (!validId(id)) return json(response, 400, { error: "not an approval id" });
      const payload = JSON.parse(await body(request));
      if (!["once", "always", "deny", "instead"].includes(payload.answer)) {
        return json(response, 400, { error: "answer must be once, always, deny or instead" });
      }
      if (payload.answer === "instead" && !String(payload.text || "").trim()) {
        return json(response, 400, { error: "instead needs text" });
      }
      const result = await upstream(AGENT, `/v1/agent/approvals/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: payload.answer, text: String(payload.text || "") }),
      });
      return json(response, result.status, result.value);
    }

    if (url.pathname === "/api/board" && request.method === "GET") {
      const bot = String(url.searchParams.get("bot") || "").trim();
      if (bot && !validId(bot)) return json(response, 400, { error: "not a bot name" });
      const route = bot ? `/v1/agent/board?bot=${encodeURIComponent(bot)}` : "/v1/agent/board";
      const result = await safely(AGENT, route);
      return json(response, result.status || 502, result.value);
    }

    if (await rent(url, request, response)) return;
    if (await studio(url, request, response)) return;

    if (url.pathname === "/api/task" && request.method === "POST") {
      const payload = JSON.parse(await body(request, TASK_BODY));
      const text = String(payload.text || "").trim();
      const id = String(payload.session || "").trim() || `panel-${Date.now().toString(36)}`;
      const images = Array.isArray(payload.images) ? payload.images.slice(0, 4) : [];
      if (!text && !images.length) return json(response, 400, { error: "the task is empty" });
      if (text.length > 8000) return json(response, 400, { error: "the task is longer than 8000 characters" });
      if (!validId(id)) return json(response, 400, { error: "the session id is not valid" });
      for (const image of images) {
        const urlValue = image?.image_url?.url || image?.image_url || image?.url;
        if (typeof urlValue !== "string" || !urlValue.startsWith("data:image/")) {
          return json(response, 400, { error: "an image must be a data:image URL" });
        }
        if (urlValue.length > 14 * 1024 * 1024) return json(response, 400, { error: "an image is too large" });
      }
      const turnBody = { text, images };
      const botName = String(payload.bot || "").trim();
      if (botName) {
        if (!validId(botName)) return json(response, 400, { error: "not a bot name" });
        turnBody.bot = botName;
      }
      if (payload.delegated !== undefined) turnBody.delegated = payload.delegated;
      const reply = await fetch(`${AGENT}/v1/agent/sessions/${encodeURIComponent(id)}/turns`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(turnBody),
        signal: AbortSignal.timeout((payload.delegated ? 60 : 15) * 60_000),
      });
      securityHeaders(response);
      response.writeHead(reply.status, {
        "Content-Type": reply.headers.get("content-type") || "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Session-Id": id,
        "X-Accel-Buffering": "no",
      });
      if (reply.body) for await (const chunk of reply.body) response.write(chunk);
      return response.end();
    }

    if (url.pathname.startsWith("/api/")) return json(response, 404, { error: "no such endpoint" });
    return send(response, 404, "not found");
  } catch (error) {
    console.error(`${request.method} ${url.pathname}: ${error.message || error}`);
    if (!response.headersSent) return json(response, 500, { error: "internal error" });
    response.end();
  }
});

server.listen(PORT, BIND, () => {
  console.log(`panel ${VERSION} on http://${BIND}:${PORT}`);
  console.log(`gateway ${GATEWAY}`);
  console.log(`agent ${AGENT}`);
});
