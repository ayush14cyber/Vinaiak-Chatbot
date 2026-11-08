import { API_URL } from "./config";
import { signedOut } from "./session";

/** A failed call: the HTTP status, and the backend's `{"error": ...}` message. */
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * @typedef {{
 *   email: string;
 *   admin: boolean;
 *   status: "none" | "pending" | "approved";
 *   org?: { org_id: string; org_name: string };
 *   // Pending as a request to join `org`, rather than to create it.
 *   joining?: boolean;
 *   // Approved, the folders the account may change: `""` is the whole org.
 *   folders?: string[];
 * }} Me
 */

/**
 * @typedef {{ available: boolean; reason?: string }} Availability
 */

/**
 * @typedef {{
 *   org_id: string;
 *   org_name: string;
 *   owner_email: string;
 *   // Unix seconds.
 *   requested_at: number;
 * }} RegistrationRequest
 */

/**
 * @typedef {{
 *   org_id: string;
 *   org_name: string;
 *   owner_email: string;
 *   // Unix seconds.
 *   approved_at: number;
 *   // Whether it has each provider's key. The keys themselves are never sent back.
 *   openrouter_key: boolean;
 *   firecrawl_key: boolean;
 *   mongodb_key: boolean;
 *   // The sites its chatbot may be embedded on, as origins like `https://example.org`.
 *   chatbot_origins: string[];
 * }} ApprovedOrg
 */

/**
 * An org's own keys, which its models, imports and reranking bill to. A key left out stays as it
 * is.
 * @typedef {{
 *   openrouter_key?: string;
 *   firecrawl_key?: string;
 *   mongodb_key?: string;
 * }} ProviderKeys
 */

/**
 * An org's admin, or an account waiting to join an org (no `folders` yet).
 * @typedef {{
 *   email: string;
 *   org_id: string;
 *   org_name: string;
 *   // The folders they may change: `""` is the whole org.
 *   folders?: string[];
 *   // Unix seconds.
 *   requested_at: number;
 * }} OrgAdmin
 */

/**
 * What a watcher keeps in sync with the web: a page, or a folder of the pages a list links to.
 * @typedef {"file" | "directory"} WatcherKind
 */

/**
 * A topic: a file when `file`, else a folder. `watcher` when
 * the portal keeps it in sync with the web. `by_watcher` when a directory watcher made the page,
 * which then can't be edited. `outside` when it's above the admin's folders, shown only as the path
 * to them, and `assigned` when it's one of them, which can't be renamed or deleted.
 * @typedef {{
 *   name: string;
 *   file: boolean;
 *   watcher?: WatcherKind;
 *   by_watcher?: boolean;
 *   outside?: boolean;
 *   assigned?: boolean;
 *   children: TreeNode[];
 * }} TreeNode
 */

/**
 * How many of the links a level of a directory watcher finds, all its pages together, it follows:
 * the first `limit`, or the last when `reverse`; all when `limit` is absent. A level's links lead
 * to the pages the next level reads; the last level's become pages, and a page whose link falls
 * out of them is deleted.
 * @typedef {{ limit?: number; reverse: boolean }} LevelLimit
 */

/**
 * A level of a directory watcher: the part of each of its pages the links are in, and its limit.
 * @typedef {LevelLimit & { selector: string }} WatcherLevel
 */

/**
 * How many of the pages of the links a directory watcher follows it watches for changes too: the
 * first `watch_changes`, or the last when `watch_reverse`; none when 0.
 * @typedef {{ watch_changes: number; watch_reverse: boolean }} Watching
 */

/**
 * What can change of a directory watcher: each of its levels' limits, in order, and its watching.
 * @typedef {Watching & { levels: LevelLimit[] }} WatcherSettings
 */

/**
 * A watcher, as its topic shows it. Times are Unix seconds.
 * @typedef {{
 *   id: string;
 *   kind: WatcherKind;
 *   url: string;
 *   // A directory watcher's: the part of the page its links are in, then of each page those links
 * // lead to, level by level. The last level's links are the ones it imports.
 *   levels?: WatcherLevel[];
 *   // A directory watcher's: how many of its pages are watched too, from the top or the bottom.
 *   watch_changes?: number;
 *   watch_reverse?: boolean;
 *   // A directory watcher's pages.
 *   pages?: number;
 *   checked_at?: number;
 *   changed_at?: number;
 *   // Why its last check failed.
 *   error?: string;
 * }} Watcher
 */

