// WCKD agent control panel: one authenticated surface over Invincible and Autobot.
// No dependencies beyond Node 20+; all upstream credentials stay on this process.

import http from "node:http";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(DIR, "public");
const VERSION = "0.1.0";
const PORT = Number(process.env.PORT || 7800);
const BIND = process.env.PANEL_BIND || "0.0.0.0";
const GATEWAY = (process.env.GATEWAY_HTTP_URL || process.env.GATEWAY_URL || "http://127.0.0.1:7777")
  .replace(/\/v1\/?$/, "")
  .replace(/\/+$/, "");
const AGENT = (process.env.AGENT_URL || "http://127.0.0.1:7792").replace(/\/+$/, "");
const TOKEN = (process.env.INVINCIBLE_TOKEN || "").trim();
const SECRET = process.env.PANEL_SECRET || "";
const PASSWORD = process.env.PANEL_PASSWORD || "";
const PASSWORD_HASH = process.env.PANEL_PASSWORD_HASH || "";
const SECURE = /^(1|true|yes|on)$/i.test(process.env.PANEL_SECURE_COOKIES || "");
const SESSION_MS = 8 * 60 * 60 * 1000;
const MAX_BODY = 1024 * 1024;
const LOGIN_WINDOW = 5 * 60 * 1000;
const LOGIN_LIMIT = 10;

if (!TOKEN) fail("INVINCIBLE_TOKEN is required");
if (!SECRET || SECRET.length < 32) fail("PANEL_SECRET must be at least 32 characters");
if (!PASSWORD && !PASSWORD_HASH) fail("PANEL_PASSWORD or PANEL_PASSWORD_HASH is required");

const HASH = PASSWORD_HASH || hashPassword(PASSWORD);
const sessions = new Map();
const attempts = new Map();
const STATIC = {
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
};

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
}

function json(res, status, value) {
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8");
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

function current(request) {
  const token = cookies(request).panel_session;
  const session = token ? sessions.get(token) : null;
  if (!session) return null;
  if (session.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expires = Date.now() + SESSION_MS;
  return { token, ...session };
}

function startSession(res) {
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(24).toString("base64url");
  sessions.set(token, { csrf, expires: Date.now() + SESSION_MS });
  securityHeaders(res);
  res.setHeader(
    "Set-Cookie",
    `panel_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${SECURE ? "; Secure" : ""}`,
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
  const response = await fetch(base + route, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let value = text;
  try {
    value = JSON.parse(text);
  } catch {}
  return { status: response.status, value };
}

async function safely(base, route) {
  try {
    return await upstream(base, route);
  } catch (error) {
    return { status: 0, value: { error: String(error.message || error) } };
  }
}

function staticFile(name, type) {
  return [readFileSync(path.join(PUBLIC, name), "utf8"), type];
}

function loginPage(error = "") {
  return readFileSync(path.join(PUBLIC, "login.html"), "utf8").replace("{{ERROR}}", error);
}

function dashboardPage() {
  return readFileSync(path.join(PUBLIC, "index.html"), "utf8").replace("{{VERSION}}", VERSION);
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
      const [models, node, info, stats, conversations, approvals, usage, insights, audit] = await Promise.all([
        safely(GATEWAY, "/v1/models"),
        safely(GATEWAY, "/v1/node"),
        safely(AGENT, "/v1/agent"),
        safely(AGENT, "/v1/agent/stats"),
        safely(AGENT, "/v1/agent/sessions"),
        safely(AGENT, "/v1/agent/approvals"),
        safely(AGENT, "/v1/agent/usage"),
        safely(AGENT, "/v1/agent/insights?days=1"),
        safely(GATEWAY, "/v1/audit?limit=30"),
      ]);
      return json(response, 200, {
        gateway: { models, node },
        agent: { info, stats, sessions: conversations, approvals, usage, insights },
        audit,
      });
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

    if (url.pathname === "/api/task" && request.method === "POST") {
      const payload = JSON.parse(await body(request));
      const text = String(payload.text || "").trim();
      const id = String(payload.session || "").trim() || `panel-${Date.now().toString(36)}`;
      if (!text) return json(response, 400, { error: "the task is empty" });
      if (text.length > 8000) return json(response, 400, { error: "the task is longer than 8000 characters" });
      if (!validId(id)) return json(response, 400, { error: "the session id is not valid" });
      const reply = await fetch(`${AGENT}/v1/agent/sessions/${encodeURIComponent(id)}/turns`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(15 * 60_000),
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

    const asset = STATIC[url.pathname];
    if (asset) {
      const [content, type] = staticFile(asset[0], asset[1]);
      securityHeaders(response);
      response.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=300" });
      return response.end(content);
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
