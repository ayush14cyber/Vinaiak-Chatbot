// Configuration, and the single dial that trades precision against recall.
//
// `RetrievalConfig.recall` is the only number most callers ever set. Every other retrieval knob
// is optional and, left `undefined`, is derived from it by `resolve`: a pure, total, I/O-free
// function whose output is echoed back in the report's `plan`, so a production trace shows exactly
// what ran.

import { IndexError, RetrieveError } from "./errors.js";
import { ContextPlacement } from "./text.js";
import { defaultBudget } from "./types.js";

/**
 * Concurrency ceilings for the engine's fan-out points. Every value must be at least 1; zero is
 * rejected by validation rather than quietly treated as one.
 */
export function defaultConcurrency() {
  return {
    /** Concurrent `VectorStore.get` calls. */
    storeGet: 6,
    /** Concurrent `VectorStore.upsert` calls. */
    storeWrite: 4,
    /** Concurrent `VectorStore.delete` calls. */
    storeDelete: 2,
    /** Concurrent `Embedder` calls. */
    embed: 4,
    /** Concurrent `Reranker` calls. */
    rerank: 6,
  };
}

function validateConcurrency(c) {
  if (
    !(c.storeGet >= 1) ||
    !(c.storeWrite >= 1) ||
    !(c.storeDelete >= 1) ||
    !(c.embed >= 1) ||
    !(c.rerank >= 1)
  ) {
    return "every Concurrency ceiling must be at least 1";
  }
  return null;
}

/** How a document is chunked and indexed. */
export class IndexConfig {
  constructor(overrides = {}) {
    /** Chunk sizing, and the limits enforced on whatever the chunker returns. */
    this.budget = { ...defaultBudget(), ...(overrides.budget ?? {}) };
    /** Where context sits relative to the body when embedding. */
    this.contextPlacement = overrides.contextPlacement ?? ContextPlacement.Prepend;
    /** Concurrency ceilings for the write path. */
    this.concurrency = { ...defaultConcurrency(), ...(overrides.concurrency ?? {}) };
    /** Refuse documents larger than this (in chars) instead of running out of memory. */
    this.maxDocumentChars = overrides.maxDocumentChars ?? 4 * 1024 * 1024;
    /** Runaway-plan guard: total chunks for one document. */
    this.maxChunksPerDoc = overrides.maxChunksPerDoc ?? 4096;
    /** A part up to `budget.maxChars * this` is accepted as-is rather than split. */
    this.overflowTolerance = overrides.overflowTolerance ?? 1.25;
  }

  /** Rejects nonsense before any backend is touched; called when the retriever is built. */
  validate() {
    const bad = (what) => {
      throw IndexError.config(what);
    };
    const b = this.budget;
    if (b.maxChars === 0) bad("ChunkBudget::max_chars must be at least 1");
    if (b.targetChars === 0 || b.targetChars > b.maxChars) {
      bad("ChunkBudget::target_chars must be within 1..=max_chars");
    }
    if (b.minChars > b.targetChars) bad("ChunkBudget::min_chars must not exceed target_chars");
    if (b.overlapChars > Math.floor(b.maxChars / 2)) {
      bad("ChunkBudget::overlap_chars must not exceed max_chars / 2");
    }
    if (b.maxGroups === 0 || b.maxPartsPerGroup === 0) {
      bad("ChunkBudget::max_groups and max_parts_per_group must be at least 1");
    }
    if (this.maxDocumentChars === 0 || this.maxChunksPerDoc === 0) {
      bad("max_document_chars and max_chunks_per_doc must be at least 1");
    }
    if (!Number.isFinite(this.overflowTolerance) || this.overflowTolerance < 1.0) {
      bad("overflow_tolerance must be a finite number of at least 1.0");
    }
    const concurrency = validateConcurrency(this.concurrency);
    if (concurrency) bad(concurrency);
  }
}

/** Per-call indexing options. */
export function defaultIndexOptions() {
  return {
    /** Reuse stored chunks whose fingerprint is unchanged instead of re-embedding them. */
    reuseUnchanged: true,
    /**
     * On a `Chunker` error, fall back to a size split with the breadcrumb as the one shared
     * context: a crudely chunked document is retrievable, an unindexed one is not.
     */
    fallbackOnChunkerError: true,
    /**
     * When some embed batches fail, write the chunks that did embed instead of failing the call,
     * and report the rest as `EmbedFailed`. Default false: a failed call is just a retry.
     */
    partialUpsertOnEmbedFailure: false,
    /** Treat empty text as "delete this document" instead of an error. */
    allowEmptyAsDelete: false,
  };
}

