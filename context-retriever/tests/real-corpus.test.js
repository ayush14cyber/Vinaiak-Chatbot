// The pipeline run over real scraped pages: BIT Mesra admission/fee notices and IIT (ISM) Dhanbad
// admission pages, in `tests/data/`. Deterministic and offline: the doubles stand in for the
// models, so what these tests exercise is the engine against real text.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  ChunkPlan,
  Cohesion,
  DocumentInput,
  IndexStatus,
  RetrievalConfig,
  Retriever,
  defaultBudget,
  ids,
  text,
} from "../src/index.js";
import {
  HashEmbedder,
  HeadingChunker,
  InMemoryStore,
  KeywordReranker,
  ScriptedChunker,
} from "../src/testing.js";
import { DATA, corpus } from "./helpers.js";

function rig() {
  const store = new InMemoryStore();
  const embedder = new HashEmbedder();
  const retriever = Retriever.builder()
    .chunker(new HeadingChunker())
    .embedder(embedder)
    .store(store)
    .reranker(new KeywordReranker())
    // A real faculty list has 400 sections, so the runaway-chunker guards have to be set for
    // the corpus you actually have.
    .indexConfig({ budget: { maxGroups: 1024, maxPartsPerGroup: 256 } })
    .build();
  return { retriever, store, embedder };
}

async function indexCorpus(r) {
  const outcomes = [];
  for (const doc of corpus()) outcomes.push(await r.retriever.addDocument(doc));
  return outcomes;
}

const ask = (r, query, recall) => r.retriever.retrieveContext(query, new RetrievalConfig(8).withRecall(recall));

function topDocuments(found) {
  const seen = [];
  for (const c of found.chunks) if (!seen.includes(c.chunk.meta.doc)) seen.push(c.chunk.meta.doc);
  return seen;
}

test("the real corpus indexes with every invariant intact", async () => {
  const r = rig();
  const outcomes = await indexCorpus(r);
  const total = outcomes.reduce((n, o) => n + o.chunksTotal, 0);
  assert.ok(total > 150, `only ${total} chunks from 21 real pages`);
  assert.equal(r.store.ids().length, total);

  const groups = new Map();
  for (const id of r.store.ids()) {
    const chunk = r.store.chunk(id);
    if (!groups.has(chunk.meta.group)) groups.set(chunk.meta.group, []);
    groups.get(chunk.meta.group).push(chunk);
  }
  for (const [group, members] of groups) {
    members.sort((a, b) => a.meta.partOrd - b.meta.partOrd);
    const first = members[0];
    assert.ok(first.payload.context.trim().length > 0, `${group} has an empty context`);
    for (const member of members) {
      assert.equal(member.payload.context, first.payload.context, `${group} has differing contexts`);
      assert.ok(member.payload.text.trim().length > 0, `${group} part ${member.meta.partOrd} is blank`);
      assert.equal(member.meta.groupLen, members.length, `${group} carries a stale groupLen`);
    }
    assert.deepEqual(
      members.map((c) => c.meta.partOrd),
      members.map((_, i) => i),
      `${group} has holes in its part ordinals`,
    );
  }
});

test("the fee table page is split but stays one passage", async () => {
  const r = rig();
  await indexCorpus(r);
  const fee = r.store.ids().filter((id) => id.startsWith("bitmesra/3712.txt")).map((id) => r.store.chunk(id));
  assert.ok(fee.length > 5, `a 43 KB page should yield many chunks, got ${fee.length}`);
  const multiPart = fee.filter((c) => c.meta.groupLen > 1);
  assert.ok(multiPart.length > 0, "the engine should have size-split the long sections of this page");
  for (const c of multiPart) assert.equal(c.meta.cohesion, Cohesion.Inseparable);

  const found = await ask(r, "fee structure tuition hostel charges", 0.8);
  const returned = new Set(found.chunks.map((c) => c.chunk.id));
  for (const c of found.chunks) {
    const meta = c.chunk.meta;
    if (meta.cohesion !== Cohesion.Inseparable) continue;
    const expected = ids.siblings(meta.doc, meta.groupOrd, meta.groupLen);
    const present = expected.filter((id) => returned.has(id)).length;
    assert.equal(present, expected.length, `group ${meta.group} came back with holes`);
  }
});

test("the faculty list cannot monopolize a generic query", async () => {
  const r = rig();
  await indexCorpus(r);
  const facultyChunks = r.store.ids().filter((id) => id.startsWith("iitism/100.txt")).length;
  assert.ok(facultyChunks > 100, `the faculty list should produce many chunks, got ${facultyChunks}`);
  const config = new RetrievalConfig(10);
  const found = await ask(r, "professor department contact email", 0.8);
  const fromFaculty = found.chunks.filter((c) => c.chunk.meta.doc === "iitism/100.txt").length;
  assert.ok(fromFaculty <= config.perDocQuota, `${fromFaculty} of ${found.chunks.length} chunks came from one page`);
  assert.ok(found.report.quotaSuppressed > 0, "the per-document quota never fired");
});

