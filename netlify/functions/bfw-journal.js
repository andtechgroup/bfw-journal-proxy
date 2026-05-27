// netlify/functions/bfw-journal.js
const DEFAULT_TARGET = "https://bonefidewealth.com/media-library?format=json";
const ALLOWED_HOSTS = new Set(["www.bonefidewealth.com", "bonefidewealth.com"]);
const REQUIRED_TAG = "Money Together";
const MAX_PAGES = 10;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

// Realistic browser User-Agent prevents Squarespace from returning an HTML
// challenge page or default HTML to requests it doesn't recognize.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

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

function normalizeUrl(urlString, baseUrl) {
  const u = new URL(urlString, baseUrl);
  // Squarespace's pagination.nextPageUrl drops the ?format=json query param,
  // which causes the upstream to serve HTML instead of JSON. Restore it.
  u.searchParams.set("format", "json");
  return u.toString();
}

function hasRequiredTag(item) {
  return Array.isArray(item?.tags) &&
    item.tags.some(tag =>
      String(tag).trim().toLowerCase() === REQUIRED_TAG.toLowerCase()
    );
}

function removePagination(json) {
  const cleaned = { ...json };
  delete cleaned.pagination;
  return cleaned;
}

/**
 * Custom error class so we can preserve diagnostic context (URL, status,
 * preview of the body) all the way back to the handler for logging.
 */
class UpstreamError extends Error {
  constructor(message, ctx) {
    super(message);
    this.name = "UpstreamError";
    this.ctx = ctx || {};
  }
}

async function fetchJson(url) {
  let upstream;
  try {
    upstream = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        "Accept": "application/json,text/plain,*/*",
      },
      redirect: "follow",
    });
  } catch (e) {
    throw new UpstreamError("Network error reaching upstream", {
      url,
      cause: String(e),
    });
  }

  const contentType = upstream.headers.get("content-type") || "";
  const text = await upstream.text();

  if (!upstream.ok) {
    throw new UpstreamError(
      `Upstream returned HTTP ${upstream.status}`,
      {
        url,
        status: upstream.status,
        contentType,
        bodyPreview: text.slice(0, 300),
      }
    );
  }

  // Guard against Squarespace returning an HTML page when we expected JSON
  // (happens with bot UAs, IP blocks, or invalid URLs that render a 404 page
  // with a 200 status — yes, really).
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    throw new UpstreamError(
      "Upstream returned non-JSON content",
      {
        url,
        status: upstream.status,
        contentType,
        bodyPreview: text.slice(0, 300),
      }
    );
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new UpstreamError("Upstream returned malformed JSON", {
      url,
      status: upstream.status,
      contentType,
      bodyPreview: text.slice(0, 300),
      cause: String(e),
    });
  }
}

async function fetchAllCollectionPages(startUrl) {
  let currentUrl = startUrl;
  let pageCount = 0;
  let firstPage = null;
  const allItems = [];

  while (currentUrl && pageCount < MAX_PAGES) {
    if (!isAllowedTarget(currentUrl)) {
      throw new UpstreamError("Blocked disallowed pagination URL", { url: currentUrl });
    }
    const pageJson = await fetchJson(currentUrl);
    if (!firstPage) firstPage = pageJson;
    if (Array.isArray(pageJson.items)) allItems.push(...pageJson.items);

    const nextPageUrl = pageJson?.pagination?.nextPageUrl;
    currentUrl = nextPageUrl ? normalizeUrl(nextPageUrl, currentUrl) : null;
    pageCount += 1;
  }

  if (!firstPage) {
    throw new UpstreamError("No collection data returned from upstream", { url: startUrl });
  }

  const filteredItems = allItems.filter(hasRequiredTag);

  return {
    ...removePagination(firstPage),
    items: filteredItems,
    collection: {
      ...firstPage.collection,
      itemCount: filteredItems.length,
    },
  };
}

exports.handler = async (event) => {
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

  const target = event.queryStringParameters?.url || DEFAULT_TARGET;

  if (!isAllowedTarget(target)) {
    return {
      statusCode: 403,
      headers: corsHeaders(),
      body: "Forbidden",
    };
  }

  try {
    const json = await fetchAllCollectionPages(target);
    return {
      statusCode: 200,
      headers: {
        ...corsHeaders(),
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
      },
      body: JSON.stringify(json),
    };
  } catch (err) {
    // Log the full context to Netlify's function logs for debugging
    const ctx = err instanceof UpstreamError ? err.ctx : {};
    console.error("bfw-journal failure:", {
      message: err?.message || String(err),
      ...ctx,
    });

    // Return a structured JSON error so the client (and you, when curl'ing
    // the function) gets useful diagnostics instead of just a parse failure.
    return {
      statusCode: 502,
      headers: {
        ...corsHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        error: "Proxy fetch failed",
        message: err?.message || String(err),
        ...ctx,
      }),
    };
  }
};