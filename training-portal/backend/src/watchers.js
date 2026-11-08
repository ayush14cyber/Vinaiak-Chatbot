// Watchers: pages and folders the portal keeps in sync with the web.
//
// - A file watcher follows a page. When the page's HTML changes, it is scraped and saved again.
// - A directory watcher follows the links inside part of a page, picked by a CSS selector. With
//   more levels, a list of lists: each next level's selector picks the links on the pages the
//   links the level above follows lead to, and the last level's links are the ones imported.
//   Those pages are only read for their links, through `webscrap`, never scraped. Each level
//   follows all its links, or as many as it's set to, from the top or the bottom. Each new link
//   among those is scraped and saved as a page in its folder; a link to a file, like a PDF or an
//   image, is saved as a link to it, which the save describes. An `http://` link that fails is
//   tried again over `https://`. The pages of its first links, or its last, as many as it's set to
//   watch, get file watchers of their own. A link that goes, or falls out of those it follows, has
//   its page deleted.
//
// A watcher is a row of `WATCHERS_TABLE`, keyed by its org and the id of the page or folder it
// keeps. The watcher Lambda runs them all every hour (`run`). Pages are fetched through
// `webscrap`, which renders them in Chromium first, so a client-rendered page has its content.
// Editing a file watcher's page by hand stops watching it. A directory watcher's pages can't be
// edited or deleted: it would import them again.

import { createHash } from "node:crypto";

import {
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { InvokeCommand } from "@aws-sdk/client-lambda";
import * as cheerio from "cheerio";
import { Media, escape } from "rag";
import { pathLooksLikeMedia } from "rag/media";
import { log } from "rag/log";

import { WATCHER_FUNCTION, WATCHERS_TABLE } from "./app.js";
import { owner as ownerOf } from "./callers.js";
import { BOOL, N, S, aws, conditionFailed, nowSecs, string } from "./dynamo.js";
import * as files from "./files.js";
import { ApiError, body, json, noContent, query } from "./http.js";
import { MAX_NEW_ID_BYTES, PART, SEP, bytes } from "./paths.js";
import * as orgs from "./orgs.js";
import * as scrape from "./scrape.js";
import { Snapshot } from "./snapshot.js";

/** `webscrap`'s function URL. It renders pages in Chromium, so their scripts have run. */
const WEBSCRAP_URL = "https://w7j2ouzoexsr4fqzfix767hx240nrypa.lambda-url.ap-south-1.on.aws/";
/** Pages per `webscrap` call. It opens 12 at a time in one browser, so this is two rounds. */
const BATCH = 24;
/** A call's pages take up to `webscrap`'s 30 s to load each, plus its 5 s for scripts. */
const WEBSCRAP_TIMEOUT_MS = 300_000;
/** `webscrap` calls at once. */
const BATCHES_AT_ONCE = 2;
/** Watchers of a batch handled at once, once their pages are fetched. */
const WATCHERS_AT_ONCE = 4;
/** Pages one directory watcher imports at once, each a Firecrawl scrape and a save. */
const IMPORTS_AT_ONCE = 2;
/** Links checked at once for whether they're files, each by a HEAD request if it looks like one. */
const MEDIA_CHECKS_AT_ONCE = 8;
/** Most links a directory watcher follows: each costs a scrape and a save. */
export const MAX_LINKS = 200;
/** Most pages a directory watcher reads for links besides its own, all its levels after the first together. */
export const MAX_LIST_PAGES = 50;
/** How long a run holds a watcher, so two runs never handle it at once: longer than a Lambda runs. */
const LEASE_SECS = 15 * 60;
/** Bytes kept free in a new page's id for a ` (n)` that makes it unique. */
export const SUFFIX_ROOM = 6;
/** Fewest bytes left for a new page's name in a directory watcher's folder. */
const MIN_NAME_BYTES = 24;

export const Kind = Object.freeze({ File: "file", Directory: "directory" });
const parseKind = (kind) => (kind === Kind.File || kind === Kind.Directory ? kind : null);

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** `items` mapped by `f`, at most `limit` at once, preserving result order. */
async function mapConcurrent(items, limit, f) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const at = next++;
      out[at] = await f(items[at], at);
    }
  });
  await Promise.all(workers);
  return out;
}

/** `chunks` of `size`. */
const chunks = (items, size) => {
  const out = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
};

/** A level of a directory watcher: `{selector, limit?, reverse}`. */
export const level = (selector, limit = null, reverse = false) => ({ selector, limit, reverse });

/**
 * A watcher's row. `links` is a `Map` of each link a directory watcher saw to the id of the page
 * made for it, `""` if it has none that's the watcher's. Times are Unix seconds.
 */
export class Watcher {
  constructor(id, kind, url, fields = {}) {
    this.id = id;
    this.kind = kind;
    this.url = url;
    this.levels = [];
    this.watchChanges = 0;
    this.watchReverse = false;
    this.links = new Map();
    this.htmlSha256 = null;
    this.markdownSha256 = null;
    this.page = null;
    this.content = null;
    this.checkedAt = null;
    this.changedAt = null;
    this.error = null;
    Object.assign(this, fields);
  }

  /** The watcher `item` stores, or `null`. */
  static of(item) {
    if (!item) return null;
    const str = (key) => (typeof item[key]?.S === "string" ? item[key].S : null);
    const num = (key) => {
      const n = item[key]?.N;
      if (n === undefined) return null;
      const v = Number.parseInt(n, 10);
      return Number.isFinite(v) && v >= 0 ? v : null;
    };
    const id = str("id");
    const kind = parseKind(str("kind") ?? "");
    const url = str("url");
    if (id === null || kind === null || url === null) return null;
    const links = new Map();
    for (const [u, page] of Object.entries(item.links?.M ?? {}).sort(([a], [b]) => cmp(a, b))) {
      if (typeof page?.S === "string") links.set(u, page.S);
    }
    let watchChanges = 0;
    if (item.watch_changes?.N !== undefined) watchChanges = Number.parseInt(item.watch_changes.N, 10) || 0;
    // A row from before counts: all its pages, or none.
    else if (item.watch_changes?.BOOL === true) watchChanges = MAX_LINKS;
    return new Watcher(id, kind, url, {
      levels: levelsOf(item),
      watchChanges,
      watchReverse: item.watch_reverse?.BOOL === true,
      links,
      htmlSha256: str("html_sha256"),
      markdownSha256: str("markdown_sha256"),
      page: snapshotOf(item, PAGE),
      content: snapshotOf(item, CONTENT),
      checkedAt: num("checked_at"),
      changedAt: num("changed_at"),
      error: str("error"),
    });
  }

  item(org) {
    const item = { org_id: S(org), id: S(this.id), kind: S(this.kind), url: S(this.url) };
    if (this.levels.length > 0) item.levels = levelsValue(this.levels);
    if (this.htmlSha256 !== null) item.html_sha256 = S(this.htmlSha256);
    if (this.markdownSha256 !== null) item.markdown_sha256 = S(this.markdownSha256);
    for (const [name, snapshot] of [[PAGE, this.page], [CONTENT, this.content]]) {
      if (snapshot) Object.assign(item, snapshotValues(name, snapshot));
    }
    if (this.checkedAt !== null) item.checked_at = N(this.checkedAt);
    if (this.changedAt !== null) item.changed_at = N(this.changedAt);
    if (this.error !== null) item.error = S(this.error);
    if (this.kind === Kind.Directory) {
      item.watch_changes = N(this.watchChanges);
      item.watch_reverse = BOOL(this.watchReverse);
      item.links = { M: Object.fromEntries([...this.links].map(([u, page]) => [u, S(page)])) };
    }
    return item;
  }

