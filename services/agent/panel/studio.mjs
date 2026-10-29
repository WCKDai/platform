// Image and speech jobs go to the gateway. Video jobs go to a rented ComfyUI session.
// Media bytes stay in this process. The browser only receives same-origin URLs.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PRESETS = path.join(path.dirname(fileURLToPath(import.meta.url)), "presets");
const MEDIA_TYPE = /^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm)|audio\/(mpeg|wav|ogg))$/;

const JOBS = 40;
const MEDIA = 12;
const MEDIA_BYTES = 24 * 1024 * 1024;

const jobs = [];
const media = new Map();

function id() {
  return randomBytes(9).toString("base64url");
}

function remember(bytes, type) {
  while (media.size >= MEDIA) {
    const oldest = media.keys().next().value;
    media.delete(oldest);
  }
  if (bytes.length > MEDIA_BYTES) throw new Error("the result is larger than 24 MiB");
  const mediaId = id();
  media.set(mediaId, { type: safeMediaType(type), bytes });
  return mediaId;
}

export function safeMediaType(type) {
  const base = String(type || "").split(";")[0].trim().toLowerCase();
  return MEDIA_TYPE.test(base) ? base : "application/octet-stream";
}

export function workflowFor(presetId, prompt) {
  const id = String(presetId || "comfyui-minimax-h3").replace(/[^A-Za-z0-9._-]/g, "");
  const file = path.join(PRESETS, `${id}.json`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`no ComfyUI workflow for preset ${id}`);
  }
  const graph = structuredClone(raw.prompt);
  if (!graph || typeof graph !== "object") throw new Error(`preset ${id} has no prompt graph`);
  const textNode = raw.prompt_node && graph[raw.prompt_node];
  if (textNode?.inputs && "text" in textNode.inputs) textNode.inputs.text = String(prompt);
  return graph;
}

export function graphProblems(graph) {
  const ids = new Set(Object.keys(graph));
  const problems = [];
  const referenced = new Set();
  for (const [nodeId, node] of Object.entries(graph)) {
    if (!node?.class_type) problems.push(`${nodeId} has no class_type`);
    for (const [key, value] of Object.entries(node?.inputs || {})) {
      if (Array.isArray(value) && value.length >= 2 && (typeof value[0] === "string" || typeof value[0] === "number")) {
        const target = String(value[0]);
        if (!ids.has(target)) problems.push(`${nodeId}.${key} links to missing node ${target}`);
        else referenced.add(target);
      }
    }
  }
  const outputs = Object.entries(graph).filter(([nodeId, node]) => !referenced.has(nodeId) && /video|save|combine/i.test(node.class_type || ""));
  if (!outputs.length) problems.push("no video output node");
  return problems;
}

function pushJob(job) {
  jobs.unshift(job);
  while (jobs.length > JOBS) {
    const dropped = jobs.pop();
    if (dropped?.media_id) media.delete(dropped.media_id);
  }
  return job;
}