const unit = (x) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
const given = (x) => x !== undefined && x !== null;

/** One retrieval request's settings. */
export class RetrievalConfig {
  /** The default: recall-leaning, the setting this engine is tuned for. */
  static DEFAULT = 0.8;
  /** How much the model's judgement outweighs retrieval evidence, when not overridden. */
  static MODEL_WEIGHT = 0.7;

  /** A recall-first config returning `topN` seed results. `overrides` sets any field. */
  constructor(topN = 8, overrides = {}) {
    /** The precision-versus-recall dial, `0.0..=1.0`; default 0.8. */
    this.recall = RetrievalConfig.DEFAULT;
    /** Target number of seed results. */
    this.topN = topN;
    /** Index/tenant selector, e.g. `"orgid3"`. */
    this.namespace = null;
    /** Opaque backend filter, passed through to the store untouched. */
    this.filter = null;
    /** Cooperative deadline, as `Date.now()` milliseconds. */
    this.deadline = null;
    /** Make a hit deadline an error instead. */
    this.strictDeadline = false;

    // Per-knob overrides; `undefined` derives the value from `recall`.
    this.fanOut = undefined;
    this.maxCandidates = undefined;
    this.expandDistinct = undefined;
    this.neighborWindow = undefined;
    this.siblingInherit = undefined;
    this.deepInput = undefined;
    this.keepMargin = undefined;
    this.minScore = undefined;
    /** `0` never calls the reranker: results come in vector order. */
    this.modelWeight = undefined;
    this.minResults = undefined;
    this.hardCapMultiplier = undefined;

    // Hard caps and invariants: never relevance dials.
    /** Max hits one `Inseparable` group may contribute to the candidate pool. */
    this.perGroupQuota = 3;
    /** Max hits one document may contribute to the candidate pool. */
    this.perDocQuota = 12;
    /** Suppress identical-body chunks across different documents. */
    this.dedupByContent = true;
    /** Hard ceiling on rerank calls for one request. */
    this.maxRerankCalls = 160;
    /** Cap on inline payload bytes the engine retains before falling back to lazy loading. */
    this.maxInlineTextBytes = 8 * 1024 * 1024;
    /** Fraction of rerank calls allowed to fail before the run is considered collapsed. */
    this.maxFailedBatchRatio = 0.5;
    /** Turn a collapsed rerank into an error. */
    this.failOnExcessiveDegradation = false;
    /** Concurrency ceilings for the read path. */
    this.concurrency = defaultConcurrency();

    const { concurrency, ...rest } = overrides;
    Object.assign(this, rest);
    if (concurrency) this.concurrency = { ...this.concurrency, ...concurrency };
  }

  /** Sets the dial. Stored as given: a value out of range is rejected by `validate`. */
  withRecall(recall) {
    this.recall = recall;
    return this;
  }

  /** Scopes the request to one index/tenant. */
  withNamespace(namespace) {
    this.namespace = namespace;
    return this;
  }

  /** Sets the cooperative deadline, in `Date.now()` milliseconds. */
  withDeadline(at) {
    this.deadline = at;
    return this;
  }

  /** Rejects nonsense before any backend is touched. Nothing out of range is clamped. */
  validate() {
    const bad = (what) => {
      throw RetrieveError.config(what);
    };
    if (!unit(this.recall)) bad("recall must be within 0.0..=1.0");
    if (!(this.topN >= 1)) bad("top_n must be at least 1");
    if (given(this.fanOut) && this.fanOut < this.topN) {
      bad("fan_out must be at least top_n: a shallower search cannot fill it");
    }
    if (this.maxCandidates === 0) bad("max_candidates must be at least 1");
    if (given(this.deepInput) && this.deepInput < this.topN) bad("deep_input must be at least top_n");
    for (const [name, value] of [
      ["sibling_inherit", this.siblingInherit],
      ["keep_margin", this.keepMargin],
      ["min_score", this.minScore],
      ["model_weight", this.modelWeight],
    ]) {
      if (given(value) && !unit(value)) bad(`${name} must be within 0.0..=1.0`);
    }
    if (given(this.minResults) && this.minResults > this.topN) {
      bad("min_results must not exceed top_n");
    }
    if (
      given(this.hardCapMultiplier) &&
      (!Number.isFinite(this.hardCapMultiplier) || this.hardCapMultiplier < 1.0)
    ) {
      bad("hard_cap_multiplier must be a finite number of at least 1.0");
    }
    if (!(this.perGroupQuota >= 1) || !(this.perDocQuota >= 1)) {
      bad("per_group_quota and per_doc_quota must be at least 1");
    }
    if (!(this.maxRerankCalls >= 1)) bad("max_rerank_calls must be at least 1");
    if (!unit(this.maxFailedBatchRatio)) bad("max_failed_batch_ratio must be within 0.0..=1.0");
    const concurrency = validateConcurrency(this.concurrency);
    if (concurrency) bad(concurrency);
  }

