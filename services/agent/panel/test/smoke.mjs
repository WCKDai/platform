// Starts a fake gateway and agent, then checks the panel's auth, rooms, rental and studio routes.
import { spawn } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { scryptSync, randomBytes } from "node:crypto";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => server);
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const salt = randomBytes(16);
const hash = scryptSync("correct horse battery", salt, 32);
const passwordHash = `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;

const seen = { confirm: null, header: null };

const gateway = await listen(async (req, res) => {
  const url = new URL(req.url, "http://gateway");
  if (url.pathname === "/v1/models") return json(res, 200, { data: [{ id: "local", invincible: { tier: "node", healthy: true } }] });
  if (url.pathname === "/v1/node") {
    return json(res, 200, {
      name: "alpha",
      images: [{ id: "img", healthy: true }],
      speech: [{ id: "kokoro", healthy: true }],
    });
  }
  if (url.pathname === "/v1/audit") return json(res, 200, { entries: [] });
  if (url.pathname === "/v1/admin/providers") return json(res, 200, { providers: [], egress: "ask", network: "public" });
  if (url.pathname === "/v1/rent/health") return json(res, 404, { error: { code: "not_found", message: "no rent" } });
  if (url.pathname === "/v1/rent/offers") {
    return json(res, 200, {
      offers: [{ id: "runpod:community:RTX", name: "RTX 4090", usd_per_hr: 0.34, estimate_usd: 0.34, region: "EU-RO-1", vram_gb: 24 }],
    });
  }
  if (url.pathname === "/v1/rent/sessions" && req.method === "GET") {
    return json(res, 200, {
      sessions: [{ id: "sess_test", phase: "ready", preset_id: "comfyui-minimax-h3", api_key: "should-not-leak", endpoints: [{ name: "ui", url: "http://127.0.0.1:9" }] }],
    });
  }
  if (url.pathname === "/v1/rent/sessions" && req.method === "POST") {
    const payload = JSON.parse((await readBody(req)).toString("utf8"));
    seen.confirm = payload.confirm;
    seen.header = req.headers["x-wckd-confirm"] || "";
    if (payload.confirm !== true) {
      return json(res, 409, {
        error: { code: "confirmation_required", message: "confirmation required" },
        offer: { id: payload.offer_id, usd_per_hr: 0.34, estimate_usd: 0.34 },
        hours: payload.hours,
        cost_estimate_usd: 0.34,
        require_regions: payload.require_regions,
      });
    }
    return json(res, 201, { id: "sess_new", phase: "hydrating", api_key: "nope", endpoints: [{ name: "ui", url: "http://secret.example/ui" }] });
  }
  if (url.pathname === "/v1/images/generations") {
    return json(res, 200, { data: [{ b64_json: PNG.toString("base64") }] });
  }
  if (url.pathname === "/v1/audio/speech") {
    res.writeHead(200, { "Content-Type": "audio/mpeg" });
    return res.end(Buffer.from("fake-mp3"));
  }
  return json(res, 404, { error: "missing" });
});

const agent = await listen((req, res) => {
  const url = new URL(req.url, "http://agent");
  if (url.pathname === "/v1/agent") return json(res, 200, { name: "Autobot", model: "auto", bots: [{ name: "default" }] });
  if (url.pathname === "/v1/agent/stats") return json(res, 200, { tasks: 1, open_sessions: 0, waiting: 0 });
  if (url.pathname === "/v1/agent/sessions") return json(res, 200, { sessions: [] });
  if (url.pathname === "/v1/agent/approvals") return json(res, 200, { approvals: [] });
  if (url.pathname === "/v1/agent/usage") return json(res, 200, { today: { turns: 0, calls: 0, input: 0, output: 0, cost: 0 } });
  if (url.pathname === "/v1/agent/insights") return json(res, 200, { models: [], tools: [], failures: {} });
  if (url.pathname === "/v1/agent/threads") return json(res, 200, { threads: [] });
  if (url.pathname === "/v1/agent/bots") return json(res, 200, { bots: [{ name: "default", default: true, status: "running", model: "auto", channels: [], sessions: 0 }] });
  if (url.pathname === "/v1/agent/settings") return json(res, 200, { bot: "default", default: true, approvals: { mode: "ask" }, agent: { tools: [] }, gateway: { model: "auto" }, mcp: [] });
  if (url.pathname === "/v1/agent/variables") return json(res, 200, { variables: [] });
  if (url.pathname === "/v1/agent/subscriptions") return json(res, 200, { subscriptions: [], totals: [], upcoming: [] });
  if (url.pathname === "/v1/agent/secrets") return json(res, 200, { secrets: [] });
  if (url.pathname === "/v1/agent/delegations") return json(res, 200, { delegations: [], paused: 0, running: 0 });
  if (url.pathname === "/v1/agent/board") return json(res, 200, { tasks: [] });
  if (url.pathname === "/v1/agent/adapters") return json(res, 200, { adapters: [] });
  return json(res, 404, { error: "missing" });
});

const port = 8791;
const panel = spawn(process.execPath, ["server.mjs"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: {
    ...process.env,
    PORT: String(port),
    PANEL_BIND: "127.0.0.1",
    INVINCIBLE_TOKEN: "node-token-not-for-the-browser",
    PANEL_SECRET: "x".repeat(32),
    PANEL_PASSWORD_HASH: passwordHash,
    GATEWAY_URL: `http://127.0.0.1:${gateway.address().port}`,
    AGENT_URL: `http://127.0.0.1:${agent.address().port}`,
    PANEL_SECURE_COOKIES: "false",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let panelLog = "";
