// Behavioural tests for the engine, against the in-memory doubles. Each test names the property
// it protects; where one proves a mechanism, it runs the negative control too.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ChunkPlan,
  Cohesion,
  ContextPlacement,
  DocumentInput,
  IndexError,
  IndexStatus,
  RetrievalConfig,
  RetrieveError,
  Retriever,
  Selection,
  describeDegradation,
} from "../src/index.js";
import {
  HashEmbedder,
  HeadingChunker,
  InMemoryStore,
  KeywordReranker,
  OneClient,
  Script,
  ScriptedChunker,
  ScriptedReranker,
} from "../src/testing.js";

// ---- fixtures ----

function build(store, embedder, chunker, reranker = null) {
  let builder = Retriever.builder()
    .chunker(chunker)
    .embedder(embedder)
    .store(store)
    // Fixture parts are a few words each, so packing is switched off the documented way.
    .indexConfig({ budget: { minChars: 4, targetChars: 4 } });
  if (reranker) builder = builder.reranker(reranker);
  return { retriever: builder.build(), store, embedder };
}

/** Heading-chunked, keyword-reranked, in-memory. The default rig. */
const rig = () => build(new InMemoryStore(), new HashEmbedder(), new HeadingChunker(), new KeywordReranker());

const doc = (id, text) => new DocumentInput(id, text);
const planParts = (context, cohesion, parts) => new Script().group(context, cohesion, parts);
const idsOf = (outcome) => outcome.chunks.map((c) => c.chunk.id);
const kinds = (degradations) => degradations.map((d) => d.kind);
const sections = (n, body = (i) => `admission text number ${i}`) =>
  Array.from({ length: n }, (_, i) => `## Section ${i}\n${body(i)}\n`).join("");

// ---- indexing: agentic chunking and contextualization ----

test("a topical document yields one distinct group per section", async () => {
  const f = rig();
  const outcome = await f.retriever.addDocument(doc("d1", "## Fees\ntuition text\n## Hostel\nroom text\n"));
  assert.equal(outcome.groups, 2);
  assert.equal(outcome.inseparableGroups, 0);
  assert.deepEqual(f.store.ids(), ["d1#g0.p0", "d1#g1.p0"]);
  assert.match(f.store.chunk("d1#g0.p0").payload.context, /Fees/);
});

test("an indivisible document shares one context and one group", async () => {
  const script = planParts("Fee table", Cohesion.Inseparable, ["row one", "row two", "row three"]);
  const f = build(new InMemoryStore(), new HashEmbedder(), new ScriptedChunker().withPlan("t", script.plan()));
  const outcome = await f.retriever.addDocument(script.doc("t"));
  assert.equal(outcome.groups, 1);
  assert.equal(outcome.inseparableGroups, 1);
  const chunks = f.store.ids().map((id) => f.store.chunk(id));
  assert.equal(chunks.length, 3);
  for (const c of chunks) {
    assert.equal(c.meta.group, "t#g0");
    assert.equal(c.meta.groupLen, 3);
    assert.equal(c.payload.context, chunks[0].payload.context);
  }
});

