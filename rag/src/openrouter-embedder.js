// OpenRouter-backed embedder. The model is declared as a constant here; change it in one place.

import { PluginError } from "context-retriever";

import { pluginError, retrying } from "./errors.js";
import { EmbeddingsClient } from "./open-client.js";

/** OpenRouter model id of the embedder. */
export const EMBED_MODEL = "openai/text-embedding-3-small";
/**
 * The model's native width. The S3 Vectors index must be created with it, and as it is part of
 * the fingerprint, changing it re-embeds everything.
 */
export const EMBED_DIMENSIONS = 1536;

const BASE_URL = "https://openrouter.ai/api/v1";
const REQUEST_TIMEOUT_MS = 60_000;
const CTX = "openrouter::embed";

/**
 * Embedder on OpenRouter's `/embeddings` endpoint (OpenAI text-embedding-3-small). The model
 * takes no task type, so documents and queries are embedded alike.
 */
export class OpenRouterEmbedder {
  constructor(apiKey) {
    this.client = new EmbeddingsClient(apiKey, EMBED_MODEL, { timeoutMs: REQUEST_TIMEOUT_MS }).setBaseUrl(BASE_URL);
  }

  /** Transient and rate-limited failures are retried before the error is thrown. */
  async embed(texts) {
    if (texts.length === 0) return [];
    const response = await retrying(async () => {
      try {
        return await this.client.embed([...texts]);
      } catch (e) {
        throw pluginError(CTX, e);
      }
    });
    // Sorted by index, so a repeated index would still give one text another's embedding.
    if (response.data.some((e, i) => e.index !== i)) {
      throw PluginError.permanent(CTX, `embedding indices are not 0..${texts.length}`);
    }
    return response.data.map((e) => e.embedding);
  }

  embedDocuments(texts) {
    return this.embed(texts);
  }

  embedQueries(texts) {
    return this.embed(texts);
  }

  embedBatchSize() {
    // OpenAI caps a request at 2,048 inputs and 300k tokens, and an input at 8,191 tokens. 32
    // inputs stay under 300k tokens even when every one is at the input cap.
    return 32;
  }

  embedDimensions() {
    return EMBED_DIMENSIONS;
  }

  embedderFingerprint() {
    return "openai/text-embedding-3-small/1536";
  }
}
