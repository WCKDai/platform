// Local upstreams with sample data so the panel can be opened without a gateway.
// Not used in production. Password: panel-demo
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { scryptSync, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNk+M9Qz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC",
  "base64",
);
const port = Number(process.env.DEMO_PORT || 8799);
const salt = randomBytes(16);
const passwordHash = `scrypt:${salt.toString("hex")}:${scryptSync("panel-demo", salt, 32).toString("hex")}`;

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}
function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => server);
}

const deadline = new Date(Date.now() + 46 * 60 * 1000).toISOString();
const created = new Date(Date.now() - 14 * 60 * 1000).toISOString();

const gateway = await listen(async (req, res) => {
  const url = new URL(req.url, "http://gateway");
  if (url.pathname === "/v1/models") {
    return json(res, 200, {
      data: [
        { id: "auto", invincible: { tier: "node", healthy: true, context: 8192, data_policy: "owned" } },
        { id: "local-qwen", invincible: { tier: "node", healthy: true, context: 32768, data_policy: "owned" } },
      ],
    });
  }
  if (url.pathname === "/v1/node") {
    return json(res, 200, {
      name: "alpha",
      images: [{ id: "img", healthy: true }],
      speech: [{ id: "kokoro", healthy: true }],
    });
  }
  if (url.pathname === "/v1/audit") {
    return json(res, 200, { entries: [{ api: "chat", at: Math.floor(Date.now() / 1000), receipt: { receipt: { decision: { action: "run", model: "local-qwen" } } } }] });
  }
  if (url.pathname === "/v1/admin/providers") return json(res, 200, { providers: [], egress: "ask", network: "public" });
  if (url.pathname === "/v1/rent/health") return json(res, 200, { ok: true, engine: "wckd" });
  if (url.pathname === "/v1/rent/offers") {
    return json(res, 200, {
      offers: [
        { id: "runpod:community:4090", name: "RTX 4090", sku: "NVIDIA GeForce RTX 4090", vram_gb: 24, usd_per_hr: 0.34, estimate_usd: 0.34, region: "EU-RO-1", cloud: "community" },
        { id: "runpod:secure:L40S", name: "L40S", sku: "NVIDIA L40S", vram_gb: 48, usd_per_hr: 0.86, estimate_usd: 0.86, region: "EU-SE-1", cloud: "secure" },
      ],
    });
  }
  if (url.pathname === "/v1/rent/sessions" && req.method === "GET") {
    return json(res, 200, {
      sessions: [
        {
          id: "sess_demo",
          phase: "ready",
          preset_id: "comfyui-minimax-h3",
          hours: 1,
          created_at: created,
          deadline_at: deadline,
          offer: { id: "runpod:community:4090", usd_per_hr: 0.34, name: "RTX 4090" },
          cost_estimate_usd: 0.34,
          data_center: "EU-RO-1",
          endpoints: [{ name: "ui", url: "http://127.0.0.1:9" }],
        },
      ],
    });
  }
  if (url.pathname === "/v1/rent/sessions" && req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (req.headers["invincible-confirmed"] !== "1") {
      return json(res, 409, {
        error: { code: "confirmation_required", message: "renting a GPU needs confirmation; send again with invincible-confirmed: 1. Nothing was created." },
        offer: { id: payload.offer_id, usd_per_hr: 0.34, estimate_usd: 0.34 * payload.hours },
        hours: payload.hours,
        cost_estimate_usd: 0.34 * payload.hours,
        require_regions: payload.require_regions,
      });
    }
    return json(res, 201, { id: "sess_new", phase: "hydrating", endpoints: [] });
  }
  if (url.pathname === "/v1/images/generations") return json(res, 200, { data: [{ b64_json: PNG.toString("base64") }] });
  if (url.pathname === "/v1/audio/speech") {
    res.writeHead(200, { "Content-Type": "audio/mpeg" });
    return res.end(Buffer.from("ID3fake"));
  }
  return json(res, 404, { error: "missing" });
});

