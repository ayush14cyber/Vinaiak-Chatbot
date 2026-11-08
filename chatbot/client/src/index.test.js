import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Chatbot, ChatbotError } from "./index.js";

/**
 * @typedef {{ path: string; headers: Record<string, string>; body: unknown }} Call
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answers each call with the next of `answers`, and records the calls. */
function mockFetch(answers) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({
      path: new URL(String(input)).pathname,
      headers: init?.headers,
      body: JSON.parse(String(init?.body)),
    });
    const answer = answers.shift();
    if (!answer) throw new Error(`unexpected call to ${String(input)}`);
    return answer;
  };
  return calls;
}

const now = () => Math.floor(Date.now() / 1000);

function jwt(exp) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "HS256" })}.${part({ org_id: "bit-mesra", exp })}.signature`;
}

function login(token = jwt(now() + 3600), resumed = false) {
  return new Response(JSON.stringify({ token, resumed }));
}

function ndjson(...events) {
  return events.map((event) => `${JSON.stringify(event)}\n`).join("");
}

/** A body that arrives in `chunks`. */
function streamed(...chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

const reply = () => new Response(ndjson({ type: "text", text: "Hi" }, { type: "done" }));

function failure(status, code, message) {
  return new Response(JSON.stringify({ code, message }), { status });
}

function chatbot(options = {}) {
  return new Chatbot({
    apiUrl: "https://chat.example/",
    orgId: "bit-mesra",
    captcha: async () => "captcha-token",
    ...options,
  });
}

test("streams the reply to the handlers and resolves with it", async () => {
  const bytes = new TextEncoder().encode(
    ndjson(
      { type: "text", text: "Let me look. " },
      { type: "function_call", name: "retrieve" },
      { type: "function_response", name: "retrieve" },
      { type: "text", text: "The fee is ₹21,000." },
      { type: "options", options: ["Hostel fees"] },
      { type: "done" },
    ),
  );
  // Split inside a line, and inside "₹", whose three bytes start with 0xE2.
  const rupee = bytes.indexOf(0xe2);
  const token = jwt(now() + 3600);
  const calls = mockFetch([
    login(token),
    new Response(streamed(bytes.slice(0, 7), bytes.slice(7, rupee + 1), bytes.slice(rupee + 1))),
  ]);
  const seen = [];

  const answer = await chatbot().chat("What is the fee?", {
    onText: (text) => seen.push(`text ${text}`),
    onFunctionCall: (name) => seen.push(`call ${name}`),
    onFunctionResponse: (name) => seen.push(`response ${name}`),
    onOptions: (options) => seen.push(`options ${options.join("|")}`),
  });

  assert.deepEqual(seen, [
    "text Let me look. ",
    "call retrieve",
    "response retrieve",
    "text The fee is ₹21,000.",
    "options Hostel fees",
  ]);
  assert.deepEqual(answer, { text: "Let me look. The fee is ₹21,000.", options: ["Hostel fees"] });
  assert.deepEqual(calls[0], {
    path: "/login",
    headers: { "content-type": "application/json" },
    body: { org_id: "bit-mesra", google_captcha_token: "captcha-token" },
  });
  assert.deepEqual(calls[1], {
    path: "/chat",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: { query: "What is the fee?" },
  });
});

test("signs in once while the token lasts, and again before it expires", async () => {
  const lasting = mockFetch([login(), reply(), reply()]);
  const bot = chatbot();
  await bot.chat("one");
  await bot.chat("two");
  assert.deepEqual(
    lasting.map((call) => call.path),
    ["/login", "/chat", "/chat"],
  );

  const expiring = mockFetch([login(jwt(now() + 10)), reply(), login(), reply()]);
  const another = chatbot();
  await another.chat("one");
  await another.chat("two");
  assert.deepEqual(
    expiring.map((call) => call.path),
    ["/login", "/chat", "/login", "/chat"],
  );
});

test("an error mid-reply rejects with ChatFailed", async () => {
  mockFetch([
    login(),
    new Response(
      ndjson({ type: "text", text: "Part" }, { type: "error", message: "Something went wrong." }),
    ),
  ]);
  await assert.rejects(chatbot().chat("q"), {
    name: "ChatbotError",
    code: "ChatFailed",
    message: "Something went wrong.",
  });
});

test("a reply that stops before done rejects with CutOff", async () => {
  mockFetch([login(), new Response(ndjson({ type: "text", text: "Part" }))]);
  await assert.rejects(chatbot().chat("q"), { code: "CutOff" });
});

test("the API's failure becomes a ChatbotError with its code", async () => {
  mockFetch([login(), failure(400, "BadRequest", "Ask a question of at most 2000 characters")]);
  await assert.rejects(chatbot().chat("q"), (error) => {
    assert.ok(error instanceof ChatbotError);
    assert.equal(error.status, 400);
    assert.equal(error.code, "BadRequest");
    assert.equal(error.message, "Ask a question of at most 2000 characters");
    return true;
  });
});

test("a refused message signs in again with the token and goes again", async () => {
  for (const refusal of [
    failure(401, "Unauthorized", "Unauthorized"),
    failure(429, "TooManyRequests", "This chat has reached its message limit"),
  ]) {
    const first = jwt(now() + 3600);
    const second = jwt(now() + 3600 + 1);
    const calls = mockFetch([login(first), refusal, login(second, true), reply()]);
    const logins = [];
    const bot = chatbot({ onLogin: (_, resumed) => logins.push(resumed) });
    assert.equal((await bot.chat("one")).text, "Hi");
    assert.deepEqual(
      calls.map((call) => [call.path, call.headers.authorization]),
      [
        ["/login", undefined],
        ["/chat", `Bearer ${first}`],
        ["/login", `Bearer ${first}`],
        ["/chat", `Bearer ${second}`],
      ],
    );
    assert.deepEqual(logins, [false, true]);
  }
});

test("a message refused after signing in again rejects", async () => {
  const limit = () => failure(429, "TooManyRequests", "Too many messages at once");
  mockFetch([login(), limit(), login(), limit()]);
  await assert.rejects(chatbot().chat("one"), { status: 429, code: "TooManyRequests" });
});

test("a kept token is used while it lasts", async () => {
  const token = jwt(now() + 3600);
  const calls = mockFetch([reply()]);
  const bot = chatbot({ token });
  assert.equal(bot.signedIn, true);
  await bot.chat("again");
  assert.deepEqual(calls[0].headers.authorization, `Bearer ${token}`);
});

test("an expired kept token signs in with it, to continue its conversation", async () => {
  const old = jwt(now() - 60);
  const fresh = jwt(now() + 3600);
  const calls = mockFetch([login(fresh, true), reply()]);
  const logins = [];
  const bot = chatbot({ token: old, onLogin: (token, resumed) => logins.push([token, resumed]) });
  assert.equal(bot.signedIn, false);
  await bot.chat("again");
  assert.equal(calls[0].path, "/login");
  assert.equal(calls[0].headers.authorization, `Bearer ${old}`);
  assert.equal(calls[1].headers.authorization, `Bearer ${fresh}`);
  assert.deepEqual(logins, [[fresh, true]]);

  mockFetch([login(jwt(now() + 3600), false)]);
  assert.equal(await chatbot({ token: old }).login(), false);
});

test("a kept token that isn't a JWT is ignored", async () => {
  const calls = mockFetch([login(), reply()]);
  await chatbot({ token: "not-a-jwt" }).chat("q");
  assert.equal(calls[0].headers.authorization, undefined);
});

test("a reset starts a new conversation on the same token", async () => {
  const token = jwt(now() + 3600);
  const calls = mockFetch([new Response(null, { status: 204 }), reply()]);
  const bot = chatbot({ token });
  assert.equal(await bot.reset(), true);
  await bot.chat("again");
  assert.deepEqual(
    calls.map((call) => [call.path, call.headers.authorization]),
    [
      ["/reset", `Bearer ${token}`],
      ["/chat", `Bearer ${token}`],
    ],
  );
});

test("a reset the chatbot refused drops the token, so the next message starts afresh", async () => {
  const calls = mockFetch([failure(429, "TooManyRequests", "Limit"), login(), reply()]);
  const bot = chatbot({ token: jwt(now() + 3600) });
  assert.equal(await bot.reset(), false);
  await bot.chat("again");
  assert.deepEqual(
    calls.map((call) => call.path),
    ["/reset", "/login", "/chat"],
  );
  assert.equal(calls[1].headers.authorization, undefined);

  // An expired token isn't sent to be reset, and can't continue the conversation either.
  const expired = mockFetch([login(), reply()]);
  const later = chatbot({ token: jwt(now() - 60) });
  assert.equal(await later.reset(), false);
  await later.chat("again");
  assert.equal(expired[0].path, "/login");
  assert.equal(expired[0].headers.authorization, undefined);
});

test("images go along with the text", async () => {
  const calls = mockFetch([login(), reply()]);
  const photo = "data:image/jpeg;base64,/9j/";
  await chatbot().chat({ text: "What is this form?", images: [photo] });
  assert.deepEqual(calls[1].body, { query: "What is this form?", images: [photo] });
});

test("an unreachable API is a NetworkError", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(chatbot().login(), { code: "NetworkError", status: 0 });
});
