// Recall measurement over the real corpus, across the recall dial.
//
// The embedder and reranker here are the deterministic doubles, so these numbers measure the
// engine's behaviour (what the dial, the quotas, the expansion and the selection do to recall),
// not any model's semantic quality.

import assert from "node:assert/strict";
import { before, test } from "node:test";

import { RetrievalConfig, Retriever } from "../src/index.js";
import { HashEmbedder, HeadingChunker, InMemoryStore, KeywordReranker } from "../src/testing.js";
import { corpus, goldenSet } from "./helpers.js";

let retriever;
let set;

before(async () => {
  retriever = Retriever.builder()
    .chunker(new HeadingChunker())
    .embedder(new HashEmbedder())
    .store(new InMemoryStore())
    .reranker(new KeywordReranker())
    .indexConfig({ budget: { maxGroups: 1024, maxPartsPerGroup: 256 } })
    .build();
  for (const doc of corpus()) await retriever.addDocument(doc);
  set = goldenSet();
  assert.ok(set.length >= 15, `expected the labelled set, parsed ${set.length}`);
});

/** The documents of a result. */
const docsOf = (outcome) => new Set(outcome.chunks.map((c) => c.chunk.meta.doc));

async function measure(dial, k) {
  let recallSum = 0;
  let precisionSum = 0;
  let returnedSum = 0;
  let candidateSum = 0;
  let foundAll = 0;
  let foundNone = 0;
  for (const c of set) {
    const found = await retriever.retrieveContext(c.query, new RetrievalConfig(k).withRecall(dial));
    // Page-level: did the pages that answer the question come back at all?
    const docs = docsOf(found);
    const hits = [...c.relevant].filter((d) => docs.has(d)).length;
    recallSum += hits / Math.max(c.relevant.size, 1);
    precisionSum += hits / Math.max(docs.size, 1);
    returnedSum += found.chunks.length;
    candidateSum += found.report.candidates;
    if (hits === c.relevant.size) foundAll += 1;
    if (hits === 0) foundNone += 1;
  }
  const n = set.length;
  return {
    recall: dial,
    recallAtK: recallSum / n,
    precisionAtK: precisionSum / n,
    meanReturned: returnedSum / n,
    meanCandidates: candidateSum / n,
    foundAll,
    foundNone,
  };
}

test("recall rises with the dial and is high by default", async () => {
  const k = 8;
  const points = [];
  for (const dial of [0.0, 0.25, 0.5, 0.8, 1.0]) points.push(await measure(dial, k));

  console.log(`\n  recall over ${set.length} labelled queries, top_n = ${k}`);
  console.log("  dial  recall@k  prec@k  returned  candidates  all/none");
  for (const p of points) {
    console.log(
      `  ${p.recall.toFixed(2)}    ${p.recallAtK.toFixed(3)}    ${p.precisionAtK.toFixed(3)}   ` +
        `${p.meanReturned.toFixed(1).padStart(6)}    ${p.meanCandidates.toFixed(1).padStart(8)}    ` +
        `${p.foundAll}/${p.foundNone}`,
    );
  }
  for (let i = 1; i < points.length; i++) {
    const [lower, higher] = [points[i - 1], points[i]];
    assert.ok(
      higher.recallAtK >= lower.recallAtK - 1e-6,
      `recall fell when the dial was raised: ${lower.recallAtK} at ${lower.recall} -> ${higher.recallAtK} at ${higher.recall}`,
    );
    assert.ok(higher.meanCandidates >= lower.meanCandidates);
  }
  const atDefault = points.find((p) => Math.abs(p.recall - 0.8) < 1e-6);
  assert.ok(atDefault.recallAtK >= 0.7, `recall@${k} at the default dial regressed to ${atDefault.recallAtK}`);
});

test("a wide budget surfaces every labelled page", async () => {
  const missing = [];
  let found = 0;
  let wanted = 0;
  for (const c of set) {
    const outcome = await retriever.retrieveContext(c.query, new RetrievalConfig(120).withRecall(1.0));
    const docs = docsOf(outcome);
    for (const page of c.relevant) {
      wanted += 1;
      if (docs.has(page)) found += 1;
      else missing.push(`${page} for ${JSON.stringify(c.query)}`);
    }
  }
  console.log(`\n  recall with a non-binding budget: ${found}/${wanted} = ${(found / wanted).toFixed(3)}`);
  assert.deepEqual(missing, []);
});

test("every labelled query finds an answer at the default dial", async () => {
  const misses = [];
  for (const c of set) {
    const found = await retriever.retrieveContext(c.query, new RetrievalConfig(8));
    const docs = docsOf(found);
    const hits = [...c.relevant].filter((d) => docs.has(d));
    if (hits.length === 0) misses.push(c.query);
  }
  // These need actual semantics, which the doubles do not have.
  const knownLimited = [
    "What is the application fee for a PhD programme?",
    "How are seats distributed across the M.Tech programmes?",
    "Which professors teach in the department, and what are their emails?",
  ];
  const unexpected = misses.filter((m) => !knownLimited.includes(m));
  assert.deepEqual(unexpected, [], "queries that newly find nothing relevant");
  assert.ok(misses.length <= knownLimited.length);
});
