// In-memory test doubles. They exist for this package's own tests, and are exported so you can
// test your own plugins against the same fixtures (`import ... from "context-retriever/testing"`).
//
// Everything here is deterministic: no clocks, no randomness, no network.

import { PluginError } from "./errors.js";
import { cmpStr, fnv1a64 } from "./ids.js";
import { normalizeWs, splitWhitespace } from "./text.js";
import { ChunkPlan, Cohesion, DocumentInput } from "./types.js";

/** Tracks concurrent entries so a test can assert a concurrency ceiling. */
export class Gauge {
  constructor() {
    this.current = 0;
    this.peak = 0;
  }

  enter() {
    this.current += 1;
    this.peak = Math.max(this.peak, this.current);
  }

  leave() {
    this.current -= 1;
  }
}

// ---- embedder ----

/**
 * Deterministic bag-of-words embedder: each whitespace token is hashed into one of `dim` buckets
 * and the vector is L2-normalized, so cosine similarity behaves like token overlap.
 */
export class HashEmbedder {
  constructor() {
    this.dim = 64;
    this.docSalt = 0n;
    this.querySalt = 0n;
    /** Batch sizes seen, in call order. */
    this.calls = [];
    /** Every text ever embedded. */
    this.textsSeen = [];
    this.gauge = new Gauge();
    this.batchSize = 1;
    this.declareDimensions = true;
    this.fingerprint = "hash/v1";
    /** Fail the nth document batch (0-based). */
    this.failNthBatch = null;
    this.returnWrongCount = false;
    this.returnWrongDim = false;
  }

  /** Embeds queries into a different space, so a test can prove which method was called. */
  withAsymmetricSalts() {
    this.querySalt = 0x9e3779b9n;
    return this;
  }

  withBatchSize(batchSize) {
    this.batchSize = batchSize;
    return this;
  }

  withFingerprint(fingerprint) {
    this.fingerprint = fingerprint;
    return this;
  }

  withoutDeclaredDimensions() {
    this.declareDimensions = false;
    return this;
  }

  failingBatch(nth) {
    this.failNthBatch = nth;
    return this;
  }

  returningWrongCount() {
    this.returnWrongCount = true;
    return this;
  }

  returningWrongDim() {
    this.returnWrongDim = true;
    return this;
  }

  callCount() {
    return this.calls.length;
  }

  seen() {
    return [...this.textsSeen];
  }

  embed(text, salt) {
    const buckets = new Array(this.dim).fill(0);
    for (const token of splitWhitespace(text)) {
      const hash = fnv1a64([token.toLowerCase()]) ^ salt;
      buckets[Number(hash % BigInt(this.dim))] += 1;
    }
    const norm = Math.sqrt(buckets.reduce((n, v) => n + v * v, 0));
    return norm > 0 ? buckets.map((v) => v / norm) : buckets;
  }

  run(texts, salt) {
    this.gauge.enter();
    this.calls.push(texts.length);
    const nth = this.calls.length - 1;
    this.textsSeen.push(...texts);
    this.gauge.leave();
    if (this.failNthBatch === nth) throw PluginError.transient("HashEmbedder", "injected failure");
    let out = texts.map((t) => this.embed(t, salt));
    if (this.returnWrongCount) out.pop();
    if (this.returnWrongDim) out = out.map(() => new Array(this.dim + 1).fill(0.1));
    return out;
  }

  async embedDocuments(texts) {
    return this.run(texts, this.docSalt);
  }

  async embedQueries(texts) {
    return this.run(texts, this.querySalt);
  }

  embedBatchSize() {
    return this.batchSize;
  }

  embedDimensions() {
    return this.declareDimensions ? this.dim : null;
  }

  embedderFingerprint() {
    return this.fingerprint;
  }
}

// ---- store ----

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) dot += a[i] * b[i];
  for (const x of a) na += x * x;
  for (const x of b) nb += x * x;
  na = Math.sqrt(na);
  nb = Math.sqrt(nb);
  return na === 0 || nb === 0 ? 0 : dot / (na * nb);
}

/**
 * Brute-force cosine search over a sorted map, so every observable ordering is deterministic. It
 * enforces the batch sizes it declares by throwing: a call over them is an engine bug.
 */
