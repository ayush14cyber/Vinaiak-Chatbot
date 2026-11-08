// How a route answers: its handler returns a reply, or throws an `ApiError`, and `serve` sends
// it, with the layers every call goes through:
//
// - no-store: every answer is kept out of shared caches, such as Vercel's in front of `/api`.
// - keep-alive: the pages reach this API through a Vercel rewrite, which gives up on a call when
//   nothing arrives for 120 s, and a save can take minutes. So a cookie call still running after
//   `QUIET` answers `200` at once, sends a space every `BEAT`, then its JSON, which JSON parsers
//   read past the spaces. Its status has gone out by then, so a failure ends as
//   `{"error", "status"}` instead. Calls with `Authorization` carry API keys, which reach the
//   Lambda directly, so they're answered as usual.
// - the call log: one JSON line per call when it ends, with its method, path, status, time in ms,
//   the org that made it and how (`by`), and why it failed. It logs a kept-alive call's real
//   status and time, not the early `200`.
// - the deadline: a call ends with a readable `504` before Lambda's 900 s timeout cuts it off.

import { AsyncLocalStorage } from "node:async_hooks";
import { STATUS_CODES } from "node:http";

import { log } from "rag/log";

/** A failed request: its status, and a message for the user as `{"error": ...}`. */
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }

  static badRequest(message) {
    return new ApiError(400, message);
  }

  static unauthorized(message) {
    return new ApiError(401, message);
  }

  static forbidden(message) {
    return new ApiError(403, message);
  }

  static notFound(message) {
    return new ApiError(404, message);
  }

  static conflict(message) {
    return new ApiError(409, message);
  }

  /** The document can't be indexed as it is, e.g. a passage too long to keep whole. */
  static unprocessable(message) {
    return new ApiError(422, message);
  }

  static rateLimited(message) {
    return new ApiError(429, message);
  }

  /** A model or Firecrawl failed. */
  static upstream(message) {
    return new ApiError(502, message);
  }

  /** The scraped page itself answered with this error status. */
  static pageStatus(status) {
    const e = new ApiError(502, `the page answered ${status}`);
    e.pageStatus = status;
    return e;
  }

  /** OpenRouter or Firecrawl refused the org's own key, which only an admin can change. */
  static providerKey(provider, status) {
    const why = status === 402 ? "is out of credits" : "isn't valid";
    return new ApiError(
      403,
      `your org's ${provider} key ${why} (${provider} answered ${status}): ask the portal's admin to update it`,
    );
  }

  /** The call ran past its deadline. */
  static timedOut(message) {
    return new ApiError(504, message);
  }

  /** Logged, not shown: AWS errors name resources. */
  static internal(error) {
    log.error({ error: describe(error) }, "internal error");
    return new ApiError(500, "internal error");
  }
}

/** `error` and its causes, joined by `: `. */
export function describe(error) {
  let message = String(error?.message ?? error);
  for (let cause = error?.cause; cause; cause = cause.cause) message += `: ${cause.message ?? cause}`;
  return message;
}

/** Formats status code and name, e.g. `"401 Unauthorized"`. */
export const statusText = (status) => `${status} ${STATUS_CODES[status] ?? ""}`.trim();

/** A JSON reply. */
export const json = (body, status = 200) => ({ status, body });
/** A reply with no body. */
export const noContent = () => ({ status: 204, body: undefined });

/** How long a call runs before it's kept alive: well inside Vercel's 120 s. */
const QUIET_MS = 90_000;
/** How often a kept-alive call sends a space. */
const BEAT_MS = 30_000;
/** The longest a call runs: the Lambda's timeout, less time to send the answer. */
export const DEADLINE_MS = 870_000;

/** The current call's log entry, for `caller` to name its org. */
const current = new AsyncLocalStorage();

/** Names the org making the current call, and how: `"cookie"`, `"api-key"` or `"admin"`. */
export function caller(org, by) {
  const entry = current.getStore();
  if (!entry) return;
  if (org) entry.org = org;
  entry.by = by;
}

function failureReply(error) {
  const apiError = error instanceof ApiError ? error : ApiError.internal(error);
  return { status: apiError.status, body: { error: apiError.message }, failure: apiError.message };
}