  /** A copy, with `fields` changed. */
  with(fields) {
    return new Watcher(this.id, this.kind, this.url, { ...this, links: new Map(this.links), ...fields });
  }
}

/** Compares strings by their UTF-8 bytes. */
const cmp = (a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

/** `levels` as stored: a list of maps. */
function levelsValue(levels) {
  return {
    L: levels.map((l) => {
      const map = { selector: S(l.selector), reverse: BOOL(l.reverse) };
      if (l.limit !== null && l.limit !== undefined) map.limit = N(l.limit);
      return { M: map };
    }),
  };
}

/**
 * A directory watcher's levels as `item` stores them. A row from before levels had a list of
 * `selectors`, or before that one `selector`, and a `limit` for the links it imports: its last
 * level's.
 */
function levelsOf(item) {
  const limit = (value) => {
    if (value?.N === undefined) return null;
    const n = Number.parseInt(value.N, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  if (Array.isArray(item.levels?.L)) {
    return item.levels.L.flatMap((value) => {
      const m = value?.M;
      if (!m || typeof m.selector?.S !== "string") return [];
      return [level(m.selector.S, limit(m.limit), m.reverse?.BOOL === true)];
    });
  }
  let selectors = [];
  if (Array.isArray(item.selectors?.L)) selectors = item.selectors.L.filter((s) => typeof s?.S === "string").map((s) => s.S);
  else if (typeof item.selector?.S === "string") selectors = [item.selector.S];
  const last = Math.max(selectors.length - 1, 0);
  return selectors.map((selector, at) => level(selector, at === last ? limit(item.limit) : null, false));
}

/** The attributes of a file watcher's snapshots: `page_shape`, `page_marks`, `page_lines`, and the same for `content`. */
const PAGE = "page";
const CONTENT = "content";

function snapshotOf(item, name) {
  const shape = item[`${name}_shape`]?.S;
  if (typeof shape !== "string") return null;
  const marksText = item[`${name}_marks`]?.S;
  const linesText = item[`${name}_lines`]?.S;
  let marks = [];
  if (typeof marksText === "string") {
    marks = marksText.split("\n");
    if (marks[marks.length - 1] === "") marks.pop();
    marks = marks.map((m) => (m.endsWith("\r") ? m.slice(0, -1) : m));
  }
  const lines = typeof linesText === "string" ? linesText.split(/\s+/u).filter(Boolean) : [];
  return new Snapshot(shape, marks, lines, []);
}

/** A snapshot's attributes. Its marks are one string, a line each; its lines' hashes one too. */
function snapshotValues(name, snapshot) {
  return {
    [`${name}_shape`]: S(snapshot.shape),
    [`${name}_marks`]: S(snapshot.marks.join("\n")),
    [`${name}_lines`]: S(snapshot.lines.join(" ")),
  };
}

const key = (org, id) => ({ org_id: S(org), id: S(id) });

/** Every item `command` pages through. */
async function allItems(app, make) {
  const items = [];
  let start;
  do {
    const out = await aws(() => app.dynamo.send(make(start)));
    items.push(...(out.Items ?? []));
    start = out.LastEvaluatedKey;
  } while (start);
  return items;
}

/** Every watcher of `org`. */
async function orgWatchers(app, org) {
  const items = await allItems(
    app,
    (start) =>
      new QueryCommand({
        TableName: WATCHERS_TABLE,
        KeyConditionExpression: "org_id = :o",
        ExpressionAttributeValues: { ":o": S(org) },
        ConsistentRead: true,
        ExclusiveStartKey: start,
      }),
  );
  return items.map(Watcher.of).filter(Boolean);
}

/** The id and kind of every watcher of `org`, and the pages its directory watchers made, for its tree. */
export async function kinds(app, org) {
  const items = await allItems(
    app,
    (start) =>
      new QueryCommand({
        TableName: WATCHERS_TABLE,
        KeyConditionExpression: "org_id = :o",
        ExpressionAttributeValues: { ":o": S(org) },
        ProjectionExpression: "id, #k, links",
        ExpressionAttributeNames: { "#k": "kind" },
        ConsistentRead: true,
        ExclusiveStartKey: start,
      }),
  );
  const out = items.flatMap((item) => {
    const kind = parseKind(string(item, "kind"));
    return kind ? [[string(item, "id"), kind]] : [];
  });
  const made = items.flatMap((item) =>
    Object.values(item.links?.M ?? {})
      .map((page) => page?.S)
      .filter((page) => typeof page === "string" && page.length > 0),
  );
  return [out, made];
}

/** The directory watcher that made the page `id`, if one did and keeps it. */
export function madeBy(watchers, id) {
  return watchers.find((w) => w.kind === Kind.Directory && [...w.links.values()].includes(id))?.id ?? null;
}

/** Refuses a hand edit or delete of a page a directory watcher made. */
export async function notMade(app, org, id) {
  const dir = madeBy(await orgWatchers(app, org), id);
  if (dir !== null) {
    throw ApiError.conflict(`the directory watcher \`${dir}\` keeps this page in sync with the web, so it can't be edited or deleted`);
  }
}

async function get(app, org, id) {
  const out = await aws(() =>
    app.dynamo.send(new GetItemCommand({ TableName: WATCHERS_TABLE, Key: key(org, id), ConsistentRead: true })),
  );
  return Watcher.of(out.Item);
}

/** Stores a new watcher; a conflict if `id` has one. */
async function putNew(app, org, watcher) {
  try {
    await app.dynamo.send(
      new PutItemCommand({ TableName: WATCHERS_TABLE, Item: watcher.item(org), ConditionExpression: "attribute_not_exists(org_id)" }),
    );
  } catch (e) {
    if (conditionFailed(e)) throw ApiError.conflict("this is watched already");
    throw ApiError.internal(e);
  }
}

/** Updates the watcher `id` with `expression`, unless it was stopped meanwhile. Whether it was there. */
async function update(app, org, id, expression, names = {}, values = {}) {
  try {
    await app.dynamo.send(
      new UpdateItemCommand({
        TableName: WATCHERS_TABLE,
        Key: key(org, id),
        UpdateExpression: expression,
        ConditionExpression: "attribute_exists(org_id)",
        ExpressionAttributeNames: Object.keys(names).length > 0 ? names : undefined,
        ExpressionAttributeValues: Object.keys(values).length > 0 ? values : undefined,
      }),
    );
    return true;
  } catch (e) {
    if (conditionFailed(e)) return false;
    throw ApiError.internal(e);
  }
}

/** Points the directory watcher `dir`'s link `url` at `page`, or forgets it (`null`). */
function setLink(app, org, dir, url, page) {
  if (page !== null) return update(app, org, dir, "SET links.#u = :p", { "#u": url }, { ":p": S(page) });
  return update(app, org, dir, "REMOVE links.#u", { "#u": url });
}

/** Holds the watcher `id` for this run, if no other run does: its row as it is now. */
async function claim(app, org, id) {
  const now = nowSecs();
  try {
    const out = await app.dynamo.send(
      new UpdateItemCommand({
        TableName: WATCHERS_TABLE,
        Key: key(org, id),
        UpdateExpression: "SET #r = :until",
        ConditionExpression: "attribute_exists(org_id) AND (attribute_not_exists(#r) OR #r < :now)",
        ExpressionAttributeNames: { "#r": "running_until" },
        ExpressionAttributeValues: { ":until": N(now + LEASE_SECS), ":now": N(now) },
        ReturnValues: "ALL_NEW",
      }),
    );
    return Watcher.of(out.Attributes);
  } catch (e) {
    if (conditionFailed(e)) return null;
    throw ApiError.internal(e);
  }
}

/** What a run found, stored as it releases the watcher. */
const found = (fields = {}) => ({ htmlSha256: null, page: null, content: null, changed: false, error: null, ...fields });

async function release(app, org, id, f) {
  const set = ["checked_at = :now"];
  const remove = ["running_until"];
  const values = { ":now": N(nowSecs()) };
  if (f.htmlSha256 !== null) {
    set.push("html_sha256 = :h");
    values[":h"] = S(f.htmlSha256);
  }
  // A file watcher from before snapshots keeps its hashes until it has them.
  if (f.page) {
    const v = snapshotValues(PAGE, f.page);
    set.push("page_shape = :ps", "page_marks = :pm", "page_lines = :pl");
    Object.assign(values, { ":ps": v.page_shape, ":pm": v.page_marks, ":pl": v.page_lines });
    remove.push("html_sha256");
  }
  if (f.content) {
    const v = snapshotValues(CONTENT, f.content);
    set.push("content_shape = :cs", "content_marks = :cm", "content_lines = :cl");
    Object.assign(values, { ":cs": v.content_shape, ":cm": v.content_marks, ":cl": v.content_lines });
    remove.push("markdown_sha256");
  }
  if (f.changed) set.push("changed_at = :now");
  if (f.error !== null) {
    set.push("#e = :e");
    values[":e"] = S(f.error);
  } else {
    remove.push("#e");
  }
  return update(app, org, id, `SET ${set.join(", ")} REMOVE ${remove.join(", ")}`, { "#e": "error" }, values);
}

// ---- what happens to watcher rows when files move, are edited or are deleted ----
//
// A change is `{remove: id}`, `{move: {from, to: Watcher}}`, or `{link: {dir, url, page}}`, a
// directory watcher's link pointing at another page, or at `""` once it isn't the watcher's.

/**
 * After a file or a folder moved, `newId` giving the new id of each id that moved (or `null`): the
 * watchers of moved files and folders move too, and links point at the new ids. A conflict, before
 * any file moves, if a watcher would move onto one that stays.
 */
export function moved(watchers, newId) {
  const changes = [];
  const staying = new Set(watchers.filter((w) => newId(w.id) === null).map((w) => w.id));
  for (const watcher of watchers) {
    const links = new Map(
      [...watcher.links].map(([url, page]) => [url, (page.length > 0 ? newId(page) : null) ?? page]),
    );
    const to = newId(watcher.id);
    if (to !== null) {
      if (staying.has(to)) throw ApiError.conflict(`a watcher has the id \`${to}\``);
      changes.push({ move: { from: watcher.id, to: watcher.with({ id: to, links }) } });
    } else {
      for (const [url, page] of links) {
        if (watcher.links.get(url) !== page) changes.push({ link: { dir: watcher.id, url, page } });
      }
    }
  }
  return changes;
}

/** After the file `id` was edited by hand: it isn't watched any more. */
export const edited = (watchers, id) => watchers.filter((w) => w.id === id).map((w) => ({ remove: w.id }));

/**
 * After the file `id` was deleted, or with `folder` the folder `id` with everything in it: their
 * watchers stop, and the directory watchers that stay forget those pages were theirs.
 */
export function deleted(watchers, id, folder) {
  const inside = `${id}${SEP}`;
  const gone = (path) => path === id || (folder && path.startsWith(inside));
  const changes = [];
  for (const watcher of watchers) {
    if (gone(watcher.id)) {
      changes.push({ remove: watcher.id });
      continue;
    }
    for (const [url, page] of watcher.links) {
      if (gone(page)) changes.push({ link: { dir: watcher.id, url, page: "" } });
    }
  }
  return changes;
}

/** Stopping the watcher `id`: a directory watcher's pages stop being watched too. */
export function stopped(watchers, id) {
  const changes = [{ remove: id }];
  const dir = watchers.find((w) => w.id === id && w.kind === Kind.Directory);
  if (dir) {
    const pages = new Set(dir.links.values());
    for (const w of watchers) if (w.kind === Kind.File && pages.has(w.id)) changes.push({ remove: w.id });
  }
  return changes;
}

async function apply(app, org, changes) {
  for (const change of changes) {
    if (change.remove !== undefined) {
      await aws(() => app.dynamo.send(new DeleteItemCommand({ TableName: WATCHERS_TABLE, Key: key(org, change.remove) })));
    } else if (change.move !== undefined) {
      const { from, to } = change.move;
      await orgs.transact(
        app,
        [
          { Put: { TableName: WATCHERS_TABLE, Item: to.item(org), ConditionExpression: "attribute_not_exists(org_id)" } },
          { Delete: { TableName: WATCHERS_TABLE, Key: key(org, from) } },
        ],
        "a watcher has the new id",
      );
    } else {
      const { dir, url, page } = change.link;
      await setLink(app, org, dir, url, page);
    }
  }
}

/** After the file `id` was saved by hand. */
export async function afterEdit(app, org, id) {
  await apply(app, org, edited(await orgWatchers(app, org), id));
}

/** After the file, or the folder, `id` was deleted. */
export async function afterDelete(app, org, id, folder) {
  await apply(app, org, deleted(await orgWatchers(app, org), id, folder));
}

/** Before the file, or the folder, `from` moves to `to`: the changes its watchers need, or a conflict. */
export async function planMove(app, org, from, to, folder) {
  const watchers = await orgWatchers(app, org);
  return moved(watchers, (id) => {
    if (!id.startsWith(from)) return null;
    const rest = id.slice(from.length);
    return rest.length === 0 || (folder && rest.startsWith(SEP)) ? `${to}${rest}` : null;
  });
}

/** Once the files moved. */
export const applyMove = (app, org, moves) => apply(app, org, moves);

// ---- webscrap ----

/** A file watcher's page: its header and footer, menus mostly, are left out of the check. */
const pageRequest = (url) => ({ url, header: false, footer: false });
/** A directory watcher's part of a page, which may be anywhere on it. */
const partRequest = (url, selector) => ({ url, selector, header: true, footer: true });
/** A watcher's own page: a directory watcher's as its first level's selector picks it. */
const requestOf = (w) => (w.kind === Kind.Directory && w.levels.length > 0 ? partRequest(w.url, w.levels[0].selector) : pageRequest(w.url));

/**
 * Each of `pages` as `webscrap` renders it, `{ok: {url, html, matches}}` or `{err: why}`, in
 * order: `BATCH` per call, `BATCHES_AT_ONCE` calls at once. Throws if `webscrap` itself failed.
 */
async function render(app, pages) {
  const batches = await mapConcurrent(chunks(pages, BATCH), BATCHES_AT_ONCE, (batch) => renderBatch(app, batch));
  return batches.flat();
}

async function renderBatch(app, pages) {
  const failed = (why) => ApiError.upstream(`couldn't fetch pages: ${why}`);
  let res;
  let text;
  try {
    res = await app.http(WEBSCRAP_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ raw_html: true, pages }),
      timeoutMs: WEBSCRAP_TIMEOUT_MS,
    });
    text = await res.text();
  } catch (e) {
    throw failed(e.message);
  }
  if (!res.ok) throw failed(`webscrap answered ${res.status} ${res.statusText}: ${text}`);
  let batch;
  try {
    batch = JSON.parse(text);
  } catch (e) {
    throw failed(e.message);
  }
  if (!Array.isArray(batch?.pages)) throw failed("missing field `pages`");
  if (batch.pages.length !== pages.length) throw failed("webscrap answered for other pages");
  return batch.pages.map((page) => {
    if (typeof page?.url === "string" && typeof page?.html === "string") {
      return { ok: { url: page.url, html: page.html, matches: Number.isInteger(page.matches) ? page.matches : 0 } };
    }
    if (typeof page?.error === "string") return { err: page.error };
    return { err: "webscrap answered a page it couldn't parse" };
  });
}

