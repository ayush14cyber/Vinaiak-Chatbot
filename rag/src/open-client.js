// A client for any OpenAI-compatible API (OpenRouter here): chat completions, streamed or not,
// the conversation history sent with each request, and embeddings. A port of the `open-client`
// Rust crate the Rust services used, so a session it stored reads back the same.
//
// Messages are kept as the Chat Completions API defines them, so they are sent as they are:
//   { role: "user", content: string | ContentPart[] }
//   { role: "assistant", content: string | null, refusal?, reasoning_content?, tool_calls?, ... }
//   { role: "tool", tool_call_id, content }

/** Base URL of the OpenAI API, used unless another one is set. */
export const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * The error object an API sent, parsed leniently: `{"error": {"message", "type", "param",
 * "code"}}`, `{"error": "message"}`, `{"message"}`, `{"detail"}`, a list of these, or any body.
 */
export class ApiError {
  constructor(message, type = null, param = null, code = null) {
    this.message = message;
    this.type = type;
    this.param = param;
    /** String or number, depending on the server. */
    this.code = code;
  }

  static fromBody(body) {
    try {
      return ApiError.fromValue(JSON.parse(body));
    } catch {
      return new ApiError(body.trim());
    }
  }

  static fromValue(value) {
    if (Array.isArray(value) && value.length > 0) value = value[0];
    const error = value && typeof value === "object" && "error" in value ? value.error : value;
    let message;
    if (typeof error === "string") {
      message = error;
    } else {
      const detail = error?.message ?? error?.detail;
      message = typeof detail === "string" ? detail : detail !== undefined ? JSON.stringify(detail) : JSON.stringify(error);
    }
    const field = (key) => (typeof error?.[key] === "string" ? error[key] : null);
    const code = error && typeof error === "object" && error.code !== undefined && error.code !== null ? error.code : null;
    return new ApiError(message, field("type"), field("param"), code);
  }
}

/**
 * The error of a request to the API, by `kind`:
 * - `"http"`: the request couldn't be sent or its response read, e.g. no connection; `timeout`
 *   says whether it timed out.
 * - `"api"`: the API sent an error; `status` is `null` for one in the middle of a stream.
 * - `"invalid_response"`: the response isn't as per the OpenAI specification.
 * - `"nothing_to_respond"`: the last message of the session is from the assistant.
 */