panel.stdout.on("data", (chunk) => {
  panelLog += chunk;
});
panel.stderr.on("data", (chunk) => {
  panelLog += chunk;
});
for (let i = 0; i < 50; i += 1) {
  try {
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    if (health.ok) break;
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function login() {
  const response = await fetch(`http://127.0.0.1:${port}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "password=correct+horse+battery",
    redirect: "manual",
  });
  const cookie = response.headers.get("set-cookie") || "";
  return cookie.split(";")[0];
}

test("health, login and every room", async () => {
  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).version, "0.2.0");
  const bad = await fetch(`http://127.0.0.1:${port}/api/overview`);
  assert.equal(bad.status, 401);
  const cookie = await login();
  const page = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie } });
  const html = await page.text();
  for (const view of ["overview", "chat", "mission", "workspaces", "delegations", "bots", "studio", "gpu", "project", "providers", "secrets", "variables", "subscriptions", "integrations", "usage", "settings"]) {
    assert.match(html, new RegExp(`data-view="${view}"`));
  }
  assert.match(html, /webawesome\/styles\/themes\/default\.css/);
  const kit = await fetch(`http://127.0.0.1:${port}/vendor/panel-kit.js`);
  assert.equal(kit.status, 200);
  assert.match(kit.headers.get("content-type"), /javascript/);
});

test("csrf, rental confirm and secret scrubbing", async () => {
  const cookie = await login();
  const session = await fetch(`http://127.0.0.1:${port}/api/session`, { headers: { cookie } });
  const { csrf } = await session.json();
  const denied = await fetch(`http://127.0.0.1:${port}/api/rent/sessions`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(denied.status, 403);
  const us = await fetch(`http://127.0.0.1:${port}/api/rent/offers?preset=comfyui-minimax-h3&hours=1&require_regions=US`, {
    headers: { cookie },
  });
  assert.equal(us.status, 400);
  const health = await fetch(`http://127.0.0.1:${port}/api/rent/health`, { headers: { cookie } });
  const healthBody = await health.json();
  assert.equal(healthBody.connected, false);
  assert.match(healthBody.message, /not connected/);
  const quote = await fetch(`http://127.0.0.1:${port}/api/rent/sessions`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify({ preset_id: "comfyui-minimax-h3", hours: 1, offer_id: "runpod:community:RTX", confirm: false, require_regions: ["EU"] }),
  });
  assert.equal(quote.status, 409);
  assert.equal(seen.confirm, false);
  assert.equal(seen.header, "");
  const quoteBody = await quote.json();
  assert.equal(quoteBody.cost_estimate_usd, 0.34);
  const rented = await fetch(`http://127.0.0.1:${port}/api/rent/sessions`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify({ preset_id: "comfyui-minimax-h3", hours: 1, offer_id: "runpod:community:RTX", confirm: true, require_regions: ["EU"] }),
  });
  assert.equal(rented.status, 201);
  assert.equal(seen.confirm, true);
  assert.equal(seen.header, "true");
  const rentedBody = await rented.json();
  assert.equal(rentedBody.api_key, undefined);
  assert.equal(rentedBody.endpoints[0].url, undefined);
  assert.equal(rentedBody.endpoints[0].ready, true);
  const listed = await fetch(`http://127.0.0.1:${port}/api/rent/sessions`, { headers: { cookie } });
  const listedBody = await listed.json();
  assert.equal(listedBody.sessions[0].api_key, undefined);
  assert.equal(listedBody.sessions[0].endpoints[0].url, undefined);
});

test("studio image and speech stay on the panel", async () => {
  const cookie = await login();
  const session = await fetch(`http://127.0.0.1:${port}/api/session`, { headers: { cookie } });
  const { csrf } = await session.json();
  const caps = await fetch(`http://127.0.0.1:${port}/api/studio/capabilities`, { headers: { cookie } });
  const capabilities = await caps.json();
  assert.equal(capabilities.images[0].id, "img");
  assert.equal(capabilities.speech[0].id, "kokoro");
  const image = await fetch(`http://127.0.0.1:${port}/api/studio/jobs`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify({ kind: "image", prompt: "a square", preset: "auto" }),
  });
  const imageBody = await image.json();
  assert.equal(image.status, 201);
  assert.equal(imageBody.job.status, "done");
  const media = await fetch(`http://127.0.0.1:${port}/api/studio/media/${imageBody.job.media_id}`, { headers: { cookie } });
  assert.equal(media.headers.get("content-type"), "image/png");
  const bytes = Buffer.from(await media.arrayBuffer());
  assert.equal(createHash("sha256").update(bytes).digest("hex"), createHash("sha256").update(PNG).digest("hex"));
  const speech = await fetch(`http://127.0.0.1:${port}/api/studio/jobs`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify({ kind: "audio", prompt: "hello", voice: "af_heart" }),
  });
  const speechBody = await speech.json();
  assert.equal(speechBody.job.media_type, "audio/mpeg");
  const video = await fetch(`http://127.0.0.1:${port}/api/studio/jobs`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify({ kind: "video", prompt: "a walk", preset: "comfyui-minimax-h3" }),
  });
  const videoBody = await video.json();
  assert.equal(videoBody.job.status, "waiting");
  assert.match(videoBody.job.detail, /ComfyUI|ready|endpoint/i);
});

test.after(() => {
  panel.kill();
  gateway.close();
  agent.close();
  if (panel.exitCode && panel.exitCode !== 0 && panel.exitCode !== null) {
    console.error(panelLog);
  }
});