test("an oversized part is split, inheriting context, and forced inseparable", async () => {
  const long = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} about fees.`).join(" ");
  const script = planParts("Fees", Cohesion.Distinct, [long]);
  const f = build(new InMemoryStore(), new HashEmbedder(), new ScriptedChunker().withPlan("d", script.plan()));
  const outcome = await f.retriever.addDocument(script.doc("d"));
  assert.ok(outcome.oversizedPartsSplit >= 1);
  const chunks = f.store.ids().map((id) => f.store.chunk(id));
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.equal(c.meta.cohesion, Cohesion.Inseparable);
    assert.ok(c.meta.chars <= 4000);
    assert.equal(c.payload.context, chunks[0].payload.context);
  }
});

test("an empty context falls back to the breadcrumb, then the document id", async () => {
  const script = planParts("   ", Cohesion.Distinct, ["body text"]);
  const f = build(new InMemoryStore(), new HashEmbedder(), new ScriptedChunker().withPlan("d", script.plan()));
  await f.retriever.addDocument(script.doc("d").withBreadcrumb(["BIT", "UG"]));
  assert.equal(f.store.chunk("d#g0.p0").payload.context, "BIT -> UG\nBIT -> UG");
  await f.retriever.removeDocument("d");
  await f.retriever.addDocument(script.doc("d"));
  assert.equal(f.store.chunk("d#g0.p0").payload.context, "d");
});

test("context is woven in exactly once per placement", async () => {
  for (const [placement, expected] of [
    [ContextPlacement.Prepend, "ctx\n\nbody text"],
    [ContextPlacement.Append, "body text\n\nctx"],
    [ContextPlacement.Both, "ctx\n\nbody text\n\nctx"],
    [ContextPlacement.None, "body text"],
  ]) {
    const embedder = new HashEmbedder();
    const script = planParts("ctx", Cohesion.Distinct, ["body text"]);
    const retriever = Retriever.builder()
      .chunker(new ScriptedChunker().withPlan("d", script.plan()))
      .embedder(embedder)
      .store(new InMemoryStore())
      .indexConfig({ contextPlacement: placement })
      .build();
    await retriever.addDocument(script.doc("d"));
    assert.deepEqual(embedder.seen(), [expected], placement);
  }
});

test("re-indexing an unchanged document makes no model calls", async () => {
  const f = rig();
  const text = "## Fees\ntuition text\n## Hostel\nroom text\n";
  await f.retriever.addDocument(doc("d1", text));
  const calls = f.embedder.callCount();
  const again = await f.retriever.addDocument(doc("d1", text));
  assert.equal(again.status, IndexStatus.Unchanged);
  assert.equal(f.embedder.callCount(), calls);
  assert.equal(again.chunksReused, 2);
});

test("editing one section re-embeds only that slot", async () => {
  const f = rig();
  await f.retriever.addDocument(doc("d1", "## A\nalpha\n## B\nbeta\n## C\ngamma\n"));
  const calls = f.embedder.callCount();
  const edited = await f.retriever.addDocument(doc("d1", "## A\nalpha\n## B\nBETA changed\n## C\ngamma\n"));
  assert.equal(edited.chunksUpserted, 1);
  assert.equal(edited.chunksReused, 2);
  assert.equal(f.embedder.callCount() - calls, 1);
});

test("a regrown group updates groupLen on every part", async () => {
  const two = planParts("ctx", Cohesion.Inseparable, ["aaa text", "bbb text"]);
  const three = planParts("ctx", Cohesion.Inseparable, ["aaa text", "bbb text", "ccc text"]);
  const store = new InMemoryStore();
  const embedder = new HashEmbedder();
  await build(store, embedder, new ScriptedChunker().withPlan("d", two.plan())).retriever.addDocument(two.doc("d"));
  const outcome = await build(store, embedder, new ScriptedChunker().withPlan("d", three.plan())).retriever.addDocument(
    three.doc("d"),
  );
  // The fingerprint covers groupLen, so the unchanged parts are written again too.
  assert.equal(outcome.chunksUpserted, 3);
  for (const id of store.ids()) assert.equal(store.chunk(id).meta.groupLen, 3);
});

test("changing the embedder fingerprint forces a full re-embed", async () => {
  const store = new InMemoryStore();
  const text = "## A\nalpha\n## B\nbeta\n";
  await build(store, new HashEmbedder(), new HeadingChunker()).retriever.addDocument(doc("d", text));
  const outcome = await build(store, new HashEmbedder().withFingerprint("hash/v2"), new HeadingChunker()).retriever.addDocument(
    doc("d", text),
  );
  assert.equal(outcome.chunksUpserted, 2);
  assert.equal(outcome.chunksReused, 0);
});

test("writes precede deletes", async () => {
  const three = planParts("ctx", Cohesion.Inseparable, ["aaa text", "bbb text", "ccc text"]);
  const one = planParts("ctx", Cohesion.Inseparable, ["aaa text"]);
  const store = new InMemoryStore();
  const embedder = new HashEmbedder();
  await build(store, embedder, new ScriptedChunker().withPlan("d1", three.plan())).retriever.addDocument(three.doc("d1"));
  store.resetCalls();
  const outcome = await build(store, embedder, new ScriptedChunker().withPlan("d1", one.plan())).retriever.addDocument(
    one.doc("d1"),
  );
  assert.equal(outcome.staleDeleted, 2, "two slots are no longer used");
  const calls = store.calls();
  const firstUpsert = calls.findIndex((c) => c.op === "upsert");
  const firstDelete = calls.findIndex((c) => c.op === "delete");
  assert.ok(firstUpsert >= 0 && firstDelete >= 0 && firstUpsert < firstDelete, JSON.stringify(calls));
  assert.equal(store.ids().length, 1, "only the live slot remains");
});

test("an embed failure writes nothing", async () => {
  const store = new InMemoryStore();
  const f = build(store, new HashEmbedder().failingBatch(0), new HeadingChunker());
  await assert.rejects(f.retriever.addDocument(doc("d1", "## A\nalpha")), (e) => e instanceof IndexError && e.code === "Embedder");
  assert.equal(store.size, 0);
});

test("a partial upsert writes what embedded, reports the rest, and converges", async () => {
  const store = new InMemoryStore();
  const f = build(store, new HashEmbedder().failingBatch(1), new HeadingChunker());
  const text = "## A\nalpha\n## B\nbeta\n## C\ngamma\n";
  const outcome = await f.retriever.addDocument(doc("d1", text), null, { partialUpsertOnEmbedFailure: true });
  assert.equal(outcome.status, IndexStatus.Indexed);
  assert.equal(outcome.degradations.find((d) => d.kind === "EmbedFailed").count, 1);
  assert.equal(store.ids().length, 2);
  const retry = await build(store, new HashEmbedder(), new HeadingChunker()).retriever.addDocument(doc("d1", text));
  assert.equal(retry.chunksUpserted, 1);
  assert.equal(store.ids().length, 3);
});

test("a failed write deletes nothing", async () => {
  const three = planParts("ctx", Cohesion.Inseparable, ["aaa text here", "bbb text here", "ccc text here"]);
  const one = planParts("ctx", Cohesion.Inseparable, ["zzz new text"]);
  const store = new InMemoryStore();
  const embedder = new HashEmbedder();
  await build(store, embedder, new ScriptedChunker().withPlan("d1", three.plan())).retriever.addDocument(three.doc("d1"));
  const before = store.ids();
  const failing = new InMemoryStore().failingUpsertAfter(0);
  for (const id of before) failing.seed(store.chunk(id), new Array(64).fill(0));
  const f = build(failing, embedder, new ScriptedChunker().withPlan("d1", one.plan()));
  await assert.rejects(f.retriever.addDocument(one.doc("d1")), (e) => e.code === "Store");
  assert.deepEqual(failing.ids(), before);
  assert.ok(!failing.calls().some((c) => c.op === "delete"));
});

test("a failed cleanup is reported and converges on retry", async () => {
  const three = planParts("ctx", Cohesion.Inseparable, ["aaa text", "bbb text", "ccc text"]);
  const one = planParts("ctx", Cohesion.Inseparable, ["aaa text"]);
  const store = new InMemoryStore();
  const embedder = new HashEmbedder();
  await build(store, embedder, new ScriptedChunker().withPlan("d1", three.plan())).retriever.addDocument(three.doc("d1"));
  store.failDelete = true;
  const f = build(store, embedder, new ScriptedChunker().withPlan("d1", one.plan()));
  const failed = await f.retriever.addDocument(one.doc("d1"));
  assert.equal(failed.status, IndexStatus.Indexed);
  assert.ok(kinds(failed.degradations).includes("StaleCleanupFailed"));
  store.failDelete = false;
  const retried = await f.retriever.addDocument(one.doc("d1"));
  assert.equal(retried.staleDeleted, 2);
  assert.deepEqual(store.ids(), ["d1#g0.p0"]);
  const settled = await f.retriever.addDocument(one.doc("d1"));
  assert.equal(settled.status, IndexStatus.Unchanged);
});

test("removeDocument deletes every chunk", async () => {
  const f = rig();
  await f.retriever.addDocument(doc("d1", "## A\nalpha\n## B\nbeta\n"));
  await f.retriever.addDocument(doc("d2", "## C\ngamma\n"));
  const outcome = await f.retriever.removeDocument("d1");
  assert.equal(outcome.status, IndexStatus.Deleted);
  assert.equal(outcome.staleDeleted, 2);
  assert.deepEqual(f.store.ids(), ["d2#g0.p0"]);
});

test("a chunker failure falls back to a size split with a shared context", async () => {
  const store = new InMemoryStore();
  const f = build(store, new HashEmbedder(), new ScriptedChunker().failingFor("d1"));
  const outcome = await f.retriever.addDocument(doc("d1", "alpha beta gamma").withBreadcrumb(["BIT", "UG"]));
  assert.ok(outcome.usedChunkerFallback);
  assert.ok(kinds(outcome.degradations).includes("ChunkerFallbackUsed"));
  assert.equal(store.chunk("d1#g0.p0").meta.cohesion, Cohesion.Inseparable);
  await assert.rejects(
    f.retriever.addDocument(doc("d1", "alpha"), null, { fallbackOnChunkerError: false }),
    (e) => e.code === "Chunker",
  );
});

test("omitted lines are not indexed and are reported exactly", async () => {
  const header = "[Home](/) [Login](/login)";
  const footer = "© 2026 BIT Mesra. All rights reserved.";
  const script = new Script()
    .omitted(header)
    .group("BIT Mesra fees", Cohesion.Distinct, ["tuition is 100000 per year"])
    .group("BIT Mesra hostel", Cohesion.Distinct, ["rooms are allotted by merit"])
    .omitted(footer);
  const store = new InMemoryStore();
  const f = build(store, new HashEmbedder(), new ScriptedChunker().withPlan("d1", script.plan()));
  const outcome = await f.retriever.addDocument(script.doc("d1"));
  assert.equal(outcome.groups, 2);
  assert.equal(outcome.linesOmitted, 2);
  assert.equal(outcome.charsOmitted, [...header].length + [...footer].length + 2);
  assert.ok(!outcome.degraded, JSON.stringify(outcome.degradations));
  assert.deepEqual(
    store.ids().map((id) => store.chunk(id).payload.text),
    ["tuition is 100000 per year", "rooms are allotted by merit"],
  );
});

test("unusable plan starts are reported", async () => {
  const zeroBased = new ChunkPlan([
    { context: "Fees", topic: null, cohesion: Cohesion.Distinct, partStarts: [0] },
    { context: "Hostel", topic: null, cohesion: Cohesion.Distinct, partStarts: [1] },
  ]);
  const store = new InMemoryStore();
  const f = build(store, new HashEmbedder(), new ScriptedChunker().withPlan("d1", zeroBased));
  const outcome = await f.retriever.addDocument(doc("d1", "tuition is 100000 per year\nrooms are allotted by merit\n"));
  assert.ok(outcome.degraded);
  assert.ok(
    outcome.degradations.some((d) => d.kind === "PlanStartsIgnored" && d.outOfRange === 1 && d.conflicting === 0),
  );
  const chunk = store.chunk("d1#g0.p0");
  assert.ok(chunk.payload.text.includes("tuition") && chunk.payload.text.includes("rooms"));
  assert.ok(chunk.payload.context.includes("Hostel"));
});

test("a plan with no line in the document takes the fallback", async () => {
  const text = "tuition is 100000 per year\nrooms are allotted by merit\n";
  const nowhere = new ChunkPlan([{ context: "Fees", topic: null, cohesion: Cohesion.Distinct, partStarts: [0, 99] }]);
  const store = new InMemoryStore();
  const f = build(store, new HashEmbedder(), new ScriptedChunker().withPlan("d1", nowhere));
  const outcome = await f.retriever.addDocument(doc("d1", text).withBreadcrumb(["BIT", "fees"]));
  assert.ok(outcome.usedChunkerFallback);
  assert.ok(kinds(outcome.degradations).includes("ChunkerFallbackUsed"));
  const stored = store.ids().map((id) => store.chunk(id).payload.text).join("");
  assert.ok(stored.includes("tuition") && stored.includes("rooms"));
  await assert.rejects(
    f.retriever.addDocument(doc("d1", text), null, { fallbackOnChunkerError: false }),
    (e) => e.code === "InvalidPlan",
  );
});

test("oversized input and bad ids are rejected before any backend call", async () => {
  const store = new InMemoryStore();
  const retriever = Retriever.builder()
    .chunker(new HeadingChunker())
    .embedder(new HashEmbedder())
    .store(store)
    .indexConfig({ maxDocumentChars: 10 })
    .build();
  await assert.rejects(retriever.addDocument(doc("d", "x".repeat(11))), (e) => e.code === "DocumentTooLarge");
  await assert.rejects(retriever.addDocument(doc("", "x")), (e) => e.code === "Input");
  await assert.rejects(retriever.addDocument(doc("a#b", "x")), (e) => e.code === "Input");
  await assert.rejects(retriever.addDocument(doc("x".repeat(257), "x")), (e) => e.code === "Input");
  await assert.rejects(retriever.addDocument(doc("d", "   ")), (e) => e.code === "Input");
  assert.deepEqual(store.calls(), []);
});

test("an over-limit plan is refused and names the right limit", async () => {
  const groups = Array.from({ length: 5 }, (_, i) => `## S${i}\ntext ${i}\n`).join("");
  const retriever = Retriever.builder()
    .chunker(new HeadingChunker())
    .embedder(new HashEmbedder())
    .store(new InMemoryStore())
    .indexConfig({ budget: { maxGroups: 3, minChars: 4, targetChars: 4 } })
    .build();
  await assert.rejects(
    retriever.addDocument(doc("d", groups)),
    (e) => e.code === "PlanTooLarge" && e.knob === "ChunkBudget::max_groups" && e.actual === 5,
  );
});