export class OpenAIError extends Error {
  constructor(kind, message, { status = null, error = null, timeout = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "OpenAIError";
    this.kind = kind;
    this.status = status;
    this.apiError = error;
    this.timeout = timeout;
  }

  static http(cause) {
    const timeout = cause?.name === "TimeoutError" || cause?.name === "AbortError" || cause?.cause?.code === "UND_ERR_HEADERS_TIMEOUT";
    const detail = cause?.cause?.message ?? cause?.message ?? String(cause);
    return new OpenAIError("http", timeout ? `operation timed out: ${detail}` : `error sending request: ${detail}`, {
      timeout,
      cause,
    });
  }

  static api(status, error) {
    const context = [];
    if (status !== null) context.push(`${status} ${STATUS_TEXT[status] ?? ""}`.trim());
    if (error.type) context.push(error.type);
    const suffix = context.length > 0 ? ` (${context.join(", ")})` : "";
    return new OpenAIError("api", `API error${suffix}: ${error.message}`, { status, error });
  }

  static invalidResponse(why) {
    return new OpenAIError("invalid_response", `Invalid response: ${why}`);
  }

  static nothingToRespond() {
    return new OpenAIError("nothing_to_respond", "Nothing to respond to, as the last message is from the assistant");
  }
}

const STATUS_TEXT = {
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  408: "Request Timeout",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

/** `fetch`, its failure to get an answer an `OpenAIError` of kind `"http"`. */
async function send(url, init) {
  try {
    return await fetch(url, init);
  } catch (error) {
    throw OpenAIError.http(error);
  }
}

async function errorFromResponse(response) {
  let body;
  try {
    body = await response.text();
  } catch (error) {
    return OpenAIError.http(error);
  }
  return OpenAIError.api(response.status, ApiError.fromBody(body));
}

/** The JSON body of a response, an error status or an error object being an error. */
async function readJson(response) {
  if (!response.ok) throw await errorFromResponse(response);
  let body;
  try {
    body = await response.text();
  } catch (error) {
    throw OpenAIError.http(error);
  }
  let value;
  try {
    value = JSON.parse(body);
  } catch (e) {
    throw OpenAIError.invalidResponse(`JSON parsing error [${e.message}]: ${body}`);
  }
  // Some servers report errors with status 200.
  if (value && value.error !== undefined && value.error !== null && value.choices === undefined) {
    throw OpenAIError.api(response.status, ApiError.fromValue(value));
  }
  return value;
}

const joinUrl = (base, path) => `${base.replace(/\/+$/, "")}/${path}`;

function headers(apiKey) {
  const h = { "content-type": "application/json" };
  if (apiKey) h.authorization = `Bearer ${apiKey}`;
  return h;
}

/** A signal that aborts after `timeoutMs`, or when `signal` does. */
function signalOf(timeoutMs, signal) {
  const signals = [];
  if (timeoutMs) signals.push(AbortSignal.timeout(timeoutMs));
  if (signal) signals.push(signal);
  if (signals.length === 0) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

// ---- content ----

/** `data:{mime};base64,{bytes}`. */
export function dataUrl(mime, bytes) {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** Downloads `url`, returning its mime type, from `Content-Type`, and its body. */
async function download(url, signal) {
  const response = await send(url, { signal });
  if (!response.ok) throw await errorFromResponse(response);
  const type = response.headers.get("content-type");
  const mime = type?.split(";")[0].trim();
  if (!mime) throw OpenAIError.invalidResponse("Download has no valid Content-Type header");
  let bytes;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw OpenAIError.http(error);
  }
  return [mime, bytes];
}

/** Content parts of a user message. */
export const ContentPart = Object.freeze({
  text: (text) => ({ type: "text", text }),
  imageUrl: (url) => ({ type: "image_url", image_url: { url } }),
  imageFromBytes: (mime, bytes) => ({ type: "image_url", image_url: { url: dataUrl(mime, bytes) } }),
  file: (filename, mime, bytes) => ({ type: "file", file: { file_data: dataUrl(mime, bytes), filename } }),
  /** A file part of the file at `url`, downloaded: OpenAI reads a file only in base64. */
  async downloadFile(url, signal) {
    const [mime, bytes] = await download(url, signal);
    const filename = url.split(/[?#]/)[0].split("/").pop() || "file";
    return ContentPart.file(filename, mime, bytes);
  },
});

/** The text of a message: a user message's text parts, joined by newlines. */
export function messageText(message) {
  if (!message) return "";
  if (message.role === "assistant") return message.content ?? "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

/** Parses an assistant message's text as JSON, a code fence around it stripped. */
export function messageJson(message) {
  let json = (message?.content ?? "").trim();
  if (json.startsWith("```")) {
    json = json.slice(3);
    if (json.startsWith("json")) json = json.slice(4);
    if (json.endsWith("```")) json = json.slice(0, -3);
    json = json.trim();
  }
  return JSON.parse(json);
}

/** A tool call's arguments, as JSON: none is `{}`. */
export function toolCallArgs(call) {
  const args = (call.function?.arguments ?? "").trim();
  return JSON.parse(args === "" ? "{}" : args);
}

let generatedCallId = 0;
const generateCallId = () => `call_${generatedCallId++}`;

/** Drops the fields with no value, as the Rust client did for unknown fields. */
function withValue(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value.length === 0) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) continue;
    out[key] = value;
  }
  return out;
}

const KNOWN = new Set(["content", "reasoning_content", "reasoning", "refusal", "tool_calls", "role"]);

/** The texts of a message or delta from the API: content, reasoning and refusal. */
function texts(raw) {
  let reasoning = [raw.reasoning_content, raw.reasoning].find((r) => typeof r === "string" && r.length > 0) ?? null;
  let content = null;
  if (typeof raw.content === "string") {
    content = raw.content;
  } else if (Array.isArray(raw.content)) {
    // Some servers send content parts in replies too.
    content = "";
    for (const part of raw.content) {
      if (part?.type === "thinking" || part?.type === "reasoning") {
        const thought =
          typeof part.thinking === "string"
            ? part.thinking
            : Array.isArray(part.thinking)
              ? part.thinking.map((t) => t?.text ?? "").join("")
              : (part.text ?? "");
        reasoning = (reasoning ?? "") + thought;
      } else if (typeof part?.text === "string") {
        content += part.text;
      }
    }
  }
  const nonEmpty = (t) => (typeof t === "string" && t.length > 0 ? t : null);
  return [nonEmpty(content), nonEmpty(reasoning), nonEmpty(raw.refusal)];
}

function extraOf(raw) {
  const extra = {};
  for (const [key, value] of Object.entries(raw ?? {})) if (!KNOWN.has(key)) extra[key] = value;
  return withValue(extra);
}

function argumentsOf(fn) {
  const args = fn?.arguments;
  if (args === undefined || args === null) return null;
  return typeof args === "string" ? args : JSON.stringify(args);
}

/** A tool call from the API, as stored: `{id, type: "function", function: {name, arguments}}`. */
function toolCallOf(raw) {
  const { index: _index, id, function: fn, type: _type, ...rest } = raw ?? {};
  return {
    id: typeof id === "string" && id.length > 0 ? id : generateCallId(),
    type: "function",
    function: { name: fn?.name ?? "", arguments: argumentsOf(fn) ?? "" },
    ...withValue(rest),
  };
}

/** An assistant message from the API, as stored. */
function assistantOf(raw) {
  raw = raw ?? {};
  const [content, reasoning, refusal] = texts(raw);
  const message = { role: "assistant", content };
  if (refusal !== null) message.refusal = refusal;
  if (reasoning !== null) message.reasoning_content = reasoning;
  const calls = (raw.tool_calls ?? []).map(toolCallOf);
  if (calls.length > 0) message.tool_calls = calls;
  return { ...message, ...extraOf(raw) };
}

/** The request body's messages: the system prompt, then the history as the API takes it. */
function wireMessages(systemPrompt, history, sendReasoning) {
  const out = [];
  if (systemPrompt !== null && systemPrompt !== undefined) out.push({ role: "system", content: systemPrompt });
  for (const message of history) {
    if (message.role !== "assistant") {
      out.push(message);
      continue;
    }
    const { reasoning_content: reasoning, tool_calls: calls = [], content, ...rest } = message;
    const wire = { ...rest, role: "assistant", content: content ?? (calls.length === 0 ? "" : null) };
    if (reasoning && sendReasoning) wire.reasoning_content = reasoning;
    if (calls.length > 0) {
      // Some servers reject empty arguments.
      wire.tool_calls = calls.map((call) => ({
        ...call,
        type: "function",
        function: { name: call.function.name, arguments: call.function.arguments.trim() === "" ? "{}" : call.function.arguments },
      }));
    }
    out.push(wire);
  }
  return out;
}

// ---- session ----

/** Asks for the summary. Not saved with the session while it is the default. */
const DEFAULT_SUMMARY_PROMPT =
  "Summarize our conversation so far, so that it can go on from your summary alone. Keep what I " +
  "asked and why, what I told you about myself and my situation, the facts, figures and sources " +
  "found for me, what was decided, and what is still open, leaving out what didn't come up. If " +
  "our conversation starts with a summary, keep what still matters from it too. Write only the " +
  "summary.";

/** History can't start with tool calls or their results, as the prompt they belong to is gone. */
const isInvalidStart = (m) => m.role === "tool" || (m.role === "assistant" && (m.tool_calls?.length ?? 0) > 0);

/** Position of the last prompt: the first of the user messages last in a row. 0 if there's none. */
function lastTurnStart(history) {
  let lastPrompt = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") {
      lastPrompt = i;
      break;
    }
  }
  if (lastPrompt < 0) return 0;
  for (let i = lastPrompt - 1; i >= 0; i--) if (history[i].role !== "user") return i + 1;
  return 0;
}

/**
 * Conversation history, sent with each request; replies are added to it. Once a reply takes the
 * conversation past `limit` tokens (its `Compactor`), the model summarizes everything before the
 * last prompt, which is then forgotten, and the summary is put at the start of that prompt.
 */
export class Session {
  constructor(limit = 64_000) {
    this.history = [];
    this.messageNumber = 0;
    this.rememberReply = true;
    this.compactor = { limit, prompt: DEFAULT_SUMMARY_PROMPT };
  }