/** The handler's reply, its failure as a reply too, cut off at the deadline. */
async function run(handler, req) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(
      () =>
        resolve(
          failureReply(
            ApiError.timedOut(
              `this took over ${DEADLINE_MS / 60_000} minutes, longer than the portal allows: try ` +
                "again, or split the page into shorter ones",
            ),
          ),
        ),
      DEADLINE_MS,
    );
    timer.unref?.();
  });
  try {
    const work = Promise.resolve()
      .then(() => handler(req))
      .then(
        (reply) => reply ?? noContent(),
        (error) => failureReply(error),
      );
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function bodyOf(reply) {
  return reply.body === undefined ? "" : JSON.stringify(reply.body);
}

function send(res, reply) {
  for (const [name, value] of Object.entries(reply.headers ?? {})) res.setHeader(name, value);
  res.status(reply.status);
  if (reply.body === undefined) return res.end();
  res.setHeader("content-type", "application/json");
  res.end(bodyOf(reply));
}

/** What a kept-alive call ends with: its body, `null` if it had none, or its error and status. */
function last(reply) {
  if (reply.status < 300) return reply.body === undefined ? "null" : bodyOf(reply);
  const error = typeof reply.body?.error === "string" ? reply.body.error : statusText(reply.status);
  return JSON.stringify({ error, status: reply.status });
}

function logLine(entry, reply, ms) {
  const fields = { method: entry.method, path: entry.path, org: entry.org, by: entry.by, status: reply.status, ms };
  if (reply.status >= 500) log.error({ ...fields, error: reply.failure }, "failed");
  // Every signed-out visit asks `/me` first.
  else if (reply.status === 401) log.info({ ...fields, error: reply.failure }, "not signed in");
  else if (reply.status >= 400) log.warn({ ...fields, error: reply.failure }, "refused");
  else log.info(fields, "done");
}

/** An Express handler for `handler`, which takes the request and returns a reply. */
export function serve(handler) {
  return async (req, res) => {
    res.setHeader("cache-control", "no-store");
    const entry = { method: req.method, path: req.originalUrl };
    const started = performance.now();
    const work = current.run(entry, () => run(handler, req)).then((reply) => {
      logLine(entry, reply, Math.round(performance.now() - started));
      return reply;
    });

    if (req.headers.authorization) return send(res, await work);
    let quiet;
    const early = await Promise.race([
      work,
      new Promise((resolve) => {
        quiet = setTimeout(() => resolve(null), QUIET_MS);
      }),
    ]);
    clearTimeout(quiet);
    if (early) return send(res, early);

    log.info({ path: entry.path }, `still running after ${QUIET_MS / 1000} s: answered 200, its result follows in the body`);
    res.status(200);
    res.setHeader("content-type", "application/json");
    res.write(" ");
    const beat = setInterval(() => res.write(" "), BEAT_MS);
    try {
      res.end(last(await work));
    } finally {
      clearInterval(beat);
    }
  };
}

// ---- request bodies and queries ----

/**
 * The JSON body of `req`, checked against `shape`: `{field: "string" | "string?" | "number?" |
 * "bool?" | "array" | "array?" | "object" | "object?"}`. A `?` field defaults to `undefined`
 * (`false` for a bool, `[]` for an array). Read after the caller is checked.
 */
export function body(req, shape = null) {
  let value;
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : (req.body ?? "");
    value = JSON.parse(raw);
  } catch (e) {
    throw ApiError.badRequest(`Failed to parse the request body as JSON: ${e.message}`);
  }
  if (!shape) return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw ApiError.unprocessable("Failed to deserialize the JSON body into the target type: expected an object");
  }
  for (const [field, type] of Object.entries(shape)) {
    const optional = type.endsWith("?");
    const kind = optional ? type.slice(0, -1) : type;
    const v = value[field];
    if (v === undefined || v === null) {
      if (!optional) {
        throw ApiError.unprocessable(`Failed to deserialize the JSON body into the target type: missing field \`${field}\``);
      }
      if (kind === "bool") value[field] = false;
      else if (kind === "array") value[field] = [];
      else value[field] = undefined;
      continue;
    }
    const ok =
      (kind === "string" && typeof v === "string") ||
      (kind === "number" && typeof v === "number" && Number.isInteger(v) && v >= 0) ||
      (kind === "bool" && typeof v === "boolean") ||
      (kind === "array" && Array.isArray(v)) ||
      (kind === "object" && typeof v === "object" && !Array.isArray(v));
    if (!ok) {
      throw ApiError.unprocessable(`Failed to deserialize the JSON body into the target type: \`${field}\`: invalid type`);
    }
  }
  return value;
}

/** The query parameter `name` of `req`, which must be there. */
export function query(req, name) {
  const value = req.query?.[name];
  if (typeof value !== "string") {
    throw ApiError.badRequest(`Failed to deserialize query string: missing field \`${name}\``);
  }
  return value;
}