export class InMemoryStore {
  constructor() {
    /** @type {Map<string, [object, number[]]>} */
    this.records = new Map();
    /** Every call, in order: `{op, ...}`. */
    this.callLog = [];
    this.gauge = new Gauge();
    this.caps = { maxTopK: null };
    this.upsertBatch = 100;
    this.getBatch = 100;
    this.failQuery = false;
    this.failGet = false;
    this.failUpsertAfterNBatches = null;
    this.failDelete = false;
    this.scrambleResultOrder = false;
    this.invertedSimilarity = false;
    this.reorderGetResults = false;
    this.injectUnrequestedChunk = false;
    this.inlinePayloads = false;
    this.failList = false;
    this.listForeignIds = false;
    this.upsertedBatches = 0;
  }

  withCaps(caps) {
    this.caps = { maxTopK: null, ...caps };
    return this;
  }

  withBatchSizes(upsert, get) {
    this.upsertBatch = upsert;
    this.getBatch = get;
    return this;
  }

  /** Returns a distance instead of a similarity: the classic integration bug. */
  inverted() {
    this.invertedSimilarity = true;
    return this;
  }

  /** Returns hits worst-first. */
  scrambled() {
    this.scrambleResultOrder = true;
    return this;
  }

  withInlinePayloads() {
    this.inlinePayloads = true;
    return this;
  }

  failingUpsertAfter(batches) {
    this.failUpsertAfterNBatches = batches;
    return this;
  }

  failingGet() {
    this.failGet = true;
    return this;
  }

  failingQuery() {
    this.failQuery = true;
    return this;
  }

  failingDelete() {
    this.failDelete = true;
    return this;
  }

  failingList() {
    this.failList = true;
    return this;
  }

  listingForeignIds() {
    this.listForeignIds = true;
    return this;
  }

  injectingUnrequestedChunk() {
    this.injectUnrequestedChunk = true;
    return this;
  }

  /** Puts a chunk in the store directly, bypassing every injected failure. */
  seed(chunk, embedding) {
    this.records.set(chunk.id, [chunk, embedding]);
  }

  get size() {
    return this.records.size;
  }

  /** Every stored id, ascending. */
  ids() {
    return [...this.records.keys()].sort(cmpStr);
  }

  chunk(id) {
    return this.records.get(id)?.[0] ?? null;
  }

  calls() {
    return [...this.callLog];
  }

  removeOutOfBand(id) {
    this.records.delete(id);
  }

  resetCalls() {
    this.callLog = [];
  }

  sortedValues() {
    return [...this.records.entries()].sort((a, b) => cmpStr(a[0], b[0])).map(([, v]) => v);
  }

  async upsert(records) {
    this.callLog.push({ op: "upsert", count: records.length });
    if (records.length > this.upsertBatch) {
      throw new Error(`engine bug: upsert of ${records.length} records over the declared upsert_batch_size ${this.upsertBatch}`);
    }
    const accepted = this.upsertedBatches++;
    if (this.failUpsertAfterNBatches !== null && accepted >= this.failUpsertAfterNBatches) {
      throw PluginError.transient("InMemoryStore::upsert", "injected");
    }
    for (const record of records) this.records.set(record.chunk.id, [record.chunk, record.embedding]);
  }

  async query(request) {
    this.callLog.push({ op: "query", topK: request.topK });
    if (this.failQuery) throw PluginError.transient("InMemoryStore::query", "injected");
    const namespaceOk = (chunk) =>
      request.namespace === null || request.namespace === undefined
        ? true
        : chunk.meta.metadata.namespace === request.namespace;
    let hits = this.sortedValues()
      .filter(([chunk]) => namespaceOk(chunk))
      .map(([chunk, embedding]) => {
        const similarity = cosine(request.vector, embedding);
        return [
          similarity,
          {
            id: chunk.id,
            meta: chunk.meta,
            similarity: this.invertedSimilarity ? 1 - similarity : similarity,
            payload: this.inlinePayloads ? chunk.payload : null,
          },
        ];
      });
    // Always nearest-first, as a real ANN index returns.
    hits.sort((a, b) => b[0] - a[0] || cmpStr(a[1].id, b[1].id));
    hits = hits.map(([, hit]) => hit);
    const topK = this.caps.maxTopK === null ? request.topK : Math.min(request.topK, this.caps.maxTopK);
    hits = hits.slice(0, topK);
    if (this.scrambleResultOrder) hits.reverse();
    return hits;
  }

