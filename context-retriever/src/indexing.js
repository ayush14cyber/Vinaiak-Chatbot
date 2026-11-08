// The write path: `addDocument` and `removeDocument`.
//
// The invariant that drives the step order: write the new chunks first, and only then delete the
// slots the document no longer uses, and never delete anything if a write failed. Any
// interruption then leaves a superset of the correct chunks, never a gap.
//
// Stale chunks are found by asking the store: `listDocumentChunkIds` is a metadata filter on the
// document id every chunk carries. After the new chunks are written, whatever the store lists for
// the document that is not in the new set is stale.

import { defaultIndexOptions } from "./config.js";
import { IndexError, PluginError } from "./errors.js";
import { chunkId, cmpStr, contentFp, documentOf, groupId, position, stateFp } from "./ids.js";
import { IndexStatus, degradation } from "./report.js";
import { charCount, embedText, renderContext, sizeSplit } from "./text.js";
import { Cohesion } from "./types.js";
import { batches, mapConcurrent, settle } from "./util.js";

const elapsed = (started) => Math.round(performance.now() - started);

/** Agentic chunking, contextualization and idempotent (re-)indexing. */
export async function addDocument(r, doc, namespace, options) {
  options = { ...defaultIndexOptions(), ...options };
  const cfg = r.indexConfig;
  const degradations = [];
  const stageMillis = {};

  const chunker = r.chunker;
  if (!chunker) throw IndexError.noChunker();
  validateInput(doc, cfg.maxDocumentChars);

  if (doc.text.trim().length === 0) {
    if (options.allowEmptyAsDelete) return removeDocument(r, doc.id, namespace);
    throw IndexError.input("document text is empty");
  }

  // ---- plan ----
  let started = performance.now();
  let cut;
  let usedChunkerFallback;
  const planned = await settle(Promise.resolve().then(() => chunker.chunk(doc, { ...cfg.budget })));
  if (planned.ok) {
    cut = cutPlan(doc, planned.value);
    if (cut.startsOutOfRange > 0 || cut.startsConflicting > 0) {
      degradations.push(
        degradation("PlanStartsIgnored", {
          outOfRange: cut.startsOutOfRange,
          conflicting: cut.startsConflicting,
        }),
      );
    }
    usedChunkerFallback = false;
  } else {
    const error = PluginError.from(planned.error);
    if (!options.fallbackOnChunkerError) throw IndexError.chunker(error);
    degradations.push(degradation("ChunkerFallbackUsed", { error }));
    cut = fallbackCut(doc, r);
    usedChunkerFallback = true;
  }

  const split = { count: 0 };
  if (!normalizePlan(doc, r, cut, split)) {
    // A plan with nothing usable in it is a chunker failure, whatever it returned.
    if (!options.fallbackOnChunkerError) throw IndexError.invalidPlan("plan has no usable parts");
    if (!usedChunkerFallback) {
      degradations.push(
        degradation("ChunkerFallbackUsed", {
          error: PluginError.permanent(
            "chunk plan",
            "no part starts inside the document, or every part is blank",
          ),
        }),
      );
    }
    cut = fallbackCut(doc, r);
    usedChunkerFallback = true;
    split.count = 0;
    if (!normalizePlan(doc, r, cut, split)) {
      throw IndexError.invalidPlan("document has no indexable text");
    }
  }

  const budget = cfg.budget;
  if (cut.groups.length > budget.maxGroups) {
    throw IndexError.planTooLarge("groups", "ChunkBudget::max_groups", cut.groups.length, budget.maxGroups);
  }
  // Only an inseparable group comes back whole, so only its size bounds a returned passage.
  const tooLong = cut.groups.find(
    (g) => g.cohesion === Cohesion.Inseparable && g.parts.length > budget.maxPartsPerGroup,
  );
  if (tooLong) {
    throw IndexError.planTooLarge(
      "parts in one inseparable group",
      "ChunkBudget::max_parts_per_group",
      tooLong.parts.length,
      budget.maxPartsPerGroup,
    );
  }
  const totalParts = cut.groups.reduce((n, g) => n + g.parts.length, 0);
  if (totalParts > cfg.maxChunksPerDoc) {
    throw IndexError.planTooLarge("chunks", "IndexConfig::max_chunks_per_doc", totalParts, cfg.maxChunksPerDoc);
  }

  const chunks = materialize(doc, r, cut.groups);
  const newIds = chunks.map((p) => p.id);
  const inseparableGroups = cut.groups.filter((g) => g.cohesion === Cohesion.Inseparable).length;
  stageMillis.plan = elapsed(started);

  // ---- what can be reused ----
  started = performance.now();
  let stored = new Map();
  if (options.reuseUnchanged) {
    // A failed read is never fatal here: it just means re-embedding.
    try {
      stored = await fetchChunks(r, newIds, namespace, degradations);
    } catch (error) {
      degradations.push(degradation("ReuseLookupFailed", { error: PluginError.from(error) }));
    }
  }
  const toEmbed = [];
  const reused = [];
  for (const p of chunks) {
    const s = stored.get(p.id);
    if (!s || s.meta.stateFp !== p.meta.stateFp) toEmbed.push(p);
    else reused.push(p);
  }
  stageMillis.diff = elapsed(started);

  // ---- embed what changed ----
  started = performance.now();
  const counter = { calls: 0 };
  const embedded = await embedChanged(r, toEmbed, counter);
  if (embedded.error) {
    // Nothing has been written, so the stored document is still the previous version.
    if (!options.partialUpsertOnEmbedFailure) throw IndexError.embedder(embedded.error);
    degradations.push(degradation("EmbedFailed", { count: embedded.failed, error: embedded.error }));
  }
  stageMillis.embed = elapsed(started);

  // ---- write ----
  started = performance.now();
  const records = [];
  const unwritten = new Set();
  toEmbed.forEach((p, i) => {
    const embedding = embedded.vectors[i];
    if (embedding) records.push({ chunk: p, embedding });
    else unwritten.add(p.id);
  });
  const chunksUpserted = records.length;
  if (records.length > 0) {
    try {
      await upsertRecords(r, records, namespace);
    } catch (error) {
      throw IndexError.store(PluginError.from(error));
    }
  }
  stageMillis.upsert = elapsed(started);

  // ---- delete the slots this document no longer uses ----
  // Only now, after every write succeeded. A slot whose embedding failed holds no part of this
  // version, so an older chunk there is stale too.
  started = performance.now();
  let staleDeleted = 0;
  let reconciled = false;
  try {
    const existing = await listOwnChunks(r, doc.id, namespace, degradations);
    const live = new Set(newIds.filter((id) => !unwritten.has(id)));
    const stale = existing.filter((id) => !live.has(id));
    if (stale.length === 0) {
      reconciled = true;
    } else {
      try {
        await deleteIds(r, stale, namespace);
        staleDeleted = stale.length;
        reconciled = true;
      } catch (error) {
        degradations.push(
          degradation("StaleCleanupFailed", { count: stale.length, error: PluginError.from(error) }),
        );
      }
    }
  } catch (error) {
    // Not fatal: the new content is written and correct.
    degradations.push(degradation("StaleListingFailed", { error: PluginError.from(error) }));
  }
  stageMillis.cleanup = elapsed(started);

  // `Unchanged` promises the index already matched the document.
  const status =
    chunksUpserted === 0 && staleDeleted === 0 && reconciled && embedded.failed === 0
      ? IndexStatus.Unchanged
      : IndexStatus.Indexed;

  return {
    doc: doc.id,
    status,
    groups: cut.groups.length,
    inseparableGroups,
    chunksTotal: chunks.length,
    chunksReused: reused.length,
    chunksUpserted,
    staleDeleted,
    oversizedPartsSplit: split.count,
    linesOmitted: cut.linesOmitted,
    charsOmitted: cut.charsOmitted,
    usedChunkerFallback,
    embedCalls: counter.calls,
    degraded: degradations.length > 0,
    degradations,
    stageMillis,
  };
}

