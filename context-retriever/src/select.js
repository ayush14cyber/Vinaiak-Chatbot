// Selection: fuse the scores, apply the floor and the margin, backfill to the recall target, keep
// groups whole, load the text of what survived, and order the result deterministically.

import { cmpStr, siblings } from "./ids.js";
import { Provenance, Selection, cmpSelection, degradation } from "./report.js";
import { payloadBytes } from "./stage.js";
import { Cohesion } from "./types.js";
import { clamp } from "./util.js";

/**
 * Compares scores as scaled integers, which makes the comparator total and stable: no NaN panic,
 * no sub-epsilon reordering between otherwise identical runs.
 */
function quantize(x) {
  if (Number.isNaN(x)) return Number.MIN_SAFE_INTEGER;
  return Math.trunc(clamp(x, -1.0e6, 1.0e6) * 1.0e6);
}

/** Fuse, threshold, backfill, complete groups, hydrate, cap, and order. */
export async function select(r, candidates, plan, namespace, meter, degradations) {
  if (candidates.length === 0) return [];

  // ---- fuse ----
  // Model and retrieval evidence are blended. The model term for a candidate no call scored,
  // while others were, is the median score the model gave in this run.
  const judged = candidates.map((c) => c.modelScore).filter((s) => s !== null);
  const typicalModel = judged.length > 0 ? median(judged) : null;
  const fused = candidates.map((candidate) => {
    const blend = (model) => plan.modelWeight * model + (1 - plan.modelWeight) * candidate.retrieval;
    let score;
    if (candidate.modelScore !== null) score = blend(candidate.modelScore);
    else if (typicalModel !== null) score = blend(typicalModel);
    else if (plan.modelWeight === 0) score = candidate.retrieval;
    // Nothing was judged, so every candidate is on the retrieval scale: vector order.
    else score = candidate.retrieval * 0.95;
    return Number.isFinite(score) ? clamp(score, 0, 1) : 0;
  });
  const best = fused.reduce((m, s) => Math.max(m, s), 0);

  // ---- threshold ----
  // Keep a candidate if it clears the absolute floor and sits within the margin of the best.
  const cutoff = Math.max(plan.minScore, best - plan.keepMargin);
  /** @type {Map<number, string>} index → selection, iterated in index order */
  let chosen = new Map();
  fused.forEach((score, index) => {
    if (score >= cutoff) {
      chosen.set(index, candidates[index].modelScore === null ? Selection.Degraded : Selection.Ranked);
    }
  });

  const byScoreThenId = (a, b) =>
    quantize(fused[b] ?? 0) - quantize(fused[a] ?? 0) || cmpStr(candidates[a].id, candidates[b].id);

  // ---- backfill to the recall target ----
  if (chosen.size < plan.minResults) {
    const rest = candidates.map((_, i) => i).filter((i) => !chosen.has(i));
    rest.sort(byScoreThenId);
    for (const index of rest) {
      if (chosen.size >= plan.minResults) break;
      chosen.set(index, Selection.Backfill);
    }
  }
  chosen = sortedByKey(chosen);

  // ---- bound the seeds ----
  // `topN` bounds seeds, not total output.
  const seeds = [...chosen.keys()].filter((i) => candidates[i].provenance.kind === "vector");
  seeds.sort(byScoreThenId);
  if (seeds.length > plan.topN) {
    // Spend the seed budget round-robin across documents, best document first.
    const byDoc = [];
    for (const index of seeds) {
      const doc = candidates[index].meta.doc;
      const entry = byDoc.find(([d]) => d === doc);
      if (entry) entry[1].push(index);
      else byDoc.push([doc, [index]]);
    }
    const admitted = [];
    for (let round = 0; admitted.length < plan.topN; round++) {
      let progressed = false;
      for (const [, list] of byDoc) {
        if (admitted.length >= plan.topN) break;
        if (round < list.length) {
          admitted.push(list[round]);
          progressed = true;
        }
      }
      if (!progressed) break;
    }
    const keep = new Set(admitted);
    for (const index of seeds) if (!keep.has(index)) chosen.delete(index);
  }

  // ---- nothing cleared the bar ----
  // A query with any candidate never comes back empty.
  if (chosen.size === 0) {
    const rest = candidates.map((_, i) => i);
    rest.sort(byScoreThenId);
    const atLeast = Math.max(plan.minResults, 1);
    for (const index of rest.slice(0, atLeast)) chosen.set(index, Selection.Backfill);
    chosen = sortedByKey(chosen);
    degradations.push(degradation("FloorBypassed", { returned: chosen.size }));
  }

  // ---- keep inseparable groups whole ----
  chosen = await completeGroups(r, candidates, fused, chosen, plan, namespace, meter, degradations);

  // ---- load the text of what survived ----
  const [hydrated, hydrateError] = await hydrate(r, candidates, chosen, namespace, meter);

  let out = [];
  let missingText = 0;
  for (const [index, selection] of chosen) {
    const candidate = candidates[index];
    const payload = candidate.payload ?? hydrated.get(candidate.id);
    if (!payload) {
      missingText += 1;
      continue;
    }
    out.push({
      chunk: { id: candidate.id, meta: candidate.meta, payload },
      score: fused[index] ?? 0,
      vectorSimilarity: candidate.similarity,
      retrievalScore: candidate.retrieval,
      modelScore: candidate.modelScore,
      provenance: candidate.provenance,
      selection,
      duplicates: candidate.duplicates,
    });
  }
  if (missingText > 0) {
    degradations.push(degradation("ChunkTextMissing", { count: missingText, error: hydrateError }));
  }

  // ---- an incomplete inseparable group is dropped, not halved ----
  out = dropIncompleteGroups(out, degradations);

  // ---- cap, then order ----
  return groupContiguous(applyCap(out, plan.hardCap()));
}

