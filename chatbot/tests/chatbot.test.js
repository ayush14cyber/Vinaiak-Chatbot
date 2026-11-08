import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { Session as Chat } from "rag/open-client";

import { passed, previousSession, sign, verifyAndLoadSession } from "../src/auth.js";
import { CallLog, levelOf } from "../src/call-log.js";
import { MAX_IMAGE_BYTES, converse, image, reportOf, userMessage } from "../src/chat.js";
import { ApiError } from "../src/errors.js";
import { MAX_REQUESTS, Session, org, sessionKey } from "../src/session.js";

const SECRET = "test-secret";
const SITE = "https://www.bitmesra.ac.in";
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

test("an expired token of ours continues its session on its org and site", async () => {
  const signed = (orgId, origin, exp, secret) => sign({ org_id: orgId, id: "session", origin, exp, iat: exp - 3600 }, secret);
  const expired = await signed("bit-mesra", SITE, 1_000_000_000, SECRET);
  assert.equal(await previousSession(expired, SECRET, "bit-mesra", SITE), "session");
  assert.equal(await previousSession(expired, SECRET, "other-org", SITE), null);
  assert.equal(await previousSession(expired, SECRET, "bit-mesra", "https://evil.example"), null);
  const forged = await signed("bit-mesra", SITE, 1_000_000_000, "not-our-secret");
  assert.equal(await previousSession(forged, SECRET, "bit-mesra", SITE), null);
  assert.equal(await previousSession("garbage", SECRET, "bit-mesra", SITE), null);
});

test("captcha must be solved on the origin", () => {
  const r = (score, hostname, success = true) => ({ success, score, hostname });
  assert.ok(passed(r(0.9, "www.bitmesra.ac.in"), "www.bitmesra.ac.in"));
  assert.ok(passed(r(0.9, "WWW.BITMESRA.AC.IN"), "www.bitmesra.ac.in"));
  assert.ok(!passed(r(0.9, "evil.example"), "www.bitmesra.ac.in"));
  assert.ok(!passed(r(0.9, undefined), "www.bitmesra.ac.in"));
  assert.ok(!passed(r(0.9, ""), ""));
  assert.ok(!passed(r(0.5, "www.bitmesra.ac.in"), "www.bitmesra.ac.in"));
  assert.ok(!passed(r(0.9, "www.bitmesra.ac.in", false), "www.bitmesra.ac.in"));
});

test("images are taken by their bytes", () => {
  const png = readFileSync(new URL("../testdata/question.png", import.meta.url));
  const labelled = `data:image/jpeg;base64,${b64(png)}`;
  assert.ok(image(labelled).image_url.url.startsWith("data:image/png;base64,iVBOR"));
  const webp = `data:image/webp;base64,${b64(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))}`;
  assert.ok(image(webp).image_url.url.startsWith("data:image/webp;base64,"));
  const tooBig = Buffer.concat([Buffer.from("\x89PNG", "latin1"), Buffer.alloc(MAX_IMAGE_BYTES)]);
  for (const refused of [`data:image/svg+xml;base64,${b64("<svg/>")}`, "https://example.com/photo.png", "data:image/png;base64,not base64!", `data:image/png;base64,${b64(tooBig)}`]) {
    assert.throws(() => image(refused), ApiError, refused.slice(0, 50));
  }
});

test("a message with images has its text first", () => {
  const photo = { type: "image_url", image_url: { url: "data:image/png;base64,aW1n" } };
  assert.equal(userMessage("Hi", []), "Hi");
  assert.deepEqual(userMessage("What is this?", [photo]), [{ type: "text", text: "What is this?" }, photo]);
  assert.deepEqual(userMessage("", [photo]), [photo]);
});

test("starting over forgets the conversation but not the count", () => {
  const s = new Session({ reqCount: 7, allowed: 2 * MAX_REQUESTS, org: org("Test", "unused"), dataNotFound: ["Hostel fee"], etag: '"v1"' });
  s.chat.ask("What is the hostel fee?");
  s.startOver();
  const first = s.conversationId;
  assert.ok(first);
  assert.equal(s.chat.history.length, 0);
  assert.deepEqual(s.dataNotFound, []);
  assert.deepEqual([s.reqCount, s.allowed, s.etag], [7, 2 * MAX_REQUESTS, '"v1"']);
  s.startOver();
  assert.notEqual(s.conversationId, first);
});