/**
 * A link a directory watcher would follow.
 * @typedef {{ url: string; text: string }} WatchedLink
 */

/**
 * @typedef {{ id: string; markdown: string; source?: string }} FileDoc
 */

/**
 * @typedef {{ markdown: string; title?: string; source: string }} Scraped
 */

/**
 * A page to save. With `force_override`, a hand edit, an image or PDF the saved page links to
 * already keeps the text typed for it; without, it gets its saved description back.
 * @typedef {{
 *   id: string;
 *   markdown: string;
 *   source?: string;
 *   force_override?: boolean;
 * }} FileUpload
 */

/**
 * The ids indexed: the file, then its parts if it was too long to index as one.
 * @typedef {{ ids: string[] }} Indexed
 */

/** The types a page can upload: those a save reads and describes. */
export const UPLOAD_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];
/** The largest upload, as the backend allows: the largest PDF a save reads. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Where to `PUT` a file, with the headers signed for it, and the public URL to link it by once it's
 * there. Only the file's type and size, as asked for, are taken, and its page's tag.
 * @typedef {{ url: string; headers: Record<string, string>; public_url: string }} PresignedUpload
 */

/**
 * An API key, without the key itself: that's shown once, when it's created.
 * @typedef {{
 *   // Names the key, to revoke it.
 *   id: string;
 *   name: string;
 *   // The key's first characters, to tell keys apart.
 *   prefix: string;
 *   // Who made it: it may change only their folders.
 *   email: string;
 *   // Unix seconds.
 *   created_at: number;
 * }} ApiKey
 */

/**
 * A key just created, with the key.
 * @typedef {ApiKey & { key: string }} NewKey
 */

/**
 * What the org's chatbot couldn't find in its documents during one conversation, as its model
 * reported it, with the conversation up to the latest report.
 * @typedef {{
 *   session_id: string;
 *   items: string[];
 *   // What the visitor asked and the chatbot replied, in markdown.
 *   conversation: { role: "user" | "assistant"; text: string }[];
 *   // Unix seconds of the latest report.
 *   reported_at: number;
 * }} DataNotFound
 */

/**
 * The colours of the chatbot an org's owner can change, by the widget's own names.
 * @typedef {"heading" | "user-box" | "bot-box" | "box-border" | "link" | "option"} ChatbotColor
 */

/**
 * How an org's chatbot looks on its sites. An empty setting keeps the widget's default.
 * @typedef {{
 *   title: string;
 *   placeholder: string;
 *   // Image addresses, `https://` only.
 *   avatar: string;
 *   launcher_icon: string;
 *   // The chatbot's first message, in markdown.
 *   greeting: string;
 *   hide_watermark: boolean;
 *   // `#rrggbb` colours; one left out keeps the widget's.
 *   colors: Partial<Record<ChatbotColor, string>>;
 * }} ChatbotWidget
 */

/**
 * @typedef {{
 *   widget: ChatbotWidget;
 *   // Whether it was ever saved: until then, nothing is at `link_url`.
 *   published: boolean;
 *   // The script each page of the org's sites embeds, which loads the chatbot as saved.
 *   link_url: string;
 *   // The sites it may be embedded on, as origins, which the portal's admin sets.
 *   origins: string[];
 * }} Chatbot
 */

/**
 * A failure in a `200`'s body. A call still running after 90 s answers `200` at once, so the
 * proxy in front of the API doesn't give up on it, and its error comes later, in the body.
 * @typedef {{ error: string; status: number }} LateFailure
 */

function isLateFailure(data) {
  const failure = data;
  return typeof failure?.error === "string" && typeof failure.status === "number";
}

/** `text` as JSON, or `undefined` if it isn't. */
function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const OPENED_ORG = "vinaiak-opened-org";