  /**
   * Validates, then expands every unset knob into a concrete value. Every derived field is
   * monotone in `recall`.
   *
   * @param {{maxTopK?: number|null}} caps the store's capabilities
   * @returns {ResolvedPlan}
   */
  resolve(caps = {}) {
    this.validate();
    const r = this.recall;
    const tn = this.topN;
    // Geometric interpolation, because recall@k rises roughly logarithmically in k.
    const geometric = (lo, hi) => Math.max(Math.round(lo * (hi / lo) ** r), 1);

    let fanOut = given(this.fanOut) ? this.fanOut : Math.max(geometric(50, 1000), tn);
    if (given(caps.maxTopK)) fanOut = Math.min(fanOut, caps.maxTopK);
    // Never fewer candidates kept than were fetched.
    const maxCandidates = Math.max(
      given(this.maxCandidates) ? this.maxCandidates : geometric(200, 4000),
      fanOut,
    );
    // Never more judged than there are candidates.
    const deepInput = Math.min(
      given(this.deepInput) ? this.deepInput : Math.max(geometric(16, 256), tn),
      maxCandidates,
    );
    return new ResolvedPlan({
      recall: r,
      topN: tn,
      fanOut,
      maxCandidates,
      expandDistinct: given(this.expandDistinct) ? this.expandDistinct : r >= 0.5,
      neighborWindow: given(this.neighborWindow) ? this.neighborWindow : Math.round(2 * r),
      siblingInherit: given(this.siblingInherit) ? this.siblingInherit : 0.4 + 0.5 * r,
      deepInput,
      // Subtractive, and the coefficient rises with r, so raising recall strictly widens the
      // kept set.
      keepMargin: given(this.keepMargin) ? this.keepMargin : 0.05 + 0.35 * r,
      minScore: given(this.minScore) ? this.minScore : 0.45 - 0.35 * r,
      // Deliberately not on the dial: it must not change how a candidate is scored.
      modelWeight: given(this.modelWeight) ? this.modelWeight : RetrievalConfig.MODEL_WEIGHT,
      minResults: given(this.minResults) ? this.minResults : Math.round(tn * r),
      hardCapMultiplier: given(this.hardCapMultiplier) ? this.hardCapMultiplier : 1.0 + 2.0 * r,
    });
  }
}

/** A fully resolved retrieval plan: what the engine will actually do. */
export class ResolvedPlan {
  constructor(fields) {
    /** The dial value this plan came from. */
    this.recall = fields.recall;
    /** Seed-result target. */
    this.topN = fields.topN;
    /** `topK` for the broad pass. */
    this.fanOut = fields.fanOut;
    /** Candidate ceiling after dedup, which bounds memory. */
    this.maxCandidates = fields.maxCandidates;
    /** Whether `Distinct` siblings are pulled in as well. */
    this.expandDistinct = fields.expandDistinct;
    /** ± ordinal window for `Distinct` sibling expansion. */
    this.neighborWindow = fields.neighborWindow;
    /** Fraction of its seed's score an expansion-arrived sibling inherits. */
    this.siblingInherit = fields.siblingInherit;
    /** Candidates the reranker judges, before the margin and siblings widen it. */
    this.deepInput = fields.deepInput;
    /** Keep a candidate if `score >= best - keepMargin`. */
    this.keepMargin = fields.keepMargin;
    /** Absolute floor on the final score. */
    this.minScore = fields.minScore;
    /** Weight of model evidence; the remainder is retrieval evidence. */
    this.modelWeight = fields.modelWeight;
    /** Results the pipeline insists on returning. */
    this.minResults = fields.minResults;
    /** Output cap, as a multiple of `topN`. */
    this.hardCapMultiplier = fields.hardCapMultiplier;
  }

  /** Absolute cap on returned chunks, siblings included. */
  hardCap() {
    return Math.round(this.topN * this.hardCapMultiplier);
  }
}