test("real questions retrieve the pages that answer them", async () => {
  const r = rig();
  await indexCorpus(r);
  const cases = [
    ["seat distribution of M.Tech programs", ["iitism/99.txt"]],
    // The page itself spells it "Calender".
    ["academic calender and holiday details", ["iitism/77.txt"]],
    ["UG admission through JOSAA based on JEE Advanced", ["iitism/35.txt", "bitmesra/3702.txt", "bitmesra/3703.txt"]],
    ["antiragging affidavit and academic bank of credit", ["bitmesra/3704.txt", "bitmesra/3718.txt"]],
    [
      "refund of fees under withdrawal",
      ["bitmesra/3705.txt", "bitmesra/3711.txt", "bitmesra/3718.txt", "iitism/86.txt", "iitism/95.txt"],
    ],
    ["toll free contact details of the institute", ["bitmesra/3708.txt", "bitmesra/3718.txt"]],
  ];
  for (const [query, allowed] of cases) {
    const found = await ask(r, query, 0.8);
    assert.ok(found.chunks.length > 0, `${query} returned nothing at all`);
    const docs = topDocuments(found);
    assert.ok(
      docs.some((d) => allowed.includes(d)),
      `${query} returned ${docs}, none of which is one of ${allowed}`,
    );
    assert.ok(found.toPrompt().length > 50, `${query} produced a trivial prompt`);
  }
});

test("raising recall looks harder and keeps what it found", async () => {
  const r = rig();
  await indexCorpus(r);
  for (const query of [
    "fee structure and refund policy",
    "admission procedure and important dates",
    "hostel and mess charges",
  ]) {
    let previousCandidates = 0;
    let previousScored = 0;
    for (const recall of [0.0, 0.3, 0.6, 1.0]) {
      const found = await ask(r, query, recall);
      assert.ok(found.report.candidates >= previousCandidates);
      assert.ok(found.report.deepScored >= previousScored);
      previousCandidates = found.report.candidates;
      previousScored = found.report.deepScored;
    }
    assert.ok(previousCandidates > 0);

    // With a non-binding budget, no source is lost on the way up.
    let previous = null;
    for (const recall of [0.0, 0.3, 0.6, 1.0]) {
      const found = await r.retriever.retrieveContext(query, new RetrievalConfig(40).withRecall(recall));
      const docs = new Set(found.chunks.map((c) => c.chunk.meta.doc));
      if (previous) {
        for (const doc of previous) assert.ok(docs.has(doc), `${query} at recall ${recall} lost the page ${doc}`);
      }
      previous = docs;
    }
  }
});

test("re-indexing the unchanged corpus costs no model calls", async () => {
  const r = rig();
  await indexCorpus(r);
  const callsAfterFirst = r.embedder.callCount();
  assert.ok(callsAfterFirst > 0);
  const second = await indexCorpus(r);
  assert.equal(r.embedder.callCount(), callsAfterFirst);
  for (const outcome of second) {
    assert.equal(outcome.status, IndexStatus.Unchanged, `${outcome.doc} was re-indexed`);
    assert.equal(outcome.chunksUpserted, 0);
  }
});

test("editing one page re-embeds only what changed", async () => {
  const r = rig();
  await indexCorpus(r);
  const before = r.embedder.callCount();
  const page = corpus().find((d) => d.id === "bitmesra/3705.txt");
  const edited = new DocumentInput(
    page.id,
    `${page.text}\n## New notice\nRefund requests now close on 30 April 2027.\n`,
  ).withBreadcrumb(page.breadcrumb);
  const outcome = await r.retriever.addDocument(edited);
  assert.equal(outcome.status, IndexStatus.Indexed);
  assert.ok(outcome.chunksReused > 0, "the untouched sections should have been reused");
  assert.ok(outcome.chunksUpserted <= 2, `${outcome.chunksUpserted} chunks re-embedded for a one-section edit`);
  assert.equal(r.embedder.callCount() - before, outcome.chunksUpserted);
  const found = await ask(r, "refund requests close on 30 April 2027", 0.8);
  assert.ok(found.chunks.some((c) => c.chunk.payload.text.includes("30 April 2027")));
});

test("resident text stays bounded on the real corpus", async () => {
  const r = rig();
  await indexCorpus(r);
  const config = new RetrievalConfig(8, { concurrency: { rerank: 4 } }).withRecall(1.0);
  const found = await r.retriever.retrieveContext("admission fee refund hostel contact", config);
  assert.ok(found.report.deepScored > 0);
  const bound = 4 * 8 * (defaultBudget().maxChars + 1024) + 256 * 1024;
  assert.ok(found.report.peakTextBytes < bound, `peak resident text ${found.report.peakTextBytes} exceeded ${bound}`);
});

test("the same question gives the same answer every time", async () => {
  const r = rig();
  await indexCorpus(r);
  const config = new RetrievalConfig(8).withRecall(0.8);
  let baseline = null;
  for (let run = 0; run < 10; run++) {
    const found = await r.retriever.retrieveContext("fee structure and refund policy", config);
    const rendered = found.chunks.map((c) => `${c.chunk.id}:${c.score.toFixed(6)}`).join("|");
    if (baseline === null) baseline = rendered;
    else assert.equal(rendered, baseline, `run ${run} differed`);
  }
});

