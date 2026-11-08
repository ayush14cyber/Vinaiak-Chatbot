// `POST /chat` and `POST /reset`: answering a visitor in their session.

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { chatBot, executeFunctionCalls, newReported } from "rag/ai";
import { ContentPart, messageText } from "rag/open-client";
import { retriever as rag } from "rag";
import { CHAT_BUCKET, DOCS_TABLE, VECTOR_BUCKET, dataNotFound } from "training-portal-backend";

import { ApiError, described } from "./errors.js";
import * as sessions from "./session.js";

/** Longest query, in chars: a visitor's question, not a document. */
const MAX_QUERY_CHARS = 2000;
/** Most times one message asks the model, so it can't keep calling tools. */
export const MAX_ROUNDS = 5;
/** Times a round is asked again when the connection to the model failed before any of it came. */
export const RETRIES = 2;
/** Most images one message may carry. */
const MAX_IMAGES = 3;
/** Largest image, in bytes. The widget shrinks bigger ones before sending. */
export const MAX_IMAGE_BYTES = 1024 * 1024;
/** Largest `/chat` request: `MAX_IMAGES` of `MAX_IMAGE_BYTES` in base64 fit, and Lambda takes 6 MB. */
export const MAX_BODY_BYTES = 6 * 1024 * 1024;

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * The image in `dataUrl`, a `data:` URL of a PNG, JPEG, WebP or GIF of at most `MAX_IMAGE_BYTES`,
 * as a content part. Its type is read from its bytes, whatever the URL says.
 */
export function image(dataUrl) {
  const refused = () => ApiError.badRequest("Attach PNG, JPEG, WebP or GIF images of at most 1 MB");
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) throw refused();
  const at = dataUrl.indexOf(";base64,");
  if (at < 0) throw refused();
  const base64 = dataUrl.slice(at + ";base64,".length);
  if (base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !BASE64.test(base64)) throw refused();
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > MAX_IMAGE_BYTES) throw refused();
  const starts = (...prefix) => prefix.every((b, i) => b === null || bytes[i] === b);
  let mime;
  if (starts(0x89, 0x50, 0x4e, 0x47)) mime = "image/png";
  else if (starts(0xff, 0xd8, 0xff)) mime = "image/jpeg";
  else if (starts(0x47, 0x49, 0x46, 0x38)) mime = "image/gif";
  else if (bytes.length >= 12 && starts(0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50)) mime = "image/webp";
  else throw refused();
  return ContentPart.imageFromBytes(mime, bytes);
}

/** What the visitor sent: plain text, or its text followed by the images, which the model reads itself. */
export function userMessage(query, images) {
  if (images.length === 0) return query;
  return [...(query.length > 0 ? [ContentPart.text(query)] : []), ...images];
}

/** The `/chat` body: `{query, images?}`. */
function chatBody(req) {
  let value;
  try {
    value = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "");
  } catch (e) {
    throw Object.assign(new Error(`Failed to parse the request body as JSON: ${e.message}`), { status: 400 });
  }
  if (typeof value?.query !== "string") {
    throw Object.assign(new Error("Failed to deserialize the JSON body into the target type: missing field `query`"), { status: 422 });
  }
  const images = value.images ?? [];
  if (!Array.isArray(images) || images.some((i) => typeof i !== "string")) {
    throw Object.assign(new Error("Failed to deserialize the JSON body into the target type: `images`: invalid type"), { status: 422 });
  }
  return { query: value.query, images };
}

/**
 * `POST /chat {query, images}`: the reply as newline-delimited JSON events ending in `done` or
 * `error`: `text`, `function_call`, `function_response`, `options`. The answer ends only once the
 * conversation is saved, so Lambda isn't frozen before.
 */
export async function chat(configs, req, res, { token, session }, log) {
  const body = chatBody(req);
  const query = body.query.trim();
  if ((query.length === 0 && body.images.length === 0) || [...query].length > MAX_QUERY_CHARS) {
    throw ApiError.badRequest("Ask a question of at most 2000 characters");
  }
  if (body.images.length > MAX_IMAGES) throw ApiError.badRequest("Attach at most 3 images");
  const images = body.images.map(image);
  const trace = { query, images: images.length, calls: [], searches: [], retries: [], reply: "", error: undefined };

  res.status(200);
  res.setHeader("content-type", "application/x-ndjson");
  res.flushHeaders();
  let open = true;
  res.on("close", () => {
    open = false;
  });
  // Sends `event`, unless the visitor left: the conversation is still saved then.
  const send = (event) => {
    if (open) res.write(`${JSON.stringify(event)}\n`);
  };

  // The log line is held until the chat is saved, so it has all of it.
  log.hold();
  let last;
  try {
    await converse(configs, token, session, userMessage(query, images), send, trace);
    last = { type: "done" };
  } catch (e) {
    trace.error = described(e);
    last = { type: "error", message: "Something went wrong. Please try again." };
  }
  log.chat(trace);
  send(last);
  res.end();
  log.release();
}

