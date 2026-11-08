import assert from "node:assert/strict";
import { test } from "node:test";

import { DocumentInput, ErrorKind, IndexError, RetrievalConfig, Retriever } from "context-retriever";
import { HashEmbedder, HeadingChunker, InMemoryStore, ScriptedReranker } from "context-retriever/testing";

import { found, render, search, searchDegraded, todayInIndia } from "../src/ai.js";
import { plan } from "../src/chunker.js";
import { decodeChunk, encodeChunk } from "../src/chunk-db.js";
import { pluginError, refusedKey } from "../src/errors.js";
import { MediaDescriptor } from "../src/media-descriptor.js";
import { ApiError, OpenAIError, Session } from "../src/open-client.js";
import { addDocument, rebuild } from "../src/retriever.js";

const api = (status, code = null) => OpenAIError.api(status, new ApiError("failed", null, null, code));

test("errors are classified by status, and an error in a 200 by its code", () => {
  assert.equal(pluginError("t", api(429)).kind, ErrorKind.RateLimited);
  assert.equal(pluginError("t", api(524)).kind, ErrorKind.Transient);
  assert.equal(pluginError("t", api(401)).kind, ErrorKind.Permanent);
  assert.equal(pluginError("t", api(200, 502)).kind, ErrorKind.Transient);
  assert.equal(pluginError("t", api(200, 429)).kind, ErrorKind.RateLimited);
  assert.equal(pluginError("t", api(200, 400)).kind, ErrorKind.Permanent);
  assert.equal(pluginError("t", api(200)).kind, ErrorKind.Transient);
  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  assert.equal(pluginError("t", OpenAIError.http(timeout)).kind, ErrorKind.Permanent);
  assert.equal(pluginError("t", OpenAIError.http(new TypeError("fetch failed"))).kind, ErrorKind.Transient);
});

test("a refused key is found in the chain", () => {
  const refused = (status) => refusedKey(IndexError.embedder(pluginError("t", api(status))));
  assert.equal(refused(401), 401);
  assert.equal(refused(402), 402);
  assert.equal(refused(403), null);
  assert.equal(refused(500), null);
});

test("the chunker's reply maps to a plan", () => {
  const p = plan({
    groups: [
      { part_starts: [2], inseparable: true, context: "About fees.", topic: "fees" },
      { part_starts: [4, 5, 6], inseparable: false, context: "About staff.", topic: "staff" },
    ],
  });
  assert.deepEqual(p.omittedStarts, []);
  assert.equal(p.groups[0].cohesion, "inseparable");
  assert.deepEqual(p.groups[1].partStarts, [4, 5, 6]);
  assert.equal(p.groups[1].topic, "staff");
});

test("a chunk's wire format keeps its 64-bit fingerprints exact", () => {
  const chunk = {
    id: "a#g0.p0",
    meta: { doc: "a", group: "a#g0", groupOrd: 0, partOrd: 0, groupLen: 1, cohesion: "distinct", stateFp: 18446744073709551615n, contentFp: 1n, chars: 4, metadata: { b: "2", a: "1" } },
    payload: { text: "body", context: "ctx", topic: null, placement: "prepend" },
  };
  const data = encodeChunk(chunk);
  assert.ok(data.includes('"state_fp":18446744073709551615'));
  assert.ok(data.includes('"metadata":{"a":"1","b":"2"}'));
  assert.deepEqual(decodeChunk(chunk.id, data), { ...chunk, meta: { ...chunk.meta, metadata: { a: "1", b: "2" } } });
});

test("a document is rebuilt from its chunks, the split overlap dropped", () => {
  const chunk = (g, p, text) => ({ meta: { groupOrd: g, partOrd: p }, payload: { text } });
  assert.equal(rebuild([chunk(0, 0, "abcdef"), chunk(0, 1, "defghi"), chunk(1, 0, "next")], 3), "abcdefghi\n\nnext");
  assert.equal(rebuild([chunk(0, 0, "one"), chunk(0, 1, "two")], 3), "one\n\ntwo");
});

test("a search finds each document once, with its source", async () => {
  const retriever = Retriever.builder().chunker(new HeadingChunker()).embedder(new HashEmbedder()).store(new InMemoryStore()).build();
  // No media links, so nothing is fetched or described.
  await addDocument(
    retriever,
    new MediaDescriptor("key"),
    fetch,
    "org",
    ["UG", "Fees"],
    "## Tuition\nThe B.Tech fee is two lakh a year.\n\n## Hostel\nThe B.Tech hostel fee is extra.\n",
    "",
    false,
    { source: "https://example.org/fees" },
  );
  await retriever.addDocument(new DocumentInput("UG|Rules", "## Rules\nThe B.Tech hostel closes at ten.\n"), "org");
  const outcome = await retriever.retrieveContext("B.Tech hostel fee", new RetrievalConfig(4));
  assert.equal(outcome.grouped().length, 3);
  const docs = found(outcome).map((d) => [d.doc, d.source ?? null]).sort();
  assert.deepEqual(docs, [["UG|Fees", "https://example.org/fees"], ["UG|Rules", null]]);
  assert.ok(render(outcome).includes("Source: Admin"));
});

test("a search whose reranker fails says so", async () => {
  const retriever = Retriever.builder()
    .chunker(new HeadingChunker())
    .embedder(new HashEmbedder())
    .store(new InMemoryStore())
    .reranker(new ScriptedReranker(0.5).withWrongLenOnCall(0))
    .build();
  await retriever.addDocument(new DocumentInput("UG|Fees", "## Hostel\nThe B.Tech hostel fee is extra.\n"), "org");
  const [passages, ran] = await search(retriever, "hostel fee", new RetrievalConfig(4));
  assert.ok(passages.includes("hostel fee is extra"));
  assert.equal(ran.found.length, 1);
  assert.ok(searchDegraded(ran));
  assert.ok(ran.degradations.some((d) => d.startsWith("RerankCollapsed")), ran.degradations.join());
});

test("the date is India's", () => {
  // 20:00 UTC is 01:30 the next morning in India.
  assert.equal(todayInIndia(new Date("2026-10-28T20:00:00Z")), "Thursday, 29 October 2026");
});

test("a session keeps its tool calls, and summarizes past its limit", async () => {
  const session = new Session(10);
  session.ask("first");
  session.reply({ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "retrieve", arguments: "{}" } }] });
  assert.deepEqual(session.pendingToolCalls().map((c) => c.id), ["c1"]);
  session.addToolResult("c1", "passages");
  assert.deepEqual(session.pendingToolCalls(), []);
  session.reply("answer");
  session.ask("second");
  const ai = { askWithoutTools: async () => ({ choices: [{ message: { role: "assistant", content: "the summary" } }] }) };
  await session.addCompletion({ choices: [{ message: { role: "assistant", content: "reply" } }], usage: { total_tokens: 11 } }, ai);
  assert.equal(session.history.length, 2);
  assert.ok(session.history[0].content.startsWith("<summary_of_earlier_conversation>\nthe summary"));
  const restored = Session.fromJSON(JSON.parse(JSON.stringify(session)));
  assert.deepEqual(restored.history, session.history);
  assert.equal(JSON.parse(JSON.stringify(session)).overflow_handler.limit, 10);
});