test("embedder contract violations are errors", async () => {
  for (const [embedder, code] of [
    [new HashEmbedder().returningWrongCount(), "EmbedCountMismatch"],
    [new HashEmbedder().returningWrongDim(), "DimensionMismatch"],
  ]) {
    const f = build(new InMemoryStore(), embedder, new HeadingChunker());
    await assert.rejects(f.retriever.addDocument(doc("d", "## A\nalpha")), (e) => e.code === code);
  }
});

test("embed batches respect the batch size and the concurrency ceiling", async () => {
  const embedder = new HashEmbedder().withBatchSize(3);
  const f = build(new InMemoryStore(), embedder, new HeadingChunker());
  await f.retriever.addDocument(doc("d", sections(10)));
  assert.deepEqual(embedder.calls, [3, 3, 3, 1]);
  assert.ok(embedder.gauge.peak <= 4);
});

test("queries go through the query-side embedder", async () => {
  const embedder = new HashEmbedder().withAsymmetricSalts();
  const f = build(new InMemoryStore(), embedder, new HeadingChunker());
  await f.retriever.addDocument(doc("d", "## A\nalpha beta\n"));
  const before = embedder.seen().length;
  await f.retriever.retrieveContext("alpha", new RetrievalConfig(1));
  assert.deepEqual(embedder.seen().slice(before), ["alpha"]);
});