/**
 * Answers `message` in `session`, streaming the reply and the tools it calls through `send`, then
 * saves the conversation, and the report if the model found data missing.
 */
export async function converse(configs, token, session, message, send, trace, deps = {}) {
  const o = session.org;
  const ai = deps.ai ?? chatBot(o.openrouter_key, o.org_name);
  const retriever =
    deps.retriever ?? rag.build(o.openrouter_key, o.mongodb_key ?? null, configs.dynamo, configs.s3v, DOCS_TABLE, VECTOR_BUCKET);
  const reported = newReported();
  session.chat.ask(message);
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let retries = 0;
    for (;;) {
      const before = session.chat.length;
      try {
        await streamRound(ai, session.chat, send, trace);
        break;
      } catch (e) {
        // Some of OpenRouter's providers drop a request now and then, mostly ones with images. If
        // none of the reply came, the session is as it was and the visitor saw nothing, so it's
        // asked again, which OpenRouter may send elsewhere.
        if (e?.kind === "http" && retries < RETRIES && session.chat.length === before) {
          trace.retries.push(described(e));
          retries++;
        } else {
          throw e;
        }
      }
    }
    const calls = session.chat.pendingToolCalls().map((c) => structuredClone(c));
    if (calls.length === 0) break;
    const again = await executeFunctionCalls(session.chat, retriever, token.org_id, reported);
    trace.searches.push(...reported.searches);
    reported.searches = [];
    for (const call of calls) {
      let args;
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        args = call.function.arguments;
      }
      trace.calls.push({ name: call.function.name, args });
      send({ type: "function_response", name: call.function.name });
    }
    if (!again) break;
  }
  if (reported.options.length > 0) send({ type: "options", options: reported.options });
  if (reported.dataNotFound.length > 0) {
    session.dataNotFound.push(...reported.dataNotFound);
    // The visitor has their reply: a report that didn't save is only logged.
    try {
      await report(configs, token, session);
    } catch (e) {
      trace.error = `the report wasn't saved: ${e.message}`;
    }
  }
  await sessions.save(configs.s3, token.id, session);
}

/** Streams the model's next message in `chat` through `send`: its text, which `trace.reply` gets too, and each tool it calls. */
async function streamRound(ai, chat, send, trace) {
  const reply = await ai.stream(chat);
  // Calls come in pieces; one is announced once its name has come.
  let announced = 0;
  for await (const chunk of reply) {
    const text = chunk?.choices?.find((c) => (c.index ?? 0) === 0)?.delta?.content;
    if (typeof text === "string" && text.length > 0) {
      trace.reply += text;
      send({ type: "text", text });
    }
    const calls = reply.message().tool_calls ?? [];
    while (announced < calls.length && calls[announced].function.name !== "") {
      send({ type: "function_call", name: calls[announced].function.name });
      announced++;
    }
  }
}

/**
 * `POST /reset`: starts a new conversation in the session, which the visitor's token goes on
 * with. Like a message, it counts as one of the session's requests.
 */
export async function reset(configs, { token, session }) {
  session.startOver();
  await sessions.save(configs.s3, token.id, session);
}

/** How many images `content` has. */
const imagesIn = (content) => (Array.isArray(content) ? content.filter((p) => p.type === "image_url").length : 0);

/**
 * The report of `session`'s conversation: all it found missing, with the conversation as the
 * visitor saw it, without the tools' calls and results. An image the visitor sent is only noted.
 */
export function reportOf(token, session, now = Math.floor(Date.now() / 1000)) {
  const conversation = session.chat.history.flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const images = message.role === "user" ? imagesIn(message.content) : 0;
    let text = messageText(message);
    if (images === 1) text += "\n[1 image attached]";
    else if (images > 1) text += `\n[${images} images attached]`;
    return text.trim().length > 0 ? [{ role: message.role, text }] : [];
  });
  const id = session.conversationId ?? token.id;
  return { session_id: id, items: [...session.dataNotFound], conversation, reported_at: now };
}

async function report(configs, token, session) {
  const r = reportOf(token, session);
  try {
    await configs.s3.send(
      new PutObjectCommand({
        Bucket: CHAT_BUCKET,
        Key: dataNotFound.key(token.org_id, r.session_id),
        ContentType: "application/json",
        Body: JSON.stringify(r),
      }),
    );
  } catch (e) {
    throw ApiError.internal(e);
  }
}