  /** The session as it is stored, in the Rust client's layout. */
  toJSON() {
    const handler = { limit: this.compactor.limit };
    if (this.compactor.prompt !== DEFAULT_SUMMARY_PROMPT) handler.prompt = this.compactor.prompt;
    return {
      history: this.history,
      message_number: this.messageNumber,
      remember_reply: this.rememberReply,
      overflow_handler: handler,
    };
  }

  /** A session as `toJSON` stored it. */
  static fromJSON(value) {
    const session = new Session(value?.overflow_handler?.limit ?? 64_000);
    session.history = Array.isArray(value?.history) ? value.history : [];
    session.messageNumber = value?.message_number ?? session.history.length;
    session.rememberReply = value?.remember_reply ?? true;
    if (typeof value?.overflow_handler?.prompt === "string") session.compactor.prompt = value.overflow_handler.prompt;
    return session;
  }

  last() {
    return this.history[this.history.length - 1] ?? null;
  }

  get length() {
    return this.history.length;
  }

  /** Adds a user message: text, or content parts. */
  ask(content) {
    this.add({ role: "user", content });
    return this;
  }

  /** Adds an assistant message. */
  reply(message) {
    this.add(typeof message === "string" ? { role: "assistant", content: message } : message);
    return this;
  }

  add(message) {
    this.history.push(message);
    this.messageNumber += 1;
  }

