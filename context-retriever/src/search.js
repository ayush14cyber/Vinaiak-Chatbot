// The read path: broad retrieval, group completion, then deep re-ranking.
//
// Step order, and why it is this order:
// 1. embed the query (query-side task type);
// 2. search wide: `fanOut` is absolute, because how deep you must search is a property of the
//    corpus, not of how many results you want;
// 3. re-sort and rank the hits ourselves, never trusting the store's order;
// 4. apply per-group and per-document quotas, after ranking;
// 5. suppress identical bodies across documents, so boilerplate does not eat the rerank budget;
// 6. complete groups before narrowing: when one part of a size-split group scores well, its
//    siblings must reach the reranker on the strength of the group;
// 7. narrow to a judgeable set by score and margin, exempting those siblings;
// 8. deep re-rank in bounded concurrent batches;
// 9. select, complete groups again for integrity, and order deterministically.

import { PluginError, RetrieveError } from "./errors.js";
import { cmpStr, position, siblings } from "./ids.js";
import { Provenance, RetrievalOutcome, Selection, degradation } from "./report.js";
import { narrow, rerank } from "./rerank.js";
import { select } from "./select.js";
import { TextMeter, emptySummary, payloadBytes } from "./stage.js";
import { Cohesion } from "./types.js";
import { clamp } from "./util.js";

const EPSILON = 1.1920929e-7; // single-precision float epsilon

const elapsed = (started) => Math.round(performance.now() - started);

