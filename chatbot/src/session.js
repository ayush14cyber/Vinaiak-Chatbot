// A visitor's session, stored as JSON in the chat bucket under `sessions/{id}.json`: the org it
// chats for, its conversation, and how many requests it served and may serve. Writes are
// conditional on the version read (`If-Match`), so parallel requests can't pass the limit.
//
// Stored as the Rust chatbot stored it: `{req_count, allowed, org: {org_name, openrouter_key,
// mongodb_key}, chat, data_not_found, conversation_id}`.

import { randomUUID } from "node:crypto";

import { GetObjectCommand, NoSuchKey, PutObjectCommand } from "@aws-sdk/client-s3";
import { Session as Chat } from "rag/open-client";
import { CHAT_BUCKET } from "training-portal-backend";

import { ApiError } from "./errors.js";

/** Requests a session may serve per login: a login that resumes it allows this many more. */
export const MAX_REQUESTS = 50;
/** Tries at a write when other requests on the session keep changing it first. */
const ATTEMPTS = 3;
/**
 * Tokens of conversation sent to the model before it is summarized. A search adds up to about
 * 25k, and what came before is read from the provider's cache, at a fiftieth of the input price.
 */
const CHAT_TOKENS = 300_000;

export const newChat = () => new Chat(CHAT_TOKENS);

/** The org a session chats for, copied at login so a message needs no database call. */
export const org = (orgName, openrouterKey, mongodbKey = null) => ({ org_name: orgName, openrouter_key: openrouterKey, mongodb_key: mongodbKey });

export class Session {
  constructor({ reqCount = 0, allowed = MAX_REQUESTS, org: o, chat = newChat(), dataNotFound = [], conversationId = null, etag = "" }) {
    this.reqCount = reqCount;
    /** How many requests the session may serve in all. Like `reqCount`, it only grows. */
    this.allowed = allowed;
    this.org = o;
    /** The conversation, as the model sees it. */
    this.chat = chat;
    /** What the model reported the documents lacked so far, for the conversation's report. */
    this.dataNotFound = dataNotFound;
    /**
     * The id of the conversation, which names its data-not-found report; `null` for the session's
     * first, which goes by the session's id.
     */
    this.conversationId = conversationId;
    /** The stored object's version, for writing it back with `If-Match`. */
    this.etag = etag;
  }

  static fromJSON(value, etag = "") {
    return new Session({
      reqCount: value.req_count ?? 0,
      // The allowance of a session stored before sessions could be resumed.
      allowed: value.allowed ?? MAX_REQUESTS,
      org: value.org,
      chat: Chat.fromJSON(value.chat),
      dataNotFound: Array.isArray(value.data_not_found) ? value.data_not_found : [],
      conversationId: value.conversation_id ?? null,
      etag,
    });
  }

  toJSON() {
    return {
      req_count: this.reqCount,
      allowed: this.allowed,
      org: this.org,
      chat: this.chat.toJSON(),
      data_not_found: this.dataNotFound,
      conversation_id: this.conversationId,
    };
  }

  /** Starts a new conversation: the model and the next report remember none of this one. */
  startOver() {
    this.chat = newChat();
    this.dataNotFound = [];
    this.conversationId = randomUUID();
  }
}

const key = (id) => `sessions/${id}.json`;

export async function create(s3, id, o) {
  const session = new Session({ org: o });
  try {
    await s3.send(new PutObjectCommand({ Bucket: CHAT_BUCKET, Key: key(id), ContentType: "application/json", Body: JSON.stringify(session) }));
  } catch (e) {
    throw ApiError.internal(e);
  }
}

/**
 * Loads session `id` and counts this request in it before it is served, so parallel requests
 * can't all pass on the same count: the write only lands if nothing changed the session since.
 */
export async function claim(s3, id) {
  for (let i = 0; i < ATTEMPTS; i++) {
    const session = await fetch(s3, key(id));
    if (!session) throw ApiError.unauthorized("the session is gone");
    if (session.reqCount >= session.allowed) throw ApiError.tooManyRequests("This chat has reached its message limit");
    session.reqCount += 1;
    if (await put(s3, key(id), session)) return session;
  }
  throw ApiError.tooManyRequests("Too many messages at once");
}

/** Continues session `id` for a new login, with `o` as it is now and `MAX_REQUESTS` more requests. False if it's gone. */
export async function resume(s3, id, o) {
  for (let i = 0; i < ATTEMPTS; i++) {
    const session = await fetch(s3, key(id));
    if (!session) return false;
    session.allowed = Math.max(session.allowed, session.reqCount + MAX_REQUESTS);
    session.org = o;
    if (await put(s3, key(id), session)) return true;
  }
  throw ApiError.internal("the session kept changing while resuming");
}

/**
 * Writes `session` back after its message. If another request on it wrote since it was read,
 * that request's count and allowance are kept, as both only grow; the rest is `session`'s.
 */
export async function save(s3, id, session) {
  for (let i = 0; i < ATTEMPTS; i++) {
    if (await put(s3, key(id), session)) return;
    const stored = await fetch(s3, key(id));
    if (!stored) throw ApiError.internal("the session disappeared while saving");
    session.reqCount = Math.max(session.reqCount, stored.reqCount);
    session.allowed = Math.max(session.allowed, stored.allowed);
    session.etag = stored.etag;
  }
  throw ApiError.internal("the session kept changing while saving");
}

/** The session at `k` with its version, if there is one. */
export async function fetch(s3, k) {
  let out;
  try {
    out = await s3.send(new GetObjectCommand({ Bucket: CHAT_BUCKET, Key: k }));
  } catch (e) {
    if (e instanceof NoSuchKey || e?.name === "NoSuchKey") return null;
    throw ApiError.internal(e);
  }
  try {
    return Session.fromJSON(JSON.parse(await out.Body.transformToString()), out.ETag ?? "");
  } catch (e) {
    throw ApiError.internal(e);
  }
}

/** Writes `session` over the version it was read at, and takes the new version. False if another request changed it since. */
export async function put(s3, k, session) {
  try {
    const out = await s3.send(
      new PutObjectCommand({ Bucket: CHAT_BUCKET, Key: k, ContentType: "application/json", IfMatch: session.etag, Body: JSON.stringify(session) }),
    );
    session.etag = out.ETag ?? "";
    return true;
  } catch (e) {
    // 412: another request wrote first. 409: S3 saw the two writes at once.
    const status = e?.$metadata?.httpStatusCode;
    if (status === 409 || status === 412) return false;
    throw ApiError.internal(e);
  }
}

/** Exposed for tests. */
export { key as sessionKey };
