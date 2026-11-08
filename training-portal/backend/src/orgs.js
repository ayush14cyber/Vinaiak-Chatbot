// Registration: an account asks for an org id, and an admin approves or rejects it. A request
// waits in `PENDING_TABLE` and moves to `ORGS_TABLE` on approval, with the org's provider keys,
// when the org's vector index is created. Its creator becomes its root admin (`admins.js`).

import {
  DeleteItemCommand,
  GetItemCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { retriever as rag } from "rag";

import * as admins from "./admins.js";
import { BY_OWNER, ORGS_TABLE, PENDING_TABLE, VECTOR_BUCKET } from "./app.js";
import { openedOrg } from "./auth.js";
import { admin, user } from "./callers.js";
import * as chatbotOrigins from "./chatbot-origins.js";
import { N, S, aws, conditionFailed, nowSecs, number, string, transactionCanceled } from "./dynamo.js";
import { ApiError, body, json, query } from "./http.js";
import { Owner } from "./owner.js";
import { ROOT } from "./paths.js";
import * as providerKeys from "./provider-keys.js";

/** Most chars in an org's name. */
const MAX_NAME_CHARS = 100;

const chars = (text) => [...text].length;

/**
 * Why `id` can't be an org id, if it can't. It names the org's S3 Vectors index, so it follows
 * their rules: 3 to 63 lowercase letters, digits, `-` and `.`, starting and ending with a letter or
 * digit.
 */
export function invalidOrgId(id) {
  const alnum = (c) => /^[a-z0-9]$/.test(c);
  if (Buffer.byteLength(id, "utf8") < 3 || Buffer.byteLength(id, "utf8") > 63) return "an org id is 3 to 63 characters long";
  if (![...id].every((c) => alnum(c) || c === "-" || c === ".")) {
    return "an org id has only lowercase letters, digits, `-` and `.`";
  }
  if (!alnum(id[0]) || !alnum(id[id.length - 1])) return "an org id starts and ends with a letter or a digit";
  return null;
}

/**
 * `GET /me`: the account, and where it stands: an org's admin, waiting to create or join one, or
 * neither. The master admin with an org open is its root admin.
 */
export async function me(app, req) {
  const u = await user(app, req);
  const opened = app.isAdmin(u.email) ? openedOrg(req) : null;
  let status;
  let item;
  let joining = false;
  let folders = [];
  const standing = opened === null ? await admins.standing(app, u.email) : null;
  if (opened !== null) {
    [status, item, folders] = ["approved", await get(app, ORGS_TABLE, opened), [ROOT]];
  } else if (standing) {
    item = await get(app, ORGS_TABLE, standing.orgId);
    if (standing.folders) [status, folders] = ["approved", standing.folders];
    else [status, joining] = ["pending", true];
  } else {
    item = await byOwner(app, PENDING_TABLE, u.sub);
    status = item ? "pending" : "none";
  }
  // An org that's gone leaves the account with none.
  if (!item) status = "none";
  const out = { email: u.email, admin: app.isAdmin(u.email), status };
  if (item) out.org = { org_id: string(item, "org_id"), org_name: string(item, "org_name") };
  if (joining && status === "pending") out.joining = true;
  if (folders.length > 0) out.folders = folders;
  return json(out);
}

/**
 * The approved org `orgId`, if there is one, as its root admin with no email: the watcher Lambda,
 * which acts for the org.
 */
export async function approvedOrg(app, orgId) {
  const item = await get(app, ORGS_TABLE, orgId);
  return item ? ownerOf(item) : null;
}

function ownerOf(item) {
  return new Owner({
    org: string(item, "org_id"),
    orgName: string(item, "org_name"),
    folders: [ROOT],
    keys: providerKeys.ProviderKeys.of(item),
  });
}

/** The row of `table` that `sub` owns, through the `BY_OWNER` index. */
export async function byOwner(app, table, sub) {
  const out = await aws(() =>
    app.dynamo.send(
      new QueryCommand({
        TableName: table,
        IndexName: BY_OWNER,
        KeyConditionExpression: "owner_sub = :s",
        ExpressionAttributeValues: { ":s": S(sub) },
        Limit: 1,
      }),
    ),
  );
  return out.Items?.[0] ?? null;
}

/** `GET /org-ids/available?id=`: whether `id` is a valid org id that no request or org has. */
export async function available(app, req) {
  await user(app, req);
  const id = query(req, "id");
  const reason = invalidOrgId(id);
  if (reason) return json({ available: false, reason });
  const taken = (await get(app, PENDING_TABLE, id)) !== null || (await get(app, ORGS_TABLE, id)) !== null;
  return json(taken ? { available: false, reason: "this org id is taken" } : { available: true });
}

/** The row of `table` for `orgId`, if there is one. */
export async function get(app, table, orgId) {
  const out = await aws(() =>
    app.dynamo.send(new GetItemCommand({ TableName: table, Key: { org_id: S(orgId) }, ConsistentRead: true })),
  );
  return out.Item ?? null;
}

/** `POST /register`: asks for `org_id`, for the account. One account owns one org. */
export async function register(app, req) {
  const u = await user(app, req);
  const r = body(req, { org_id: "string", org_name: "string" });
  const reason = invalidOrgId(r.org_id);
  if (reason) throw ApiError.badRequest(reason);
  const orgName = r.org_name.trim();
  if (orgName.length === 0 || chars(orgName) > MAX_NAME_CHARS) {
    throw ApiError.badRequest(`an org name is 1 to ${MAX_NAME_CHARS} characters long`);
  }
  if (await admins.row(app, u.email)) {
    throw ApiError.conflict("this account is an admin of an org already, or asked to join one");
  }
  if (await byOwner(app, PENDING_TABLE, u.sub)) {
    throw ApiError.conflict("this account already has a request waiting for approval");
  }
  // One transaction, so two requests for the same id can't both win.
  await transact(
    app,
    [
      {
        Put: {
          TableName: PENDING_TABLE,
          Item: {
            org_id: S(r.org_id),
            org_name: S(orgName),
            owner_sub: S(u.sub),
            owner_email: S(u.email),
            requested_at: N(nowSecs()),
          },
          ConditionExpression: "attribute_not_exists(org_id)",
        },
      },
      {
        ConditionCheck: {
          TableName: ORGS_TABLE,
          Key: { org_id: S(r.org_id) },
          ConditionExpression: "attribute_not_exists(org_id)",
        },
      },
    ],
    "this org id is taken",
  );
  return json({ status: "pending" }, 201);
}

/** Writes `items` in one transaction; a failed condition is a conflict, `taken`. */
export async function transact(app, items, taken) {
  try {
    await app.dynamo.send(new TransactWriteItemsCommand({ TransactItems: items }));
  } catch (e) {
    if (transactionCanceled(e)) throw ApiError.conflict(taken);
    throw ApiError.internal(e);
  }
}

/** `GET /admin/requests`: the requests waiting for approval, oldest first. */
export async function requests(app, req) {
  await admin(app, req);
  const out = (await scan(app, PENDING_TABLE)).map((item) => ({
    org_id: string(item, "org_id"),
    org_name: string(item, "org_name"),
    owner_email: string(item, "owner_email"),
    requested_at: number(item, "requested_at"),
  }));
  out.sort((a, b) => a.requested_at - b.requested_at);
  return json(out);
}

/** Every row of `table`. */
export async function scan(app, table) {
  const items = [];
  let start;
  do {
    const out = await aws(() => app.dynamo.send(new ScanCommand({ TableName: table, ExclusiveStartKey: start })));
    items.push(...(out.Items ?? []));
    start = out.LastEvaluatedKey;
  } while (start);
  return items;
}

/** `GET /admin/orgs`: the approved orgs, by name. */
export async function list(app, req) {
  await admin(app, req);
  const out = (await scan(app, ORGS_TABLE)).map((item) => {
    const keys = providerKeys.ProviderKeys.of(item);
    return {
      org_id: string(item, "org_id"),
      org_name: string(item, "org_name"),
      owner_email: string(item, "owner_email"),
      approved_at: number(item, "approved_at"),
      openrouter_key: keys.hasOpenrouter(),
      firecrawl_key: keys.hasFirecrawl(),
      mongodb_key: keys.hasMongodb(),
      chatbot_origins: chatbotOrigins.of(item),
    };
  });
  const key = (org) => org.org_name.toLowerCase();
  out.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return json(out);
}

/**
 * `POST /admin/approve`: checks the org's provider keys with their providers, creates its vector
 * index, then moves its request into `ORGS_TABLE` with the keys and any chatbot origins.
 */
export async function approve(app, req) {
  await admin(app, req);
  const r = body(req, {
    org_id: "string",
    openrouter_key: "string?",
    firecrawl_key: "string?",
    mongodb_key: "string?",
    chatbot_origins: "array?",
  });
  const item = await get(app, PENDING_TABLE, r.org_id);
  if (!item) throw ApiError.notFound("no request has this org id");
  const openrouter = providerKeys.given(r.openrouter_key);
  const firecrawl = providerKeys.given(r.firecrawl_key);
  const mongodb = providerKeys.given(r.mongodb_key);
  if (!openrouter || !firecrawl || !mongodb) {
    throw ApiError.badRequest("give the org's OpenRouter, Firecrawl and MongoDB keys");
  }
  const origins = chatbotOrigins.parse(r.chatbot_origins);
  await providerKeys.check(app, openrouter, firecrawl, mongodb);
  // First, so an approved org can always index; creating it again succeeds.
  try {
    await rag.createOrgIndex(app.s3v, VECTOR_BUCKET, r.org_id);
  } catch (e) {
    throw ApiError.internal(e);
  }
  item.approved_at = N(nowSecs());
  item[providerKeys.OPENROUTER] = S(openrouter);
  item[providerKeys.FIRECRAWL] = S(firecrawl);
  item[providerKeys.MONGODB] = S(mongodb);
  if (origins.length > 0) item[chatbotOrigins.ATTRIBUTE] = chatbotOrigins.value(origins);
  // Its creator becomes its root admin.
  const creator = admins.creator(string(item, "owner_email"), r.org_id);
  await transact(
    app,
    [
      {
        Delete: {
          TableName: PENDING_TABLE,
          Key: { org_id: S(r.org_id) },
          ConditionExpression: "attribute_exists(org_id)",
        },
      },
      { Put: { TableName: ORGS_TABLE, Item: item, ConditionExpression: "attribute_not_exists(org_id)" } },
      { Put: creator },
    ],
    "the request was approved or rejected meanwhile, or its creator joined another org",
  );
  return json({ status: "approved" });
}

/** `POST /admin/reject`: deletes the request, which frees its org id. */
export async function reject(app, req) {
  await admin(app, req);
  const r = body(req, { org_id: "string" });
  try {
    await app.dynamo.send(
      new DeleteItemCommand({
        TableName: PENDING_TABLE,
        Key: { org_id: S(r.org_id) },
        ConditionExpression: "attribute_exists(org_id)",
      }),
    );
  } catch (e) {
    if (conditionFailed(e)) throw ApiError.notFound("no request has this org id");
    throw ApiError.internal(e);
  }
  return json({ status: "rejected" });
}