/** Broad retrieval followed by deep re-ranking. */
export async function retrieveContext(r, rawQuery, config) {
  const query = String(rawQuery ?? "").trim();
  if (query.length === 0) throw RetrieveError.emptyQuery();

  // Validates the config; an invalid value is an error, never clamped.
  const plan = config.resolve(r.limits.caps);
  const degradations = [];
  const stageMillis = {};
  const meter = new TextMeter();
  const namespace = config.namespace ?? null;

  // ---- embed the query ----
  let started = performance.now();
  let vectors;
  try {
    vectors = await r.embedder.embedQueries([query]);
  } catch (error) {
    throw RetrieveError.queryEmbedding(PluginError.from(error));
  }
  const vector = vectors?.[0];
  if (!vector) throw RetrieveError.contract("embed_queries returned no vectors for one input");
  const dim = r.embedDimensions;
  if (dim !== null && dim !== undefined && vector.length !== dim) {
    throw RetrieveError.contract(`embed_queries returned dimension ${vector.length}, expected ${dim}`);
  }
  stageMillis.embed_query = elapsed(started);

  // ---- broad pass ----
  started = performance.now();
  let hits;
  try {
    hits = await r.store.query({
      vector,
      topK: plan.fanOut,
      namespace,
      filter: config.filter ?? null,
    });
  } catch (error) {
    throw RetrieveError.store(PluginError.from(error));
  }
  stageMillis.broad = elapsed(started);

  const rawHits = hits.length;
  if (rawHits > plan.fanOut) {
    throw RetrieveError.contract(`store returned ${rawHits} hits for top_k ${plan.fanOut}`);
  }
  checkOrder(hits, degradations);

  let candidates = [];
  let invalid = 0;
  let invalidSample = null;
  for (const hit of hits) {
    if (position(hit.id) === null || !(hit.meta?.groupLen > 0)) {
      invalid += 1;
      invalidSample ??= hit.id;
      continue;
    }
    if (!Number.isFinite(hit.similarity)) {
      throw RetrieveError.contract(`store returned a non-finite similarity for ${hit.id}`);
    }
    candidates.push({
      id: hit.id,
      meta: hit.meta,
      similarity: hit.similarity,
      retrieval: 0,
      provenance: Provenance.vector(0),
      payload: hit.payload ?? null,
      duplicates: 0,
      modelScore: null,
    });
  }
  if (invalidSample !== null) {
    degradations.push(degradation("UnrequestedChunk", { count: invalid, sample: invalidSample }));
  }

  // Our own ordering, never the store's, and ties broken by id so the result is reproducible.
  candidates.sort((a, b) => b.similarity - a.similarity || cmpStr(a.id, b.id));
  candidates.forEach((candidate, i) => {
    candidate.provenance = Provenance.vector(i + 1);
  });

  let quotaSuppressed;
  [candidates, quotaSuppressed] = applyQuota(candidates, config);
  let duplicatesDropped = 0;
  if (config.dedupByContent) [candidates, duplicatesDropped] = dedupByContent(candidates);
  normalizeRetrievalScores(candidates);
  if (candidates.length > plan.maxCandidates) candidates.length = plan.maxCandidates;
  capInlineText(candidates, config.maxInlineTextBytes);

  // ---- complete groups, before any narrowing ----
  started = performance.now();
  const siblingsAdded = await expandGroups(r, candidates, plan, config, namespace, meter, degradations);
  stageMillis.expand = elapsed(started);
  const candidateCount = candidates.length;

  // ---- narrow to a judgeable set ----
  const deepSet = narrow(candidates, plan);

  // ---- deep re-ranking ----
  // At weight 0 the model's scores would count for nothing, so none are paid for.
  started = performance.now();
  const outcome =
    plan.modelWeight === 0
      ? emptySummary()
      : await rerank(r, query, candidates, deepSet, config, namespace, meter, degradations);
  stageMillis.rerank = elapsed(started);

  if (config.deadline !== null && config.deadline !== undefined && Date.now() >= config.deadline) {
    if (config.strictDeadline) throw RetrieveError.deadline();
    degradations.push(degradation("DeadlineHit"));
  }

  // ---- select ----
  started = performance.now();
  const selected = await select(r, candidates, plan, namespace, meter, degradations);
  stageMillis.select = elapsed(started);

  const groupIntegrityAdded = selected.filter((s) => s.selection === Selection.GroupIntegrity).length;
  const report = {
    plan,
    rawHits,
    quotaSuppressed,
    duplicatesDropped,
    candidates: candidateCount,
    siblingsAdded,
    groupIntegrityAdded,
    deepScored: outcome.deepScored,
    rerankCalls: outcome.rerankCalls,
    rerankBatchesFailed: outcome.batchesFailed,
    rerankChars: outcome.rerankChars,
    chunksLoaded: meter.loaded,
    peakTextBytes: meter.peak,
    degraded: degradations.length > 0,
    stageMillis,
  };
  return new RetrievalOutcome(selected, report, degradations);
}

/**
 * Counts how often the store's own order disagrees with similarity-descending: the only cheap
 * detector for returning a distance without converting it.
 */
function checkOrder(hits, degradations) {
  if (hits.length < 4) return;
  const pairs = hits.length - 1;
  let inversions = 0;
  for (let i = 0; i + 1 < hits.length; i++) {
    if (hits[i].similarity < hits[i + 1].similarity) inversions += 1;
  }
  if (inversions * 2 > pairs) degradations.push(degradation("StoreOrderDisagrees", { inversions, pairs }));
}

/**
 * Keeps at most `perDocQuota` hits per document, and at most `perGroupQuota` per `Inseparable`
 * group, dropping the worst-ranked first. The per-group quota applies only to `Inseparable`
 * groups because only there is it lossless.
 */
function applyQuota(candidates, config) {
  const perGroup = new Map();
  const perDoc = new Map();
  const kept = [];
  for (const candidate of candidates) {
    const group = candidate.meta.group;
    const doc = candidate.meta.doc;
    const g = perGroup.get(group) ?? 0;
    if (candidate.meta.cohesion === Cohesion.Inseparable && g >= config.perGroupQuota) continue;
    const d = perDoc.get(doc) ?? 0;
    if (d >= config.perDocQuota) continue;
    perGroup.set(group, g + 1);
    perDoc.set(doc, d + 1);
    kept.push(candidate);
  }
  return [kept, candidates.length - kept.length];
}