/** `map` with its keys in ascending order, as a `BTreeMap` iterates. */
function sortedByKey(map) {
  return new Map([...map.entries()].sort((a, b) => a[0] - b[0]));
}

/**
 * Bounds the output, recall-first: never part of a passage; never drop a matched document; never
 * drop a group there was room to begin; then stop.
 */
function applyCap(chunks, hardCap) {
  if (chunks.length <= hardCap) return chunks;

  // Group, then order groups by their best member, by score alone.
  const groups = [];
  for (const chunk of chunks) {
    const key = chunk.chunk.meta.group;
    const entry = groups.find(([k]) => k === key);
    if (entry) entry[1].push(chunk);
    else groups.push([key, [chunk]]);
  }
  groups.sort(([, a], [, b]) => capOrder(bestOf(a), bestOf(b)));

  // Round-robin across documents, best document first.
  const byDoc = [];
  for (const [, members] of groups) {
    const doc = members[0]?.chunk.meta.doc ?? "";
    const entry = byDoc.find(([d]) => d === doc);
    if (entry) entry[1].push(members);
    else byDoc.push([doc, [members]]);
  }

  // Round 0, every document's best group, is admitted regardless of the cap.
  const kept = [];
  for (const [, groupList] of byDoc) if (groupList.length > 0) kept.push(...groupList[0]);

  for (let round = 1; ; round++) {
    let offered = false;
    for (const [, groupList] of byDoc) {
      if (kept.length >= hardCap) break;
      const members = groupList[round];
      if (!members) continue;
      offered = true;
      if (members[0]?.chunk.meta.cohesion === Cohesion.Inseparable) {
        // Whole, even if it overshoots: there was room to start it.
        kept.push(...members);
      } else {
        // A distinct group's parts stand alone, so trimming is harmless.
        const room = Math.max(hardCap - kept.length, 0);
        kept.push(...[...members].sort(finalCmp).slice(0, room));
      }
    }
    if (kept.length >= hardCap || !offered) break;
  }
  return kept;
}

/** Best member first, by score alone. */
function capOrder(a, b) {
  return (
    quantize(b.score) - quantize(a.score) ||
    quantize(b.retrievalScore) - quantize(a.retrievalScore) ||
    finalCmp(a, b)
  );
}

function bestOf(members) {
  return members.reduce((best, m) => (best === null || capOrder(m, best) < 0 ? m : best), null);
}

/** Removes any `Inseparable` group that is missing members, and says so. */
function dropIncompleteGroups(out, degradations) {
  const present = new Map();
  for (const chunk of out) {
    const meta = chunk.chunk.meta;
    if (meta.cohesion !== Cohesion.Inseparable) continue;
    const entry = present.get(meta.group) ?? [0, meta.groupLen];
    entry[0] += 1;
    present.set(meta.group, entry);
  }
  const incomplete = new Set();
  for (const group of [...present.keys()].sort(cmpStr)) {
    const [have, groupLen] = present.get(group);
    if (have < groupLen) {
      degradations.push(degradation("GroupIncomplete", { group, want: groupLen, have }));
      incomplete.add(group);
    }
  }
  return incomplete.size === 0 ? out : out.filter((c) => !incomplete.has(c.chunk.meta.group));
}

/**
 * Brings back every part of every selected `Inseparable` group, ignoring the floor and the
 * margin: pool members first, then whatever is still missing from the store.
 */