  /** Tool calls of the last assistant message which have no result yet. */
  pendingToolCalls() {
    const answered = [];
    for (let i = this.history.length - 1; i >= 0; i--) {
      const message = this.history[i];
      if (message.role === "tool") answered.push(message.tool_call_id);
      else if (message.role === "assistant") {
        return (message.tool_calls ?? []).filter((call) => !answered.includes(call.id));
      } else break;
    }
    return [];
  }

  /** Adds the result of the pending tool call `callId`: strings as they are, else as JSON. */
  addToolResult(callId, result) {
    if (!this.pendingToolCalls().some((call) => call.id === callId)) {
      throw new Error(`No unanswered tool call with id \`${callId}\` in the last assistant message`);
    }
    const content = typeof result === "string" ? result : JSON.stringify(result);
    this.add({ role: "tool", tool_call_id: callId, content });
    return this;
  }

  /** Removes the last turn: the last prompt and everything after it. */
  forgetLastTurn() {
    const removed = this.history.splice(lastTurnStart(this.history));
    this.messageNumber = Math.max(this.messageNumber - removed.length, 0);
    return removed;
  }

  /** Removes the oldest message, and the tool calls and results right after it. */
  forgetOldest() {
    let count = 1;
    while (count < this.history.length && isInvalidStart(this.history[count])) count += 1;
    if (count >= this.history.length) return null;
    const oldest = this.history[0];
    this.history.splice(0, count);
    return oldest;
  }

  addReply(reply) {
    if (this.rememberReply) this.reply(reply);
    else if (this.last()?.role === "user") this.forgetLastTurn();
  }

  /** Adds the reply of `completion`, then summarizes the history if it grew past the limit. */
  async addCompletion(completion, ai = null) {
    this.addReply(completionMessage(completion));
    if (ai) await this.compact(ai, completion);
  }

  async compact(ai, completion) {
    const tokens = completion?.usage?.total_tokens ?? 0;
    const start = lastTurnStart(this.history);
    if (tokens <= this.compactor.limit || start === 0) return;
    const earlier = [...this.history.slice(0, start), { role: "user", content: this.compactor.prompt }];
    let summary;
    try {
      const reply = await ai.askWithoutTools(earlier);
      if ((completionMessage(reply).tool_calls ?? []).length > 0) return;
      summary = (completionMessage(reply).content ?? "").trim();
    } catch {
      // Nothing is forgotten, and it is asked for again after the next reply.
      return;
    }
    if (summary.length === 0) return;
    const kept = this.history.length - start;
    while (this.history.length > kept && this.forgetOldest() !== null) {
      // forgetting
    }
    const first = this.history[0];
    if (first?.role === "user") {
      const wrapped = `<summary_of_earlier_conversation>\n${summary}\n</summary_of_earlier_conversation>`;
      if (typeof first.content === "string") first.content = `${wrapped}\n\n${first.content}`;
      else first.content = [{ type: "text", text: wrapped }, ...first.content];
    }
  }
}

/** The first choice's message of a completion. */
export function completionMessage(completion) {
  return completion?.choices?.[0]?.message ?? { role: "assistant", content: null };
}

// ---- chat ----

/** A tool given to the model: a function, by its schema `{name, description, parameters}`. */
export const functionTool = (schema) => ({ type: "function", function: schema });

/** Structured output: the reply follows `schema`. */
export const jsonSchemaFormat = (schema) => ({
  type: "json_schema",
  json_schema: { name: "response", schema, strict: true },
});

const RESERVED = new Set(["model", "messages", "tools", "tool_choice", "stream"]);

/** A model with its system prompt, tools and parameters. */
export class AI {
  constructor(apiKey, model, systemPrompt = null, { timeoutMs = null } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = DEFAULT_BASE_URL;
    this.model = model;
    this.systemPrompt = systemPrompt;
    this.tools = [];
    this.toolChoice = null;
    this.params = { stream_options: { include_usage: true } };
    this.sendReasoning = false;
    this.timeoutMs = timeoutMs;
  }