/** Suppresses identical bodies across different documents, keeping the best. */
function dedupByContent(candidates) {
  const best = new Map();
  const drop = new Array(candidates.length).fill(false);
  let dropped = 0;
  candidates.forEach((candidate, i) => {
    const fp = candidate.meta.contentFp;
    const keeper = best.get(fp);
    if (keeper === undefined) {
      best.set(fp, i);
      return;
    }
    // Within one document, repeated bodies are legitimate structure.
    if (candidates[keeper].meta.doc === candidate.meta.doc) return;
    candidates[keeper].duplicates = Math.min(candidates[keeper].duplicates + 1, 0xffff);
    drop[i] = true;
    dropped += 1;
  });
  return [candidates.filter((_, i) => !drop[i]), dropped];
}

/**
 * Maps raw store similarities onto `0.0..=1.0` within this candidate set: min-max, because cosine
 * similarity can be negative.
 */
function normalizeRetrievalScores(candidates) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of candidates) {
    lo = Math.min(lo, c.similarity);
    hi = Math.max(hi, c.similarity);
  }
  const span = hi - lo;
  for (const c of candidates) {
    c.retrieval = span > EPSILON ? clamp((c.similarity - lo) / span, 0, 1) : 1;
  }
}

/** Drops inline payloads past the configured byte ceiling; those fall back to lazy loading. */
function capInlineText(candidates, maxBytes) {
  let budget = maxBytes;
  for (const c of candidates) {
    if (!c.payload) continue;
    const bytes = payloadBytes(c.payload);
    if (bytes <= budget) budget -= bytes;
    else c.payload = null;
  }
}

/**
 * Pulls in the siblings of hits whose parts are only honest together. `Inseparable` expansion is
 * unconditional at every recall setting; `Distinct` expansion is on the dial, bounded by
 * `neighborWindow`.
 */
