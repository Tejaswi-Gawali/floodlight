// Floodlight cricket proxy (Cloudflare Worker).
// Needs: KV binding FLOODLIGHT_KV, secret CRICAPI_KEY (one key, or several separated by commas).
// Optional var CACHE_SECONDS (default 120).
// All visitors share one upstream fetch per CACHE_SECONDS, and nothing is fetched while nobody is watching.

const ALLOWED_ORIGIN = /^(https:\/\/tejaswi-gawali\.github\.io|http:\/\/localhost(:\d+)?|http:\/\/127\.0\.0\.1(:\d+)?)$/;

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN.test(origin) ? origin : "https://tejaswi-gawali.github.io",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Expose-Headers": "X-Floodlight-Cache, X-Floodlight-Fetched-At",
    "Vary": "Origin",
  };
}

function jsonResponse(request, body, status, cacheState, fetchedAt) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Floodlight-Cache": cacheState,
      "X-Floodlight-Fetched-At": String(fetchedAt || 0),
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(request) });

    const url = new URL(request.url);
    if (url.pathname !== "/cricket") {
      return jsonResponse(request, { status: "failure", message: "Not found" }, 404, "NONE", 0);
    }

    const ttlMs = (parseInt(env.CACHE_SECONDS || "120", 10) || 120) * 1000;
    const now = Date.now();
    const stored = await env.FLOODLIGHT_KV.get("cricket", "json");

    // attemptedAt (not fetchedAt) gates retries, so a quota-exceeded upstream isn't hammered on every visit
    if (stored && stored.body && now - stored.attemptedAt < ttlMs) {
      return jsonResponse(request, stored.body, 200, "HIT", stored.fetchedAt);
    }

    // CRICAPI_KEY may hold several keys separated by commas/spaces; start from the last one that worked
    const keys = String(env.CRICAPI_KEY || "").split(/[\s,;]+/).filter(Boolean);
    const startIdx = stored && Number.isInteger(stored.keyIdx) ? stored.keyIdx % Math.max(keys.length, 1) : 0;
    let fresh = null, keyIdx = startIdx;
    for (let i = 0; i < keys.length && !fresh; i++) {
      keyIdx = (startIdx + i) % keys.length;
      try {
        const upstream = await fetch(
          "https://api.cricapi.com/v1/currentMatches?apikey=" + encodeURIComponent(keys[keyIdx]) + "&offset=0"
        );
        const data = await upstream.json();
        if (data && data.status === "success") fresh = data;
      } catch (e) {}
    }

    const next = {
      body: fresh || (stored && stored.body) || null,
      fetchedAt: fresh ? now : (stored ? stored.fetchedAt : 0),
      attemptedAt: now,
      keyIdx: fresh ? keyIdx : startIdx,
    };
    ctx.waitUntil(env.FLOODLIGHT_KV.put("cricket", JSON.stringify(next)));

    if (!next.body) {
      return jsonResponse(request, { status: "failure", message: "Live cricket feed unavailable right now" }, 502, "MISS", 0);
    }
    return jsonResponse(request, next.body, 200, fresh ? "MISS" : "STALE", next.fetchedAt);
  },
};