test("deleting a page removes exactly its chunks", async () => {
  const r = rig();
  await indexCorpus(r);
  const before = r.store.ids().length;
  const owned = r.store.ids().filter((id) => id.startsWith("iitism/77.txt")).length;
  assert.ok(owned > 5);
  const outcome = await r.retriever.removeDocument("iitism/77.txt");
  assert.equal(outcome.staleDeleted, owned);
  assert.equal(r.store.ids().length, before - owned);
  assert.ok(!r.store.ids().some((id) => id.startsWith("iitism/77.txt")));
  const found = await ask(r, "academic calendar and holiday details", 0.8);
  assert.ok(!topDocuments(found).includes("iitism/77.txt"), "a deleted page is still being retrieved");
});

/**
 * The faculty directory, chunked the way the chunker contract recommends for a list of
 * independent records: one `Distinct` group, each professor a part.
 */
function facultyDirectoryPlan() {
  const source = readFileSync(join(DATA, "iitism/100.txt"), "utf8");
  const records = [];
  for (const line of source.split("\n").map((l) => l.replace(/\r$/, ""))) {
    if (line.startsWith("### ") || records.length === 0) records.push("");
    records[records.length - 1] += `${line}\n`;
  }
  const cleaned = records.map((r) => r.trim()).filter((r) => r.length > 0);
  const doc = new DocumentInput("iitism/100.txt", source).withBreadcrumb(["IIT ISM Dhanbad", "website"]);
  const partStarts = doc
    .lines()
    .map((line, i) => [line, i])
    .filter(([line, i]) => i === 0 || line.startsWith("### "))
    .map(([, i]) => i + 1);
  const plan = new ChunkPlan([
    {
      context:
        "Faculty directory of IIT (ISM) Dhanbad: each entry gives a professor's department, " +
        "designation, email and phone number.",
      topic: "Faculty directory",
      cohesion: Cohesion.Distinct,
      partStarts,
    },
  ]);
  return { doc, plan, records: cleaned };
}

test("a directory of records is packed into few whole-record parts", async () => {
  const { doc, plan, records } = facultyDirectoryPlan();
  assert.ok(records.length > 390, `expected the faculty records, got ${records.length}`);
  const store = new InMemoryStore();
  const retriever = Retriever.builder()
    .chunker(new ScriptedChunker().withPlan(doc.id, plan))
    .embedder(new HashEmbedder())
    .store(store)
    .build();
  const outcome = await retriever.addDocument(doc);
  const budget = defaultBudget();
  const parts = store.ids().map((id) => store.chunk(id));
  assert.equal(outcome.groups, 1, "the directory must stay one group");
  assert.equal(outcome.inseparableGroups, 0, "a directory is not inseparable");
  assert.ok(parts.length < records.length / 5, `${records.length} records became ${parts.length} chunks`);
  for (const part of parts) {
    const chars = text.charCount(part.payload.text);
    assert.ok(chars <= budget.targetChars, `a part of ${chars} chars exceeds the target`);
    assert.ok(chars >= budget.minChars, `a part of ${chars} chars is under the floor`);
    assert.equal(part.meta.cohesion, Cohesion.Distinct);
  }
  for (const record of records) {
    const holders = parts.filter((p) => p.payload.text.includes(record)).length;
    assert.equal(holders, 1, `record ${record.split("\n")[0]} appears in ${holders} parts`);
  }
});

test("a directory group is not starved by the per-group quota", async () => {
  const { doc, plan } = facultyDirectoryPlan();
  const store = new InMemoryStore();
  const retriever = Retriever.builder()
    .chunker(new ScriptedChunker().withPlan(doc.id, plan))
    .embedder(new HashEmbedder())
    .store(store)
    .reranker(new KeywordReranker())
    .build();
  await retriever.addDocument(doc);
  const totalParts = store.ids().length;
  const config = new RetrievalConfig(4);
  const found = await retriever.retrieveContext("Petroleum Engineering professors", config);
  assert.equal(found.report.rawHits, totalParts);
  assert.equal(found.report.quotaSuppressed, totalParts - config.perDocQuota);
});

test("a question about one professor does not return the whole directory", async () => {
  const { doc, plan } = facultyDirectoryPlan();
  const store = new InMemoryStore();
  const retriever = Retriever.builder()
    .chunker(new ScriptedChunker().withPlan(doc.id, plan))
    .embedder(new HashEmbedder())
    .store(store)
    .reranker(new KeywordReranker())
    .build();
  await retriever.addDocument(doc);
  const totalParts = store.ids().length;
  const found = await retriever.retrieveContext(
    "Prof. A K Pathak Petroleum Engineering Adjunct Professor email",
    new RetrievalConfig(4),
  );
  assert.ok(found.chunks.some((c) => c.chunk.payload.text.includes("akhilendra56@iitism.ac.in")));
  assert.ok(found.chunks.length * 4 < totalParts, `${found.chunks.length} of ${totalParts} parts came back`);
});
