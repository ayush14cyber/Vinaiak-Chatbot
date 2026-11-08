# rag

The models and storage behind `context-retriever`, and the chatbot's prompt and tools.

| Module | What it is |
| --- | --- |
| `src/chunker.js` | The agentic chunker: DeepSeek V4.1 Flash (OpenRouter) answers with line numbers only. |
| `src/openrouter-embedder.js` | `openai/text-embedding-3-small`, 1536 dimensions, through OpenRouter. |
| `src/voyage-reranker.js` | Voyage `rerank-3-lite` through MongoDB Atlas (`ai.mongodb.com`). |
| `src/media-descriptor.js` | Claude Haiku 5.5 transcribes the images and PDFs a page links to, inside the link. |
| `src/chunk-db.js` | The store: S3 Vectors for vectors and chunk metadata, DynamoDB (`org_documents`) as the side index of each document's chunk ids. |
| `src/retriever.js` | `build()` wires the above into a `Retriever`; `addDocument`, `readDocument`, `rebuild`, `createOrgIndex`. |
| `src/ai.js` | The chatbot: its system prompt, its tools (`retrieve`, `offer_options`, `data_not_found`), and `executeFunctionCalls`. |
| `src/open-client.js` | An OpenAI-compatible client: chat sessions that summarize themselves past a token limit, streaming, and embeddings. |
| `src/log.js` | One JSON line per event, as CloudWatch keeps them. |

Every model call bills to the org's own keys. `npm test` runs offline, with the HTTP APIs and AWS
faked.
