// One log line per call, written once it has ended, a streamed reply included: its method, path,
// status and time in ms, the org and session it was for, and why it failed. For `/chat`, also
// what answering took, and a warning if a search degraded, e.g. its reranker failed and left
// plain vector search. On Lambda, stdout goes to CloudWatch (`/aws/lambda/chatbot`).

import { searchDegraded } from "rag/ai";
import { log as logger } from "rag/log";

/**
 * The current call's log line, which its handlers fill in. It is written when the last of its
 * holders lets go: once the answer has been sent, and what goes on after it, like a chat's
 * saving, is done.
 */
export class CallLog {
  constructor(method, path, write = writeLine) {
    this.method = method;
    this.path = path;
    this.start = performance.now();
    this.entry = { status: 0, org: null, session: null, error: null, chat: null };
    this.holders = 0;
    this.write = write;
  }

  /** Names the org the call is for. */
  org(org) {
    this.entry.org = org;
  }

  /** Names the session the call is for. */
  session(session) {
    this.entry.session = session;
  }

  /**
   * What answering a message took: `{query, images, calls: [{name, args}], searches, retries,
   * reply, error?}`.
   */
  chat(trace) {
    const { error, ...rest } = trace;
    this.entry.error = error ?? this.entry.error;
    this.entry.chat = rest;
  }

  /** Keeps the line from being written until `release`. */
  hold() {
    this.holders += 1;
  }

  release() {
    this.holders -= 1;
    if (this.holders === 0) this.write(this.fields(), this);
  }

  fields() {
    const e = this.entry;
    const out = { method: this.method, path: this.path, status: e.status, ms: Math.round(performance.now() - this.start) };
    if (e.org !== null) out.org = e.org;
    if (e.session !== null) out.session = e.session;
    if (e.error !== null) out.error = e.error;
    const chat = e.chat;
    if (chat) {
      out.query = chat.query;
      if (chat.images > 0) out.images = chat.images;
      out.calls = chat.calls;
      out.searches = chat.searches;
      if (chat.retries.length > 0) out.retries = chat.retries;
      out.reply = chat.reply;
    }
    return out;
  }
}

/** The level and message of a line: a streamed reply that failed after it began still answered 200. */
export function levelOf(fields) {
  const { status, error } = fields;
  const degraded = (fields.searches ?? []).some(searchDegraded);
  if (status >= 500 || (status < 400 && error !== undefined)) return ["error", "failed"];
  if (status === 401) return ["info", "not signed in"];
  if (status >= 400) return ["warn", "refused"];
  if (degraded) return ["warn", "degraded"];
  return ["info", "done"];
}

function writeLine(fields) {
  const [level, msg] = levelOf(fields);
  logger[level](fields, msg);
}

/** Express middleware: a `CallLog` on `req.log`, written once the answer is sent and its holders are done. */
export function callLog(write = writeLine) {
  return (req, res, next) => {
    const line = new CallLog(req.method, req.path, write);
    req.callLog = line;
    line.hold();
    res.on("close", () => {
      line.entry.status = res.statusCode;
      if (res.locals.failure !== undefined) line.entry.error = res.locals.failure;
      line.release();
    });
    next();
  };
}