  setBaseUrl(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    return this;
  }

  setTools(tools) {
    this.tools = [...tools];
    return this;
  }

  param(key, value) {
    if (value === null || value === undefined) delete this.params[key];
    else this.params[key] = value;
    return this;
  }

  temperature(t) {
    return this.param("temperature", t);
  }

  reasoningEffort(effort) {
    return this.param("reasoning_effort", effort);
  }

  responseFormat(format) {
    return this.param("response_format", format);
  }

  body(history, stream, overrides = {}) {
    const tools = overrides.tools ?? this.tools;
    const toolChoice = overrides.toolChoice !== undefined ? overrides.toolChoice : this.toolChoice;
    const params = overrides.params ?? this.params;
    const body = { model: this.model, messages: wireMessages(this.systemPrompt, history, this.sendReasoning) };
    if (tools.length > 0) body.tools = tools;
    if (toolChoice !== null) body.tool_choice = toolChoice;
    if (stream) body.stream = true;
    for (const [key, value] of Object.entries(params)) {
      if (RESERVED.has(key) || (key === "stream_options" && !stream) || value === null) continue;
      body[key] = value;
    }
    return body;
  }

  request(body, signal) {
    return send(joinUrl(this.baseUrl, "chat/completions"), {
      method: "POST",
      headers: headers(this.apiKey),
      body: JSON.stringify(body),
      signal: signalOf(this.timeoutMs, signal),
    });
  }

  /** The reply to `messages` without tools or a response format: for a summary. */
  async askWithoutTools(messages) {
    const params = { ...this.params };
    delete params.response_format;
    // Rejected without tools.
    const toolChoice = this.tools.length > 0 ? "none" : this.toolChoice;
    const response = await this.request(this.body(messages, false, { params, toolChoice }));
    return readJson(response);
  }

  static checkTurn(session) {
    if (session.last()?.role === "assistant") throw OpenAIError.nothingToRespond();
  }

  /** The reply to `session`, added to it. */
  async ask(session, { signal } = {}) {
    AI.checkTurn(session);
    const response = await this.request(this.body(session.history, false), signal);
    const completion = await readJson(response);
    await session.addCompletion(completion, this);
    return completion;
  }

  /**
   * The reply to `session`, streamed: iterate the returned stream for its chunks. Once it ends,
   * the reply is added to the session (and the history summarized, if it grew past its limit).
   * A stream left early adds what came of the reply.
   */
  async stream(session, { signal } = {}) {
    AI.checkTurn(session);
    const response = await this.request(this.body(session.history, true), signal);
    if (!response.ok) throw await errorFromResponse(response);
    return new ChatStream(response, session, this);
  }
}

/** Where the event that ends first in `buffer` ends, and its delimiter's length. */
function findEventEnd(buffer) {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return null;
  if (lf < 0) return [crlf, 4];
  if (crlf < 0) return [lf, 2];
  return lf < crlf ? [lf, 2] : [crlf, 4];
}

/** A reply as it streams in, and the session it is added to once it ends. */
export class ChatStream {
  constructor(response, session, ai) {
    this.response = response;
    this.session = session;
    this.ai = ai;
    this.reply = { id: null, model: null, message: { role: "assistant", content: null }, finishReason: null, usage: null };
    this.indexes = [];
    this.received = false;
    this.added = false;
  }

  /** The reply so far. */
  message() {
    return this.reply.message;
  }

  addChunk(chunk) {
    this.reply.id ??= chunk.id ?? null;
    this.reply.model ??= chunk.model ?? null;
    if (chunk.usage) this.reply.usage = chunk.usage;
    const choice = (chunk.choices ?? []).find((c) => (c.index ?? 0) === 0);
    if (!choice) return false;
    this.apply(choice.delta ?? {});
    if (choice.finish_reason) this.reply.finishReason = choice.finish_reason;
    return true;
  }

