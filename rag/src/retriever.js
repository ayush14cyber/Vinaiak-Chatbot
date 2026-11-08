// The retriever this package assembles: the OpenRouter chunker and embedder and the Voyage
// reranker over S3 Vectors with its DynamoDB side index.

import { DocumentInput, IndexConfig, RetrievalConfig, Retriever, text as engineText } from "context-retriever";

import { AgenticChunker } from "./chunker.js";
import { ChunkDb, createIndex, listDocIds, removeChunklessRow } from "./chunk-db.js";
import { PIECE_CHARS, pieces } from "./media-descriptor.js";
import { EMBED_DIMENSIONS, OpenRouterEmbedder } from "./openrouter-embedder.js";
import { VoyageReranker } from "./voyage-reranker.js";

/**
 * Hits the reranker judges, the best by vector score; the score margin and `Inseparable`
 * siblings widen it to at most twice this. On bit-mesra's 60 labelled questions (2026-11-03), 64
 * and 32 found the same pages as the default dial's 147, and 16 lost pages on 3.
 */
const DEEP_INPUT = 64;
/** Hits of the broad search: as many as the reranker can judge. */
const FAN_OUT = 2 * DEEP_INPUT;

/** How `build`'s retriever cuts documents. `readDocument` undoes it. */
function indexConfig() {
  // An inseparable group comes back whole, so this caps the largest passage a query returns: 16
  // parts of at most 5,000 chars. A page with a bigger one is refused with `PlanTooLarge`.
  return new IndexConfig({ budget: { maxPartsPerGroup: 16 } });
}

/**
 * A `Retriever` over every backend of this package, with one OpenRouter key for the chunker and
 * the embedder, and a MongoDB Atlas model API key for the reranker. Without that key it has no
 * reranker: a query then keeps the vector search's order. `table` is the DynamoDB side index and
 * `bucket` the S3 Vectors bucket. Every call must name the org as its namespace.
 */
export function build(openrouterApiKey, mongodbApiKey, dynamo, s3v, table, bucket) {
  let builder = Retriever.builder()
    .chunker(new AgenticChunker(openrouterApiKey))
    .embedder(new OpenRouterEmbedder(openrouterApiKey))
    .store(new ChunkDb(dynamo, s3v, table, bucket));
  if (mongodbApiKey) builder = builder.reranker(new VoyageReranker(mongodbApiKey));
  return builder.indexConfig(indexConfig()).build();
}

/** The config of one query for `org` on `build`'s retriever. */
export function retrievalConfig(org, topN) {
  return new RetrievalConfig(topN, {
    fanOut: Math.max(FAN_OUT, topN),
    deepInput: Math.max(DEEP_INPUT, topN),
    modelWeight: 0.8,
  }).withNamespace(org);
}

/** The engine metadata entry holding `addDocument`'s `metadata`, as JSON. */
const METADATA_KEY = "metadata";
/** Joins a breadcrumb into a doc id, e.g. `UG|B.TECH|CSE|Admission`. */
const DOC_ID_SEPARATOR = "|";

/** Why `addDocument` or `addDescribedDocument` failed. `code` is `Breadcrumb` or `Index`. */
export class AddDocumentError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "AddDocumentError";
    this.code = code;
  }
}

/** `breadcrumb`, if it can be a doc id. */
function checked(breadcrumb) {
  if (breadcrumb.length === 0) throw new AddDocumentError("Breadcrumb", "invalid breadcrumb: it is empty");
  if (breadcrumb.some((segment) => segment.length === 0 || segment.includes(DOC_ID_SEPARATOR))) {
    throw new AddDocumentError(
      "Breadcrumb",
      "invalid breadcrumb: a segment is empty or contains `|`, the doc id separator",
    );
  }
  return breadcrumb;
}

/**
 * Indexes `markdown` as the document at `breadcrumb` in `org`, with `metadata` (e.g.
 * `{source: "https://..."}`) on every chunk; `metadata()` reads it back from a retrieved chunk.
 *
 * The images and PDFs it links to are described first, so the chunker reads their content.
 * `previous` is the document as `readDocument` returns it, or empty for a new one. The described
 * document comes in pieces, each indexed with the same breadcrumb and metadata: almost always
 * one, as the doc id; the rest as `{id}~1`, `{id}~2`, ... Pieces an earlier version had beyond
 * these are removed. Index one breadcrumb at a time. Returns each piece's `[id, outcome]`.
 */
export async function addDocument(retriever, descriptor, http, org, breadcrumb, markdown, previous, forceOverride, metadata) {
  const crumbs = checked(breadcrumb);
  // Before describing, which costs a model call per file.
  const meta = JSON.stringify(metadata);
  const described = await descriptor.describeMedia(http, markdown, previous, forceOverride);
  return indexPieces(retriever, org, crumbs, described, meta);
}

/**
 * `addDocument` for markdown whose media is already described, like the text `readDocument`
 * returns: indexed as is, without a model call per file. Used to move a document.
 */