/** One page as `webscrap` renders it, for a person waiting. */
async function renderOne(app, page) {
  const [rendered] = await render(app, [page]);
  if (!rendered) throw pageError("no answer");
  if (rendered.err !== undefined) throw pageError(rendered.err);
  return rendered.ok;
}

/** Why `webscrap` couldn't render a page: a 400 when it's the selector or the URL. */
function pageError(error) {
  if (error.includes("is not a valid selector") || error.includes("Invalid URL")) return ApiError.badRequest(error);
  return ApiError.upstream(`couldn't read the page: ${error}`);
}

/**
 * The http(s) links in `html`, `{url, text}`, each once, in order, without their `#fragment`s.
 * `base`, the page's URL, resolves any that aren't absolute. Links to the page itself are left out.
 */
export function links(html, base) {
  const page = new URL(base);
  page.hash = "";
  const seen = new Set([page.href]);
  const $ = cheerio.load(html, null, false);
  const out = [];
  $("a[href]").each((_, a) => {
    let url;
    try {
      url = new URL($(a).attr("href").trim(), base);
    } catch {
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    url.hash = "";
    const href = url.href;
    if (seen.has(href)) return;
    seen.add(href);
    out.push({ url: href, text: $(a).text().split(/\s+/u).filter(Boolean).join(" ") });
  });
  return out;
}

/** `text` as a name: whitespace collapsed, and `|`, `~` and `#`, which ids keep for themselves, replaced. */
export const cleanName = (text) =>
  text.replaceAll("|", "/").replaceAll("~", "-").replaceAll("#", " ").split(/\s+/u).filter(Boolean).join(" ");

/** The name of the page for `link`: its text, or the last segment of its URL's path, or its host. */
export function pageName(link) {
  const name = cleanName(link.text);
  if (name.length > 0) return name;
  let url = null;
  try {
    url = new URL(link.url);
  } catch {}
  const segment = url?.pathname.split("/").reverse().find((s) => s.length > 0);
  let decoded = "";
  if (segment !== undefined) {
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      decoded = segment;
    }
  }
  const fromPath = cleanName(decoded);
  if (fromPath.length > 0) return fromPath;
  return cleanName(url?.hostname || "Page");
}

