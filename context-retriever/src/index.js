// Broad Retrieval → Deep Re-ranking: a provider-agnostic retrieval engine for RAG, tuned for
// recall first.
//
// This package contains the algorithm and nothing else: no HTTP client, no AWS, no model SDK. You
// implement four plugins over whatever you already use, and the engine orchestrates them.
//
// - `Retriever.addDocument` does agentic chunking: your chunker splits a document by topic and
//   returns, for each topic, a short context passage plus the line numbers where its parts begin.
//   The engine cuts the parts from the document itself, weaves breadcrumb and context into every
//   part exactly once, embeds what actually changed, writes, and only then deletes the slots the
//   document no longer uses.
// - `Retriever.retrieveContext` searches wide, completes shared-context groups so their parts
//   arrive together, narrows to a judgeable set, has your reranker score it in bounded concurrent
//   batches, and returns the selection in deterministic, group-contiguous order.
//
// One dial, `RetrievalConfig.recall` (0.0 to 1.0, default 0.8), trades precision against recall.
// Priority order throughout: recall, then precision, then speed.

export { IndexConfig, RetrievalConfig, ResolvedPlan, defaultConcurrency, defaultIndexOptions } from "./config.js";
export { ErrorKind, IndexError, PluginError, RetrieveError, chain } from "./errors.js";
export * as ids from "./ids.js";
export {
  IndexStatus,
  Provenance,
  RetrievalOutcome,
  GroupView,
  Selection,
  describeDegradation,
} from "./report.js";
export { Retriever, RetrieverBuilder } from "./retriever.js";
export * as text from "./text.js";
export { ContextPlacement } from "./text.js";
export { ChunkPlan, Cohesion, DocumentInput, defaultBudget } from "./types.js";