test("a session is stored as the Rust chatbot stored it", () => {
  const s = new Session({ org: org("Test", "k") });
  s.chat.ask("Hi");
  const stored = JSON.parse(JSON.stringify(s));
  assert.deepEqual(Object.keys(stored), ["req_count", "allowed", "org", "chat", "data_not_found", "conversation_id"]);
  assert.deepEqual(stored.org, { org_name: "Test", openrouter_key: "k", mongodb_key: null });
  assert.deepEqual(Object.keys(stored.chat), ["history", "message_number", "remember_reply", "overflow_handler"]);
  assert.equal(stored.chat.overflow_handler.limit, 300_000);
  const back = Session.fromJSON({ ...stored, allowed: undefined });
  assert.equal(back.allowed, MAX_REQUESTS, "a session from before resuming");
  assert.deepEqual(back.chat.history, s.chat.history);
});

test("a report keeps what the visitor saw", () => {
  const s = new Session({ org: org("Test", "k"), dataNotFound: ["Hostel fee"] });
  s.chat.ask([{ type: "text", text: "What's this?" }, { type: "image_url", image_url: { url: "data:x" } }]);
  s.chat.reply({ role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "retrieve", arguments: "{}" } }] });
  s.chat.addToolResult("c1", "passages");
  s.chat.reply("It's the fee notice.");
  assert.deepEqual(reportOf({ id: "sess" }, s, 5), {
    session_id: "sess",
    items: ["Hostel fee"],
    conversation: [{ role: "user", text: "What's this?\n[1 image attached]" }, { role: "assistant", text: "It's the fee notice." }],
    reported_at: 5,
  });
});

test("log lines are levelled by how the call ended", () => {
  assert.deepEqual(levelOf({ status: 500 }), ["error", "failed"]);
  assert.deepEqual(levelOf({ status: 200, error: "reset" }), ["error", "failed"]);
  assert.deepEqual(levelOf({ status: 401, error: "expired" }), ["info", "not signed in"]);
  assert.deepEqual(levelOf({ status: 429 }), ["warn", "refused"]);
  assert.deepEqual(levelOf({ status: 200, searches: [{ degradations: ["RerankCollapsed { failed: 1, total: 1 }"] }] }), ["warn", "degraded"]);
  assert.deepEqual(levelOf({ status: 200 }), ["info", "done"]);
});

test("a chat logs once its work is done", () => {
  const lines = [];
  const line = new CallLog("POST", "/chat", (fields) => lines.push(fields));
  line.hold();
  line.hold();
  line.org("bit-mesra");
  line.entry.status = 200;
  line.release();
  assert.equal(lines.length, 0, "written before the chat was done");
  line.chat({ query: "q", images: 0, calls: [], searches: [], retries: [], reply: "r" });
  line.release();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].org, "bit-mesra");
  assert.equal(lines[0].reply, "r");
});

/** An S3 that keeps objects in memory, with ETags and `If-Match`. */
function memoryS3() {
  const objects = new Map();
  let version = 0;
  return {
    objects,
    async send(cmd) {
      const { Key, Body, IfMatch } = cmd.input;
      if (cmd instanceof GetObjectCommand) {
        const o = objects.get(Key);
        if (!o) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
        return { ETag: o.etag, Body: { transformToString: async () => o.body } };
      }
      if (cmd instanceof PutObjectCommand) {
        if (IfMatch !== undefined && objects.has(Key) && objects.get(Key).etag !== IfMatch) {
          throw Object.assign(new Error("PreconditionFailed"), { $metadata: { httpStatusCode: 412 } });
        }
        const etag = `"v${++version}"`;
        objects.set(Key, { etag, body: Body });
        return { ETag: etag };
      }
      throw new Error("unexpected command");
    },
  };
}

test("a session caps its requests, and a token works only on its site", async () => {
  const s3 = memoryS3();
  const configs = { s3, jwtSecret: SECRET };
  s3.objects.set(sessionKey("s1"), { etag: '"v0"', body: JSON.stringify(new Session({ org: org("Test", "k"), reqCount: MAX_REQUESTS - 1 })) });
  const now = Math.floor(Date.now() / 1000);
  const jwt = await sign({ org_id: "test", id: "s1", origin: SITE, exp: now + 3600, iat: now }, SECRET);
  const call = (origin, token = jwt) => verifyAndLoadSession(configs, { headers: { authorization: `Bearer ${token}`, origin } }, new CallLog("POST", "/x", () => {}));
  const claimed = await call(SITE);
  assert.equal(claimed.session.reqCount, MAX_REQUESTS);
  await assert.rejects(call(SITE), (e) => e.code === "TooManyRequests");
  await assert.rejects(call("https://evil.example"), (e) => e.code === "Unauthorized");
  const gone = await sign({ org_id: "test", id: "gone", origin: SITE, exp: now + 3600, iat: now }, SECRET);
  await assert.rejects(call(SITE, gone), (e) => e.code === "Unauthorized");
  const old = await sign({ org_id: "test", id: "s1", origin: SITE, exp: now - 7200, iat: now - 9000 }, SECRET);
  await assert.rejects(call(SITE, old), (e) => e.message.includes("ExpiredSignature"));
});