async function completeGroups(r, candidates, fused, chosen, plan, namespace, meter, degradations) {
  const wants = [];
  for (const index of chosen.keys()) {
    const c = candidates[index];
    if (c.meta.cohesion !== Cohesion.Inseparable) continue;
    const score = fused[index] ?? 0;
    const want = wants.find((w) => w.group === c.meta.group);
    if (want) {
      if (score > want.best) {
        want.best = score;
        want.bestRetrieval = c.retrieval;
        want.seed = c.id;
      }
    } else {
      wants.push({
        group: c.meta.group,
        doc: c.meta.doc,
        groupOrd: c.meta.groupOrd,
        groupLen: c.meta.groupLen,
        seed: c.id,
        best: score,
        bestRetrieval: c.retrieval,
      });
    }
  }
  if (wants.length === 0) return chosen;

  // 1. Pool members first: free.
  for (const want of wants) {
    candidates.forEach((c, index) => {
      if (c.meta.group === want.group && !chosen.has(index)) chosen.set(index, Selection.GroupIntegrity);
    });
  }

  // 2. Whatever is still missing comes from the store.
  const ids = new Set(candidates.map((c) => c.id));
  const missing = [];
  wants.forEach((want, w) => {
    for (const id of siblings(want.doc, want.groupOrd, want.groupLen)) {
      if (!ids.has(id)) missing.push([w, id]);
    }
  });
  if (missing.length === 0) return sortedByKey(chosen);

  const fetched = await r.getMany(
    missing.map(([, id]) => id),
    namespace,
    1,
  );
  for (const [batch, error] of fetched.failed) {
    // Not fatal: the affected groups come up short and are dropped whole, with this as the reason.
    const inBatch = new Set(batch);
    const groups = new Set(missing.filter(([, id]) => inBatch.has(id)).map(([w]) => wants[w].group));
    for (const group of [...groups].sort(cmpStr)) {
      degradations.push(degradation("GroupExpansionFailed", { group, error: error.flattened() }));
    }
  }

  let bytes = 0;
  let added = 0;
  const fetchedChunks = [...fetched.chunks.entries()].sort((a, b) => cmpStr(a[0], b[0]));
  for (const [, chunk] of fetchedChunks) {
    // Only for the group we asked about.
    const entry = missing.find(([, id]) => id === chunk.id);
    if (!entry) continue;
    const want = wants[entry[0]];
    if (chunk.meta.group !== want.group || candidates.some((c) => c.id === chunk.id)) continue;
    bytes += payloadBytes(chunk.payload);
    added += 1;
    const index = candidates.length;
    candidates.push({
      id: chunk.id,
      meta: chunk.meta,
      similarity: 0,
      retrieval: clamp(want.bestRetrieval * plan.siblingInherit, 0, 1),
      provenance: Provenance.sibling(want.seed),
      payload: chunk.payload,
      duplicates: 0,
      modelScore: null,
    });
    fused.push(clamp(want.best * plan.siblingInherit, 0, 1));
    chosen.set(index, Selection.GroupIntegrity);
  }
  meter.enter(bytes, added);
  return sortedByKey(chosen);
}

/** Loads the text of selected chunks that do not have it yet. */
async function hydrate(r, candidates, chosen, namespace, meter) {
  const wanted = [...chosen.keys()].map((i) => candidates[i]).filter((c) => !c.payload).map((c) => c.id);
  const fetched = await r.getMany(wanted, namespace, 1);
  const out = new Map();
  let bytes = 0;
  for (const [id, chunk] of fetched.chunks) {
    out.set(id, chunk.payload);
    bytes += payloadBytes(chunk.payload);
  }
  meter.enter(bytes, out.size);
  const error = fetched.failed.length > 0 ? fetched.failed[fetched.failed.length - 1][1] : null;
  return [out, error];
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  if (n % 2 === 1) return sorted[Math.floor(n / 2)];
  return (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/** Total, jitter-free comparator. */
function finalCmp(a, b) {
  const am = a.chunk.meta;
  const bm = b.chunk.meta;
  return (
    cmpSelection(a.selection, b.selection) ||
    quantize(b.score) - quantize(a.score) ||
    quantize(b.retrievalScore) - quantize(a.retrievalScore) ||
    cmpStr(am.doc, bm.doc) ||
    am.groupOrd - bm.groupOrd ||
    am.partOrd - bm.partOrd ||
    cmpStr(a.chunk.id, b.chunk.id)
  );
}

/**
 * Emits group-contiguously: groups ordered by their best member, members in reading order, so the
 * result reads as coherent prose for the answering model.
 */
function groupContiguous(chunks) {
  const sorted = [...chunks].sort(finalCmp);
  const bestOfGroup = new Map();
  const cmpKey = (x, y) => cmpSelection(x[0], y[0]) || x[1] - y[1] || x[2] - y[2];
  sorted.forEach((chunk, position) => {
    const key = chunk.chunk.meta.group;
    const candidate = [chunk.selection, -quantize(chunk.score), position];
    const current = bestOfGroup.get(key);
    if (!current || cmpKey(candidate, current) < 0) bestOfGroup.set(key, candidate);
  });
  return sorted.sort((a, b) => {
    const ka = bestOfGroup.get(a.chunk.meta.group);
    const kb = bestOfGroup.get(b.chunk.meta.group);
    return (
      cmpKey(ka, kb) ||
      a.chunk.meta.partOrd - b.chunk.meta.partOrd ||
      cmpStr(a.chunk.id, b.chunk.id)
    );
  });
}
