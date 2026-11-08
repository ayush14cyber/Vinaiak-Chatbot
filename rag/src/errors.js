// How `rag`'s plugins classify and retry their failures.

import { setTimeout as sleep } from "node:timers/promises";

import { ErrorKind, PluginError } from "context-retriever";

import { OpenAIError } from "./open-client.js";

/** Retries of a transient or rate-limited plugin call, after the first. Waits 1s, 2s, 4s. */
const RETRIES = 3;

/** Runs `call` until it succeeds or fails permanently, retrying a transient or rate-limited failure. */
export async function retrying(call) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      const retry =
        attempt < RETRIES &&
        error instanceof PluginError &&
        (error.kind === ErrorKind.Transient || error.kind === ErrorKind.RateLimited);
      if (!retry) throw error;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

/**
 * Classifies an `OpenAIError` by its HTTP status. OpenRouter reports a provider failing after the
 * reply began as a 200 whose body is an error, so its `code` stands in for the status. A timeout
 * is permanent: another try would likely take as long.
 */
export function pluginError(ctx, error) {
  if (!(error instanceof OpenAIError)) return PluginError.permanent(ctx, error);
  if (error.kind === "http") {
    return error.timeout ? PluginError.permanent(ctx, error) : PluginError.transient(ctx, error);
  }
  if (error.kind !== "api" || error.status === null) return PluginError.permanent(ctx, error);
  let status = error.status;
  if (status >= 200 && status < 300) {
    const code = error.apiError?.code;
    status = typeof code === "number" && Number.isInteger(code) && code >= 0 ? code : 500;
  }
  if (status === 429) return PluginError.rateLimited(ctx, error);
  // 524/529 are OpenRouter's edge timeout and provider overload.
  if (status === 408 || status >= 500) return PluginError.transient(ctx, error);
  return PluginError.permanent(ctx, error);
}

/**
 * The status OpenRouter refused its API key with, somewhere in `error`'s chain: 401 for a key
 * that isn't valid, 402 for one out of credits.
 */
export function refusedKey(error) {
  for (let e = error; e; e = e.cause) {
    if (e instanceof OpenAIError && e.kind === "api" && (e.status === 401 || e.status === 402)) return e.status;
  }
  return null;
}