// ---- retrieval: groups ----

test("one matching part brings its whole inseparable group", async () => {
  const clauses = [
    "general conduct and discipline clauses",
    "hostel allotment clauses",
    "antiragging affidavit is mandatory for every student",
    "withdrawal and transfer clauses",
  ];
  const script = planParts("Admission rules", Cohesion.Inseparable, clauses);
  let f = build(new InMemoryStore(), new HashEmbedder(), new ScriptedChunker().withPlan("rules", script.plan()), new KeywordReranker());
  await f.retriever.addDocument(script.doc("rules"));
  await f.retriever.addDocument(doc("other", "## Placements\nplacement statistics and recruiters"));
  let found = await f.retriever.retrieveContext("antiragging affidavit", new RetrievalConfig(2));
  const returned = idsOf(found);
  for (let part = 0; part < 4; part++) assert.ok(returned.includes(`rules#g0.p${part}`), returned.join());
  assert.deepEqual(
    found.chunks.filter((c) => c.chunk.meta.doc === "rules").map((c) => c.chunk.meta.partOrd),
    [0, 1, 2, 3],
  );
  assert.ok(found.chunks.some((c) => c.provenance.kind === "sibling"));

  // Negative control: the same text as distinct groups at recall 0 pulls in no siblings.
  const distinct = clauses.reduce((s, clause) => s.group("Admission rules", Cohesion.Distinct, [clause]), new Script());
  assert.equal(distinct.text(), script.text());
  f = build(new InMemoryStore(), new HashEmbedder(), new ScriptedChunker().withPlan("rules", distinct.plan()), new KeywordReranker());
  await f.retriever.addDocument(script.doc("rules"));
  found = await f.retriever.retrieveContext("antiragging affidavit", new RetrievalConfig(1).withRecall(0));
  assert.ok(!found.chunks.some((c) => c.provenance.kind === "sibling"));
});