function endpointUrl(session) {
  const endpoints = Array.isArray(session?.endpoints) ? session.endpoints : [];
  const ui = endpoints.find((item) => item?.name === "ui" && item.url) || endpoints.find((item) => item?.url);
  const url = String(ui?.url || "");
  if (!/^https?:\/\//i.test(url)) return "";
  return url.replace(/\/+$/, "");
}

async function comfySubmit(base, prompt, preset) {
  const health = await fetch(`${base}/queue`, { signal: AbortSignal.timeout(8_000) });
  if (!health.ok) {
    return { status: "waiting", detail: `ComfyUI answered ${health.status} on this session.` };
  }
  let graph;
  try {
    graph = workflowFor(preset, prompt);
  } catch (error) {
    return { status: "failed", detail: String(error.message || error) };
  }
  const problems = graphProblems(graph);
  if (problems.length) return { status: "failed", detail: problems.join("; ") };
  const posted = await fetch(`${base}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph, extra_data: { wckd: "panel" } }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await posted.text();
  let value = {};
  try {
    value = JSON.parse(text);
  } catch {
    value = { message: text.slice(0, 500) };
  }
  if (!posted.ok) {
    const message = value.error?.message || value.error || value.message || `ComfyUI refused the prompt (${posted.status})`;
    return { status: "failed", detail: String(message).slice(0, 500) };
  }
  return { status: "running", comfy_id: value.prompt_id || "", detail: "Submitted to the rented ComfyUI session." };
}

async function comfyProgress(base, promptId) {
  const queue = await fetch(`${base}/queue`, { signal: AbortSignal.timeout(8_000) });
  if (!queue.ok) return { status: "waiting", detail: "ComfyUI stopped answering.", progress: 0 };
  const body = await queue.json();
  const running = body.queue_running?.length || 0;
  const pending = body.queue_pending?.length || 0;
  if (!promptId) return { status: "running", progress: running ? 40 : 10, detail: `${running} running, ${pending} waiting` };
  const history = await fetch(`${base}/history/${encodeURIComponent(promptId)}`, { signal: AbortSignal.timeout(8_000) });
  if (!history.ok) return { status: "running", progress: 50, detail: `${running} running, ${pending} waiting` };
  const hist = await history.json();
  const entry = hist[promptId];
  if (!entry) return { status: "running", progress: running ? 55 : 15, detail: `${running} running, ${pending} waiting` };
  const statusStr = entry.status?.status_str || (entry.status?.completed ? "success" : "");
  if (statusStr === "error") return { status: "failed", detail: "ComfyUI reported an error for this prompt.", progress: 100 };
  const outputs = entry.outputs || {};
  for (const node of Object.values(outputs)) {
    const file = (node.images || node.gifs || node.videos || [])[0];
    if (!file?.filename) continue;
    const view = new URL(`${base}/view`);
    view.searchParams.set("filename", file.filename);
    if (file.subfolder) view.searchParams.set("subfolder", file.subfolder);
    if (file.type) view.searchParams.set("type", file.type);
    const downloaded = await fetch(view, { signal: AbortSignal.timeout(60_000) });
    if (!downloaded.ok) return { status: "failed", detail: "ComfyUI finished but the file could not be read." };
    const bytes = Buffer.from(await downloaded.arrayBuffer());
    const type = downloaded.headers.get("content-type") || (file.filename.endsWith(".mp4") ? "video/mp4" : "image/png");
    return { status: "done", progress: 100, detail: "Ready.", bytes, type };
  }
  if (entry.status?.completed) return { status: "done", progress: 100, detail: "ComfyUI finished without a media file." };
  return { status: "running", progress: 70, detail: "ComfyUI is working." };
}

export function createStudio({ upstream, safely, json, send, readBody, gateway }) {
  return async function studio(url, request, response) {
    if (url.pathname === "/api/studio/capabilities" && request.method === "GET") {
      const node = await safely(gateway, "/v1/node");
      const value = node.status === 200 && node.value && typeof node.value === "object" ? node.value : {};
      return json(response, 200, {
        images: Array.isArray(value.images) ? value.images : [],
        speech: Array.isArray(value.speech) ? value.speech : [],
      });
    }

    if (url.pathname === "/api/studio/jobs" && request.method === "GET") {
      return json(response, 200, { jobs: jobs.map(publicJob) });
    }

    const one = url.pathname.match(/^\/api\/studio\/jobs\/([^/]+)$/);
    if (one && request.method === "GET") {
      const job = jobs.find((item) => item.id === decodeURIComponent(one[1]));
      if (!job) return json(response, 404, { error: "no such job" });
      if (job.kind === "video" && job.comfy_base && (job.status === "running" || job.status === "waiting")) {
        try {
          const step = await comfyProgress(job.comfy_base, job.comfy_id);
          job.status = step.status;
          job.detail = step.detail || job.detail;
          job.progress = step.progress ?? job.progress;
          job.updated_at = Date.now();
          if (step.bytes) {
            job.media_id = remember(step.bytes, step.type);
            job.media_type = step.type;
            job.status = "done";
            job.progress = 100;
          }
        } catch (error) {
          job.detail = String(error.message || error);
        }
      }
      return json(response, 200, { job: publicJob(job) });
    }

    if (one && request.method === "DELETE") {
      const index = jobs.findIndex((item) => item.id === decodeURIComponent(one[1]));
      if (index < 0) return json(response, 404, { error: "no such job" });
      const [removed] = jobs.splice(index, 1);
      if (removed.media_id) media.delete(removed.media_id);
      return json(response, 200, { ok: true });
    }

    const mediaPath = url.pathname.match(/^\/api\/studio\/media\/([^/]+)$/);
    if (mediaPath && request.method === "GET") {
      const item = media.get(decodeURIComponent(mediaPath[1]));
      if (!item) return json(response, 404, { error: "no such file" });
      const type = safeMediaType(item.type);
      const extra = { "Cache-Control": "private, max-age=3600" };
      if (type === "application/octet-stream") extra["Content-Disposition"] = "attachment";
      return send(response, 200, item.bytes, type, extra);
    }

    if (url.pathname === "/api/studio/jobs" && request.method === "POST") {
      const payload = JSON.parse(await readBody(request, 256 * 1024));
      const kind = String(payload.kind || "");
      const prompt = String(payload.prompt || "").trim();
      if (!["image", "audio", "video"].includes(kind)) return json(response, 400, { error: "kind must be image, audio or video" });
      if (!prompt) return json(response, 400, { error: "the prompt is empty" });
      if (prompt.length > 4096) return json(response, 400, { error: "the prompt is longer than 4096 characters" });
      const job = pushJob({
        id: id(),
        kind,
        prompt,
        preset: String(payload.preset || "auto").slice(0, 80),
        status: "running",
        progress: 5,
        detail: "Sending…",
        created_at: Date.now(),
        updated_at: Date.now(),
        media_id: "",
        media_type: "",
        session_id: String(payload.session_id || ""),
        comfy_id: "",
        comfy_base: "",
      });
      try {
        if (kind === "image") await runImage(job, payload);
        else if (kind === "audio") await runAudio(job, payload);
        else await runVideo(job, payload);
      } catch (error) {
        job.status = "failed";
        job.detail = String(error.message || error);
        job.progress = 100;
        job.updated_at = Date.now();
      }
      return json(response, job.status === "failed" ? 502 : 201, { job: publicJob(job) });
    }

    return false;

    async function runImage(job, payload) {
      const model = job.preset && job.preset !== "auto" ? job.preset : "auto";
      const size = ["1024x1024", "1024x1536", "1536x1024"].includes(payload.size) ? payload.size : "1024x1024";
      const result = await upstream(gateway, "/v1/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: job.prompt, n: 1, size, response_format: "b64_json" }),
        timeout: 180_000,
      });
      if (result.status === 404) {
        job.status = "failed";
        job.detail = "No image backend on this node. Add one under [[images]] in the gateway config.";
        job.progress = 100;
        return;
      }
      const value = result.value;
      if (result.status !== 200 || !value || typeof value !== "object") {
        throw new Error(errorText(value) || `the image backend answered ${result.status}`);
      }
      const b64 = value.data?.[0]?.b64_json;
      if (!b64) throw new Error("the image backend returned no image");
      const bytes = Buffer.from(b64, "base64");
      job.media_id = remember(bytes, "image/png");
      job.media_type = "image/png";
      job.status = "done";
      job.progress = 100;
      job.detail = "Ready.";
      job.updated_at = Date.now();
    }

    async function runAudio(job, payload) {
      const model = job.preset && job.preset !== "auto" ? job.preset : "auto";
      const voice = String(payload.voice || "").trim();
      const body = { model, input: job.prompt, response_format: "mp3" };
      if (voice) body.voice = voice.slice(0, 80);
      const result = await upstream(gateway, "/v1/audio/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "audio/mpeg, application/json" },
        body: JSON.stringify(body),
        timeout: 180_000,
        raw: true,
      });
      if (result.status === 404) {
        job.status = "failed";
        job.detail = "No speech backend on this node. Add one under [[speech]] in the gateway config.";
        job.progress = 100;
        return;
      }
      const type = result.type || "";
      if (result.status !== 200 || type.includes("json") || type.startsWith("text/")) {
        let message = "";
        try {
          const parsed = JSON.parse(result.buf.toString("utf8"));
          message = errorText(parsed);
        } catch {
          message = result.buf.toString("utf8").slice(0, 300);
        }
        throw new Error(message || `the speech backend answered ${result.status}`);
      }
      job.media_id = remember(result.buf, type.split(";")[0] || "audio/mpeg");
      job.media_type = type.split(";")[0] || "audio/mpeg";
      job.status = "done";
      job.progress = 100;
      job.detail = "Ready.";
      job.updated_at = Date.now();
    }

    async function runVideo(job) {
      const rent = await safely(gateway, "/v1/rent/sessions");
      if (!rent || rent.status === 0 || rent.status === 404 || rent.status === 405) {
        job.status = "waiting";
        job.progress = 0;
        job.detail = "GPU rental is not connected on this node. Video needs a rented ComfyUI session.";
        return;
      }
      const sessions = rent.value?.sessions || [];
      const session = sessions.find((item) => item.id === job.session_id) || sessions.find((item) => item.phase === "ready");
      if (!session) {
        job.status = "waiting";
        job.progress = 0;
        job.detail = "No rented session is ready. Rent a GPU, then run this again.";
        return;
      }
      job.session_id = session.id || job.session_id;
      if (session.phase !== "ready") {
        job.status = "waiting";
        job.progress = 0;
        job.detail = `Session ${session.id} is ${session.phase || "not ready"}. Video stays queued until ComfyUI answers.`;
        return;
      }
      const base = endpointUrl(session);
      if (!base) {
        job.status = "waiting";
        job.detail = "The session has no UI endpoint yet.";
        return;
      }
      job.comfy_base = base;
      try {
        const submitted = await comfySubmit(base, job.prompt, job.preset);
        job.status = submitted.status;
        job.detail = submitted.detail;
        job.comfy_id = submitted.comfy_id || "";
        job.progress = submitted.status === "running" ? 20 : submitted.status === "failed" ? 100 : 0;
      } catch {
        job.status = "waiting";
        job.progress = 0;
        job.detail = "ComfyUI has not answered on this session yet.";
      }
      job.updated_at = Date.now();
    }
  };
}

function publicJob(job) {
  return {
    id: job.id,
    kind: job.kind,
    prompt: job.prompt,
    preset: job.preset,
    status: job.status,
    progress: job.progress,
    detail: job.detail,
    created_at: job.created_at,
    updated_at: job.updated_at,
    media_id: job.media_id,
    media_type: job.media_type,
    session_id: job.session_id,
  };
}

function errorText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.error?.message || value.error || value.message || "";
}

export function resetStudio() {
  jobs.splice(0, jobs.length);
  media.clear();
}
