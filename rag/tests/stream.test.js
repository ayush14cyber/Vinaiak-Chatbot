import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { AI, Session } from "../src/open-client.js";

/** A server streaming `events` as server-sent events, and the bodies it was sent. */
async function streaming(events) {
  const bodies = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      bodies.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const e of events) res.write(`data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  server.unref();
  return [`http://127.0.0.1:${server.address().port}`, bodies];
}

test("a streamed reply with tool calls in pieces is added to the session", async () => {
  const [url, bodies] = await streaming([
    { choices: [{ index: 0, delta: { content: "Let me " } }] },
    { choices: [{ index: 0, delta: { content: "check." } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "retrieve", arguments: '{"que' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"fees"}' } }] }, finish_reason: "tool_calls" }] },
    { choices: [], usage: { total_tokens: 5 } },
    "[DONE]",
  ]);
  const ai = new AI("key", "m", "sys").setBaseUrl(url).setTools([{ type: "function", function: { name: "retrieve" } }]);
  const session = new Session();
  session.ask("fees?");
  const stream = await ai.stream(session);
  let text = "";
  for await (const chunk of stream) text += chunk.choices?.[0]?.delta?.content ?? "";
  assert.equal(text, "Let me check.");
  assert.equal(bodies[0].stream, true);
  assert.deepEqual(bodies[0].stream_options, { include_usage: true });
  assert.equal(bodies[0].messages[0].role, "system");
  const last = session.last();
  assert.equal(last.content, "Let me check.");
  assert.deepEqual(last.tool_calls, [{ id: "c1", type: "function", function: { name: "retrieve", arguments: '{"query":"fees"}' } }]);
  assert.deepEqual(session.pendingToolCalls().map((c) => c.id), ["c1"]);
});

test("an error event in a stream is an API error", async () => {
  const [url] = await streaming([{ choices: [{ index: 0, delta: { content: "a" } }] }, { error: { message: "provider died", code: 502 } }]);
  const session = new Session();
  session.ask("q");
  const stream = await new AI("k", "m").setBaseUrl(url).stream(session);
  await assert.rejects(async () => {
    for await (const _ of stream) {
      // reading
    }
  }, (e) => e.kind === "api" && e.status === null && e.apiError.code === 502);
  // What came of the reply is kept.
  assert.equal(session.last().content, "a");
});
