// Voyage-backed reranker, called through MongoDB Atlas with a model API key made there. The model
// is declared as a constant here; change it in one place.

import { PluginError } from "context-retriever";

import { retrying } from "./errors.js";

/** Voyage model id of the reranker. */
export const RERANK_MODEL = "rerank-3-lite";

/** Voyage's endpoint for a key made in MongoDB Atlas. A key made on voyageai.com is refused here. */
const RERANK_URL = "https://ai.mongodb.com/v1/rerank";
const REQUEST_TIMEOUT_MS = 60_000;
const CTX = "voyage::rerank";

function document(context, topic, text) {
  return topic !== null && topic !== undefined ? `${context}\nTopic: ${topic}\n\n${text}` : `${context}\n\n${text}`;
}

/** A request that failed without a status. A timeout is permanent. */
function requestError(e) {
  const timeout = e?.name === "TimeoutError" || e?.name === "AbortError";
  const message = e?.cause?.message ?? e?.message ?? String(e);
  return timeout ? PluginError.permanent(CTX, message) : PluginError.transient(CTX, message);
}

/**
 * Reranker on Voyage's `/rerank` endpoint. A cross-encoder: each (query, item) pair is scored on
 * its own, so scores are comparable across calls, as the engine's reranker contract requires.
 */
export class VoyageReranker {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  /** One request to `/rerank`, its failure classified for the retry in `rerank`. */
  async send(body) {
    let response;
    let text;
    try {
      response = await fetch(RERANK_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      text = await response.text();
    } catch (e) {
      throw requestError(e);
    }
    if (!response.ok) {
      const msg = `${response.status}: ${text}`;
      if (response.status === 429) throw PluginError.rateLimited(CTX, msg);
      if (response.status === 408 || response.status >= 500) throw PluginError.transient(CTX, msg);
      throw PluginError.permanent(CTX, msg);
    }
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed?.data)) throw new Error("missing field `data`");
      return parsed;
    } catch (e) {
      throw PluginError.permanent("voyage::rerank_parse", `${e.message}: ${text}`);
    }
  }

  /** Transient and rate-limited failures are retried; a permanent one is thrown at once. */
  async rerank(request) {
    const body = {
      model: RERANK_MODEL,
      query: request.query,
      documents: request.items.map((item) => document(item.context, item.topic, item.text)),
    };
    const parsed = await retrying(() => this.send(body));
    // NaN marks an item the response skipped: the engine imputes that one score.
    const scores = new Array(request.items.length).fill(Number.NaN);
    for (const hit of parsed.data) {
      if (Number.isInteger(hit.index) && hit.index >= 0 && hit.index < scores.length) {
        scores[hit.index] = hit.relevance_score;
      }
    }
    return scores;
  }

  rerankBatchSize() {
    // Voyage's per-request cap.
    return 1000;
  }

  rerankBatchChars() {
    // Voyage caps a request at 1,000 documents and 600k tokens. The engine counts only each
    // item's text against this budget, while every document also carries its context and topic.
    return 300_000;
  }
}