/** The org the master admin opened, to act as its admin, if any. Kept for this tab only. */
export function openedOrg() {
  try {
    return sessionStorage.getItem(OPENED_ORG);
  } catch {
    return null;
  }
}

/** Opens `org` as its admin, for the master admin, or with `null` closes it. */
export function openOrg(org) {
  try {
    if (org) sessionStorage.setItem(OPENED_ORG, org);
    else sessionStorage.removeItem(OPENED_ORG);
  } catch {}
  // Another org's pages mustn't show from the cache.
  pages.clear();
}

/**
 * Calls the API. The browser sends the session cookie itself. As `org`, or the opened org, the
 * master admin acts as that org's admin.
 */
async function call(method, path, body, org) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  const opened = org ?? openedOrg();
  if (opened) headers["x-org"] = opened;
  let res;
  try {
    res = await fetch(API_URL + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Can't reach the portal. Check your connection and try again.");
  }
  if (res.status === 204) return undefined;
  // `null` if the connection dropped while the body came.
  const text = await res.text().catch(() => null);
  const data = text ? parse(text) : null;
  let failure = isLateFailure(data) ? data : null;
  if (!res.ok) {
    const error = data?.error;
    failure = {
      status: res.status,
      error: typeof error === "string" ? error : `The portal answered ${res.status}.`,
    };
  } else if (text === null || data === undefined) {
    // Cut off: a kept-alive call's spaces with no JSON after them.
    failure = { status: 502, error: "The portal's answer was cut off. Try again." };
  }
  if (failure) {
    // The cookie expired or was dropped: signing in again sets a new one, maybe another account's.
    if (failure.status === 401) {
      openOrg(null);
      signedOut.notify();
    }
    throw new ApiError(failure.status, failure.error);
  }
  return data;
}

const q = (value) => encodeURIComponent(value);
const get = (path) => call("GET", path);
const send = (method, path, body) => call(method, path, body);

/**
 * Pages already read, by id, so opening one again doesn't ask the API. A save, rename or delete
 * drops what it may have changed, whether it succeeded or not: a saved page reads back with its
 * images described, so it's read again. Refresh drops them all (`forgetPages`).
 */
const pages = new Map();

/** Drops the cached page `id` and its parts, or with `folder`, every page in the folder `id`. */
function forget(id, folder = false) {
  for (const cached of pages.keys()) {
    const gone = folder
      ? cached.startsWith(`${id}|`)
      : cached === id || cached.startsWith(`${id}~`);
    if (gone) pages.delete(cached);
  }
}

/** Drops every cached page, so the next open reads it from the API. */
export function forgetPages() {
  pages.clear();
}