  apply(delta) {
    const message = this.reply.message;
    const [content, reasoning, refusal] = texts(delta);
    if (content !== null) message.content = (message.content ?? "") + content;
    if (reasoning !== null) message.reasoning_content = (message.reasoning_content ?? "") + reasoning;
    if (refusal !== null) message.refusal = (message.refusal ?? "") + refusal;
    merge(message, extraOf(delta));
    for (const piece of delta.tool_calls ?? []) {
      const at = piece.index === undefined || piece.index === null ? -1 : this.indexes.indexOf(piece.index);
      const args = argumentsOf(piece.function);
      if (at >= 0) {
        const call = message.tool_calls[at];
        if (call.function.name === "" && piece.function?.name) call.function.name = piece.function.name;
        if (args !== null) call.function.arguments += args;
        const { index: _i, id: _id, function: _f, type: _t, ...rest } = piece;
        merge(call, withValue(rest));
      } else {
        message.tool_calls = message.tool_calls ?? [];
        const call = toolCallOf(piece);
        call.function.arguments = args ?? "";
        message.tool_calls.push(call);
        this.indexes.push(piece.index ?? null);
      }
    }
  }

  completion() {
    return {
      id: this.reply.id,
      model: this.reply.model,
      choices: [{ index: 0, message: this.reply.message, finish_reason: this.reply.finishReason }],
      usage: this.reply.usage,
    };
  }

  parseEvent(event) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (data.length === 0) return null;
    let value;
    try {
      value = JSON.parse(data);
    } catch (e) {
      throw OpenAIError.invalidResponse(`JSON parsing error [${e.message}]: ${data}`);
    }
    if (value && value.error !== undefined && value.choices === undefined) {
      throw OpenAIError.api(null, ApiError.fromValue(value));
    }
    this.received = this.addChunk(value) || this.received;
    return value;
  }

  async *[Symbol.asyncIterator]() {
    const reader = this.response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let ended = false;
    try {
      while (true) {
        const end = findEventEnd(buffer);
        if (end) {
          const [at, length] = end;
          const event = buffer.slice(0, at);
          buffer = buffer.slice(at + length);
          if (event.trim() === "data: [DONE]") {
            ended = true;
            buffer = "";
            continue;
          }
          const chunk = this.parseEvent(event);
          if (chunk !== null) yield chunk;
          continue;
        }
        if (ended) {
          if (buffer.trim().length === 0) break;
          // The last event may not be followed by a blank line.
          buffer += "\n\n";
          continue;
        }
        let read;
        try {
          read = await reader.read();
        } catch (error) {
          throw OpenAIError.http(error);
        }
        if (read.done) {
          ended = true;
          buffer += decoder.decode();
        } else {
          buffer += decoder.decode(read.value, { stream: true });
        }
      }
      if (this.received) {
        this.added = true;
        await this.session.addCompletion(this.completion(), this.ai);
      }
    } finally {
      // A stream left or broken early keeps what came of the reply.
      if (this.received && !this.added) {
        this.added = true;
        this.session.addReply(this.reply.message);
      }
      reader.releaseLock?.();
    }
  }
}

function merge(fields, delta) {
  for (const [key, value] of Object.entries(delta)) {
    if (!(key in fields)) fields[key] = value;
    else if (Array.isArray(fields[key]) && Array.isArray(value)) fields[key].push(...value);
  }
}

// ---- embeddings ----

/** A client of an `/embeddings` endpoint. */
export class EmbeddingsClient {
  constructor(apiKey, model, { timeoutMs = null } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = DEFAULT_BASE_URL;
    this.params = {};
    this.timeoutMs = timeoutMs;
  }

  setBaseUrl(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    return this;
  }

  /** The embeddings of `input`, a text or texts, sorted by index. */
  async embed(input) {
    const body = { model: this.model, input, ...this.params };
    const response = await send(joinUrl(this.baseUrl, "embeddings"), {
      method: "POST",
      headers: headers(this.apiKey),
      body: JSON.stringify(body),
      signal: signalOf(this.timeoutMs),
    });
    const value = await readJson(response);
    const expected = Array.isArray(input) ? input.length : 1;
    const data = Array.isArray(value?.data) ? value.data : null;
    if (!data) throw OpenAIError.invalidResponse(`Unexpected response format: ${JSON.stringify(value)}`);
    if (data.length !== expected) {
      throw OpenAIError.invalidResponse(`Expected ${expected} embeddings, received ${data.length}`);
    }
    const sorted = data.map((d) => ({ embedding: d.embedding, index: d.index ?? 0 })).sort((a, b) => a.index - b.index);
    return { ...value, data: sorted };
  }
}