test("the store's result order is never trusted", async () => {
  const honest = rig();
  const scrambled = build(new InMemoryStore().scrambled(), new HashEmbedder(), new HeadingChunker(), new KeywordReranker());
  const body =
    "## Fees\ntuition fee structure for btech\n## Hostel\nhostel room allotment\n" +
    "## Refund\nrefund policy on withdrawal";
  await honest.retriever.addDocument(doc("d1", body));
  await scrambled.retriever.addDocument(doc("d1", body));
  const config = new RetrievalConfig(3);
  const a = await honest.retriever.retrieveContext("refund policy withdrawal", config);
  const b = await scrambled.retriever.retrieveContext("refund policy withdrawal", config);
  assert.deepEqual(idsOf(a), idsOf(b), "output must not depend on store order");
});

test("an inverted store is reported", async () => {
  const f = build(new InMemoryStore().inverted(), new HashEmbedder(), new HeadingChunker(), new KeywordReranker());
  const body = Array.from(
    { length: 12 },
    (_, i) => `## Section ${i}\n${"admission fees ".repeat(i + 1)}body text number ${i}\n`,
  ).join("");
  await f.retriever.addDocument(doc("d1", body));
  const found = await f.retriever.retrieveContext("admission fees", new RetrievalConfig(4));
  assert.ok(kinds(found.degradations).includes("StoreOrderDisagrees"), JSON.stringify(kinds(found.degradations)));
});

test("a chunk nobody asked for is dropped", async () => {
  const f = build(new InMemoryStore().injectingUnrequestedChunk(), new HashEmbedder(), new HeadingChunker(), new KeywordReranker());
  await f.retriever.addDocument(doc("d1", "## A\nalpha text\n## B\nbravo text"));
  await f.retriever.addDocument(doc("d2", "## C\ncharlie text"));
  const found = await f.retriever.retrieveContext("alpha text", new RetrievalConfig(2));
  // Whatever came back, every chunk's text belongs to its own id.
  for (const c of found.chunks) assert.equal(f.store.chunk(c.chunk.id).payload.text, c.chunk.payload.text);
  // Re-indexing reads the stored chunks back, and is told one more came.
  const again = await f.retriever.addDocument(doc("d1", "## A\nalpha text\n## B\nbravo text"));
  assert.ok(kinds(again.degradations).includes("UnrequestedChunk"));
});

test("identical boilerplate across documents is deduped", async () => {
  const f = rig();
  for (const id of ["a", "b", "c"]) {
    await f.retriever.addDocument(doc(id, `## Footer\ncopyright all rights reserved\n## Own\n${id} unique page\n`));
  }
  const found = await f.retriever.retrieveContext("copyright all rights reserved", new RetrievalConfig(4));
  assert.ok(found.report.duplicatesDropped >= 2);
  const footers = found.chunks.filter((c) => c.chunk.payload.text.includes("copyright"));
  assert.equal(footers.length, 1);
  assert.equal(footers[0].duplicates, 2);
});

// ---- retrieval: reranking ----

test("a failed rerank batch degrades rather than dropping candidates", async () => {
  const reranker = new ScriptedReranker(0.5).withBatchSize(4).failingBatchesWith("d1#g0.p0");
  const f = build(new InMemoryStore(), new HashEmbedder(), new HeadingChunker(), reranker);
  await f.retriever.addDocument(doc("d1", sections(12)));
  const found = await f.retriever.retrieveContext("admission text number 0", new RetrievalConfig(8));
  const gold = found.chunks.find((c) => c.chunk.id === "d1#g0.p0");
  assert.ok(gold, "the gold chunk must still be in the output");
  assert.equal(gold.modelScore, null);
  assert.equal(gold.selection, Selection.Degraded);
  assert.ok(found.report.rerankBatchesFailed >= 1);
});

