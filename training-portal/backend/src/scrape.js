// A web page as markdown, through Firecrawl, for the user to edit and save as a file.

import { owner as ownerOf } from "./callers.js";
import { ApiError, json, query, statusText } from "./http.js";

const FIRECRAWL_SCRAPE = "https://api.firecrawl.dev/v2/scrape";
/** Firecrawl's own default page timeout is 60 s. */
const TIMEOUT_MS = 90_000;

/** `GET /scrape?url=`: the page's main content as markdown. Nothing is saved. */
export async function scrape(app, req) {
  const o = await ownerOf(app, req);
  const url = query(req, "url");
  return json(await fetchPage(app, o.keys.firecrawl(), url));
}

/** Whether `url` is an http or https URL. */
export function isWebUrl(url) {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** The main content of the page at `url`, through Firecrawl on `key`: `{markdown, title?, source}`. */
export async function fetchPage(app, key, url) {
  if (!isWebUrl(url)) throw ApiError.badRequest("give an http or https URL");
  let res;
  try {
    res = await app.http(FIRECRAWL_SCRAPE, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
      timeoutMs: TIMEOUT_MS,
    });
  } catch (e) {
    throw ApiError.upstream(`Firecrawl failed: ${e.message}`);
  }
  const reply = await res.json().catch(() => ({ success: false }));
  if (!res.ok || reply?.success !== true) {
    const message = `Firecrawl answered ${statusText(res.status)}: ${reply?.error ?? "no reason given"}`;
    if (res.status === 401 || res.status === 402) throw ApiError.providerKey("Firecrawl", res.status);
    if (res.status === 429) throw ApiError.rateLimited(message);
    if (res.status === 400) throw ApiError.badRequest(message);
    throw ApiError.upstream(message);
  }
  const data = reply.data;
  if (!data) throw ApiError.upstream("Firecrawl returned no page");
  const metadata = data.metadata ?? {};
  if (Number.isInteger(metadata.statusCode) && metadata.statusCode >= 400) throw ApiError.pageStatus(metadata.statusCode);
  const markdown = typeof data.markdown === "string" ? data.markdown : "";
  if (markdown.trim().length === 0) throw ApiError.upstream("the page has no text");
  // A string, or a list when the page declares several.
  const title = typeof metadata.title === "string" ? metadata.title : Array.isArray(metadata.title) ? metadata.title.find((t) => typeof t === "string") : undefined;
  const out = { markdown };
  if (title !== undefined) out.title = title;
  out.source = typeof metadata.url === "string" ? metadata.url : url;
  return out;
}
