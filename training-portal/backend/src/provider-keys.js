// An org's own OpenRouter, Firecrawl and MongoDB keys. Its models, imports and reranking bill to
// them, so each provider's dashboard shows the org's usage under its key. An admin gives them when
// approving the org, and can replace them later; they're never sent back.

import { UpdateItemCommand } from "@aws-sdk/client-dynamodb";

import { ORGS_TABLE } from "./app.js";
import { admin } from "./callers.js";
import { S, aws, string } from "./dynamo.js";
import { ApiError, body, noContent, statusText } from "./http.js";
import { get as getOrg } from "./orgs.js";

/** The attributes of an org's row holding its keys. */
export const OPENROUTER = "openrouter_key";
export const FIRECRAWL = "firecrawl_key";
/** A MongoDB Atlas model API key, for Voyage's reranker. */
export const MONGODB = "mongodb_key";

/** Reads the key's own limits and usage, which costs nothing. */
const OPENROUTER_CHECK = "https://openrouter.ai/api/v1/key";
/** Reads the team's credits, which costs nothing. */
const FIRECRAWL_CHECK = "https://api.firecrawl.dev/v2/team/credit-usage";
/** Reranks one letter, which counts no tokens; MongoDB has no free call that only reads the key. */
const MONGODB_CHECK = "https://ai.mongodb.com/v1/rerank";
const CHECK_TIMEOUT_MS = 15_000;

/** An org's keys, from its row. An org approved before a key was asked for lacks it. */
export class ProviderKeys {
  constructor(openrouter, firecrawl, mongodb) {
    this._openrouter = openrouter;
    this._firecrawl = firecrawl;
    this._mongodb = mongodb;
  }

  static of(item) {
    const key = (name) => string(item, name) || null;
    return new ProviderKeys(key(OPENROUTER), key(FIRECRAWL), key(MONGODB));
  }

  openrouter() {
    if (!this._openrouter) {
      throw ApiError.forbidden("your org has no OpenRouter key yet; ask the portal's admin to set one");
    }
    return this._openrouter;
  }

  firecrawl() {
    if (!this._firecrawl) {
      throw ApiError.forbidden("your org has no Firecrawl key yet; ask the portal's admin to set one");
    }
    return this._firecrawl;
  }

  /** Only the reranker needs it, and saving a page never reranks. */
  mongodb() {
    return this._mongodb;
  }

  hasOpenrouter() {
    return this._openrouter !== null;
  }

  hasFirecrawl() {
    return this._firecrawl !== null;
  }

  hasMongodb() {
    return this._mongodb !== null;
  }
}

/** `key` trimmed, unless it's missing or blank. */
export function given(key) {
  if (typeof key !== "string") return null;
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Asks each provider whether it takes the key given for it, all at once. */
export async function check(app, openrouter, firecrawl, mongodb) {
  await Promise.all([
    openrouter ? checkOpenrouter(app, openrouter) : null,
    firecrawl ? ask(app, "Firecrawl", FIRECRAWL_CHECK, {}, firecrawl) : null,
    mongodb
      ? ask(app, "MongoDB", MONGODB_CHECK, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "rerank-3-lite", query: "a", documents: ["a"] }),
        }, mongodb)
      : null,
  ]);
}

/** A management key passes OpenRouter's check but can't call models. */
async function checkOpenrouter(app, key) {
  const res = await ask(app, "OpenRouter", OPENROUTER_CHECK, {}, key);
  const json = await res.json().catch(() => ({}));
  if (json?.data?.is_management_key === true || json?.data?.is_provisioning_key === true) {
    throw ApiError.badRequest("that's an OpenRouter management key, which can't call models; give an API key");
  }
}

/** Sends a request with `key`; a refusal means the key is wrong. */
async function ask(app, provider, url, init, key) {
  let res;
  try {
    res = await app.http(url, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${key}` },
      timeoutMs: CHECK_TIMEOUT_MS,
    });
  } catch (e) {
    throw ApiError.upstream(`couldn't check the ${provider} key: ${e.message}`);
  }
  if (res.ok) return res;
  if (res.status === 401 || res.status === 403) throw ApiError.badRequest(`${provider} doesn't accept that key`);
  throw ApiError.upstream(`${provider} answered ${statusText(res.status)} when checking the key`);
}

/**
 * `PUT /admin/orgs/keys`: replaces an approved org's keys, those given, once their providers take
 * them. A key left out stays, but the org must end up with all three.
 */
export async function set(app, req) {
  await admin(app, req);
  const k = body(req, { org_id: "string", openrouter_key: "string?", firecrawl_key: "string?", mongodb_key: "string?" });
  const [openrouter, firecrawl, mongodb] = [given(k.openrouter_key), given(k.firecrawl_key), given(k.mongodb_key)];
  if (!openrouter && !firecrawl && !mongodb) throw ApiError.badRequest("give a key to set");
  const item = await getOrg(app, ORGS_TABLE, k.org_id);
  if (!item) throw ApiError.notFound("no approved org has this id");
  const current = ProviderKeys.of(item);
  if (!openrouter && !current.hasOpenrouter()) throw ApiError.badRequest("this org has no OpenRouter key yet; give one");
  if (!firecrawl && !current.hasFirecrawl()) throw ApiError.badRequest("this org has no Firecrawl key yet; give one");
  if (!mongodb && !current.hasMongodb()) throw ApiError.badRequest("this org has no MongoDB key yet; give one");
  await check(app, openrouter, firecrawl, mongodb);

  const sets = [];
  const values = {};
  for (const [name, key] of [[OPENROUTER, openrouter], [FIRECRAWL, firecrawl], [MONGODB, mongodb]]) {
    if (!key) continue;
    sets.push(`${name} = :${name}`);
    values[`:${name}`] = S(key);
  }
  await aws(() =>
    app.dynamo.send(
      new UpdateItemCommand({
        TableName: ORGS_TABLE,
        Key: { org_id: S(k.org_id) },
        ConditionExpression: "attribute_exists(org_id)",
        UpdateExpression: `SET ${sets.join(", ")}`,
        ExpressionAttributeValues: values,
      }),
    ),
  );
  return noContent();
}
