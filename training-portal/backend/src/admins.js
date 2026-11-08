// Who may change an org's topics. Each admin has a row in `ADMINS_TABLE`, keyed by their email,
// with their org and the folders they may change, `""` being the org's root. The org's creator gets
// the root when the org is approved. Anyone else asks to join it (`POST /join`), and the master
// admin lets them in with some folders, changes them, or removes them.

import { DeleteItemCommand, GetItemCommand, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

import { ADMINS_TABLE, ORGS_TABLE, PENDING_TABLE } from "./app.js";
import { admin, user } from "./callers.js";
import { L, N, S, aws, conditionFailed, nowSecs, number, string } from "./dynamo.js";
import { ApiError, body, json, noContent, query } from "./http.js";
import * as keys from "./keys.js";
import * as orgs from "./orgs.js";
import { ROOT, covers, names } from "./paths.js";

/** An admin's folders, or `null` while they wait to join. */
function foldersOf(item) {
  const list = item?.folders?.L;
  return Array.isArray(list) ? list.filter((f) => typeof f.S === "string").map((f) => f.S) : null;
}

const foldersValue = (folders) => L(folders.map(S));

/** The row of `email`, an admin or an account waiting to join. */
export async function row(app, email) {
  const out = await aws(() =>
    // A removed admin stops at once.
    app.dynamo.send(new GetItemCommand({ TableName: ADMINS_TABLE, Key: { email: S(email) }, ConsistentRead: true })),
  );
  return out.Item ?? null;
}

/** `email`'s org and folders, if they're an admin of an approved org. */
export async function owner(app, email) {
  const item = await row(app, email);
  if (!item) return null;
  const folders = foldersOf(item);
  if (!folders) return null;
  const org = await orgs.approvedOrg(app, string(item, "org_id"));
  if (!org) return null;
  org.email = email;
  org.folders = folders;
  return org;
}

/** Where `email` stands with an org, for `GET /me`: `{orgId, folders}`, `folders` null while they wait. */
export async function standing(app, email) {
  const item = await row(app, email);
  return item ? { orgId: string(item, "org_id"), folders: foldersOf(item) } : null;
}

/** The put making `email` the root admin of `orgId`, its creator's, when the org is approved. */
export function creator(email, orgId) {
  return {
    TableName: ADMINS_TABLE,
    Item: { email: S(email), org_id: S(orgId), folders: foldersValue([ROOT]), requested_at: N(nowSecs()) },
    ConditionExpression: "attribute_not_exists(email)",
  };
}

/** `POST /join {org_id}`: asks the master admin to let the account into an approved org. */
export async function join(app, req) {
  const u = await user(app, req);
  const j = body(req, { org_id: "string" });
  if (!(await orgs.get(app, ORGS_TABLE, j.org_id))) throw ApiError.notFound("no approved org has this id");
  if (await orgs.byOwner(app, PENDING_TABLE, u.sub)) {
    throw ApiError.conflict("this account already has a request waiting for approval");
  }
  try {
    await app.dynamo.send(
      new PutItemCommand({
        TableName: ADMINS_TABLE,
        Item: { email: S(u.email), org_id: S(j.org_id), requested_at: N(nowSecs()) },
        ConditionExpression: "attribute_not_exists(email)",
      }),
    );
  } catch (e) {
    if (conditionFailed(e)) throw ApiError.conflict("this account is an admin of an org already, or asked to join one");
    throw ApiError.internal(e);
  }
  return json({ status: "pending" }, 201);
}

/** `GET /admin/admins`: every org's admins, and the accounts waiting to join one, oldest first. */
export async function list(app, req) {
  await admin(app, req);
  const [rows, all] = await Promise.all([orgs.scan(app, ADMINS_TABLE), orgs.scan(app, ORGS_TABLE)]);
  const namesOf = new Map(all.map((org) => [string(org, "org_id"), string(org, "org_name")]));
  const out = rows.map((item) => {
    const orgId = string(item, "org_id");
    return {
      email: string(item, "email"),
      org_id: orgId,
      org_name: namesOf.get(orgId) ?? "",
      folders: foldersOf(item),
      requested_at: number(item, "requested_at"),
    };
  });
  out.sort((a, b) => a.requested_at - b.requested_at);
  return json(out);
}

/** A folder of `folders` inside another of them, with that one. */
function nested(folders) {
  for (const inner of folders) {
    const outer = folders.find((o) => o !== inner && covers([o], inner, false));
    if (outer !== undefined) return [inner, outer];
  }
  return null;
}

const notFound = () => ApiError.notFound("no admin, nor account waiting to join, has this email");

/**
 * `PUT /admin/admins {email, folders}`: lets an account waiting to join in with `folders`, or
 * changes an admin's. `""` is the root. None may be inside another.
 */
export async function set(app, req) {
  await admin(app, req);
  const f = body(req, { email: "string", folders: "array" });
  if (!f.folders.every((folder) => typeof folder === "string")) {
    throw ApiError.unprocessable("Failed to deserialize the JSON body into the target type: `folders`: invalid type");
  }
  if (f.folders.length === 0) throw ApiError.badRequest("give at least one folder");
  for (const folder of f.folders) if (folder.length > 0) names(folder);
  const folders = [...new Set(f.folders)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const inside = nested(folders);
  if (inside) {
    const [inner, outer] = inside;
    throw ApiError.badRequest(`“${inner}” is inside “${outer.length === 0 ? "the root" : outer}”, which covers it already`);
  }
  try {
    await app.dynamo.send(
      new UpdateItemCommand({
        TableName: ADMINS_TABLE,
        Key: { email: S(f.email) },
        UpdateExpression: "SET folders = :f",
        ExpressionAttributeValues: { ":f": foldersValue(folders) },
        ConditionExpression: "attribute_exists(email)",
      }),
    );
  } catch (e) {
    if (conditionFailed(e)) throw notFound();
    throw ApiError.internal(e);
  }
  return json({ folders });
}

/** `DELETE /admin/admins?email=`: removes an admin and revokes their API keys, or refuses a join. */
export async function remove(app, req) {
  await admin(app, req);
  const email = query(req, "email");
  const item = await row(app, email);
  if (!item) throw notFound();
  // Their keys first: should that fail, they're still an admin, and removing them again retries.
  await keys.revokeAll(app, string(item, "org_id"), email);
  try {
    await app.dynamo.send(
      new DeleteItemCommand({
        TableName: ADMINS_TABLE,
        Key: { email: S(email) },
        ConditionExpression: "attribute_exists(email)",
      }),
    );
  } catch (e) {
    if (conditionFailed(e)) throw notFound();
    throw ApiError.internal(e);
  }
  return noContent();
}