/** Most bytes for a page's name in `folder`, leaving room for a ` (n)`. */
export const nameRoom = (folder) => Math.max(MAX_NEW_ID_BYTES - (bytes(folder) + 1 + SUFFIX_ROOM), 0);

/** `text` cut to at most `max` UTF-8 bytes, at a character boundary. */
function cutBytes(text, max) {
  let out = "";
  let used = 0;
  for (const ch of text) {
    const b = bytes(ch);
    if (used + b > max) break;
    out += ch;
    used += b;
  }
  return out;
}

/**
 * An id for a new page named `name` in `folder`, that `taken` doesn't have, nor parts of: the name
 * cut to fit, then numbered ` (2)`, ` (3)`, ... if it's taken.
 */
export function freeId(folder, name, taken) {
  const cut = cutBytes(name, nameRoom(folder)).trimEnd();
  const free = (id) => {
    const parts = `${id}${PART}`;
    if (taken.has(id)) return false;
    for (const t of taken) if (t.startsWith(parts)) return false;
    return true;
  };
  const id = `${folder}${SEP}${cut}`;
  if (free(id)) return id;
  for (let n = 2; ; n++) {
    const numbered = `${folder}${SEP}${cut} (${n})`;
    if (free(numbered)) return numbered;
  }
}

/** The links a directory watcher found that it hasn't seen, and the ones it saw that went, with their pages. */
export function compare(seen, foundLinks) {
  const urls = new Set(foundLinks.map((l) => l.url));
  const fresh = foundLinks.filter((l) => !seen.has(l.url));
  const went = [...seen].filter(([url]) => !urls.has(url)).sort(([a], [b]) => cmp(a, b));
  return [fresh, went];
}

// ---- runs ----

/**
 * Runs the watchers `job` names (`{org?, id?}`; every watcher when empty), oldest checked first,
 * starting none after `stopAt` (ms since the epoch, or `null`); those left run next time.
 */
export async function run(app, job = {}, stopAt = null) {
  let watchers;
  try {
    watchers = await listed(app, job);
  } catch (e) {
    log.error({ error: e.message }, "couldn't list the watchers");
    return;
  }
  // Each org's owner, read once; `null` skips its watchers.
  const owners = new Map();
  const jobs = [];
  for (const [org, watcher] of watchers) {
    if (!owners.has(org)) {
      let owner = null;
      try {
        owner = await orgs.approvedOrg(app, org);
        if (!owner) log.warn({ org }, "its org isn't approved, so its watchers don't run");
      } catch (e) {
        log.error({ org, error: e.message }, "couldn't read the org");
      }
      owners.set(org, owner);
    }
    const owner = owners.get(org);
    if (owner) jobs.push([owner, watcher]);
  }
  const outcomes = (await mapConcurrent(chunks(jobs, BATCH), BATCHES_AT_ONCE, (batch) => runBatch(app, batch, stopAt))).flat();
  const changed = outcomes.filter((o) => o.kind === "Updated" || (o.kind === "Links" && o.imported + o.deleted > 0)).length;
  const failedCount = outcomes.filter((o) => o.kind === "Failed").length;
  // A run that found nothing logs nothing: it runs every hour.
  if (changed + failedCount > 0) {
    log.info({ watchers: jobs.length, run: outcomes.length, changed, failed: failedCount }, "watchers run");
  }
}

const past = (stopAt) => stopAt !== null && Date.now() >= stopAt;

/** Each watcher `job` names, with its org, oldest checked first. */
async function listed(app, job) {
  let watchers;
  if (job.org && job.id) {
    const w = await get(app, job.org, job.id);
    watchers = w ? [[job.org, w]] : [];
  } else if (job.org) {
    watchers = (await orgWatchers(app, job.org)).map((w) => [job.org, w]);
  } else {
    const items = await allItems(app, (start) => new ScanCommand({ TableName: WATCHERS_TABLE, ConsistentRead: true, ExclusiveStartKey: start }));
    watchers = items.flatMap((item) => {
      const w = Watcher.of(item);
      return w ? [[string(item, "org_id"), w]] : [];
    });
  }
  // Never checked first (`null` checkedAt before timestamps).
  return watchers.sort(([, a], [, b]) => (a.checkedAt ?? -1) - (b.checkedAt ?? -1));
}

/** Claims the watchers of a batch, fetches their pages in one `webscrap` call, then handles each. */
async function runBatch(app, batch, stopAt) {
  if (past(stopAt)) return [];
  const claimed = [];
  const outcomes = [];
  for (const [owner, watcher] of batch) {
    const [org, id] = [owner.org, watcher.id];
    try {
      const w = await claim(app, org, id);
      if (w) claimed.push([owner, w]);
      else {
        log.info({ org, id }, "another run has it, or it stopped");
        outcomes.push({ kind: "Busy" });
      }
    } catch (e) {
      log.warn({ org, id, error: e.message }, "couldn't claim the watcher");
      outcomes.push({ kind: "Failed", error: e.message });
    }
  }
  let rendered;
  try {
    rendered = await render(app, claimed.map(([, w]) => requestOf(w)));
  } catch (e) {
    rendered = claimed.map(() => ({ err: e.message }));
  }
  const runs = await mapConcurrent(claimed, WATCHERS_AT_ONCE, ([owner, w], at) => watch(app, owner, w, rendered[at], stopAt));
  return outcomes.concat(runs);
}