test("a failed call does not outrank what the model confirmed", async () => {
  const confirmed = "d1#g7.p0";
  const body = Array.from({ length: 12 }, (_, i) =>
    i === 0
      ? "## Section 0\nadmission fees hostel refund\n"
      : i === 1
        ? "## Section 1\nadmission fees hostel\n"
        : i === 2
          ? "## Section 2\nadmission fees\n"
          : `## Section ${i}\nnotice number ${i}\n`,
  ).join("");
  const run = async (fail) => {
    let reranker = new ScriptedReranker(0.05).withScore(confirmed, 0.95).withBatchSize(3);
    if (fail) reranker = reranker.failingBatchesWith("d1#g0.p0");
    const f = build(new InMemoryStore(), new HashEmbedder(), new HeadingChunker(), reranker);
    await f.retriever.addDocument(doc("d1", body));
    const found = await f.retriever.retrieveContext("admission fees hostel refund", new RetrievalConfig(2));
    return [found, reranker.observed()];
  };
  const [control] = await run(false);
  const [failed, calls] = await run(true);
  assert.equal(failed.report.rerankBatchesFailed, 1);
  for (const top of ["d1#g0.p0", "d1#g1.p0", "d1#g2.p0"]) assert.ok(calls[0].items.includes(top));
  for (const found of [control, failed]) {
    const first = found.chunks[0];
    assert.equal(first.chunk.id, confirmed, idsOf(found).join());
    assert.equal(first.selection, Selection.Ranked);
    assert.ok(found.chunks.filter((c) => c.modelScore === null).every((c) => c.score < first.score));
  }
});

test("a wrong-length response fails only its batch and misattributes nothing", async () => {
  const reranker = new ScriptedReranker(0.5).withBatchSize(4).withWrongLenOnCall(0);
  const f = build(new InMemoryStore(), new HashEmbedder(), new HeadingChunker(), reranker);
  await f.retriever.addDocument(doc("d1", sections(12)));
  const found = await f.retriever.retrieveContext("admission text", new RetrievalConfig(8));
  assert.ok(kinds(found.degradations).includes("RerankContractViolated"));
  const firstCall = new Set(reranker.observed()[0].items);
  for (const c of found.chunks) if (firstCall.has(c.chunk.id)) assert.equal(c.modelScore, null);
});

test("a NaN score is missing for one item, and out of range is told apart", async () => {
  const reranker = new ScriptedReranker(0.5).nanForId("d1#g1.p0").withRawScore("d1#g2.p0", 7);
  const f = build(new InMemoryStore(), new HashEmbedder(), new HeadingChunker(), reranker);
  await f.retriever.addDocument(doc("d1", sections(4)));
  const found = await f.retriever.retrieveContext("admission text", new RetrievalConfig(4).withRecall(1));
  const unusable = found.degradations.find((d) => d.kind === "RerankScoresUnusable");
  assert.deepEqual([unusable.nonFinite, unusable.outOfRange], [1, 1]);
  const nan = found.chunks.find((c) => c.chunk.id === "d1#g1.p0");
  assert.ok(nan, "a NaN demotes nothing to zero");
  assert.equal(nan.modelScore, null);
});

test("a wrong score count is a failed call that can fail the request", async () => {
  const reranker = new ScriptedReranker(0.5).withWrongLenOnCall(0);
  const f = build(new InMemoryStore(), new HashEmbedder(), new HeadingChunker(), reranker);
  await f.retriever.addDocument(doc("d1", sections(4)));
  const config = new RetrievalConfig(4, { failOnExcessiveDegradation: true });
  await assert.rejects(f.retriever.retrieveContext("admission text", config), (e) => e.code === "RerankCollapsed");
});

test("a char budget splits the set into calls within it", async () => {
  const reranker = new ScriptedReranker(0.5).withBatchSize(100).withBatchChars(50);
  const f = build(new InMemoryStore(), new HashEmbedder(), new HeadingChunker(), reranker);
  await f.retriever.addDocument(doc("d1", sections(6)));
  const found = await f.retriever.retrieveContext("admission text", new RetrievalConfig(6));
  assert.ok(reranker.callCount() > 1);
  assert.ok(!kinds(found.degradations).includes("RerankCharBudgetExceeded"));
});

test("total rerank failure falls back to retrieval order, and says so", async () => {
  const reranker = new ScriptedReranker(0.5).failingBatchesWith("d1#g0.p0").withBatchSize(100);
  const f = build(new InMemoryStore(), new HashEmbedder(), new HeadingChunker(), reranker);
  await f.retriever.addDocument(doc("d1", sections(6)));
  const found = await f.retriever.retrieveContext("admission text number 2", new RetrievalConfig(3));
  assert.ok(kinds(found.degradations).includes("RerankCollapsed"));
  assert.ok(describeDegradation(found.degradations.find((d) => d.kind === "RerankCollapsed")).startsWith("RerankCollapsed {"));
  assert.ok(found.chunks.length > 0);
});

test("no reranker is a documented path, not a degradation", async () => {
  const f = build(new InMemoryStore(), new HashEmbedder(), new HeadingChunker());
  await f.retriever.addDocument(doc("d1", sections(6)));
  const found = await f.retriever.retrieveContext("admission text number 2", new RetrievalConfig(3));
  assert.equal(found.report.rerankCalls, 0);
  assert.ok(!found.isDegraded(), JSON.stringify(found.degradations));
  assert.equal(found.chunks[0].chunk.id, "d1#g2.p0");
});

test("model weight zero never calls the reranker", async () => {
  const reranker = new ScriptedReranker(0.5);
  const f = build(new InMemoryStore(), new HashEmbedder(), new HeadingChunker(), reranker);
  await f.retriever.addDocument(doc("d1", sections(6)));
  await f.retriever.retrieveContext("admission text", new RetrievalConfig(3, { modelWeight: 0 }));
  assert.equal(reranker.callCount(), 0);
});