  async get(ids) {
    this.callLog.push({ op: "get", ids: [...ids] });
    if (ids.length > this.getBatch) {
      throw new Error(`engine bug: get of ${ids.length} ids over the declared get_batch_size ${this.getBatch}`);
    }
    if (this.failGet) throw PluginError.transient("InMemoryStore::get", "injected");
    let out = ids.map((id) => this.records.get(id)?.[0]).filter(Boolean);
    if (this.reorderGetResults) out.reverse();
    if (this.injectUnrequestedChunk) {
      const asked = new Set(ids);
      const other = this.sortedValues().find(([c]) => !asked.has(c.id));
      if (other) out.push(other[0]);
    }
    return out;
  }

  async delete(ids) {
    this.callLog.push({ op: "delete", ids: [...ids] });
    if (ids.length > this.getBatch) {
      throw new Error(`engine bug: delete of ${ids.length} ids over the declared get_batch_size ${this.getBatch}`);
    }
    if (this.failDelete) throw PluginError.transient("InMemoryStore::delete", "injected");
    for (const id of ids) this.records.delete(id);
  }

  async listDocumentChunkIds(doc) {
    this.callLog.push({ op: "list", doc });
    if (this.failList) throw PluginError.transient("InMemoryStore::list", "injected");
    // A metadata filter on the stored `doc` field, as a real store would run it.
    const values = this.sortedValues();
    const ids = values.filter(([c]) => c.meta.doc === doc).map(([c]) => c.id);
    if (this.listForeignIds) {
      const other = values.find(([c]) => c.meta.doc !== doc);
      if (other) ids.push(other[0].id);
    }
    return ids;
  }

  storeCapabilities() {
    return this.caps;
  }

  upsertBatchSize() {
    return this.upsertBatch;
  }

  getBatchSize() {
    return this.getBatch;
  }
}

// ---- chunkers ----

/**
 * Splits markdown on headings into one `Distinct` group per section, with the heading as the
 * context; a document with no headings becomes one `Inseparable` group.
 */
export class HeadingChunker {
  /** The plan this chunker would produce. */
  static planFor(doc) {
    // [first line, heading, whether any body text follows it yet]
    const sections = [];
    doc.lines().forEach((line, index) => {
      const trimmed = line.trimStart();
      const heading = trimmed.startsWith("#") ? trimmed.replace(/^#+/, "").trim() : null;
      const hasText = line.trim().length > 0;
      const last = sections[sections.length - 1];
      if (heading !== null && last && !last[2]) last[1] = heading;
      else if (heading !== null) sections.push([index + 1, heading, false]);
      else if (last) last[2] ||= hasText;
      else sections.push([index + 1, null, hasText]);
    });
    if (sections.every(([, heading]) => heading === null)) {
      return ChunkPlan.indivisible(doc.breadcrumb.join(" -> "));
    }
    return new ChunkPlan(
      sections.map(([start, heading]) => ({
        context: heading ?? "",
        topic: heading,
        cohesion: Cohesion.Distinct,
        partStarts: [start],
      })),
    );
  }

  async chunk(doc) {
    return HeadingChunker.planFor(doc);
  }
}

/** A document written as the parts it should be cut into. */
export class Script {
  constructor() {
    this._text = "";
    this._lines = 0;
    this._plan = new ChunkPlan();
  }

  /** Appends one group whose parts are these texts, in order. */
  group(context, cohesion, parts) {
    const partStarts = parts.map((part) => this.push(part));
    this._plan.groups.push({ context, topic: null, cohesion, partStarts });
    return this;
  }

  /** Appends text the chunker marks as omitted, like a page footer. */
  omitted(text) {
    this._plan.omittedStarts.push(this.push(text));
    return this;
  }

  text() {
    return this._text;
  }

  plan() {
    return new ChunkPlan(
      this._plan.groups.map((g) => ({ ...g, partStarts: [...g.partStarts] })),
      [...this._plan.omittedStarts],
    );
  }

  doc(id) {
    return new DocumentInput(id, this._text);
  }

  push(text) {
    const start = this._lines + 1;
    this._text += `${text}\n`;
    this._lines += (text.match(/\n/g) ?? []).length + 1;
    return start;
  }
}

/** Returns a plan you wrote by hand, per document id. */
export class ScriptedChunker {
  constructor() {
    this.plans = new Map();
    this.failFor = new Set();
    this.calls = 0;
  }

  withPlan(docId, plan) {
    this.plans.set(docId, plan);
    return this;
  }

