// What the two entry points return: the chunks, what the run cost, and everything that went wrong
// without stopping it.

import { PluginError } from "./errors.js";

/**
 * Why a chunk is in the result set, and its primary sort class, in this order. `Degraded`
 * outranks `Backfill` on purpose: under recall-first, a candidate we failed to judge is a better
 * bet than one we judged and rejected.
 */
export const Selection = Object.freeze({
  /** Scored by the model and above the threshold. */
  Ranked: "ranked",
  /** Never scored by the model, and kept. */
  Degraded: "degraded",
  /** Scored below the threshold, included only to reach `minResults`. */
  Backfill: "backfill",
  /** Below the threshold, re-admitted to keep an `Inseparable` group whole. */
  GroupIntegrity: "group_integrity",
});

const SELECTION_ORDER = {
  [Selection.Ranked]: 0,
  [Selection.Degraded]: 1,
  [Selection.Backfill]: 2,
  [Selection.GroupIntegrity]: 3,
};

/** Compares two selections in their sort order. */
export function cmpSelection(a, b) {
  return SELECTION_ORDER[a] - SELECTION_ORDER[b];
}

/** How a chunk entered the candidate pool. */
export const Provenance = Object.freeze({
  /** A direct nearest-neighbour hit, with its 1-based rank in the broad pass. */
  vector: (rank) => ({ kind: "vector", rank }),
  /** Pulled in because a sibling in its group was a hit. */
  sibling: (seed) => ({ kind: "sibling", seed }),
  /** Pulled in as an ordinal neighbour of a `Distinct` hit. */
  neighbor: (seed) => ({ kind: "neighbor", seed }),
});

/**
 * A non-fatal problem, as `{kind, ...fields}`. The kinds:
 *
 * - `ChunkerFallbackUsed {error}`: the chunker failed and the engine size-split the document.
 * - `PlanStartsIgnored {outOfRange, conflicting}`: line numbers the engine couldn't use.
 * - `StaleCleanupFailed {count, error}`: stale chunks couldn't be deleted; re-running converges.
 * - `ReuseLookupFailed {error}`: every chunk was embedded again.
 * - `EmbedFailed {count, error}`: chunks left out because their embed batch failed.
 * - `StaleListingFailed {error}`: stale chunks from an earlier version may remain.
 * - `ForeignChunkListed {count, sample}`: the listing named another document's chunks.
 * - `StoreOrderDisagrees {inversions, pairs}`: the store likely returned distances.
 * - `UnrequestedChunk {count, sample}`: a store returned a chunk that was never asked for.
 * - `GroupExpansionFailed {group, error}`: a group's other parts couldn't be fetched.
 * - `GroupTruncated {group, had, kept}`: a `Distinct` group's neighbour list was trimmed.
 * - `GroupIncomplete {group, want, have}`: an `Inseparable` group was left out of the answer.
 * - `ChunkTextMissing {count, error}`: selected chunks whose text couldn't be loaded.
 * - `RerankTextMissing {count, error}`: candidates left out of a rerank call for want of text.
 * - `RerankBatchFailed {items, error}`: one rerank call failed.
 * - `RerankContractViolated {items, got}`: a reranker returned the wrong number of scores.
 * - `RerankScoresUnusable {nonFinite, outOfRange}`: scores the engine couldn't use.
 * - `RerankCollapsed {failed, total}`: the run degraded to plain vector search.
 * - `RerankCharBudgetExceeded {calls, budget, largest}`.
 * - `DeepInputReduced {from, to}`: the rerank-call ceiling cut the candidates judged.
 * - `DeadlineHit`: selection ran on whatever had been scored.
 * - `FloorBypassed {returned}`: nothing cleared the floor, so the best were returned anyway.
 */
export const degradation = (kind, fields = {}) => ({ kind, ...fields });

const snake = (name) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function debugValue(value) {
  if (value === null || value === undefined) return "None";
  if (value instanceof PluginError) {
    const source = String(value.cause?.message ?? value.cause);
    return `PluginError { kind: ${value.kind}, context: ${JSON.stringify(value.context)}, source: ${JSON.stringify(source)} }`;
  }
  if (value instanceof Error) return JSON.stringify(value.message);
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

/**
 * A degradation formatted as one line for a log:
 * `RerankCollapsed { failed: 1, total: 1 }`, `DeadlineHit`.
 */
export function describeDegradation(d) {
  const { kind, ...fields } = d;
  const entries = Object.entries(fields);
  if (entries.length === 0) return kind;
  if (entries.length === 1 && entries[0][0] === "error") {
    return `${kind}(${debugValue(entries[0][1])})`;
  }
  const body = entries
    .map(([key, value]) => {
      const shown = key === "error" && value ? `Some(${debugValue(value)})` : debugValue(value);
      return `${snake(key)}: ${shown}`;
    })
    .join(", ");
  return `${kind} { ${body} }`;
}

/** One group's chunks, in reading order: what "retrieved together" means. */
export class GroupView {
  constructor(group, context, topic, cohesion, parts, bestScore) {
    this.group = group;
    this.context = context;
    this.topic = topic;
    this.cohesion = cohesion;
    /** Its returned parts, in `partOrd` order. */
    this.parts = parts;
    /** The best score among its parts. */
    this.bestScore = bestScore;
  }

  /** Context once, then the parts in reading order. */
  render() {
    let out = "";
    if (this.topic !== null && this.topic !== undefined) out += `[${this.topic}]\n`;
    out += this.context;
    for (const part of this.parts) out += `\n\n${part.chunk.payload.text}`;
    return out;
  }
}

/** What one `retrieveContext` call did. */
export class RetrievalOutcome {
  constructor(chunks, report, degradations) {
    /**
     * The selected chunks, group-contiguous and deterministically ordered. Each is
     * `{chunk, score, vectorSimilarity, retrievalScore, modelScore, provenance, selection,
     * duplicates}`.
     */
    this.chunks = chunks;
    /** What the run did and what it cost. */
    this.report = report;
    /** Everything that went wrong without stopping the run. */
    this.degradations = degradations;
  }

  /** The chunks by group, parts in reading order, groups in result order. */
  grouped() {
    const views = [];
    for (const chunk of this.chunks) {
      const meta = chunk.chunk.meta;
      const view = views.find((v) => v.group === meta.group);
      if (view) {
        view.bestScore = Math.max(view.bestScore, chunk.score);
        view.parts.push(chunk);
      } else {
        views.push(
          new GroupView(
            meta.group,
            chunk.chunk.payload.context,
            chunk.chunk.payload.topic ?? null,
            meta.cohesion,
            [chunk],
            chunk.score,
          ),
        );
      }
    }
    for (const view of views) view.parts.sort((a, b) => a.chunk.meta.partOrd - b.chunk.meta.partOrd);
    return views;
  }

  /** Prompt-ready text: each group's context once, then its parts, groups separated by `---`. */
  toPrompt() {
    return this.grouped()
      .map((view) => view.render())
      .join("\n\n---\n\n");
  }

  /** Whether anything went wrong on the way to this result. */
  isDegraded() {
    return this.degradations.length > 0;
  }
}

/** What happened to a document on the write path. */
export const IndexStatus = Object.freeze({
  /** The index was updated. */
  Indexed: "indexed",
  /** The index is confirmed to match the document already. */
  Unchanged: "unchanged",
  /** Every chunk of the document was deleted. */
  Deleted: "deleted",
});