/** Deletes every chunk of a document: whatever the store lists for it. */
export async function removeDocument(r, doc, namespace) {
  const degradations = [];
  const stageMillis = {};
  const started = performance.now();

  // Here listing is the whole job, so its failure is the call's failure.
  let ids;
  try {
    ids = await listOwnChunks(r, doc, namespace, degradations);
  } catch (error) {
    throw IndexError.store(PluginError.from(error));
  }
  const groups = new Set(ids.map((id) => position(id)?.[0]).filter((g) => g !== undefined));

  let staleDeleted = 0;
  if (ids.length > 0) {
    try {
      await deleteIds(r, ids, namespace);
    } catch (error) {
      throw IndexError.store(PluginError.from(error));
    }
    staleDeleted = ids.length;
  }
  stageMillis.cleanup = elapsed(started);

  return {
    doc,
    status: IndexStatus.Deleted,
    groups: groups.size,
    inseparableGroups: 0,
    chunksTotal: 0,
    chunksReused: 0,
    chunksUpserted: 0,
    staleDeleted,
    oversizedPartsSplit: 0,
    linesOmitted: 0,
    charsOmitted: 0,
    usedChunkerFallback: false,
    embedCalls: 0,
    degraded: degradations.length > 0,
    degradations,
    stageMillis,
  };
}