/** Handles one claimed watcher whose page was fetched, records what it found, and releases it. */
async function watch(app, owner, watcher, rendered, stopAt) {
  const org = owner.org;
  const id = watcher.id;
  let outcome;
  let f;
  try {
    [outcome, f] =
      watcher.kind === Kind.File ? await watchFile(app, owner, watcher, rendered) : await watchDirectory(app, owner, watcher, rendered, stopAt);
  } catch (e) {
    [outcome, f] = failed(e.message);
  }
  if (f) {
    try {
      await release(app, org, id, f);
    } catch (e) {
      outcome = { kind: "Failed", error: e.message };
    }
  }
  const url = watcher.url;
  // What found nothing logs nothing: every watcher runs every hour.
  switch (outcome.kind) {
    case "Failed":
      log.warn({ org, id, url, error: outcome.error }, "watcher failed");
      break;
    case "SameContent":
      log.info({ org, id, url, page_change: outcome.page }, "scraped, but its content is the same");
      break;
    case "Updated":
      log.info({ org, id, url, page_change: outcome.page, content_change: outcome.content }, "re-indexed");
      break;
    case "Stopped":
      log.info({ org, id }, "stopped: its page is gone, or it was stopped or edited meanwhile");
      break;
    case "Links": {
      const { kind, ...counts } = outcome;
      if (Object.values(counts).some((n) => n > 0)) log.info({ org, id, url, ...counts }, "links changed");
      break;
    }
    default:
  }
  return outcome;
}

/** A failure, stored on the watcher. */
const failed = (error) => [{ kind: "Failed", error }, found({ error })];

/**
 * A file watcher: when its page changed, other than by what moves on its own (see `Snapshot`), the
 * page is scraped, and saved if its content changed too. No row update for a watcher that stopped.
 */
async function watchFile(app, owner, watcher, rendered) {
  if (rendered.err !== undefined) return failed(`couldn't read the page: ${rendered.err}`);
  const r = rendered.ok;
  const now = nowSecs();
  let page;
  try {
    page = pageSnapshot(r);
  } catch (e) {
    return failed(e.message);
  }
  let pageChange;
  if (watcher.page) pageChange = page.changedFrom(watcher.page, now);
  // A watcher from before snapshots.
  else if (watcher.htmlSha256 !== null) pageChange = watcher.htmlSha256 !== sha256(r.html) ? "its HTML changed, before snapshots" : null;
  else pageChange = "it had no snapshot to compare with";
  if (pageChange === null) return [{ kind: "Unchanged" }, found({ page })];

  if (!(await files.isFile(app, owner.org, watcher.id))) {
    await apply(app, owner.org, [{ remove: watcher.id }]);
    return [{ kind: "Stopped" }, null];
  }
  const scraped = await scrapePage(app, owner, watcher.url);
  const content = Snapshot.ofMarkdown(scraped.markdown);
  let contentChange;
  if (watcher.content) contentChange = content.changedFrom(watcher.content, now);
  else if (watcher.markdownSha256 !== null)
    contentChange = watcher.markdownSha256 !== sha256(scraped.markdown) ? "its markdown changed, before snapshots" : null;
  else contentChange = "it had no snapshot to compare with";
  if (contentChange === null) return [{ kind: "SameContent", page: pageChange }, found({ page, content })];

  // A hand edit while the page was scraped stopped the watcher, and the edit stands.
  if (!(await get(app, owner.org, watcher.id))) return [{ kind: "Stopped" }, null];
  await files.save(app, owner, watcher.id, scraped.markdown, watcher.url);
  return [{ kind: "Updated", page: pageChange, content: contentChange }, found({ page, content, changed: true })];
}

/** A rendered page's snapshot. */
function pageSnapshot(rendered) {
  try {
    new URL(rendered.url);
  } catch (e) {
    throw new Error(`webscrap's URL: ${e.message}`);
  }
  return Snapshot.ofPage(rendered.html, rendered.url);
}

const scrapePage = (app, owner, url) => scrape.fetchPage(app, owner.keys.firecrawl(), url);

/**
 * Reads a directory watcher's levels down from `first`, its page as `levels[0]`'s selector matched
 * it: `{links, htmlSha256}`, the last level's links, all of them, and the SHA-256 of what every
 * level matched. A page that can't be read, or where its selector matches nothing, fails it all:
 * a list missing a part would delete that part's pages.
 */
async function list(app, first, levels) {
  let foundLinks = matchedLinks(first, () => "the selector matches nothing on the page; the page may have changed");
  const htmls = [first.html];
  const read = { count: 0 };
  // `at` counts from 0; messages, as a person numbers them, from 1.
  for (let at = 1; at < levels.length; at++) {
    const pages = nextPages(foundLinks, levels[at - 1], at, read);
    const rendered = await render(app, pages.map((p) => partRequest(p.url, levels[at].selector)));
    const onPages = [];
    pages.forEach((page, i) => {
      const r = rendered[i];
      if (r.err !== undefined) throw pageError(`${page.url} (level ${at + 1}): ${r.err}`);
      onPages.push(matchedLinks(r.ok, () => `the level ${at + 1} selector matches nothing on ${page.url}; the page may have changed`));
      htmls.push(r.ok.html);
    });
    foundLinks = merge(onPages);
  }
  return { links: foundLinks, htmlSha256: listingSha256(htmls) };
}

/** The links in what a selector matched on `rendered`, or a 400, `nothing()`, if it matched nothing. */
export function matchedLinks(rendered, nothing) {
  if (rendered.matches === 0) throw ApiError.badRequest(nothing());
  try {
    new URL(rendered.url);
  } catch (e) {
    throw ApiError.upstream(`webscrap answered a bad URL: ${e.message}`);
  }
  return links(rendered.html, rendered.url);
}

/**
 * The pages level `at` (from 0) reads for links: of the links the level `above` found, those it
 * follows, files left out first. `read.count` counts the pages read so far, up to `MAX_LIST_PAGES`.
 */
export function nextPages(foundLinks, above, at, read) {
  const pages = followed(foundLinks.filter((l) => !looksLikeMedia(l.url)), above.limit, above.reverse);
  if (pages.length === 0) throw ApiError.badRequest(`level ${at} finds no links to pages for level ${at + 1} to read`);
  read.count += pages.length;
  if (read.count > MAX_LIST_PAGES) {
    throw ApiError.badRequest(
      `by level ${at + 1}, it reads ${read.count} pages for links, over the ${MAX_LIST_PAGES} a watcher reads; narrow the selectors, or follow fewer links at the levels above`,
    );
  }
  return pages;
}