/** A model that answers from `rounds`, each the chunks of one streamed reply. */
function scriptedAI(rounds, { failFirst = 0 } = {}) {
  let fails = failFirst;
  return {
    async stream(session) {
      if (fails-- > 0) throw Object.assign(new Error("error sending request: connection reset"), { kind: "http" });
      const chunks = rounds.shift();
      const message = { role: "assistant", content: null };
      return {
        message: () => message,
        async *[Symbol.asyncIterator]() {
          for (const delta of chunks) {
            if (delta.content) message.content = (message.content ?? "") + delta.content;
            if (delta.tool_calls) message.tool_calls = delta.tool_calls;
            yield { choices: [{ index: 0, delta }] };
          }
          session.reply(message);
        },
      };
    },
  };
}

test("a chat streams its reply and tools, then saves the conversation and its report", async () => {
  const s3 = memoryS3();
  const session = new Session({ org: org("BIT", "k") });
  await s3.send(new PutObjectCommand({ Key: sessionKey("s1"), Body: JSON.stringify(session) }));
  session.etag = s3.objects.get(sessionKey("s1")).etag;
  const calls = [
    { id: "c1", type: "function", function: { name: "data_not_found", arguments: '{"items":["Hostel fee"]}' } },
    { id: "c2", type: "function", function: { name: "offer_options", arguments: '{"options":["Fees","Hostel"]}' } },
  ];
  const ai = scriptedAI([[{ tool_calls: calls }], [{ content: "I couldn't find it." }]], { failFirst: 1 });
  const events = [];
  const trace = { query: "Hostel fee?", images: 0, calls: [], searches: [], retries: [], reply: "" };
  await converse({ s3 }, { id: "s1", org_id: "bit" }, session, "Hostel fee?", (e) => events.push(e), trace, { ai, retriever: {} });
  assert.deepEqual(events.map((e) => e.type), ["function_call", "function_call", "function_response", "function_response", "text", "options"]);
  assert.deepEqual(events.at(-1).options, ["Fees", "Hostel"]);
  assert.equal(trace.reply, "I couldn't find it.");
  assert.equal(trace.retries.length, 1);
  assert.deepEqual(trace.calls[0], { name: "data_not_found", args: { items: ["Hostel fee"] } });
  const saved = Session.fromJSON(JSON.parse(s3.objects.get(sessionKey("s1")).body));
  assert.equal(saved.chat.history.length, 5);
  assert.deepEqual(saved.dataNotFound, ["Hostel fee"]);
  const report = JSON.parse(s3.objects.get("data-not-found/bit/s1.json").body);
  assert.deepEqual(report.items, ["Hostel fee"]);
  assert.equal(report.conversation[0].text, "Hostel fee?");
});

test("a chat stops after the most rounds", async () => {
  const s3 = memoryS3();
  const session = new Session({ org: org("BIT", "k") });
  await s3.send(new PutObjectCommand({ Key: sessionKey("s2"), Body: "{}" }));
  session.etag = s3.objects.get(sessionKey("s2")).etag;
  let n = 0;
  const round = () => [{ tool_calls: [{ id: `c${n++}`, type: "function", function: { name: "nope", arguments: "{}" } }] }];
  const ai = scriptedAI(Array.from({ length: 10 }, round));
  const events = [];
  await converse({ s3 }, { id: "s2", org_id: "bit" }, session, "q", (e) => events.push(e), { calls: [], searches: [], retries: [], reply: "" }, { ai, retriever: {} });
  assert.equal(events.filter((e) => e.type === "function_response").length, 5);
});

test("chat history from the stored session reads back", () => {
  const chat = Chat.fromJSON({ history: [{ role: "user", content: "x" }], message_number: 1, remember_reply: true, overflow_handler: { limit: 300000 } });
  assert.equal(chat.length, 1);
});