// ---- steps ----

function validateInput(doc, maxChars) {
  const id = doc.id;
  if (typeof id !== "string" || id.length === 0) throw IndexError.input("document id is empty");
  const bytes = Buffer.byteLength(id, "utf8");
  if (bytes > 256) {
    throw IndexError.input(`document id is ${bytes} bytes, over the 256-byte limit`);
  }
  if (id.includes("#")) {
    throw IndexError.input("document id must not contain '#', the chunk-id separator");
  }
  // Counted in chars, not bytes: the limit exists to bound work, and work is per char.
  const chars = charCount(doc.text);
  if (chars > maxChars) throw IndexError.documentTooLarge(chars, maxChars);
}

/**
 * Cuts the document at the plan's line numbers, so that every line lands in exactly one part or
 * one omitted run, whatever the numbers are. Returns no groups if no part survives.
 */
function cutPlan(doc, plan) {
  const lines = doc.lines();
  const groups = plan.groups ?? [];
  const omittedStarts = plan.omittedStarts ?? [];

  // Each start tagged with its owner: a group's index, or `omitted`, which sorts after every
  // group. So where two starts share a line, an earlier group wins, and any part over an omission.
  const omitted = groups.length;
  const all = [];
  groups.forEach((g, owner) => {
    for (const start of g.partStarts ?? []) all.push([start, owner]);
  });
  for (const start of omittedStarts) all.push([start, omitted]);
  let starts = all.filter(
    ([start]) => Number.isInteger(start) && start >= 1 && start <= lines.length,
  );
  const cut = {
    groups: [],
    linesOmitted: 0,
    charsOmitted: 0,
    startsOutOfRange: all.length - starts.length,
    startsConflicting: 0,
  };
  starts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  // An owner repeating its own start changes nothing, so it is dropped first and not counted.
  starts = starts.filter((s, i) => i === 0 || s[0] !== starts[i - 1][0] || s[1] !== starts[i - 1][1]);
  const claimed = starts.length;
  starts = starts.filter((s, i) => i === 0 || s[0] !== starts[i - 1][0]);
  cut.startsConflicting = claimed - starts.length;
  // Lines before the first start would otherwise belong to nothing.
  if (starts.length > 0) starts[0] = [1, starts[0][1]];

  // Each group with the index of its first run, to restore document order.
  const drafts = groups.map((g) => [
    Infinity,
    { context: g.context ?? "", topic: g.topic ?? null, cohesion: g.cohesion, parts: [] },
  ]);
  starts.forEach(([start, owner], run) => {
    const end = run + 1 < starts.length ? starts[run + 1][0] - 1 : lines.length;
    const runLines = lines.slice(start - 1, end);
    if (owner === omitted) {
      cut.linesOmitted += runLines.length;
      cut.charsOmitted += runLines.reduce((n, l) => n + charCount(l), 0);
    } else {
      const draft = drafts[owner];
      draft[0] = Math.min(draft[0], run);
      draft[1].parts.push(runLines.join(""));
    }
  });
  cut.groups = drafts
    .filter(([, group]) => group.parts.length > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([, group]) => group);
  return cut;
}

/**
 * One group with the breadcrumb as its context, covering the whole document: used when the
 * chunker fails. `Inseparable` while it fits `maxPartsPerGroup`, else `Distinct`.
 */
