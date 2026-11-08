// API keys: how an AI, or any program, acts as an org's admin without signing in to Google. An
// admin creates a key in the portal and gives it to the program, which sends it as
// `Authorization: Bearer`. Only the key's SHA-256 is stored, so the key is shown once. A key acts
// as its creator, with their folders as they are now: removing them revokes it.

import { createHash, randomBytes } from "node:crypto";

import { DeleteItemCommand, GetItemCommand, PutItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";

import * as admins from "./admins.js";
import { BY_ORG, KEYS_TABLE } from "./app.js";
import { owner as ownerOf } from "./callers.js";
import { N, S, aws, conditionFailed, nowSecs, number, string } from "./dynamo.js";
import { ApiError, body, json, noContent, query } from "./http.js";
import * as orgs from "./orgs.js";

/** Starts every key, telling it apart from a Google token, and making a leaked one easy to spot. */
export const PREFIX = "vtp_";
/** Random bytes in a key. */
const KEY_BYTES = 32;
/** The chars of a key kept to show which one it is: the prefix and four more. */
const SHOWN_CHARS = PREFIX.length + 4;
const MAX_NAME_CHARS = 60;
/** Most keys an org has at once. */
const MAX_KEYS = 20;

/** A new key: the prefix, then `KEY_BYTES` random bytes in hex. */
const newKey = () => `${PREFIX}${randomBytes(KEY_BYTES).toString("hex")}`;

/** SHA-256 of `text`, in hex. */
export const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** The approved org `key` acts for, if it is a key that wasn't revoked. */
export async function owner(app, key) {
  const out = await aws(() =>
    app.dynamo.send(
      new GetItemCommand({
        TableName: KEYS_TABLE,
        Key: { key_hash: S(sha256(key)) },
        ProjectionExpression: "org_id, email",
        // A revoked key stops working at once.
        ConsistentRead: true,
      }),
    ),
  );
  if (!out.Item) return null;
  const [org, email] = [string(out.Item, "org_id"), string(out.Item, "email")];
  let o = null;
  if (email.length === 0) {
    o = null;
  } else if (app.isAdmin(email)) {
    // The master admin's, made with the org open: its root admin.
    o = await orgs.approvedOrg(app, org);
    if (o) o.email = email;
  } else {
    o = await admins.owner(app, email);
    if (o && o.org !== org) o = null;
  }
  if (o) o.byKey = true;
  return o;
}

/** Refuses keys: a key can't make or revoke keys, so a leaked one can't make more. */
function signedIn(o) {
  if (o.byKey) throw ApiError.forbidden("an API key can't manage API keys; sign in to the portal");
}

const keyOf = (item) => ({
  id: string(item, "key_hash"),
  name: string(item, "name"),
  prefix: string(item, "prefix"),
  email: string(item, "email"),
  created_at: number(item, "created_at"),
});

/** The org's keys, oldest first. */
async function keysOf(app, org) {
  const out = [];
  let start;
  do {
    const page = await aws(() =>
      app.dynamo.send(
        new QueryCommand({
          TableName: KEYS_TABLE,
          IndexName: BY_ORG,
          KeyConditionExpression: "org_id = :o",
          ExpressionAttributeValues: { ":o": S(org) },
          ExclusiveStartKey: start,
        }),
      ),
    );
    out.push(...(page.Items ?? []).map(keyOf));
    start = page.LastEvaluatedKey;
  } while (start);
  out.sort((a, b) => a.created_at - b.created_at);
  return out;
}

/** Revokes every key `email` made in `org`, as they stop being its admin. */
export async function revokeAll(app, org, email) {
  for (const key of (await keysOf(app, org)).filter((k) => k.email === email)) {
    await aws(() => app.dynamo.send(new DeleteItemCommand({ TableName: KEYS_TABLE, Key: { key_hash: S(key.id) } })));
  }
}

/** `GET /keys`: the org's API keys, without the keys themselves. */
export async function list(app, req) {
  const o = await ownerOf(app, req);
  signedIn(o);
  return json(await keysOf(app, o.org));
}

/** `POST /keys {name}`: a new API key for the org. */
export async function create(app, req) {
  const o = await ownerOf(app, req);
  signedIn(o);
  const c = body(req, { name: "string" });
  const name = c.name.trim();
  if (name.length === 0 || [...name].length > MAX_NAME_CHARS) {
    throw ApiError.badRequest(`name the key in 1 to ${MAX_NAME_CHARS} characters`);
  }
  if ((await keysOf(app, o.org)).length >= MAX_KEYS) {
    throw ApiError.conflict(`an org has at most ${MAX_KEYS} keys; revoke one first`);
  }
  const key = newKey();
  const info = { id: sha256(key), name, prefix: key.slice(0, SHOWN_CHARS), email: o.email, created_at: nowSecs() };
  await aws(() =>
    app.dynamo.send(
      new PutItemCommand({
        TableName: KEYS_TABLE,
        Item: {
          key_hash: S(info.id),
          org_id: S(o.org),
          name: S(info.name),
          prefix: S(info.prefix),
          email: S(info.email),
          created_at: N(info.created_at),
        },
        ConditionExpression: "attribute_not_exists(key_hash)",
      }),
    ),
  );
  return json({ ...info, key }, 201);
}

/** `DELETE /keys?id=`: revokes one of the org's keys. */
export async function revoke(app, req) {
  const o = await ownerOf(app, req);
  signedIn(o);
  const id = query(req, "id");
  if (id.length === 0) throw ApiError.notFound("your org has no key with this id");
  try {
    await app.dynamo.send(
      new DeleteItemCommand({
        TableName: KEYS_TABLE,
        Key: { key_hash: S(id) },
        ConditionExpression: "org_id = :o",
        ExpressionAttributeValues: { ":o": S(o.org) },
      }),
    );
  } catch (e) {
    if (conditionFailed(e)) throw ApiError.notFound("your org has no key with this id");
    throw ApiError.internal(e);
  }
  return noContent();
}
