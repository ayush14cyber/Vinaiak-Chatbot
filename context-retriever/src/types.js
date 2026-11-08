// The data the engine and the plugins exchange.
//
// Two shapes matter most here:
// - A chunk group draft on the way in, which is how a chunker expresses "these parts are only
//   honest together", in line numbers, so the engine cuts the text itself and nothing can be
//   paraphrased or lost.
// - A scored ref on the way out of a store, which carries no text by default: that is what keeps
//   a large corpus affordable.
//
// Shapes, as plain objects:
//
//   ChunkMeta     { doc, group, groupOrd, partOrd, groupLen, cohesion, stateFp: bigint,
//                   contentFp: bigint, chars, metadata: Record<string,string> }
//   ChunkPayload  { text, context, topic: string|null, placement }
//   StoredChunk   { id, meta: ChunkMeta, payload: ChunkPayload }
//   ScoredRef     { id, meta: ChunkMeta, similarity (higher is better), payload?: ChunkPayload }
//   VectorRecord  { chunk: StoredChunk, embedding: number[] | Float32Array }
//   VectorQuery   { vector, topK, namespace, filter }
//   RerankItem    { id, context, topic, text }
//   RerankRequest { query, items: RerankItem[] }

import { linesInclusive } from "./text.js";

/** How tightly the parts of a group belong together. The values are stable fingerprint tags. */
export const Cohesion = Object.freeze({
  /** Topic-distinct: this part stands alone once its context is prepended. */
  Distinct: "distinct",
  /**
   * Size-split, not topic-distinct: reading one part without its siblings would be misleading.
   * Expansion is unconditional, and selection never emits a partial group.
   */
  Inseparable: "inseparable",
});

/** Input to `Retriever.addDocument`. */
export class DocumentInput {
  /**
   * @param {string} id stable identity, such as an S3 object key
   * @param {string} text full document text
   */
  constructor(id, text) {
    this.id = id;
    this.text = text;
    /** Hierarchical path, e.g. `["BIT Mesra", "PHD", "admission"]`, rendered into every context. */
    this.breadcrumb = [];
    /** Opaque passthrough, copied verbatim into every chunk's metadata. */
    this.metadata = {};
  }

  /** Sets the hierarchical path. */
  withBreadcrumb(breadcrumb) {
    this.breadcrumb = [...breadcrumb].map(String);
    return this;
  }

  /** Adds one metadata entry, passed through to every chunk. */
  withMeta(key, value) {
    this.metadata[key] = String(value);
    return this;
  }

  /**
   * The lines a chunk plan's line numbers refer to. Line 1 is the first. Each line keeps its
   * `'\n'`, so they concatenate back to `text` exactly. Number a chunker's prompt from this.
   */
  lines() {
    return linesInclusive(this.text);
  }
}

/**
 * A chunker's full plan for one document, in line numbers. Every number is a 1-based line of
 * `DocumentInput.lines()`.
 *
 * Every part, and every omitted run, lasts until the next start of any of them, in any group, or
 * the end of the document. So every line lands in exactly one part or one omitted run whatever
 * numbers the chunker returns.
 */
export class ChunkPlan {
  constructor(groups = [], omittedStarts = []) {
    /** @type {{context: string, topic: string|null, cohesion: string, partStarts: number[]}[]} */
    this.groups = groups;
    /** Where each run of lines that belongs in no part begins: page chrome. */
    this.omittedStarts = omittedStarts;
  }

  /**
   * The escape hatch for "this document cannot be split by topic without creating misleading
   * fragments": one group covering every line, `Inseparable`, one shared context.
   */
  static indivisible(context) {
    return new ChunkPlan([{ context, topic: null, cohesion: Cohesion.Inseparable, partStarts: [1] }]);
  }
}

/** Sizing guidance handed to the chunker, and the limits the engine enforces. */
export function defaultBudget() {
  return {
    /** Size to aim for, in chars, and the size the engine packs small parts up to. */
    targetChars: 1800,
    /** Hard cap. The engine size-splits anything larger. */
    maxChars: 4000,
    /** The floor on part size. */
    minChars: 120,
    /** Overlap used by the size-driven splitter. */
    overlapChars: 150,
    /** Runaway-chunker guard: groups per document. */
    maxGroups: 256,
    /** The largest an `Inseparable` group may be, at index time and at query time. */
    maxPartsPerGroup: 128,
  };
}