/** Whether `url`'s path looks like a file a model describes, a PDF or an image, by its extension. */
export function looksLikeMedia(url) {
  try {
    return pathLooksLikeMedia(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** The links found on each page of a level, in order, as one list: each link once, at its first place. */
export function merge(onPages) {
  const seen = new Set();
  return onPages.flat().filter((l) => !seen.has(l.url) && seen.add(l.url));
}

/** The SHA-256 of what each level matched; of one level's alone, as before levels. */
export const listingSha256 = (htmls) => (htmls.length === 1 ? sha256(htmls[0]) : sha256(htmls.join("\n")));

/**
 * Of the links a directory watcher's last level found, `all`, the ones it follows, as `last` limits
 * them: `[all, followed]`. Throws why there are none: a list that finds nothing is an error, not an
 * empty list, so a site redesign doesn't delete every page. The reason is a plain `Error`.
 */
export function foundLinks(all, last) {
  const out = last ? followed(all, last.limit, last.reverse) : [...all];
  if (out.length === 0) throw new Error("what the selector matches has no links");
  if (out.length > MAX_LINKS) throw new Error(tooMany(out.length));
  return [all, out];
}

/** What becomes of a link a directory watcher follows no more: `"Delete"`, `"Forget"` or `"Stay"`. */
export function gone(page, at) {
  if (page.length === 0) return at !== null && at !== undefined && at < MAX_LINKS ? "Stay" : "Forget";
  return "Delete";
}

/** The first `limit` of `found`, or the last if `reverse`, in their order; all if `null`. */
export function followed(list, limit, reverse) {
  if (limit !== null && limit !== undefined && list.length > limit) {
    return reverse ? list.slice(list.length - limit) : list.slice(0, limit);
  }
  return [...list];
}

/** `at`, a place in a list of `len`, counted from the end a limit reads from. */
export const fromEnd = (at, len, reverse) => (reverse ? len - 1 - at : at);

const tooMany = (n) => `the selectors find ${n} links, over the ${MAX_LINKS} a watcher follows; narrow them, or follow fewer`;

/** A directory watcher: its new links are imported as pages, and the pages of links that went are deleted. */
async function watchDirectory(app, owner, watcher, rendered, stopAt) {
  const org = owner.org;
  if (rendered.err !== undefined) return failed(`couldn't read the page: ${rendered.err}`);
  // Every level is read every run: a page further down can change while the ones above don't.
  let listing;
  try {
    listing = await list(app, rendered.ok, watcher.levels);
  } catch (e) {
    return failed(e.message);
  }
  const { htmlSha256 } = listing;
  if (watcher.htmlSha256 === htmlSha256) return [{ kind: "Unchanged" }, found()];
  const last = watcher.levels.at(-1) ?? null;
  let all;
  let follows;
  try {
    [all, follows] = foundLinks(listing.links, last);
  } catch (e) {
    return failed(e.message);
  }
  const [fresh, went] = compare(watcher.links, follows);
  const reverse = last?.reverse === true;
  const at = new Map(all.map((l, i) => [l.url, fromEnd(i, all.length, reverse)]));

  // Names are given before any import starts, so two new links can't take the same one.
  const taken = await files.takenIn(app, org, watcher.id);
  if (nameRoom(watcher.id) < MIN_NAME_BYTES) return failed("the folder's id is too long to name pages in it");
  const named = fresh.map((link) => {
    const id = freeId(watcher.id, pageName(link), taken);
    taken.add(id);
    return [link, id];
  });

  // The pages of the first links it follows, or the last, are watched for changes.
  const inFound = new Map(follows.map((l, i) => [l.url, i]));
  const first = (link) =>
    inFound.has(link.url) && fromEnd(inFound.get(link.url), follows.length, watcher.watchReverse) < watcher.watchChanges;
  const fileWatchers = new Set((await orgWatchers(app, org)).filter((w) => w.kind === Kind.File).map((w) => w.id));
  let [rewatch, unwatch] = rewatched(follows, watcher.links, [watcher.watchChanges, watcher.watchReverse], fileWatchers);
  // Files, like PDF notices, are described, and not watched: a file watcher reads HTML.
  const media = await mediaAmong(app, [...named.map(([l]) => l), ...rewatch.map(([l]) => l)]);
  rewatch = rewatch.filter(([l]) => !media.has(l.url));
  const watches = (link) => first(link) && !media.has(link.url);
  // A page that gets a file watcher starts from its snapshot, so its first check needn't scrape.
  const toWatch = [...named.map(([l]) => l).filter(watches), ...rewatch.map(([l]) => l)].map((l) => l.url);
  const snaps = await snapshots(app, toWatch);

  const imports = named.map(([link, id]) => {
    const page = snaps.get(link.url) ?? null;
    snaps.delete(link.url);
    return { link, id, watched: watches(link), media: media.get(link.url) ?? null, page };
  });
  const imported = await mapConcurrent(imports, IMPORTS_AT_ONCE, async (n) => {
    try {
      return { ok: await importPage(app, owner, watcher, n, stopAt) };
    } catch (e) {
      return { err: e.message };
    }
  });
  const errors = [];
  let [done, left, unreadable] = [0, 0, 0];
  for (const r of imported) {
    if (r.err !== undefined) errors.push(r.err);
    else if (r.ok === "Done") done++;
    else if (r.ok === "Left") left++;
    else unreadable++;
  }
  let deletedCount = 0;
  for (const [url, page] of went) {
    const where = at.has(url) ? at.get(url) : null;
    const what = gone(page, where);
    if (what === "Stay") continue;
    try {
      await removeLink(app, owner, watcher, url, page);
      if (what === "Delete") {
        deletedCount++;
        const why = where === null ? "it's no longer listed" : "it fell out of the limit";
        log.info({ org, id: watcher.id, page, url, why }, "deleted the page of a link");
      }
    } catch (e) {
      errors.push(`${url}: ${e.message}`);
    }
  }

  let watched = 0;
  if (rewatch.length > 0) {
    // Read again: a page deleted or renamed meanwhile isn't watched again.
    try {
      const nowRow = await get(app, org, watcher.id);
      if (nowRow) {
        for (const [link, page] of rewatch) {
          if (nowRow.links.get(link.url) !== page) continue;
          const file = new Watcher(page, Kind.File, link.url, { page: snaps.get(link.url) ?? null, checkedAt: nowSecs() });
          snaps.delete(link.url);
          try {
            await putNew(app, org, file);
            watched++;
          } catch (e) {
            if (!(e instanceof ApiError && e.status === 409)) errors.push(`${link.url}: ${e.message}`);
          }
        }
      }
    } catch (e) {
      errors.push(e.message);
    }
  }
  let unwatched = 0;
  for (const page of unwatch) {
    try {
      await apply(app, org, [{ remove: page }]);
      unwatched++;
    } catch (e) {
      errors.push(`${page}: ${e.message}`);
    }
  }

  const outcome = { kind: "Links", imported: done, deleted: deletedCount, left, unreadable, watched, unwatched };
  const changed = done + deletedCount > 0;
  if (errors.length > 0) {
    const error = `${errors.length} of the links failed; the first: ${errors[0]}`;
    const { kind, ...counts } = outcome;
    const debug = `Links { ${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(", ")} }`;
    return [{ kind: "Failed", error: `${debug}: ${error}` }, found({ changed, error })];
  }
  // Stored only once every link is done, so what's left or failed is tried again next run.
  return [outcome, found({ htmlSha256: left === 0 ? htmlSha256 : null, changed })];
}

/** Whether a page answering `status` will keep refusing: a client error, but not a timeout or a rate limit. */
export const refusesForGood = (status) => status >= 400 && status < 500 && status !== 408 && status !== 429;

/**
 * The pages of the links a directory watcher follows, `found`, that get a file watcher, being among
 * the first `count`, or the last if `reverse`, each `[link, page]`, and those whose file watcher
 * stops. `watched` has the ids of the org's file watchers. New links are left to `importPage`.
 */
export function rewatched(follows, seen, [count, reverse], watched) {
  const watch = [];
  const unwatch = [];
  follows.forEach((link, at) => {
    const page = seen.get(link.url);
    if (!page) return;
    const among = fromEnd(at, follows.length, reverse) < count;
    if (among && !watched.has(page)) watch.push([link, page]);
    else if (!among && watched.has(page)) unwatch.push(page);
  });
  return [watch, unwatch];
}

/** Of `links`, the files a model describes, by link URL, each with the file's URL: over https if only that answered. */
async function mediaAmong(app, list) {
  const checks = await mapConcurrent(list, MEDIA_CHECKS_AT_ONCE, async (link) => {
    for (const url of [link.url, overHttps(link.url)].filter(Boolean)) {
      if ((await Media.of(app.http, url)) !== null) return [link.url, url];
    }
    return null;
  });
  return new Map(checks.filter(Boolean));
}

/** `url` over https, if it's over http. */
export const overHttps = (url) => (url.startsWith("http://") ? `https://${url.slice("http://".length)}` : null);

/** The page at `url` scraped, and the URL that answered: over https if `url` is over http and failed. */
async function scrapeLink(app, owner, url) {
  try {
    return [await scrapePage(app, owner, url), url];
  } catch (error) {
    const https = overHttps(url);
    if (https === null) throw error;
    return [await scrapePage(app, owner, https), https];
  }
}

/** A file's page as saved: a link to the file at `url`, whose text the save replaces with the file's markdown. */
export const mediaPage = (text, url) => `[${escape(text)}](<${url}>)`;

/** The pages at `urls` as rendered now, by URL. Those that couldn't be are left out. */
async function snapshots(app, urls) {
  const out = new Map();
  if (urls.length === 0) return out;
  let rendered;
  try {
    rendered = await render(app, urls.map(pageRequest));
  } catch {
    return out;
  }
  urls.forEach((url, i) => {
    if (rendered[i].ok === undefined) return;
    try {
      out.set(url, pageSnapshot(rendered[i].ok));
    } catch {}
  });
  return out;
}

/** Imports a new link as a page of the directory watcher `dir`: `"Done"`, `"Left"` or `"Unreadable"`. */
async function importPage(app, owner, dir, { link, id, watched, media, page }, stopAt) {
  if (past(stopAt)) return "Left";
  const fail = (e) => new Error(`${link.url}: ${e.message}`);
  const isMedia = media !== null;
  let markdown;
  let source;
  if (isMedia) {
    [markdown, source] = [mediaPage(link.text, media), media];
  } else {
    try {
      const [scraped, from] = await scrapeLink(app, owner, link.url);
      [markdown, source] = [scraped.markdown, from];
    } catch (e) {
      // Remembered without a page, as a detached link is, so later runs don't scrape it again.
      if (e instanceof ApiError && e.pageStatus !== undefined && refusesForGood(e.pageStatus)) {
        try {
          await setLink(app, owner.org, dir.id, link.url, "");
        } catch (e2) {
          throw fail(e2);
        }
        log.info({ org: owner.org, id: dir.id, url: link.url, status: e.pageStatus }, "skipped a link whose page refuses");
        return "Unreadable";
      }
      throw fail(e);
    }
  }
  const content = Snapshot.ofMarkdown(markdown);
  try {
    // Stopped, or moved with its folder, while the page was scraped: `id` isn't its page any more.
    if (!(await get(app, owner.org, dir.id))) return "Left";
    await files.save(app, owner, id, markdown, source);
    log.info({ org: owner.org, id: dir.id, page: id, url: link.url, source, media: isMedia }, "imported a new link");
    if (watched) {
      const now = nowSecs();
      const w = new Watcher(id, Kind.File, source, { page, content, checkedAt: now, changedAt: now });
      try {
        await putNew(app, owner.org, w);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 409)) throw e;
      }
    }
    await setLink(app, owner.org, dir.id, link.url, id);
  } catch (e) {
    throw fail(e);
  }
  return "Done";
}

/** Forgets a link that went, deleting its page, its parts and its watcher if they're still the watcher's. */
async function removeLink(app, owner, dir, url, page) {
  if (page.length > 0) {
    const retriever = app.retriever(owner);
    const parts = await files.ids(app, owner.org, `${page}${PART}`);
    for (const id of [page, ...parts]) {
      let removed;
      try {
        removed = await retriever.removeDocument(id, owner.org);
      } catch (e) {
        throw files.indexFailure(e);
      }
      files.logDegraded([[id, removed]]);
    }
    const watchers = await orgWatchers(app, owner.org);
    await apply(app, owner.org, deleted(watchers, page, false));
  }
  await setLink(app, owner.org, dir.id, url, null);
}

// ---- routes ----

/** Refuses API keys: a watcher spends on the org's keys every hour, so a person sets it up. */
function signedIn(owner) {
  if (owner.byKey) throw ApiError.forbidden("an API key can't manage watchers; sign in to the portal");
}

/** `levels` as a request gives them, each `{selector, limit?, reverse?}`. */
function levelsIn(value) {
  if (!Array.isArray(value)) throw ApiError.unprocessable("Failed to deserialize the JSON body into the target type: `levels`: invalid type");
  return value.map((l) => {
    if (typeof l?.selector !== "string") {
      throw ApiError.unprocessable("Failed to deserialize the JSON body into the target type: `levels`: missing field `selector`");
    }
    return level(l.selector, limitIn(l.limit), l.reverse === true);
  });
}

function limitIn(limit) {
  if (limit === undefined || limit === null) return null;
  if (!Number.isInteger(limit) || limit < 0) throw ApiError.unprocessable("Failed to deserialize the JSON body into the target type: `limit`: invalid type");
  return limit;
}

/** `POST /watchers/links {url, levels}`: the links a directory watcher with them would find at its last level. */
export async function preview(app, req) {
  const owner = await ownerOf(app, req);
  signedIn(owner);
  const r = body(req, { url: "string", levels: "array" });
  const levels = checkLevels(levelsIn(r.levels), 0);
  const found = await linksAt(app, r.url, levels);
  return json({ links: found, max: MAX_LINKS });
}

/**
 * `levels` with their selectors trimmed, if a directory watcher can have them with `watchChanges`:
 * one level at least, each with a selector and following from 1 to `MAX_LINKS` links or all, and
 * watching as many pages as its last level follows at most.
 */
export function checkLevels(input, watchChanges) {
  const levels = input.map((l) => ({ ...l, selector: l.selector.trim() }));
  if (levels.length === 0 || levels.some((l) => l.selector.length === 0)) throw ApiError.badRequest("give a selector for each level");
  if (levels.some((l) => l.limit !== null && (l.limit < 1 || l.limit > MAX_LINKS))) {
    throw ApiError.badRequest(`follow from 1 to ${MAX_LINKS} links at each level, or all`);
  }
  const follows = levels.at(-1).limit ?? MAX_LINKS;
  if (watchChanges > follows) throw ApiError.badRequest(`watch from 0 to ${follows} pages for changes, as many as it follows at most`);
  return levels;
}

/** The links `levels`, checked, find at their last level from `url`, for a person choosing them. */
async function linksAt(app, url, levels) {
  if (!scrape.isWebUrl(url)) throw ApiError.badRequest("give an http or https URL");
  const rendered = await renderOne(app, partRequest(url, levels[0].selector));
  if (rendered.matches === 0) throw ApiError.badRequest("the selector matches nothing on the page");
  return (await list(app, rendered, levels)).links;
}

/**
 * `POST /watchers`: a file watcher (`{kind: "file", id, url}`), whose page is imported now
 * (`201 {ids}`), or a directory watcher (`{kind: "directory", id, url, levels, watch_changes?,
 * watch_reverse?}`), whose pages are imported by its first run, started now (`202 {links}`).
 */
export async function create(app, req) {
  const owner = await ownerOf(app, req);
  signedIn(owner);
  const raw = body(req, { kind: "string", id: "string", url: "string" });
  if (raw.kind === Kind.File) {
    return json({ ids: await createFile(app, owner, raw.id, raw.url) }, 201);
  }
  if (raw.kind !== Kind.Directory) {
    throw ApiError.unprocessable(`Failed to deserialize the JSON body into the target type: unknown variant \`${raw.kind}\`, expected \`file\` or \`directory\``);
  }
  const r = body(req, { levels: "array", watch_changes: "number?", watch_reverse: "bool?" });
  const count = await createDirectory(app, owner, raw.id, {
    url: raw.url,
    levels: levelsIn(r.levels),
    watchChanges: r.watch_changes ?? 0,
    watchReverse: r.watch_reverse,
  });
  await start(app, owner.org, raw.id);
  return json({ links: count }, 202);
}

async function createFile(app, owner, id, url) {
  owner.newNames(id);
  if (!scrape.isWebUrl(url)) throw ApiError.badRequest("give an http or https URL");
  if (await get(app, owner.org, id)) throw ApiError.conflict("this is watched already");
  if (await files.isFile(app, owner.org, id)) throw ApiError.conflict("a page has this id");
  await files.fits(app, owner.org, id, true);
  // `save` would replace them, and they aren't this page's. Checked before the scrape costs a credit.
  await files.noParts(app, owner.org, id);
  const rendered = await renderOne(app, pageRequest(url));
  let page;
  try {
    page = pageSnapshot(rendered);
  } catch (e) {
    throw ApiError.upstream(e.message);
  }
  const scraped = await scrapePage(app, owner, url);
  const content = Snapshot.ofMarkdown(scraped.markdown);
  const ids = await files.save(app, owner, id, scraped.markdown, url);
  const now = nowSecs();
  await putNew(app, owner.org, new Watcher(id, Kind.File, url, { page, content, checkedAt: now, changedAt: now }));
  return ids;
}

/** Stores a directory watcher with no links seen yet, and its folder: the number of links its first run will import. */
async function createDirectory(app, owner, id, { url, levels: given, watchChanges, watchReverse }) {
  owner.newNames(id);
  const levels = checkLevels(given, watchChanges);
  if (nameRoom(id) < MIN_NAME_BYTES) throw ApiError.badRequest("this id is too long to name pages in it");
  if (await get(app, owner.org, id)) throw ApiError.conflict("this is watched already");
  await files.fits(app, owner.org, id, false);
  if (await files.isFolder(app, owner.org, id)) throw ApiError.conflict("a folder has this id");
  const all = await linksAt(app, url, levels);
  let follows;
  try {
    [, follows] = foundLinks(all, levels.at(-1));
  } catch (e) {
    throw ApiError.badRequest(e.message);
  }
  await putNew(app, owner.org, new Watcher(id, Kind.Directory, url, { levels, watchChanges, watchReverse }));
  await files.keepFolder(app, owner.org, id);
  return follows.length;
}

/**
 * Starts the first run of the watcher `id`: on Lambda by invoking the watcher Lambda, which a
 * request couldn't wait for; elsewhere in the background. If it can't start, the hourly run still runs it.
 */
async function start(app, org, id) {
  if (process.env.AWS_LAMBDA_FUNCTION_NAME === undefined) {
    run(app, { org, id }, null).catch((e) => log.error({ org, id, error: e.message }, "the watcher's run failed"));
    return;
  }
  try {
    await app.lambda.send(
      new InvokeCommand({
        FunctionName: WATCHER_FUNCTION,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify({ org, id })),
      }),
    );
  } catch (e) {
    log.warn({ org, id, error: e.message }, "couldn't start the watcher");
  }
}