async function expandGroups(r, candidates, plan, config, namespace, meter, degradations) {
  const present = new Set(candidates.map((c) => c.id));

  // One entry per group that wants completing.
  const wants = [];
  for (const candidate of candidates) {
    const meta = candidate.meta;
    const inseparable = meta.cohesion === Cohesion.Inseparable;
    if (!inseparable && !plan.expandDistinct) continue;
    if (meta.groupLen <= 1) continue;
    if (wants.some((w) => w.group === meta.group)) continue;
    let ids = siblings(meta.doc, meta.groupOrd, meta.groupLen).filter((id) => !present.has(id));
    if (!inseparable && plan.neighborWindow > 0) {
      // A distinct part's neighbours help only nearby, so pay for a window.
      ids = ids.filter((id) => {
        const pos = position(id);
        return pos !== null && Math.abs(pos[1] - meta.partOrd) <= plan.neighborWindow;
      });
    } else if (!inseparable) {
      continue;
    }
    if (ids.length === 0) continue;
    wants.push({
      seed: candidate.id,
      seedScore: candidate.retrieval,
      inseparable,
      groupOrd: meta.groupOrd,
      doc: meta.doc,
      group: meta.group,
      ids,
    });
  }
  if (wants.length === 0) return 0;
  wants.sort((a, b) => b.seedScore - a.seedScore || cmpStr(a.group, b.group));

  // Budget spent round-robin in descending seed score, not first-come.
  const globalBudget = plan.fanOut * 2;
  const quota = wants.map(() => 0);
  let spent = 0;

  // Inseparable groups first, and only in full. The best-scoring one is always admitted.
  let firstInseparable = true;
  wants.forEach((want, i) => {
    if (!want.inseparable) return;
    const needed = want.ids.length;
    const fits = spent + needed <= globalBudget;
    if (needed === 0 || !(fits || firstInseparable)) return;
    firstInseparable = false;
    quota[i] = needed;
    spent += needed;
  });

  // Then the distinct neighbours, round-robin in descending seed score.
  let progress = true;
  while (spent < globalBudget && progress) {
    progress = false;
    for (let i = 0; i < wants.length; i++) {
      const want = wants[i];
      if (want.inseparable) continue;
      if (spent >= globalBudget) break;
      if (quota[i] < want.ids.length) {
        quota[i] += 1;
        spent += 1;
        progress = true;
      }
    }
  }

  // Trim each group's wanted ids to its quota, keeping the parts nearest the seed.
  const requests = [];
  wants.forEach((want, i) => {
    const allowed = quota[i];
    if (allowed === 0) return;
    let ids = [...want.ids];
    if (ids.length > allowed) {
      const seedPart = position(want.seed)?.[1] ?? 0;
      const part = (id) => position(id)?.[1] ?? 0xffffffff;
      ids.sort((a, b) => {
        const pa = part(a);
        const pb = part(b);
        return Math.abs(pa - seedPart) - Math.abs(pb - seedPart) || pa - pb;
      });
      ids = ids.slice(0, allowed).sort(cmpStr);
      degradations.push(degradation("GroupTruncated", { group: want.group, had: want.ids.length, kept: allowed }));
    }
    requests.push([i, ids]);
  });

  // One pass after the fetch, so completion order cannot leak into the result.
  const ids = requests.flatMap(([, ids]) => ids);
  const fetched = await r.getMany(ids, namespace, config.concurrency.storeGet);
  const failed = new Set();
  for (const [batch, error] of fetched.failed) {
    const inBatch = new Set(batch);
    for (const [i, wanted] of requests) {
      if (wanted.some((id) => inBatch.has(id)) && !failed.has(i)) {
        failed.add(i);
        degradations.push(degradation("GroupExpansionFailed", { group: wants[i].group, error: error.flattened() }));
      }
    }
  }
  const merged = requests.map(([i, ids]) => {
    const chunks = [];
    for (const id of ids) {
      const chunk = fetched.chunks.get(id);
      if (chunk) {
        fetched.chunks.delete(id);
        chunks.push(chunk);
      }
    }
    return [i, chunks];
  });

  let added = 0;
  let siblingBytes = 0;
  // Expansion keeps the text it fetched, bounded here rather than left to grow.
  const retentionCeiling = config.maxInlineTextBytes;
  for (const [i, chunks] of merged) {
    const want = wants[i];
    let accepted = 0;
    for (const chunk of chunks) {
      // Never trust an id we did not ask for, nor a chunk from another group.
      if (
        present.has(chunk.id) ||
        chunk.meta.group !== want.group ||
        chunk.meta.doc !== want.doc ||
        chunk.meta.groupOrd !== want.groupOrd
      ) {
        continue;
      }
      const bytes = payloadBytes(chunk.payload);
      const keepPayload = siblingBytes + bytes <= retentionCeiling;
      if (keepPayload) siblingBytes += bytes;
      candidates.push({
        id: chunk.id,
        meta: chunk.meta,
        // Never scored by the store: it arrived on its seed's strength.
        similarity: 0,
        retrieval: clamp(want.seedScore * plan.siblingInherit, 0, 1),
        provenance: want.inseparable ? Provenance.sibling(want.seed) : Provenance.neighbor(want.seed),
        payload: keepPayload ? chunk.payload : null,
        duplicates: 0,
        modelScore: null,
      });
      accepted += 1;
      added += 1;
    }
    if (want.inseparable) {
      const members = candidates.filter((c) => c.meta.group === want.group);
      const wantLen = want.ids.length > 0 && members.length > 0 ? members[0].meta.groupLen : 0;
      if (accepted < want.ids.length && members.length < wantLen) {
        degradations.push(degradation("GroupIncomplete", { group: want.group, want: wantLen, have: members.length }));
      }
    }
  }

  // Counted, so `peakTextBytes` is the whole truth.
  meter.enter(siblingBytes, added);
  return added;
}
