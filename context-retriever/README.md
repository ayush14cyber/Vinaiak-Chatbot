# context-retriever

The retrieval engine: agentic chunking, then broad vector search followed by deep reranking. It
does no I/O itself; its chunker, embedder, store and reranker are plugins (`rag` provides the real
ones, `context-retriever/testing` fakes for tests).

```js
import { Retriever, RetrievalConfig, DocumentInput } from "context-retriever";

const retriever = Retriever.builder()
  .chunker(chunker)      // { chunk(doc, budget) }
  .embedder(embedder)    // { embedDocuments, embedQueries, embedBatchSize, embedDimensions, embedderFingerprint }
  .store(store)          // { upsert, query, get, delete, listDocumentChunkIds, storeCapabilities, ... }
  .reranker(reranker)    // optional: { rerank({query, items}), rerankBatchSize, rerankBatchChars }
  .build();

await retriever.addDocument(new DocumentInput("Admissions|UG|Fees", markdown), "my-org");
const outcome = await retriever.retrieveContext("hostel fee", new RetrievalConfig(8).withNamespace("my-org"));
console.log(outcome.toPrompt());
```

- **Chunk ids** are positional, `{doc}#g{g}.p{p}`, and a group's `{doc}#g{g}`: inseparable passages
  (a fee table) share a group and always come back whole.
- **The recall dial** (`RetrievalConfig.withRecall(0..1)`) trades cost for recall: how many vector
  hits are fetched and how many go to the reranker (`RetrievalConfig.resolve`).
- **Fingerprints** of chunk state and content are FNV-1a 64-bit values, as `BigInt`s, identical to
  the Rust crate's, so indexes it wrote stay valid.
- **Degradations** (a reranker that failed, a chunker that fell back to cutting by size) are
  reported on the outcome rather than thrown.

`npm test` runs the property, engine, real-corpus and recall tests (`tests/`), offline.

Dual-licensed under MIT or Apache-2.0, as the original crate.