const notWatched = (id) => ApiError.notFound(`nothing is watched at \`${id}\``);

/** A watcher as the API shows it. */
export function details(w) {
  const directory = w.kind === Kind.Directory;
  const out = { id: w.id, kind: w.kind, url: w.url };
  if (w.levels.length > 0) {
    out.levels = w.levels.map((l) => {
      const shown = { selector: l.selector };
      if (l.limit !== null) shown.limit = l.limit;
      shown.reverse = l.reverse;
      return shown;
    });
  }
  if (directory) {
    // A row from before counts watches all its pages, as many as it follows at most.
    out.watch_changes = Math.min(w.watchChanges, w.levels.at(-1)?.limit ?? MAX_LINKS);
    out.watch_reverse = w.watchReverse;
    out.pages = [...w.links.values()].filter((p) => p.length > 0).length;
  }
  if (w.checkedAt !== null) out.checked_at = w.checkedAt;
  if (w.changedAt !== null) out.changed_at = w.changedAt;
  if (w.error !== null) out.error = w.error;
  return out;
}

/** `GET /watchers?id=`: a watcher. Reading spends nothing, so a key may. */
export async function read(app, req) {
  const owner = await ownerOf(app, req);
  const id = query(req, "id");
  owner.names(id);
  const w = await get(app, owner.org, id);
  if (!w) throw notWatched(id);
  return json(details(w));
}