  failingFor(docId) {
    this.failFor.add(docId);
    return this;
  }

  callCount() {
    return this.calls;
  }

  async chunk(doc) {
    this.calls += 1;
    if (this.failFor.has(doc.id)) throw PluginError.transient("ScriptedChunker", "injected");
    return this.plans.get(doc.id) ?? ChunkPlan.indivisible(doc.breadcrumb.join(" -> "));
  }
}

// ---- rerankers ----

/** Returns scores you wrote by hand, with knobs for every way a real reranker misbehaves. */
export class ScriptedReranker {
  constructor(defaultScore) {
    this.scores = new Map();
    this.defaultScore = defaultScore;
    this.batchSize = 8;
    this.batchChars = 0;
    this.rawScores = new Map();
    /** Every call, in order: `{items: ids}`. */
    this.calls = [];
    this.gauge = new Gauge();
    this.failBatchesContaining = new Set();
    this.wrongLenOnCall = null;
    this.nanFor = new Set();
  }

  withScore(chunkId, score) {
    this.scores.set(chunkId, score);
    return this;
  }

  withBatchSize(batchSize) {
    this.batchSize = batchSize;
    return this;
  }

  withBatchChars(chars) {
    this.batchChars = chars;
    return this;
  }

  withRawScore(chunkId, score) {
    this.rawScores.set(chunkId, score);
    return this;
  }

  failingBatchesWith(chunkId) {
    this.failBatchesContaining.add(chunkId);
    return this;
  }

  nanForId(chunkId) {
    this.nanFor.add(chunkId);
    return this;
  }

  withWrongLenOnCall(call) {
    this.wrongLenOnCall = call;
    return this;
  }

  observed() {
    return [...this.calls];
  }

  callCount() {
    return this.calls.length;
  }

  saw(chunkId) {
    return this.calls.some((call) => call.items.includes(chunkId));
  }

  async rerank(request) {
    this.gauge.enter();
    this.calls.push({ items: request.items.map((i) => i.id) });
    const nth = this.calls.length - 1;
    this.gauge.leave();
    if (request.items.some((i) => this.failBatchesContaining.has(i.id))) {
      throw PluginError.transient("ScriptedReranker", "injected");
    }
    const out = request.items.map((item) => {
      if (this.nanFor.has(item.id)) return Number.NaN;
      if (this.rawScores.has(item.id)) return this.rawScores.get(item.id);
      const score = this.scores.get(item.id) ?? this.defaultScore;
      return Math.min(Math.max(score, 0), 1);
    });
    if (this.wrongLenOnCall === nth) out.pop();
    return out;
  }

  rerankBatchSize() {
    return this.batchSize;
  }

  rerankBatchChars() {
    return this.batchChars;
  }
}

/** Scores by token overlap between the query and the chunk's context plus body. */
export class KeywordReranker {
  constructor() {
    this.batchSize = 8;
    this.calls = [];
    this.gauge = new Gauge();
  }

  withBatchSize(batchSize) {
    this.batchSize = batchSize;
    return this;
  }

  callCount() {
    return this.calls.length;
  }

  async rerank(request) {
    this.gauge.enter();
    this.calls.push({ items: request.items.map((i) => i.id) });
    this.gauge.leave();
    const terms = new Set(
      splitWhitespace(request.query)
        .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase())
        .filter((t) => Buffer.byteLength(t, "utf8") > 2),
    );
    return request.items.map((item) => {
      const haystack = normalizeWs(`${item.context} ${item.text}`).toLowerCase();
      if (terms.size === 0) return 0;
      let hits = 0;
      for (const term of terms) if (haystack.includes(term)) hits += 1;
      return Math.min(Math.max(hits / terms.size, 0), 1);
    });
  }

  rerankBatchSize() {
    return this.batchSize;
  }
}

/** One object implementing every plugin at once. */
export class OneClient {
  constructor() {
    this.embedder = new HashEmbedder();
    this.chunker = new HeadingChunker();
    this.reranker = new KeywordReranker();
  }

  embedDocuments(texts) {
    return this.embedder.embedDocuments(texts);
  }

  embedQueries(texts) {
    return this.embedder.embedQueries(texts);
  }

  embedDimensions() {
    return this.embedder.embedDimensions();
  }

  chunk(doc, budget) {
    return this.chunker.chunk(doc, budget);
  }

  rerank(request) {
    return this.reranker.rerank(request);
  }
}
