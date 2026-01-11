// netlify/functions/bfw-journal.js

const DEFAULT_TARGET = "https://www.bonefidewealth.com/media-library?format=json";
const ALLOWED_HOSTS = new Set(["www.bonefidewealth.com", "bonefidewealth.com"]);

// If you want to lock this down, set this in Netlify env vars:
// ALLOWED_ORIGIN=https://domoneytogether.com
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Vary": "Origin",
  };
}

function isAllowedTarget(urlString) {
  try {
    const u = new URL(urlString);
    return ALLOWED_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

function rewriteNextPageUrl(json, proxyBaseUrl) {
  // Squarespace JSON usually has: json.pagination.nextPageUrl
  const next = json?.pagination?.nextPageUrl;
  if (!next) return json;

  // Route nextPageUrl back through this proxy via ?url=...
  const proxied = `${proxyBaseUrl}?url=${encodeURIComponent(next)}`;
  return {
    ...json,
    pagination: {
      ...json.pagination,
      nextPageUrl: proxied,
    },
  };
}

exports.handler = async (event) => {
  // Handle preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        ...corsHeaders(),
        "Cache-Control": "public, max-age=86400",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: corsHeaders(),
      body: "Method Not Allowed",
    };
  }

  // Allow pagination passthrough: /.netlify/functions/bfw-journal?url=<nextPageUrl>
  const target = event.queryStringParameters?.url || DEFAULT_TARGET;

  if (!isAllowedTarget(target)) {
    return {
      statusCode: 403,
      headers: corsHeaders(),
      body: "Forbidden",
    };
  }

  try {
    const upstream = await fetch(target, {
      headers: {
        // Helps some origin servers respond consistently
        "User-Agent": "domoneytogether-netlify-proxy",
        "Accept": "application/json,text/plain,*/*",
      },
    });

    const text = await upstream.text();

    // If upstream isn't JSON for some reason, pass through for debugging
    let body = text;
    let contentType = upstream.headers.get("content-type") || "application/json";

    // Attempt JSON parse and rewrite pagination URLs
    try {
      const parsed = JSON.parse(text);

      // Build absolute proxy URL for rewriting pagination
      // event.rawUrl exists in Netlify runtime; fallback to host header.
      const host =
        event.headers["x-forwarded-host"] ||
        event.headers.host ||
        "localhost:8888";

      const proto = event.headers["x-forwarded-proto"] || "https";
      const proxyBaseUrl = `${proto}://${host}/.netlify/functions/bfw-journal`;

      const rewritten = rewriteNextPageUrl(parsed, proxyBaseUrl);
      body = JSON.stringify(rewritten);
      contentType = "application/json";
    } catch {
      // ignore parse error and return raw text
    }

    return {
      statusCode: upstream.status,
      headers: {
        ...corsHeaders(),
        "Content-Type": contentType,
        // Cache for 5 minutes (tweak as desired)
        "Cache-Control": "public, max-age=300",
      },
      body,
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: corsHeaders(),
      body: `Upstream fetch failed: ${err?.message || String(err)}`,
    };
  }
};