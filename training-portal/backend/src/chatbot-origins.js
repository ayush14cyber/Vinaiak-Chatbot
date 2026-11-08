// The sites an org's chatbot may be embedded on, as origins (`scheme://host[:port]`, what a browser
// sends as `Origin`). An admin gives them when approving the org, or later.

import { GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

import { ORGS_TABLE } from "./app.js";
import { admin } from "./callers.js";
import { L, S, conditionFailed, string } from "./dynamo.js";
import { ApiError, body, json } from "./http.js";
import { ProviderKeys } from "./provider-keys.js";

/** The attribute of an org's row holding them, a list of strings; absent when it has none. */
export const ATTRIBUTE = "chatbot_origins";

/** The org's origins, from its row. */
export function of(item) {
  const list = item?.[ATTRIBUTE]?.L;
  return Array.isArray(list) ? list.filter((o) => typeof o.S === "string").map((o) => o.S) : [];
}

/** `origins` as stored. */
export const value = (origins) => L(origins.map(S));

/**
 * `given`, each read as an origin, in order and without repeats; blank ones are skipped. A bare
 * domain is read as `https://`, and a path, as a pasted page address has, is dropped.
 */
export function parse(given) {
  const origins = [];
  for (const raw of given ?? []) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const o = origin(trimmed);
    if (!origins.includes(o)) origins.push(o);
  }
  return origins;
}

export function origin(given) {
  const invalid = () => ApiError.badRequest(`\`${given}\` isn't a site's address, like https://example.org`);
  let url;
  try {
    url = new URL(given.includes("://") ? given : `https://${given}`);
  } catch {
    throw invalid();
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) throw invalid();
  // A URL takes `*` in a host, but a browser never sends one as an origin.
  if (given.includes("*")) throw ApiError.badRequest(`\`${given}\` has a wildcard; list each site instead`);
  return url.origin;
}

/** `PUT /admin/orgs/chatbot-origins`: replaces an approved org's origins; none removes them. */
export async function set(app, req) {
  await admin(app, req);
  const r = body(req, { org_id: "string", chatbot_origins: "array" });
  const origins = parse(r.chatbot_origins);
  const update = {
    TableName: ORGS_TABLE,
    Key: { org_id: S(r.org_id) },
    ConditionExpression: "attribute_exists(org_id)",
  };
  if (origins.length === 0) update.UpdateExpression = `REMOVE ${ATTRIBUTE}`;
  else {
    update.UpdateExpression = `SET ${ATTRIBUTE} = :origins`;
    update.ExpressionAttributeValues = { ":origins": value(origins) };
  }
  try {
    await app.dynamo.send(new UpdateItemCommand(update));
  } catch (e) {
    if (conditionFailed(e)) throw ApiError.notFound("no approved org has this id");
    throw ApiError.internal(e);
  }
  return json({ chatbot_origins: origins });
}

const sameAscii = (a, b) => a.toLowerCase() === b.toLowerCase();

export function matchesCandidate(allowed, raw) {
  const candidate = raw.trim();
  if (candidate.length === 0) return false;
  if (sameAscii(allowed, candidate)) return true;
  const tryOrigin = (text) => {
    try {
      return origin(text);
    } catch {
      return null;
    }
  };
  const parsed = tryOrigin(candidate);
  if (parsed !== null && sameAscii(allowed, parsed)) return true;
  if (!candidate.includes("://")) {
    for (const scheme of ["https://", "http://"]) {
      const o = tryOrigin(`${scheme}${candidate}`);
      if (o !== null && sameAscii(allowed, o)) return true;
    }
  }
  return false;
}

/** Whether `host` is allowed for `orgId`'s chatbot, by the org's registered origins. */
export async function isAllowedOrigin(dynamo, orgId, host) {
  if (!orgId || !host) return false;
  const res = await dynamo.send(
    new GetItemCommand({
      TableName: ORGS_TABLE,
      Key: { org_id: S(orgId) },
      ProjectionExpression: "#o",
      ExpressionAttributeNames: { "#o": ATTRIBUTE },
    }),
  );
  return res.Item ? of(res.Item).some((allowed) => matchesCandidate(allowed, host)) : false;
}

/**
 * What the chatbot needs of an approved org: its name, the keys its replies bill to, and the
 * origins it may be embedded on.
 */
export class ChatbotOrg {
  constructor(orgName, openrouterKey, mongodbKey, origins) {
    this.orgName = orgName;
    this.openrouterKey = openrouterKey;
    this.mongodbKey = mongodbKey;
    this.origins = origins;
  }

  /** Whether the chatbot may be embedded on `o`. */
  allows(o) {
    return this.origins.some((allowed) => matchesCandidate(allowed, o));
  }
}

/** The approved org `orgId`, as its chatbot sees it, read in one call; `null` if there's none. */
export async function chatbotOrg(dynamo, orgId) {
  if (!orgId) return null;
  const res = await dynamo.send(new GetItemCommand({ TableName: ORGS_TABLE, Key: { org_id: S(orgId) } }));
  if (!res.Item) return null;
  const keys = ProviderKeys.of(res.Item);
  return new ChatbotOrg(string(res.Item, "org_name"), keys.hasOpenrouter() ? keys.openrouter() : null, keys.mongodb(), of(res.Item));
}