test("degraded outranks backfill", async () => {
  const reranker = new ScriptedReranker(0.05).withBatchSize(4).failingBatchesWith("d1#g0.p0");
  const f = build(new InMemoryStore(), new HashEmbedder(), new HeadingChunker(), reranker);
  await f.retriever.addDocument(doc("d1", sections(12)));
  const found = await f.retriever.retrieveContext("admission text", new RetrievalConfig(8).withRecall(1));
  let seenBackfill = false;
  for (const c of found.chunks) {
    if (c.selection === Selection.Backfill) seenBackfill = true;
    if (c.selection === Selection.Degraded) assert.ok(!seenBackfill, "a Degraded chunk after a Backfill one");
  }
});

test("min results backfills and labels what it added", async () => {
  const reranker = new ScriptedReranker(0.0).withScore("d1#g0.p0", 1.0);
  const f = build(new InMemoryStore(), new HashEmbedder(), new HeadingChunker(), reranker);
  await f.retriever.addDocument(doc("d1", sections(8)));
  const found = await f.retriever.retrieveContext("admission text number 0", new RetrievalConfig(4, { minResults: 4 }));
  assert.ok(found.chunks.length >= 4);
  assert.equal(found.chunks[0].selection, Selection.Ranked);
  assert.ok(found.chunks.slice(1).every((c) => c.selection === Selection.Backfill));
});

test("the rerank call ceiling is respected", async () => {
  const reranker = new ScriptedReranker(0.5).withBatchSize(1);
  const f = build(new InMemoryStore(), new HashEmbedder(), new HeadingChunker(), reranker);
  await f.retriever.addDocument(doc("d1", sections(20)));
  const found = await f.retriever.retrieveContext("admission text", new RetrievalConfig(4, { maxRerankCalls: 3 }));
  assert.equal(reranker.callCount(), 3);
  assert.ok(kinds(found.degradations).includes("DeepInputReduced"));
});

test("an expired deadline returns partial results, or errors on request", async () => {
  const f = rig();
  await f.retriever.addDocument(doc("d1", sections(6)));
  const past = Date.now() - 1000;
  const found = await f.retriever.retrieveContext("admission text", new RetrievalConfig(3).withDeadline(past));
  assert.ok(kinds(found.degradations).includes("DeadlineHit"));
  await assert.rejects(
    f.retriever.retrieveContext("admission text", new RetrievalConfig(3, { strictDeadline: true }).withDeadline(past)),
    (e) => e.code === "Deadline",
  );
});

test("namespaces scope a query", async () => {
  const f = rig();
  await f.retriever.addDocument(doc("a", "## A\nshared words\n").withMeta("namespace", "org1"));
  await f.retriever.addDocument(doc("b", "## B\nshared words\n").withMeta("namespace", "org2"));
  const found = await f.retriever.retrieveContext("shared words", new RetrievalConfig(4).withNamespace("org1"));
  assert.deepEqual([...new Set(found.chunks.map((c) => c.chunk.meta.doc))], ["a"]);
});

test("an empty store returns nothing, and an empty query is an error", async () => {
  const f = rig();
  const found = await f.retriever.retrieveContext("anything", new RetrievalConfig(3));
  assert.deepEqual(found.chunks, []);
  await assert.rejects(f.retriever.retrieveContext("   ", new RetrievalConfig(3)), (e) => e.code === "EmptyQuery");
});

test("the floor bypass still keeps a group whole", async () => {
  const script = planParts("Fee schedule", Cohesion.Inseparable, [
    "semester one tuition rows",
    "semester two tuition rows",
    "semester three tuition rows",
    "semester four tuition rows",
  ]);
  const f = build(
    new InMemoryStore(),
    new HashEmbedder(),
    new ScriptedChunker().withPlan("fees", script.plan()),
    new ScriptedReranker(0.0).withBatchSize(8),
  );
  await f.retriever.addDocument(script.doc("fees"));
  await f.retriever.addDocument(doc("other", "## Placements\nplacement statistics and recruiters"));
  const found = await f.retriever.retrieveContext("semester tuition rows", new RetrievalConfig(8).withRecall(0));
  assert.ok(kinds(found.degradations).includes("FloorBypassed"));
  const parts = found.chunks.filter((c) => c.chunk.meta.doc === "fees").length;
  assert.ok(parts === 0 || parts === 4, `the floor bypass returned ${parts} of 4 parts`);
});

test("an inseparable group missing a part out of band is dropped whole", async () => {
  const script = planParts("Fee schedule", Cohesion.Inseparable, ["row one fee", "row two fee", "row three fee"]);
  const store = new InMemoryStore();
  const f = build(store, new HashEmbedder(), new ScriptedChunker().withPlan("fees", script.plan()), new KeywordReranker());
  await f.retriever.addDocument(script.doc("fees"));
  await f.retriever.addDocument(doc("other", "## Other\nsome fee notice"));
  store.removeOutOfBand("fees#g0.p2");
  const found = await f.retriever.retrieveContext("row fee", new RetrievalConfig(4));
  assert.ok(!found.chunks.some((c) => c.chunk.meta.doc === "fees"));
  assert.ok(kinds(found.degradations).includes("GroupIncomplete"));
});