export async function addDescribedDocument(retriever, org, breadcrumb, markdown, metadata) {
  const crumbs = checked(breadcrumb);
  return indexPieces(retriever, org, crumbs, pieces(markdown, PIECE_CHARS), JSON.stringify(metadata));
}

/** Indexes `parts` as the doc id of `breadcrumb`, then `{id}~1`, ..., and removes those after. */
async function indexPieces(retriever, org, breadcrumb, parts, metadata) {
  const id = breadcrumb.join(DOC_ID_SEPARATOR);
  const outcomes = [];
  try {
    for (let n = 0; n < parts.length; n++) {
      const doc = new DocumentInput(pieceId(id, n), parts[n])
        .withBreadcrumb(breadcrumb)
        .withMeta(METADATA_KEY, metadata);
      outcomes.push([doc.id, await retriever.addDocument(doc, org)]);
    }
    // An earlier version's pieces are numbered without gaps, so the first one with no chunks is
    // past its last.
    for (let n = outcomes.length; ; n++) {
      const removed = await retriever.removeDocument(pieceId(id, n), org);
      if (removed.staleDeleted === 0) break;
    }
  } catch (e) {
    throw new AddDocumentError("Index", "indexing a piece of the document failed", e);
  }
  return outcomes;
}

/** Document id of piece `n` of document `id`. */
function pieceId(id, n) {
  return n === 0 ? id : `${id}~${n}`;
}

/** The metadata `addDocument` stored with `chunk`'s document, or `null` if it was indexed without. */
export function metadata(chunk) {
  const json = chunk.chunk.meta.metadata[METADATA_KEY];
  return json === undefined ? null : JSON.parse(json);
}

/**
 * The document `docId` of `org`, rebuilt from its chunks, or `null` if it has none: `{markdown,
 * metadata}`, its text as indexed, with its media described and blank lines between passages
 * normalized to one. `addDescribedDocument` indexes the text again as is.
 */
export async function readDocument(dynamo, s3v, table, bucket, org, docId) {
  return readFrom(new ChunkDb(dynamo, s3v, table, bucket), org, docId);
}

export async function readFrom(store, org, docId) {
  const chunkIds = await store.listDocumentChunkIds(docId, org);
  const size = store.getBatchSize();
  const calls = [];
  for (let i = 0; i < chunkIds.length; i += size) calls.push(store.get(chunkIds.slice(i, i + size), org));
  const chunks = (await Promise.all(calls)).flat();
  if (chunks.length === 0) return null;
  const json = chunks[0].meta.metadata[METADATA_KEY];
  const meta = json === undefined ? null : JSON.parse(json);
  chunks.sort((a, b) => a.meta.groupOrd - b.meta.groupOrd || a.meta.partOrd - b.meta.partOrd);
  const budget = indexConfig().budget;
  return {
    markdown: rebuild(chunks, Math.min(budget.overlapChars, Math.floor(budget.maxChars / 2))),
    metadata: meta,
  };
}

/**
 * Joins a document's `chunks`, in reading order, back into its text. Groups, and the parts the
 * engine packed into one group, are joined by a blank line. A part split off an oversized one
 * starts with the last `overlap` chars of the part before (fewer if that part is shorter), which
 * are dropped.
 */
export function rebuild(chunks, overlap) {
  let out = "";
  let prev = null;
  for (const chunk of chunks) {
    const part = chunk.payload.text;
    if (prev === null) {
      out += part;
    } else {
      let repeated = null;
      if (prev.meta.groupOrd === chunk.meta.groupOrd) {
        const n = Math.min(overlap, Math.max(engineText.charCount(prev.payload.text) - 1, 0));
        if (n > 0) {
          const chars = Array.from(part);
          if (chars.length > n) {
            const head = chars.slice(0, n).join("");
            if (prev.payload.text.endsWith(head)) repeated = head.length;
          }
        }
      }
      out += repeated === null ? `\n\n${part}` : part.slice(repeated);
    }
    prev = chunk;
  }
  return out;
}

/**
 * Ids of `org`'s documents starting with `prefix`, in order: every document when `prefix` is
 * empty, the documents under a directory when it ends with `|`, and the pieces after the first
 * of a document when it ends with `~`.
 */
export function listDocumentIds(dynamo, table, org, prefix) {
  return listDocIds(dynamo, table, org, prefix);
}

/**
 * Removes `docId` from `table` if it is listed there without any chunk, as a removal that
 * failed between its two writes leaves it. Returns whether there was one.
 */
export function removeChunklessDocument(dynamo, table, org, docId) {
  return removeChunklessRow(dynamo, table, org, docId);
}

/** Creates `org`'s S3 Vectors index in `bucket`. Every org needs one before its first document. */
export function createOrgIndex(s3v, bucket, org) {
  return createIndex(s3v, bucket, org, EMBED_DIMENSIONS);
}