function fallbackCut(doc, r) {
  const budget = r.indexConfig.budget;
  const parts = sizeSplit(doc.text, budget.maxChars, budget.overlapChars);
  const cohesion = parts.length <= budget.maxPartsPerGroup ? Cohesion.Inseparable : Cohesion.Distinct;
  return {
    groups: [{ context: doc.breadcrumb.join(" -> "), topic: null, cohesion, parts }],
    linesOmitted: 0,
    charsOmitted: 0,
    startsOutOfRange: 0,
    startsConflicting: 0,
  };
}

/** Cleans up whatever the chunker returned. Returns false if nothing usable is left. */
function normalizePlan(doc, r, cut, split) {
  const cfg = r.indexConfig;
  const budget = cfg.budget;
  const overflow = Math.trunc(budget.maxChars * cfg.overflowTolerance);
  const out = [];

  for (const group of cut.groups) {
    // No chunk is ever embedded uncontextualized: the breadcrumb, then the document id.
    if (group.context.trim().length === 0) {
      const breadcrumb = doc.breadcrumb.join(" -> ");
      group.context = breadcrumb.trim().length === 0 ? doc.id : breadcrumb;
    }
    if (group.topic !== null && group.topic.trim().length === 0) group.topic = null;

    const parts = group.parts.map((p) => p.trim()).filter((p) => p.length > 0);
    const packed = packParts(parts, budget.targetChars, budget.minChars);
    const oversized = (p) => charCount(p) > overflow;

    if (group.cohesion === Cohesion.Distinct && packed.length > 1 && packed.some(oversized)) {
      // An oversized part of a distinct group is split into a group of its own, inseparable, so
      // one long entry can't make a whole directory inseparable.
      let run = [];
      const sibling = (cohesion, parts) => ({
        context: group.context,
        topic: group.topic,
        cohesion,
        parts,
      });
      for (const part of packed) {
        if (!oversized(part)) {
          run.push(part);
          continue;
        }
        const pieces = sizeSplit(part, budget.maxChars, budget.overlapChars);
        if (pieces.length <= 1) {
          run.push(...pieces);
          continue;
        }
        split.count += 1;
        if (run.length > 0) {
          out.push(sibling(Cohesion.Distinct, run));
          run = [];
        }
        out.push(sibling(Cohesion.Inseparable, pieces));
      }
      if (run.length > 0) out.push(sibling(Cohesion.Distinct, run));
      continue;
    }

    const sized = [];
    let splitAny = false;
    for (const part of packed) {
      if (oversized(part)) {
        const pieces = sizeSplit(part, budget.maxChars, budget.overlapChars);
        if (pieces.length > 1) {
          splitAny = true;
          split.count += 1;
        }
        sized.push(...pieces);
      } else {
        sized.push(part);
      }
    }
    // The pieces of one passage are only honest together.
    if (splitAny) group.cohesion = Cohesion.Inseparable;
    group.parts = sized;
    out.push(group);
  }

  cut.groups = out.filter((g) => g.parts.length > 0);
  return cut.groups.length > 0;
}

/**
 * Packs consecutive parts of one group up to `target` chars: never splitting a part, never
 * crossing a group boundary, never changing cohesion. A part shorter than `min` absorbs its
 * successor even past `target`, and a trailing runt folds into the part before it.
 */
function packParts(parts, target, min) {
  const out = [];
  let current = "";
  let currentChars = 0;
  for (const part of parts) {
    const chars = charCount(part);
    if (current.length === 0) {
      current = part;
      currentChars = chars;
    } else if (currentChars + 2 + chars <= target || currentChars < min) {
      current += `\n\n${part}`;
      currentChars += 2 + chars;
    } else {
      out.push(current);
      current = part;
      currentChars = chars;
    }
  }
  if (current.length > 0) {
    if (out.length > 0 && currentChars < min) out[out.length - 1] += `\n\n${current}`;
    else out.push(current);
  }
  return out;
}