/** The portal API, as the account the session cookie signs in. */
export const api = {
  // Another account's pages mustn't show from the cache.
  signIn: (credential) => send("POST", "/session", { credential }).finally(forgetPages),
  signOut: () => send("DELETE", "/session").finally(() => openOrg(null)),
  me: () => get("/me"),
  available: (id) => get(`/org-ids/available?id=${q(id)}`),
  register: (org_id, org_name) => send("POST", "/register", { org_id, org_name }),
  /** Asks the master admin to let the account into the org `org_id`. */
  join: (org_id) => send("POST", "/join", { org_id }),

  requests: () => get("/admin/requests"),
  approve: (org_id, keys, chatbot_origins) =>
    send("POST", "/admin/approve", { org_id, ...keys, chatbot_origins }),
  reject: (org_id) => send("POST", "/admin/reject", { org_id }),
  orgs: () => get("/admin/orgs"),
  setKeys: (org_id, keys) => send("PUT", "/admin/orgs/keys", { org_id, ...keys }),
  /** Replaces them all; none removes them. Answers them as stored, each read as an origin. */
  setChatbotOrigins: (org_id, chatbot_origins) =>
    send("PUT", "/admin/orgs/chatbot-origins", {
      org_id,
      chatbot_origins,
    }),
  /** Every org's admins, and the accounts waiting to join one, oldest first. */
  admins: () => get("/admin/admins"),
  /** Lets an account waiting to join in with `folders`, or changes an admin's. */
  setAdmin: (email, folders) => send("PUT", "/admin/admins", { email, folders }),
  /** Removes an admin and revokes their API keys, or refuses an account waiting to join. */
  removeAdmin: (email) => send("DELETE", `/admin/admins?email=${q(email)}`),

  /** The topics the account may see; as the master admin, those of `org` when given. */
  tree: (org) => call("GET", "/tree", undefined, org),
  // The read is kept while it runs too, so opening a page twice at once reads it once.
  readFile: (id) => {
    let file = pages.get(id);
    if (!file) {
      const read = get(`/files?id=${q(id)}`);
      pages.set(id, read);
      // A failed read isn't kept, so opening the page again retries.
      read.catch(() => pages.get(id) === read && pages.delete(id));
      file = read;
    }
    return file;
  },
  createFile: (file) => send("POST", "/files", file).finally(() => forget(file.id)),
  editFile: (file) => send("PUT", "/files", file).finally(() => forget(file.id)),
  /**
   * Where to upload `files`, in order, to link them from the page `id`. Only that page's saves
   * record them, so deleting it deletes them, and a link copied to another page doesn't.
   */
  presignUploads: (id, files) =>
    send("POST", "/files/uploads", {
      id,
      files: files.map((file) => ({ name: file.name, type: file.type, size: file.size })),
    }),
  renameFile: (from, to) =>
    send("POST", "/files/rename", { from, to }).finally(() => {
      forget(from);
      forget(to);
    }),
  deleteFile: (id) => send("DELETE", `/files?id=${q(id)}`).finally(() => forget(id)),
  createFolder: (id) => send("POST", "/folders", { id }),
  renameFolder: (from, to) =>
    send("POST", "/folders/rename", { from, to }).finally(() => {
      forget(from, true);
      forget(to, true);
    }),
  deleteFolder: (id) => send("DELETE", `/folders?id=${q(id)}`).finally(() => forget(id, true)),

  scrape: (url) => get(`/scrape?url=${q(url)}`),

  watcher: (id) => get(`/watchers?id=${q(id)}`),
  /**
   * The links a directory watcher of `levels` at `url` would find at its last level, the last
   * level's own limit not applied; it follows at most `max`.
   */
  watchedLinks: (url, levels) => send("POST", "/watchers/links", { url, levels }),
  /** Imports the page at `url` as `id`, and watches it. */
  watchPage: (id, url) =>
    send("POST", "/watchers", { kind: "file", id, url }).finally(() => forget(id)),
  /**
   * Watches the links `levels` find from `url`, as many as each level follows, imported into the
   * folder `id` in the background.
   */
  watchLinks: (id, url, levels, watching) =>
    send("POST", "/watchers", {
      kind: "directory",
      id,
      url,
      levels,
      ...watching,
    }),
  /**
   * Changes what the directory watcher `id` follows and watches. When that changes, it checks its
   * list again now, in the background.
   */
  editWatcher: (id, settings) => send("PUT", "/watchers", { id, ...settings }),
  stopWatching: (id) => send("DELETE", `/watchers?id=${q(id)}`),

  keys: () => get("/keys"),
  createKey: (name) => send("POST", "/keys", { name }),
  revokeKey: (id) => send("DELETE", `/keys?id=${q(id)}`),

  /** Newest first. */
  dataNotFound: () => get("/data-not-found"),
  dismissDataNotFound: (session_id) =>
    send("DELETE", `/data-not-found?session_id=${q(session_id)}`),

  chatbot: () => get("/chatbot"),
  /** Saves the widget, and publishes it to every site that embeds the org's chatbot. */
  saveChatbot: (widget) => send("PUT", "/chatbot", widget),
};

/**
 * @typedef {typeof api} Portal
 */

/** Sends `file` where `upload` says: straight to S3, not through the API. */
export async function upload(upload, file) {
  const res = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: file });
  if (!res.ok) throw new ApiError(res.status, `Storage refused ${file.name} (${res.status}).`);
}

export function message(error) {
  return error instanceof Error ? error.message : "Something went wrong.";
}