const agent = await listen((req, res) => {
  const url = new URL(req.url, "http://agent");
  if (url.pathname === "/v1/agent") return json(res, 200, { name: "Autobot", model: "auto", bots: [{ name: "default" }, { name: "reviewer" }] });
  if (url.pathname === "/v1/agent/stats") return json(res, 200, { tasks: 2, open_sessions: 3, waiting: 1 });
  if (url.pathname === "/v1/agent/sessions") {
    return json(res, 200, {
      sessions: [
        { id: "panel-checkout", bot: "default", modified: Math.floor(Date.now() / 1000) },
        { id: "panel-readme", bot: "reviewer", modified: Math.floor(Date.now() / 1000) - 3600 },
      ],
    });
  }
  if (url.pathname.startsWith("/v1/agent/sessions/")) {
    return json(res, 200, {
      messages: [
        { role: "user", content: "Fix the failing test in checkout.py and run it once." },
        { role: "assistant", content: "The assertion compared cents as floats. I compared integers and the test passed.", tool_calls: [{ function: { name: "shell", arguments: "python -m pytest tests/test_checkout.py" } }] },
        { role: "tool", content: "1 passed", tool_call_id: "1" },
      ],
      plan: { done: 1, total: 3, items: [{ text: "Read the failure", status: "done" }, { text: "Patch the assertion", status: "doing" }, { text: "Re-run the test", status: "pending" }] },
    });
  }
  if (url.pathname === "/v1/agent/plan") {
    return json(res, 200, { done: 1, total: 3, items: [{ text: "Read the failure", status: "done" }, { text: "Patch the assertion", status: "doing" }, { text: "Re-run the test", status: "pending" }] });
  }
  if (url.pathname === "/v1/agent/approvals") {
    return json(res, 200, { approvals: [{ id: "ap1", action: "shell", detail: "python -m pytest tests/test_checkout.py" }] });
  }
  if (url.pathname === "/v1/agent/usage") {
    return json(res, 200, { today: { turns: 4, calls: 9, input: 18200, output: 2400, cost: 0.012, cloud_calls: 0 } });
  }
  if (url.pathname === "/v1/agent/insights") {
    return json(res, 200, { models: [{ model: "local-qwen", calls: 9, tokens: 20600, cloud: false }], tools: [{ name: "shell", count: 3 }], failures: { errors: 0, stopped: 0, tool_errors: 0, refused: 0 } });
  }
  if (url.pathname === "/v1/agent/threads") {
    return json(res, 200, {
      threads: [
        { id: "th_checkout", name: "checkout", branch: "autobot/checkout", base: "main", session: "panel-checkout", dirty: true, ahead: 1, head: "a1b2c3d", worktree_exists: true },
        { id: "th_readme", name: "readme", branch: "autobot/readme", base: "main", session: "panel-readme", dirty: false, ahead: 0, head: "d4e5f6a", worktree_exists: true, pr_url: "https://example.com/pull/12" },
      ],
    });
  }
  if (url.pathname === "/v1/agent/bots") {
    return json(res, 200, {
      bots: [
        { name: "default", default: true, status: "running", model: "auto", approvals: "ask", persona: "The operator's agent.", channels: [{ kind: "telegram", status: "connected" }], sessions: 2 },
        { name: "reviewer", status: "stopped", model: "local-qwen", approvals: "edits", persona: "Reads diffs and asks before writing.", channels: [], sessions: 1 },
      ],
    });
  }
  if (url.pathname === "/v1/agent/settings") {
    return json(res, 200, {
      bot: "default",
      default: true,
      approvals: { mode: "ask" },
      agent: { tools: [{ group: "files-read", on: true }, { group: "terminal", on: true }], workdir: "/srv/app", sandbox: "off", max_steps: 24, check: "pytest -q" },
      gateway: { model: "auto", url: "http://127.0.0.1:7777/v1" },
      mcp: ["github"],
      serve: "127.0.0.1:7792",
    });
  }
  if (url.pathname === "/v1/agent/variables") {
    return json(res, 200, { variables: [{ key: "project.name", value: "platform", description: "repo", updated_at: Math.floor(Date.now() / 1000) }] });
  }
  if (url.pathname === "/v1/agent/subscriptions") {
    return json(res, 200, {
      subscriptions: [{ id: "sub1", name: "Claude Max", provider: "Anthropic", plan: "Max", status: "active", monthly_cost: 100, currency: "USD", renews_on: "2026-11-02", seats: 1 }],
      totals: [{ monthly: 100, currency: "USD" }],
      upcoming: [{ name: "Claude Max", renews_on: "2026-11-02", days: 4 }],
      active: 1,
      all: 1,
    });
  }
  if (url.pathname === "/v1/agent/secrets") {
    return json(res, 200, { secrets: [{ name: "telegram.token", kind: "token", bytes: 46, updated_at: Math.floor(Date.now() / 1000) }] });
  }
  if (url.pathname === "/v1/agent/delegations") {
    return json(res, 200, {
      paused: 1,
      running: 1,
      max_resumes: 5,
      delegations: [
        { id: "job1", task: "Keep the checkout fix moving", bot: "default", session: "panel-checkout", state: "running", resumes: 0, max_resumes: 5 },
        { id: "job2", task: "Wait for the usage window", bot: "reviewer", session: "panel-readme", state: "paused", resumes: 1, max_resumes: 5, retry_at: Math.floor(Date.now() / 1000) + 600 },
      ],
    });
  }
  if (url.pathname === "/v1/agent/board") {
    return json(res, 200, {
      tasks: [
        { id: "t1", plan: "checkout", agent: "default", goal: "Patch the assertion", status: "running", created: 1, updated: 1, origin: "panel-checkout" },
        { id: "t2", plan: "checkout", agent: "reviewer", goal: "Read the diff before the PR", status: "todo", created: 1, updated: 1, origin: "panel-checkout" },
        { id: "t3", plan: "checkout", agent: "default", goal: "Which filename should the note use?", status: "blocked", question: "checkout-note.md or NOTES.md?", created: 1, updated: 1, origin: "panel-checkout" },
      ],
    });
  }
  if (url.pathname === "/v1/agent/project") {
    return json(res, 200, {
      root: "/srv/app",
      check: "pytest -q",
      brief: "Platform monorepo. Panel is services/agent/panel, dependency-free Node. Do not add a build step. Gateway owns provider keys.",
      characters: 120,
      updated_at: Math.floor(Date.now() / 1000),
    });
  }
  if (url.pathname === "/v1/agent/adapters") return json(res, 200, { adapters: [] });
  return json(res, 404, { error: "missing" });
});

const panel = spawn(process.execPath, ["server.mjs"], {
  cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  env: {
    ...process.env,
    PORT: String(port),
    PANEL_BIND: "127.0.0.1",
    INVINCIBLE_TOKEN: "demo-token",
    PANEL_SECRET: "demo-secret-demo-secret-demo-secret",
    PANEL_PASSWORD_HASH: passwordHash,
    GATEWAY_URL: `http://127.0.0.1:${gateway.address().port}`,
    AGENT_URL: `http://127.0.0.1:${agent.address().port}`,
    PANEL_SECURE_COOKIES: "false",
  },
  stdio: "inherit",
});
panel.on("exit", (code) => process.exit(code ?? 0));
console.log(`demo panel http://127.0.0.1:${port} password panel-demo`);
