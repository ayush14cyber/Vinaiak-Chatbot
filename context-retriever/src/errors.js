// Errors: the one type every plugin returns, and what the two entry points return.

/**
 * What kind of failure a plugin hit, for its own retry policy and for logs.
 *
 * The engine decides by stage, never by kind: a failed rerank call degrades the run, a failed
 * store query fails it.
 */
export const ErrorKind = Object.freeze({
  /** May pass on a retry: a timeout, a 5xx. */
  Transient: "Transient",
  /** Quota exhausted, 429 or 503. May pass after a wait. */
  RateLimited: "RateLimited",
  /**
   * Bad request, auth failure, dimension mismatch, a filter the store cannot honour. Retrying
   * will not help.
   */
  Permanent: "Permanent",
});

/** `error`'s message, then each of its causes', joined by `: `. */
export function chain(error) {
  let message = String(error?.message ?? error);
  let cause = error?.cause;
  while (cause) {
    message += `: ${cause?.message ?? cause}`;
    cause = cause?.cause;
  }
  return message;
}

function asError(source) {
  return source instanceof Error ? source : new Error(String(source));
}

/**
 * The single error type every plugin returns.
 *
 * Note what it deliberately cannot express: which backend is to blame. The engine wraps it into
 * the blame-assigning code of an `IndexError` or a `RetrieveError`.
 */
export class PluginError extends Error {
  /**
   * @param {string} kind one of `ErrorKind`
   * @param {string} context short operation label for logs, e.g. `"s3vectors::query_vectors"`
   * @param {unknown} source the underlying cause, kept as `cause`
   */
  constructor(kind, context, source) {
    const cause = asError(source);
    super(`${kind} failure during ${context}: ${cause.message}`, { cause });
    this.name = "PluginError";
    this.kind = kind;
    this.context = context;
  }

  /** May pass on a retry. */
  static transient(context, source) {
    return new PluginError(ErrorKind.Transient, context, source);
  }

  /** Quota, 429 or 503. */
  static rateLimited(context, source) {
    return new PluginError(ErrorKind.RateLimited, context, source);
  }

  /** Retrying will not help. */
  static permanent(context, source) {
    return new PluginError(ErrorKind.Permanent, context, source);
  }

  /**
   * An error that isn't a `PluginError` is treated as permanent, so a retry policy built on the
   * kind never retries what nobody judged worth retrying.
   */
  static from(error) {
    if (error instanceof PluginError) return error;
    return new PluginError(ErrorKind.Permanent, "unclassified", error);
  }

  /** A copy for a second report: the kind, the context and the message. */
  flattened() {
    return new PluginError(this.kind, this.context, chain(this.cause));
  }
}

/** Why indexing a document failed. `code` names the case. */
export class IndexError extends Error {
  constructor(code, message, { cause, ...details } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "IndexError";
    this.code = code;
    Object.assign(this, details);
  }

  /** The input violates a documented precondition. */
  static input(why) {
    return new IndexError("Input", `invalid input: ${why}`, { why });
  }

  /** Indexing needs a chunker, and the retriever was built without one. */
  static noChunker() {
    return new IndexError(
      "NoChunker",
      "no chunker configured; build the retriever with `.chunker(..)` to index",
    );
  }

  /** The retriever was built without the required plugins. */
  static build(what) {
    return new IndexError("Build", `retriever is missing a required plugin: ${what}`, { what });
  }

  /** A configuration value, or a size a plugin declared, is invalid. */
  static config(why) {
    return new IndexError("Config", `invalid configuration: ${why}`, { why });
  }

  /** Refused rather than truncated: truncating destroys recall invisibly. */
  static documentTooLarge(actual, limit) {
    return new IndexError(
      "DocumentTooLarge",
      `document is ${actual} chars, over max_document_chars (${limit})`,
      { actual, limit },
    );
  }

  /** The chunker broke its contract. */
  static invalidPlan(why) {
    return new IndexError("InvalidPlan", `chunker returned an invalid plan: ${why}`, { why });
  }

  /** Refused rather than truncated; `what` names the limit that was hit and `knob` its setting. */
  static planTooLarge(what, knob, actual, limit) {
    return new IndexError(
      "PlanTooLarge",
      `chunker plan is too large: ${actual} ${what}, over the limit of ${limit} (${knob}); ` +
        "refusing rather than truncating, which would lose text silently",
      { what, knob, actual, limit },
    );
  }

  /** The embedder returned the wrong number of vectors. Never zipped. */
  static embedCountMismatch(want, got) {
    return new IndexError("EmbedCountMismatch", `embedder returned ${got} vectors for ${want} inputs`, {
      want,
      got,
    });
  }

  /** The embedder returned a vector of unexpected width. */
  static dimensionMismatch(want, got) {
    return new IndexError("DimensionMismatch", `embedder returned dimension ${got}, expected ${want}`, {
      want,
      got,
    });
  }

  /** The chunker failed and no fallback was allowed. */
  static chunker(cause) {
    return new IndexError("Chunker", "chunker failed", { cause });
  }

  /** The embedder failed. Nothing was written. */
  static embedder(cause) {
    return new IndexError("Embedder", "embedder failed", { cause });
  }

  /** The store failed. Nothing was deleted. */
  static store(cause) {
    return new IndexError("Store", "vector store failed", { cause });
  }
}

/** Why retrieval failed. `code` names the case. */
export class RetrieveError extends Error {
  constructor(code, message, { cause, ...details } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "RetrieveError";
    this.code = code;
    Object.assign(this, details);
  }

  /** The query was empty or whitespace. */
  static emptyQuery() {
    return new RetrieveError("EmptyQuery", "query is empty");
  }

  /** The config is not usable. */
  static config(why) {
    return new RetrieveError("Config", `invalid config: ${why}`, { why });
  }

  /** The query could not be embedded, so there is nothing to search with. */
  static queryEmbedding(cause) {
    return new RetrieveError("QueryEmbedding", "failed to embed the query", { cause });
  }

  /**
   * The store failed. Returning an empty result here would read as "nothing relevant exists",
   * which is the worst possible lie for a retrieval system.
   */
  static store(cause) {
    return new RetrieveError("Store", "vector store failed", { cause });
  }

  /** A plugin broke a documented invariant. */
  static contract(why) {
    return new RetrieveError("Contract", `contract violation: ${why}`, { why });
  }

  /** Too many rerank calls failed and `failOnExcessiveDegradation` was set. */
  static rerankCollapsed(failed, total, last) {
    return new RetrieveError(
      "RerankCollapsed",
      `${failed} of ${total} rerank calls failed, over max_failed_batch_ratio`,
      { failed, total, cause: last },
    );
  }

  /** The cooperative deadline expired and `strictDeadline` was set. */
  static deadline() {
    return new RetrieveError("Deadline", "deadline exceeded with strict_deadline set");
  }
}
