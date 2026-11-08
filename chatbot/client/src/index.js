/**
 * One line of `/chat`'s answer.
 * @typedef {| { type: "text"; text: string }
 *   | { type: "function_call"; name: string }
 *   | { type: "function_response"; name: string }
 *   | { type: "options"; options: string[] }
 *   | { type: "done" }
 *   | { type: "error"; message: string }} ChatEvent
 */

/**
 * Called as the reply comes.
 * @typedef {{
 *   // The next piece of the reply, which is markdown.
 *   onText?(text: string): void;
 *   // The assistant is calling the tool `name`, e.g. `retrieve` while it searches the documents.
 *   onFunctionCall?(name: string): void;
 *   // The tool `name` answered the assistant.
 *   onFunctionResponse?(name: string): void;
 *   // Replies the visitor is likely to send next, to show as buttons. Send the one picked as the next query.
 *   onOptions?(options: string[]): void;
 * }} ChatHandlers
 */

/**
 * A message to the chatbot: text, images it reads itself, or both.
 * @typedef {{
 *   text: string;
 *   // `data:` URLs of PNG, JPEG, WebP or GIF images: at most 3, of at most 1 MB each.
 *   images?: string[];
 * }} Question
 */

/**
 * A complete reply.
 * @typedef {{ text: string; options: string[] }} Reply
 */

/**
 * @typedef {{
 *   // The chatbot API, e.g. its Lambda Function URL.
 *   apiUrl: string;
 *   // The org whose chatbot this is. Its admin lists the sites it may be embedded on.
 *   orgId: string;
 *   // A reCAPTCHA v3 token, e.g. `() => grecaptcha.execute(siteKey, { action: "login" })`.
 *   captcha(): Promise<string>;
 *   // A token an earlier sign-in gave `onLogin`, to continue its conversation.
 *   token?: string | null;
 *   // Called on each sign-in with its token, to keep for `token`, and whether it continued the
 * // conversation of the token before. If it didn't, the chatbot remembers none of it.
 *   onLogin?(token: string, resumed: boolean): void;
 * }} ChatbotOptions
 */

/**
 * A failed call. `code` is the API's, e.g. `CaptchaFailed`, or `TooManyRequests` when a message
 * was refused even after signing in again, or this library's: `NetworkError`, `ChatFailed` when
 * the assistant failed mid-reply, and `CutOff` when the reply stopped coming.
 */
export class ChatbotError extends Error {
  status;
  code;

  constructor(status, code, message) {
    super(message);
    this.name = "ChatbotError";
    this.status = status;
    this.code = code;
  }
}

/** Signs in before a token expires within this many seconds, so a message doesn't outlive it. */
const EXPIRY_MARGIN = 30;

/**
 * An org's chatbot. A sign-in lasts an hour and allows 50 messages; `chat()` signs in again after
 * either, which continues the conversation while the chatbot keeps it: at least a day after its
 * last message.
 */
export class Chatbot {
  #options;
  #token = null;
  /** Unix seconds when `#token` expires. */
  #expires = 0;

  constructor(options) {
    this.#options = { ...options, apiUrl: options.apiUrl.replace(/\/+$/, "") };
    if (options.token) {
      try {
        this.#expires = expiry(options.token);
        this.#token = options.token;
      } catch {
        // Not a token of ours: the first message signs in afresh.
      }
    }
  }

  /**
   * Passes the captcha and signs in, continuing the conversation if there is one. Resolves with
   * whether it did; otherwise a new one starts.
   */
  async login() {
    const { apiUrl, orgId, captcha, onLogin } = this.#options;
    const res = await call(
      `${apiUrl}/login`,
      { org_id: orgId, google_captcha_token: await captcha() },
      this.#token ?? undefined,
    );
    const { token, resumed } = await res.json();
    this.#token = token;
    this.#expires = expiry(token);
    onLogin?.(token, resumed);
    return resumed;
  }

  /** Whether `chat()` would sign in first. */
  get signedIn() {
    return this.#token !== null && Date.now() / 1000 <= this.#expires - EXPIRY_MARGIN;
  }

  /**
   * Starts a new conversation: the chatbot forgets this one, and the token goes on with the next.
   * Resolves with whether it did. If it couldn't, e.g. once the token expired, it drops the token
   * instead, so the next message signs in to a new conversation: forget the kept token too.
   */
  async reset() {
    if (this.signedIn) {
      try {
        await call(`${this.#options.apiUrl}/reset`, {}, this.#token ?? undefined);
        return true;
      } catch {
        // Dropped below, which starts a new conversation all the same.
      }
    }
    this.#token = null;
    return false;
  }

  /** Sends `query`, calling `handlers` as the reply comes, and resolves with the whole reply. */
  async chat(query, handlers = {}) {
    const { text, images = [] } = typeof query === "string" ? { text: query } : query;
    const body = images.length ? { query: text, images } : { query: text };
    const send = () => call(`${this.#options.apiUrl}/chat`, body, this.#token ?? undefined);
    if (!this.signedIn) await this.login();
    let res;
    try {
      res = await send();
    } catch (error) {
      // The sign-in ran out by the chatbot's clock, which may be ahead of this one, or its messages
      // did. Signing in again with it continues the conversation, or starts a new one if the
      // chatbot no longer has it; either way the message goes again.
      const refused =
        error instanceof ChatbotError && (error.status === 401 || error.status === 429);
      if (!refused) throw error;
      await this.login();
      res = await send();
    }
    const reply = { text: "", options: [] };
    for await (const event of events(res)) {
      switch (event.type) {
        case "text":
          reply.text += event.text;
          handlers.onText?.(event.text);
          break;
        case "function_call":
          handlers.onFunctionCall?.(event.name);
          break;
        case "function_response":
          handlers.onFunctionResponse?.(event.name);
          break;
        case "options":
          reply.options = event.options;
          handlers.onOptions?.(event.options);
          break;
        case "done":
          return reply;
        case "error":
          throw new ChatbotError(res.status, "ChatFailed", event.message);
      }
    }
    throw new ChatbotError(res.status, "CutOff", "The reply was cut off. Please try again.");
  }
}

/** POSTs `body` as JSON. Throws `ChatbotError` unless the API answers 2xx. */
async function call(url, body, token) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  } catch {
    throw new ChatbotError(0, "NetworkError", "Can't reach the chatbot. Check your connection.");
  }
  if (res.ok) return res;
  const failure = await res.json().catch(() => null);
  throw new ChatbotError(
    res.status,
    typeof failure?.code === "string" ? failure.code : "HttpError",
    typeof failure?.message === "string" ? failure.message : `The chatbot answered ${res.status}.`,
  );
}

/** The events of `res`, one JSON object per line, as they come. */
async function* events(res) {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { done, value } = await reader.read();
    // A character can be split between chunks; `stream` keeps its first bytes for the next one.
    buffered += decoder.decode(value, { stream: !done });
    let end;
    while ((end = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, end).trim();
      buffered = buffered.slice(end + 1);
      if (line) yield JSON.parse(line);
    }
    if (done) break;
  }
  if (buffered.trim()) yield JSON.parse(buffered);
}

/** When `token`, a JWT, expires, in Unix seconds. */
function expiry(token) {
  const payload = token.split(".")[1] ?? "";
  const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
  const { exp } = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));

  return exp;
}
