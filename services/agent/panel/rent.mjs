// Proxy for the gateway's /v1/rent/* routes. The browser never sees a provider key.
// The node strips body `confirm` and `X-Wckd-Confirm`. A create is real only when this
// proxy adds `invincible-confirmed: 1`. Without that header the node returns 409 and
// provisions nothing. This process never adds the header unless the operator confirmed.

const RENT_OFF = "GPU rental not connected on this node";
const EU = new Set(["EU", "EU-secure"]);

function missing(result) {
  return !result || result.status === 0 || result.status === 404 || result.status === 405;
}

function regionsOf(input) {
  let list = input;
  if (typeof list === "string") list = list.split(",").map((part) => part.trim()).filter(Boolean);
  if (list == null || list === "") list = ["EU"];
  if (!Array.isArray(list) || list.length === 0) list = ["EU"];
  if (list.length !== 1 || !EU.has(list[0])) {
    return { error: "GPU rental stays in the EU. Choose EU or EU-secure." };
  }
  return { regions: list };
}

function hoursOf(value) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) return null;
  return hours;
}

function publicSession(session) {
  if (!session || typeof session !== "object" || Array.isArray(session)) return session;
  const copy = { ...session };
  if (Array.isArray(session.endpoints)) {
    copy.endpoints = session.endpoints.map((endpoint) => ({
      name: typeof endpoint?.name === "string" ? endpoint.name : "endpoint",
      ready: Boolean(endpoint?.url),
    }));
  }
  return copy;
}

function publicRent(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(publicRent);
  const copy = { ...value };
  if (copy.session) copy.session = publicSession(copy.session);
  if (Array.isArray(copy.sessions)) copy.sessions = copy.sessions.map(publicSession);
  if (Array.isArray(copy.endpoints) || typeof copy.phase === "string") return publicSession(copy);
  return copy;
}

function readJson(text) {
  const raw = text && String(text).trim() ? String(text) : "{}";
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "the body must be a JSON object" };
    return { value };
  } catch {
    return { error: "the body is not JSON" };
  }
}

export function createRent({ upstream, safely, scrub, json, readBody }) {
  return async function rent(url, request, response) {
    if (!url.pathname.startsWith("/api/rent")) return false;

    if (url.pathname === "/api/rent/health" && request.method === "GET") {
      const result = await safely("/v1/rent/health");
      if (missing(result)) return json(response, 200, { connected: false, message: RENT_OFF });
      return json(response, result.status, { connected: result.status === 200, ...(scrub(result.value) || {}) });
    }

    if (url.pathname === "/api/rent/offers" && request.method === "GET") {
      const preset = String(url.searchParams.get("preset") || "").trim();
      const hours = hoursOf(url.searchParams.get("hours"));
      const regions = regionsOf(url.searchParams.get("require_regions"));
      if (!preset) return json(response, 400, { error: "preset is required" });
      if (!hours) return json(response, 400, { error: "hours must be greater than 0 and at most 24" });
      if (regions.error) return json(response, 400, { error: regions.error });
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 20)));
      const query = new URLSearchParams({
        preset,
        hours: String(hours),
        limit: String(limit),
        require_regions: regions.regions.join(","),
      });
      const result = await safely(`/v1/rent/offers?${query}`);
      if (missing(result)) return json(response, 200, { connected: false, message: RENT_OFF, offers: [] });
      const value = scrub(result.value) || {};
      return json(response, result.status, { connected: true, ...value });
    }

    if (url.pathname === "/api/rent/sessions" && request.method === "GET") {
      const result = await safely("/v1/rent/sessions");
      if (missing(result)) return json(response, 200, { connected: false, message: RENT_OFF, sessions: [] });
      const value = publicRent(scrub(result.value) || {});
      return json(response, result.status, { connected: true, ...value });
    }

    if (url.pathname === "/api/rent/sessions" && request.method === "POST") {
      const parsed = readJson(await readBody(request, 64 * 1024));
      if (parsed.error) return json(response, 400, { error: parsed.error });
      const payload = parsed.value;
      const preset = String(payload.preset_id || "").trim();
      const hours = hoursOf(payload.hours);
      const regions = regionsOf(payload.require_regions);
      const project = String(payload.project_id || "panel").trim().slice(0, 80);
      if (!preset) return json(response, 400, { error: "preset_id is required" });
      if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(preset)) return json(response, 400, { error: "preset_id is not valid" });
      if (!hours) return json(response, 400, { error: "hours must be greater than 0 and at most 24" });
      if (regions.error) return json(response, 400, { error: regions.error });
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(project)) return json(response, 400, { error: "project_id is not valid" });
      const confirm = payload.confirm === true;
      const offer = payload.offer_id ? String(payload.offer_id).slice(0, 200) : "";
      const body = {
        project_id: project,
        preset_id: preset,
        hours,
        confirm,
        require_regions: regions.regions,
      };
      if (offer) body.offer_id = offer;
      const headers = { "Content-Type": "application/json" };
      // The node ignores body confirm. Only this header authorises a create.
      if (confirm) headers["invincible-confirmed"] = "1";
      let result;
      try {
        result = await upstream("/v1/rent/sessions", {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          timeout: 120_000,
        });
      } catch (error) {
        return json(response, 502, { error: String(error.message || error) });
      }
      if (missing(result)) return json(response, 503, { connected: false, message: RENT_OFF });
      const value = publicRent(scrub(result.value) || {});
      return json(response, result.status, value);
    }

    const one = url.pathname.match(/^\/api\/rent\/sessions\/([^/]+)$/);
    if (one && request.method === "GET") {
      const id = decodeURIComponent(one[1]);
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) return json(response, 400, { error: "not a session id" });
      const result = await safely(`/v1/rent/sessions/${encodeURIComponent(id)}`);
      if (missing(result)) return json(response, 503, { connected: false, message: RENT_OFF });
      return json(response, result.status, publicRent(scrub(result.value)));
    }

    const stop = url.pathname.match(/^\/api\/rent\/sessions\/([^/]+)\/stop$/);
    if (stop && request.method === "POST") {
      const id = decodeURIComponent(stop[1]);
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) return json(response, 400, { error: "not a session id" });
      const parsed = readJson(await readBody(request, 4096));
      if (parsed.error) return json(response, 400, { error: parsed.error });
      const force = parsed.value.force === true;
      let result;
      try {
        result = await upstream(`/v1/rent/sessions/${encodeURIComponent(id)}/stop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force }),
          timeout: 180_000,
        });
      } catch (error) {
        return json(response, 502, { error: String(error.message || error) });
      }
      if (missing(result)) return json(response, 503, { connected: false, message: RENT_OFF });
      return json(response, result.status, publicRent(scrub(result.value)));
    }

    return json(response, 404, { error: "no such endpoint" });
  };
}

export { RENT_OFF };