test("the grouped view emits context once, in reading order", async () => {
  const script = planParts("Rules", Cohesion.Inseparable, ["first rule text", "second rule text"]);
  const f = build(new InMemoryStore(), new HashEmbedder(), new ScriptedChunker().withPlan("r", script.plan()), new KeywordReranker());
  await f.retriever.addDocument(script.doc("r"));
  const found = await f.retriever.retrieveContext("second rule", new RetrievalConfig(2));
  const prompt = found.toPrompt();
  assert.equal(prompt.split("Rules").length - 1, 1);
  assert.ok(prompt.indexOf("first rule") < prompt.indexOf("second rule"));
});

test("output is identical across many runs", async () => {
  const f = rig();
  await f.retriever.addDocument(doc("d1", sections(30)));
  const runs = new Set();
  for (let i = 0; i < 10; i++) {
    const found = await f.retriever.retrieveContext("admission text number", new RetrievalConfig(5));
    runs.add(found.chunks.map((c) => `${c.chunk.id}:${c.score}`).join("|"));
  }
  assert.equal(runs.size, 1);
});

// ---- building and configuration ----

test("one object may implement every plugin", async () => {
  const client = new OneClient();
  const retriever = Retriever.builder().chunker(client).embedder(client).store(new InMemoryStore()).reranker(client).build();
  await retriever.addDocument(doc("d", "## A\nalpha beta\n"));
  const found = await retriever.retrieveContext("alpha", new RetrievalConfig(1));
  assert.equal(found.chunks.length, 1);
});

test("explain requires no backend call", () => {
  const store = new InMemoryStore();
  const retriever = Retriever.builder().embedder(new HashEmbedder()).store(store).build();
  const plan = retriever.explain(new RetrievalConfig(8));
  assert.equal(plan.fanOut, 549);
  assert.equal(plan.deepInput, 147);
  assert.equal(plan.minResults, 6);
  assert.deepEqual(store.calls(), []);
});

test("a zero batch size from a plugin, or a missing plugin, fails the build", () => {
  assert.throws(
    () => Retriever.builder().embedder(new HashEmbedder().withBatchSize(0)).store(new InMemoryStore()).build(),
    (e) => e instanceof IndexError && e.code === "Config",
  );
  assert.throws(() => Retriever.builder().store(new InMemoryStore()).build(), (e) => e.code === "Build");
  assert.throws(
    () => Retriever.builder().embedder(new HashEmbedder()).store(new InMemoryStore().withCaps({ maxTopK: 0 })).build(),
    (e) => e.code === "Config",
  );
});

test("an invalid config is rejected before any call", async () => {
  assert.throws(
    () => Retriever.builder().embedder(new HashEmbedder()).store(new InMemoryStore()).indexConfig({ budget: { targetChars: 0 } }).build(),
    (e) => e.code === "Config",
  );
  const store = new InMemoryStore();
  const retriever = Retriever.builder().embedder(new HashEmbedder()).store(store).build();
  for (const config of [
    new RetrievalConfig(8).withRecall(1.5),
    new RetrievalConfig(8).withRecall(Number.NaN),
    new RetrievalConfig(0),
    new RetrievalConfig(8, { fanOut: 2 }),
    new RetrievalConfig(8, { minResults: 9 }),
    new RetrievalConfig(8, { maxRerankCalls: 0 }),
  ]) {
    await assert.rejects(retriever.retrieveContext("q", config), (e) => e instanceof RetrieveError && e.code === "Config");
  }
  assert.deepEqual(store.calls(), []);
});

test("indexing without a chunker is a clear error", async () => {
  const retriever = Retriever.builder().embedder(new HashEmbedder()).store(new InMemoryStore()).build();
  await assert.rejects(retriever.addDocument(doc("d", "x")), (e) => e.code === "NoChunker");
});

// ---- cleanup ----

test("a wrong listing cannot delete another document's chunks", async () => {
  const store = new InMemoryStore().listingForeignIds();
  const f = build(store, new HashEmbedder(), new HeadingChunker());
  await f.retriever.addDocument(doc("a", "## A\nalpha\n"));
  await f.retriever.addDocument(doc("b", "## B\nbeta\n"));
  const removed = await f.retriever.removeDocument("b");
  assert.ok(kinds(removed.degradations).includes("ForeignChunkListed"));
  assert.deepEqual(store.ids(), ["a#g0.p0"]);
});

test("a listing failure is reported and converges, but fails a removal loudly", async () => {
  const store = new InMemoryStore();
  const f = build(store, new HashEmbedder(), new HeadingChunker());
  await f.retriever.addDocument(doc("d", "## A\nalpha\n## B\nbeta\n"));
  store.failList = true;
  const outcome = await f.retriever.addDocument(doc("d", "## A\nalpha\n"));
  assert.ok(kinds(outcome.degradations).includes("StaleListingFailed"));
  assert.equal(outcome.status, IndexStatus.Indexed);
  await assert.rejects(f.retriever.removeDocument("d"), (e) => e.code === "Store");
  store.failList = false;
  const settled = await f.retriever.addDocument(doc("d", "## A\nalpha\n"));
  assert.equal(settled.staleDeleted, 1);
  assert.deepEqual(store.ids(), ["d#g0.p0"]);
});