/** Whether `next` follows more of the links at some level than `old`. */
export function loosens(old, next) {
  return old.some((o, i) => {
    const n = next[i];
    if (n === undefined || o.limit === null) return false;
    return n.limit === null || n.limit > o.limit;
  });
}

/**
 * `PUT /watchers {id, levels: [{limit?, reverse?}], watch_changes?, watch_reverse?}`: sets how many
 * links each level of a directory watcher follows, and how many of their pages it watches, then
 * runs it again now. A conflict while a run has it, as that run would undo the change.
 */
export async function edit(app, req) {
  const owner = await ownerOf(app, req);
  signedIn(owner);
  const s = body(req, { id: "string", levels: "array", watch_changes: "number?", watch_reverse: "bool?" });
  owner.names(s.id);
  const watcher = await get(app, owner.org, s.id);
  if (!watcher) throw notWatched(s.id);
  if (watcher.kind !== Kind.Directory || watcher.levels.length === 0) {
    throw ApiError.badRequest("a file watcher has nothing to set; stop watching its page to edit it");
  }
  if (s.levels.length !== watcher.levels.length) {
    throw ApiError.badRequest(`give how many links each of its ${watcher.levels.length} levels follows`);
  }
  const watchChanges = s.watch_changes ?? 0;
  const levels = checkLevels(
    watcher.levels.map((l, i) => level(l.selector, limitIn(s.levels[i]?.limit), s.levels[i]?.reverse === true)),
    watchChanges,
  );
  if (loosens(watcher.levels, levels)) {
    const all = await linksAt(app, watcher.url, levels);
    try {
      foundLinks(all, levels.at(-1));
    } catch (e) {
      throw ApiError.badRequest(e.message);
    }
  }

  const now = nowSecs();
  let out;
  try {
    out = await app.dynamo.send(
      new UpdateItemCommand({
        TableName: WATCHERS_TABLE,
        Key: key(owner.org, s.id),
        ConditionExpression: "attribute_exists(org_id) AND (attribute_not_exists(#r) OR #r < :now)",
        // What a row from before levels kept them in, removed.
        ExpressionAttributeNames: { "#r": "running_until", "#lv": "levels", "#l": "limit", "#s": "selector", "#ss": "selectors" },
        ExpressionAttributeValues: { ":now": N(now), ":lv": levelsValue(levels), ":w": N(watchChanges), ":wr": BOOL(s.watch_reverse) },
        ReturnValues: "ALL_NEW",
        // Without its hash, its run looks at its links again, though the list is as it was.
        UpdateExpression: "SET #lv = :lv, watch_changes = :w, watch_reverse = :wr REMOVE #l, #s, #ss, html_sha256",
      }),
    );
  } catch (e) {
    if (conditionFailed(e)) throw ApiError.conflict("it's being checked right now; try again in a few minutes");
    throw ApiError.internal(e);
  }
  const updated = Watcher.of(out.Attributes);
  if (!updated) throw ApiError.internal("the watcher's row didn't parse");
  await start(app, owner.org, s.id);
  return json(details(updated));
}

/** `DELETE /watchers?id=`: stops watching. The pages stay, and a directory watcher's folder too. */
export async function stop(app, req) {
  const owner = await ownerOf(app, req);
  signedIn(owner);
  const id = query(req, "id");
  owner.names(id);
  const watchers = await orgWatchers(app, owner.org);
  const watcher = watchers.find((w) => w.id === id);
  if (!watcher) throw notWatched(id);
  // Its directory watcher watches its first pages; how many is set there.
  const dir = madeBy(watchers, id);
  if (dir !== null) {
    throw ApiError.conflict(`the directory watcher \`${dir}\` watches this page as one of its first; set how many in its Edit`);
  }
  if (watcher.kind === Kind.Directory) await files.keepFolder(app, owner.org, id);
  await apply(app, owner.org, stopped(watchers, id));
  return noContent();
}
