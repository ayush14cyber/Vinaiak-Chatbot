// The pipeline object and its builder.

import { IndexConfig } from "./config.js";
import { IndexError, PluginError } from "./errors.js";
import { cmpStr } from "./ids.js";
import { addDocument, removeDocument } from "./indexing.js";
import { retrieveContext } from "./search.js";
import { batches, mapConcurrent, settle } from "./util.js";

/**
 * The defaults of a plugin's optional methods. A plugin is any object with the methods its role
 * needs:
 *
 * - Chunker: `chunk(doc, budget) -> Promise<ChunkPlan>`
 * - Embedder: `embedDocuments(texts)`, `embedQueries(texts) -> Promise<number[][]>`, and
 *   optionally `embedBatchSize()` (default 1), `embedDimensions()` (default none) and
 *   `embedderFingerprint()` (default `"embedder/unversioned"`)
 * - VectorStore: `upsert(records, ns)`, `query({vector, topK, namespace, filter})`,
 *   `get(ids, ns)`, `delete(ids, ns)`, `listDocumentChunkIds(doc, ns)`, and optionally
 *   `storeCapabilities()` (default `{maxTopK: null}`), `upsertBatchSize()` (default 100) and
 *   `getBatchSize()` (default 100)
 * - Reranker: `rerank({query, items}) -> Promise<number[]>`, and optionally `rerankBatchSize()`
 *   (default 8) and `rerankBatchChars()` (default 0, no budget)
 *
 * Plugins own their retries, back-off and error classification: they throw `PluginError`s. An
 * error of any other type is treated as permanent.
 */
const call = (plugin, method, fallback) =>
  typeof plugin[method] === "function" ? plugin[method]() : fallback;

/**
 * Broad retrieval followed by deep re-ranking, over whatever backends you plug in. Every method
 * is safe to share, so one instance can serve every tenant, chosen per call by namespace.
 */
export class Retriever {
  /** Starts building one. */
  static builder() {
    return new RetrieverBuilder();
  }

  constructor(parts) {
    this._chunker = parts.chunker;
    this._embedder = parts.embedder;
    this._store = parts.store;
    this._reranker = parts.reranker;
    this._indexConfig = parts.indexConfig;
    this._limits = parts.limits;
    this._embedderFp = parts.embedderFp;
    this._embedDimensions = parts.embedDimensions;
  }

  /**
   * Agentic chunking, contextualization and idempotent (re-)indexing of one document. Callers
   * must serialize concurrent calls for the same document id.
   *
   * @returns {Promise<object>} the IndexOutcome
   */
  addDocument(doc, namespace = null, options = {}) {
    return addDocument(this, doc, namespace, options);
  }

  /** Deletes every chunk of a document. */
  removeDocument(doc, namespace = null) {
    return removeDocument(this, doc, namespace);
  }

  /** Broad retrieval, then deep re-ranking. */
  retrieveContext(query, config) {
    return retrieveContext(this, query, config);
  }

  /** What a config will actually do, with no I/O. */
  explain(config) {
    return config.resolve(this._limits.caps);
  }

  // ---- internal accessors ----

  get chunker() {
    return this._chunker;
  }

  get embedder() {
    return this._embedder;
  }

  get store() {
    return this._store;
  }

  get reranker() {
    return this._reranker;
  }

  get indexConfig() {
    return this._indexConfig;
  }

  get limits() {
    return this._limits;
  }

  get embedderFingerprint() {
    return this._embedderFp;
  }

  get embedDimensions() {
    return this._embedDimensions;
  }

  /**
   * `VectorStore.get` for any number of ids: calls of at most the store's get batch size,
   * `concurrency` at a time. Only ids that were asked for are kept.
   *
   * @returns {Promise<{chunks: Map<string, object>, failed: Array<[string[], PluginError]>,
   *   unrequested: number, unrequestedSample: string|null}>}
   */
  async getMany(ids, namespace, concurrency) {
    const calls = batches(ids, this._limits.getBatch);
    const results = await mapConcurrent(calls, concurrency, async (batch) => {
      const result = await settle(this._store.get(batch, namespace));
      return [batch, result];
    });
    // In request order, so which failure is reported first does not depend on timing.
    results.sort((a, b) => cmpIdLists(a[0], b[0]));

    const wanted = new Set(ids);
    const fetched = { chunks: new Map(), failed: [], unrequested: 0, unrequestedSample: null };
    for (const [batch, result] of results) {
      if (!result.ok) {
        fetched.failed.push([batch, PluginError.from(result.error)]);
        continue;
      }
      for (const chunk of result.value) {
        if (wanted.has(chunk.id)) {
          fetched.chunks.set(chunk.id, chunk);
        } else {
          fetched.unrequested += 1;
          fetched.unrequestedSample ??= chunk.id;
        }
      }
    }
    return fetched;
  }
}

function cmpIdLists(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = cmpStr(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

/** Builds a `Retriever`. An embedder and a store are required. */
export class RetrieverBuilder {
  constructor() {
    this._chunker = null;
    this._embedder = null;
    this._store = null;
    this._reranker = null;
    this._indexConfig = null;
  }

  /** The agentic chunker. Optional: without it, `addDocument` throws `NoChunker`. */
  chunker(chunker) {
    this._chunker = chunker;
    return this;
  }

  /** The embedder. Required. */
  embedder(embedder) {
    this._embedder = embedder;
    return this;
  }

  /** The vector store. Required. */
  store(store) {
    this._store = store;
    return this;
  }

  /** The deep reranker. Optional: without it, results come in retrieval order. */
  reranker(reranker) {
    this._reranker = reranker;
    return this;
  }

  /** Chunking and write-path settings, an `IndexConfig` or its overrides. */
  indexConfig(config) {
    this._indexConfig = config instanceof IndexConfig ? config : new IndexConfig(config);
    return this;
  }

  /**
   * Finishes. Throws `IndexError` when a required plugin is missing, the config is invalid, or a
   * plugin declares a batch size of zero.
   */
  build() {
    if (!this._embedder) throw IndexError.build("embedder");
    if (!this._store) throw IndexError.build("store");
    const indexConfig = this._indexConfig ?? new IndexConfig();
    indexConfig.validate();

    const positive = (value, what) => {
      if (!(value >= 1)) throw IndexError.config(`${what} returned ${value}; it must be at least 1`);
      return value;
    };
    const caps = { maxTopK: null, ...call(this._store, "storeCapabilities", {}) };
    if (caps.maxTopK === 0) {
      throw IndexError.config(
        "VectorStore::store_capabilities().max_top_k is Some(0); use None for no limit",
      );
    }
    const limits = {
      embedBatch: positive(call(this._embedder, "embedBatchSize", 1), "Embedder::embed_batch_size()"),
      upsertBatch: positive(call(this._store, "upsertBatchSize", 100), "VectorStore::upsert_batch_size()"),
      getBatch: positive(call(this._store, "getBatchSize", 100), "VectorStore::get_batch_size()"),
      rerankBatch: this._reranker
        ? positive(call(this._reranker, "rerankBatchSize", 8), "Reranker::rerank_batch_size()")
        : 0,
      rerankChars: this._reranker ? call(this._reranker, "rerankBatchChars", 0) : 0,
      caps,
    };
    return new Retriever({
      chunker: this._chunker,
      embedder: this._embedder,
      store: this._store,
      reranker: this._reranker,
      indexConfig,
      limits,
      embedderFp: call(this._embedder, "embedderFingerprint", "embedder/unversioned"),
      embedDimensions: call(this._embedder, "embedDimensions", null),
    });
  }
}
