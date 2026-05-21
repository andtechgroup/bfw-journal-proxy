// netlify/functions/bfw-journal.js

const DEFAULT_TARGET = "https://bonefidewealth.com/media-library?format=json";
const ALLOWED_HOSTS = new Set(["www.bonefidewealth.com", "bonefidewealth.com"]);
const REQUIRED_TAG = "Money Together";
const MAX_PAGES = 10;

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

function normalizeUrl(urlString, baseUrl) {
  return new URL(urlString, baseUrl).toString();
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

async function fetchJson(url) {
  const upstream = await fetch(url, {
    headers: {
      "User-Agent": "domoneytogether-netlify-proxy",
      "Accept": "application/json,text/plain,*/*",
    },
  });

  const text = await upstream.text();

  if (!upstream.ok) {
    throw new Error(`Upstream returned ${upstream.status}: ${text.slice(0, 200)}`);
  }

  return JSON.parse(text);
}

async function fetchAllCollectionPages(startUrl) {
  let currentUrl = startUrl;
  let pageCount = 0;
  let firstPage = null;
  const allItems = [];

  while (currentUrl && pageCount < MAX_PAGES) {
    if (!isAllowedTarget(currentUrl)) {
      throw new Error(`Blocked disallowed pagination URL: ${currentUrl}`);
    }

    const pageJson = await fetchJson(currentUrl);

    if (!firstPage) {
      firstPage = pageJson;
    }

    if (Array.isArray(pageJson.items)) {
      allItems.push(...pageJson.items);
    }

    const nextPageUrl = pageJson?.pagination?.nextPageUrl;

    currentUrl = nextPageUrl
      ? normalizeUrl(nextPageUrl, currentUrl)
      : null;

    pageCount += 1;
  }

  if (!firstPage) {
    throw new Error("No collection data returned from upstream.");
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
    return {
      statusCode: 502,
      headers: {
        ...corsHeaders(),
        "Content-Type": "text/plain",
      },
      body: `Proxy fetch failed: ${err?.message || String(err)}`,
    };
  }
};
