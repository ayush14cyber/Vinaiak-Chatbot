// What an org's chatbot couldn't find in its documents, as its model reported through
// `data_not_found`, with the conversation it came up in. The chatbot keeps one report per
// conversation, rewritten as it reports more; the org's owner reads them here to add what's
// missing, and dismisses each once it's handled.
//
// A report: `{session_id, items: string[], conversation: [{role: "user" | "assistant", text}],
// reported_at}`.

import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, NoSuchKey } from "@aws-sdk/client-s3";

import { owner as ownerOf } from "./callers.js";
import { aws } from "./dynamo.js";
import { ApiError, json, noContent, query } from "./http.js";

/** The chatbot's bucket: its sessions under `sessions/`, and the reports under `PREFIX`. */
export const CHAT_BUCKET = "training-portal-chat-sessions";
/** The reports, one folder per org. */
const PREFIX = "data-not-found";
/** Reports read at once. */
const CONCURRENCY = 8;

/** Where the report of conversation `sessionId` of `orgId` is kept. */
export const key = (orgId, sessionId) => `${PREFIX}/${orgId}/${sessionId}.json`;

/** `GET /data-not-found`: the org's reports, newest first. */
export async function list(app, req) {
  const o = await ownerOf(app, req);
  return json(await reports(app, o.org));
}

/** `DELETE /data-not-found?session_id=`: dismisses a report, once its data was added. */
export async function dismiss(app, req) {
  const o = await ownerOf(app, req);
  const sessionId = query(req, "session_id");
  // A session id is a UUID; anything else would name some other object.
  if (sessionId.length === 0 || !/^[0-9a-fA-F-]+$/.test(sessionId)) {
    throw ApiError.notFound("your org has no report with this id");
  }
  await aws(() => app.s3.send(new DeleteObjectCommand({ Bucket: CHAT_BUCKET, Key: key(o.org, sessionId) })));
  return noContent();
}

/** `org`'s reports, newest first: the first 1,000. */
async function reports(app, org) {
  const listed = await aws(() =>
    app.s3.send(new ListObjectsV2Command({ Bucket: CHAT_BUCKET, Prefix: `${PREFIX}/${org}/` })),
  );
  const keys = (listed.Contents ?? []).map((object) => object.Key).filter(Boolean);
  const read = [];
  for (let i = 0; i < keys.length; i += CONCURRENCY) {
    read.push(...(await Promise.all(keys.slice(i, i + CONCURRENCY).map((k) => readReport(app, k)))));
  }
  return read.filter(Boolean).sort((a, b) => b.reported_at - a.reported_at);
}

/** The report at `objectKey`, unless it was dismissed since it was listed. */
async function readReport(app, objectKey) {
  let out;
  try {
    out = await app.s3.send(new GetObjectCommand({ Bucket: CHAT_BUCKET, Key: objectKey }));
  } catch (e) {
    if (e instanceof NoSuchKey || e?.name === "NoSuchKey") return null;
    throw ApiError.internal(e);
  }
  try {
    return JSON.parse(await out.Body.transformToString());
  } catch (e) {
    throw ApiError.internal(e);
  }
}