/** Assigns positional ids and fingerprints. A group's context is rendered once for every part. */
function materialize(doc, r, groups) {
  const placement = r.indexConfig.contextPlacement;
  const embedderFp = r.embedderFingerprint;
  const out = [];
  groups.forEach((group, g) => {
    const context = renderContext(doc.breadcrumb, group.context, group.topic);
    const gid = groupId(doc.id, g);
    const groupLen = group.parts.length;
    // Identical bodies within one group are not deduped: `partOrd` must stay contiguous.
    group.parts.forEach((part, p) => {
      out.push({
        id: chunkId(doc.id, g, p),
        meta: {
          doc: doc.id,
          group: gid,
          groupOrd: g,
          partOrd: p,
          groupLen,
          cohesion: group.cohesion,
          stateFp: stateFp(
            context,
            part,
            group.topic,
            placement,
            groupLen,
            group.cohesion,
            embedderFp,
            doc.metadata,
          ),
          contentFp: contentFp(part),
          chars: charCount(part),
          metadata: { ...doc.metadata },
        },
        payload: { text: part, context, topic: group.topic, placement },
      });
    });
  });
  return out;
}

/**
 * Embeds in batches. A batch that fails leaves its chunks `null`; one that breaks the embedder's
 * contract (wrong count or width) fails the whole call.
 */
async function embedChanged(r, toEmbed, counter) {
  if (toEmbed.length === 0) return { vectors: [], failed: 0, error: null };
  const embedder = r.embedder;
  const wantDim = r.embedDimensions;
  const calls = batches(toEmbed, r.limits.embedBatch).map((batch) =>
    batch.map((p) => embedText(p.payload.context, p.payload.text, p.payload.placement)),
  );
  const results = await mapConcurrent(calls, r.indexConfig.concurrency.embed, (texts) =>
    settle(Promise.resolve().then(() => embedder.embedDocuments(texts))),
  );
  counter.calls += results.length;

  const embedded = { vectors: [], failed: 0, error: null };
  results.forEach((result, i) => {
    const sent = calls[i].length;
    if (!result.ok) {
      embedded.failed += sent;
      for (let n = 0; n < sent; n++) embedded.vectors.push(null);
      embedded.error ??= PluginError.from(result.error);
      return;
    }
    const vectors = result.value;
    if (vectors.length !== sent) throw IndexError.embedCountMismatch(sent, vectors.length);
    if (wantDim !== null && wantDim !== undefined) {
      const bad = vectors.find((v) => v.length !== wantDim);
      if (bad) throw IndexError.dimensionMismatch(wantDim, bad.length);
    }
    embedded.vectors.push(...vectors);
  });
  return embedded;
}

async function upsertRecords(r, records, namespace) {
  const results = await mapConcurrent(
    batches(records, r.limits.upsertBatch),
    r.indexConfig.concurrency.storeWrite,
    (batch) => settle(r.store.upsert(batch, namespace)),
  );
  for (const result of results) if (!result.ok) throw result.error;
}

async function deleteIds(r, ids, namespace) {
  // Sorted so the call sequence is deterministic and comparable across runs.
  const sorted = [...new Set(ids)].sort(cmpStr);
  const results = await mapConcurrent(
    batches(sorted, r.limits.getBatch),
    r.indexConfig.concurrency.storeDelete,
    (batch) => settle(r.store.delete(batch, namespace)),
  );
  for (const result of results) if (!result.ok) throw result.error;
}

/** The stored chunks at `ids`, by id. A chunk whose id was not requested is dropped and reported. */
export async function fetchChunks(r, ids, namespace, degradations) {
  const fetched = await r.getMany(ids, namespace, r.indexConfig.concurrency.storeGet);
  if (fetched.unrequestedSample !== null) {
    degradations.push(
      degradation("UnrequestedChunk", { count: fetched.unrequested, sample: fetched.unrequestedSample }),
    );
  }
  if (fetched.failed.length > 0) throw fetched.failed[0][1];
  return fetched.chunks;
}

/**
 * Every chunk id the store holds for `doc`, keeping only ids that really belong to it: an id that
 * does not parse as a slot of this document is dropped and reported, never deleted.
 */
async function listOwnChunks(r, doc, namespace, degradations) {
  const listed = await r.store.listDocumentChunkIds(doc, namespace);
  const own = new Set();
  let foreign = 0;
  let sample = null;
  for (const id of listed) {
    if (documentOf(id) === doc && position(id) !== null) {
      own.add(id);
    } else {
      foreign += 1;
      sample ??= id;
    }
  }
  if (sample !== null) degradations.push(degradation("ForeignChunkListed", { count: foreign, sample }));
  // Sorted, so deletes go out in a deterministic order.
  return [...own].sort(cmpStr);
}
