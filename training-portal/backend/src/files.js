// An approved org's files and folders. A file is a document indexed through `rag`, its id the path
// down to it, like `UG|BTECH|CSE`. A folder is any path with files under it, or one kept in the
// org's `folders` set while empty. A path is one or the other: nothing goes inside a file (`fits`).

import { GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { IndexError, chain, describeDegradation } from "context-retriever";
import { MediaDescriptor, refusedKey, retriever as rag } from "rag";
import { log } from "rag/log";

import { DOCS_TABLE, ORGS_TABLE, VECTOR_BUCKET } from "./app.js";
import { owner as ownerOf } from "./callers.js";
import { S, aws } from "./dynamo.js";
import { ApiError, body, json, noContent, query } from "./http.js";
import { MAX_NEW_ID_BYTES, PART, SEP, bytes, names, parent } from "./paths.js";
import * as tree from "./tree.js";
import * as uploads from "./uploads.js";
import * as watchers from "./watchers.js";

/** Files a folder operation moves or removes at once. */
const CONCURRENCY = 8;

/** A failed save or removal, as the caller is told it. */
export function indexFailure(error) {
  if (error instanceof ApiError) return error;
  const status = refusedKey(error);
  if (status !== null) return ApiError.providerKey("OpenRouter", status);
  if (error instanceof rag.AddDocumentError) {
    if (error.code === "Breadcrumb") return ApiError.badRequest(chain(error));
    return indexFailure(error.cause);
  }
  if (error instanceof IndexError) {
    if (error.code === "DocumentTooLarge" || error.code === "PlanTooLarge") return ApiError.unprocessable(chain(error));
    // The text, or an id the engine can't index.
    if (error.code === "Input") return ApiError.badRequest(chain(error));
    if (["Chunker", "Embedder", "InvalidPlan"].includes(error.code)) return ApiError.upstream(chain(error));
  }
  return ApiError.internal(chain(error));
}

/** `call`'s result, its failure as `indexFailure` says. */
async function indexing(call) {
  try {
    return await call();
  } catch (e) {
    throw indexFailure(e);
  }
}

const noFile = (id) => ApiError.notFound(`no file has the id \`${id}\``);

/** `org`'s doc ids starting with `prefix`. */
export async function ids(app, org, prefix) {
  try {
    return await rag.listDocumentIds(app.dynamo, DOCS_TABLE, org, prefix);
  } catch (e) {
    throw ApiError.internal(e);
  }
}

export async function isFile(app, org, id) {
  const out = await aws(() =>
    app.dynamo.send(
      new GetItemCommand({
        TableName: DOCS_TABLE,
        Key: { org_id: S(org), doc_id: S(id) },
        ProjectionExpression: "doc_id",
        ConsistentRead: true,
      }),
    ),
  );
  return out.Item !== undefined;
}

/**
 * Refuses to index `id` while it has parts (`{id}~1`, ...): `rag` would remove or overwrite them,
 * and the user sees them as files of their own.
 */
export async function noParts(app, org, id) {
  const found = await ids(app, org, `${id}${PART}`);
  if (found.length > 0) throw ApiError.conflict(`rename or delete its parts first: ${found.join(", ")}`);
}

async function readDoc(app, org, id) {
  try {
    return await rag.readDocument(app.dynamo, app.s3v, DOCS_TABLE, VECTOR_BUCKET, org, id);
  } catch (e) {
    throw ApiError.internal(chain(e));
  }
}

/** The folders `org` keeps while empty. */
async function folders(app, org) {
  const out = await aws(() =>
    app.dynamo.send(
      new GetItemCommand({
        TableName: ORGS_TABLE,
        Key: { org_id: S(org) },
        ProjectionExpression: "#f",
        ExpressionAttributeNames: { "#f": "folders" },
        ConsistentRead: true,
      }),
    ),
  );
  return out.Item?.folders?.SS ?? [];
}

/** Adds `list` to `org`'s set (`op` `ADD`), or removes them from it (`DELETE`). */
async function updateFolders(app, org, op, list) {
  if (list.length === 0) return;
  await aws(() =>
    app.dynamo.send(
      new UpdateItemCommand({
        TableName: ORGS_TABLE,
        Key: { org_id: S(org) },
        UpdateExpression: `${op} #f :f`,
        ExpressionAttributeNames: { "#f": "folders" },
        ExpressionAttributeValues: { ":f": { SS: list } },
        ConditionExpression: "attribute_exists(org_id)",
      }),
    ),
  );
}

/**
 * Refuses a file (`file`) or a folder at `id` inside a file, or where the other one is: a path is
 * a file or a folder, never both.
 */
export async function fits(app, org, id, file) {
  for (let at = id.indexOf(SEP); at >= 0; at = id.indexOf(SEP, at + 1)) {
    const above = id.slice(0, at);
    if (await isFile(app, org, above)) throw ApiError.conflict(`\`${above}\` is a file, so nothing can go inside it`);
  }
  if (file && (await isFolder(app, org, id))) throw ApiError.conflict("a folder has this id");
  if (!file && (await isFile(app, org, id))) throw ApiError.conflict("a file has this id");
}

/** Whether `id` is a folder: kept, or with something under it. */
export async function isFolder(app, org, id) {
  const inside = `${id}${SEP}`;
  const [docs, kept] = await Promise.all([ids(app, org, inside), folders(app, org)]);
  return docs.length > 0 || kept.some((f) => f === id || f.startsWith(inside));
}

/** The ids of the files and folders under the folder `id`, which a new file in it can't take. */
export async function takenIn(app, org, id) {
  const inside = `${id}${SEP}`;
  const [docs, kept] = await Promise.all([ids(app, org, inside), folders(app, org)]);
  return taken(id, docs, kept);
}

/** What's under the folder `id`: of `docs`, the files under it, and the folders they're in. */
export function taken(id, docs, kept) {
  const inside = `${id}${SEP}`;
  const out = new Set(kept.filter((f) => f.startsWith(inside)));
  for (const doc of docs.filter((d) => d.startsWith(inside))) {
    for (let at = doc.indexOf(SEP, id.length + 1); at >= 0; at = doc.indexOf(SEP, at + 1)) out.add(doc.slice(0, at));
    out.add(doc);
  }
  return out;
}

/** Keeps the folder `id` while it's empty. */
export const keepFolder = (app, org, id) => updateFolders(app, org, "ADD", [id]);

/** Keeps the folder `id` was in, so removing its last file doesn't remove the folder. */
async function keepParent(app, org, id) {
  const p = parent(id);
  if (p !== null) await updateFolders(app, org, "ADD", [p]);
}

/** `GET /tree`: the org's topic tree, rooted at its name. */
export async function getTree(app, req) {
  const o = await ownerOf(app, req);
  const [docIds, kept, [kinds, made]] = await Promise.all([ids(app, o.org, ""), folders(app, o.org), watchers.kinds(app, o.org)]);
  return json(tree.build(o.orgName, docIds, kept, kinds, made, o.folders));
}

/** `GET /files?id=`: a file. */
export async function read(app, req) {
  const o = await ownerOf(app, req);
  const id = query(req, "id");
  o.names(id);
  const doc = await readDoc(app, o.org, id);
  if (!doc) throw noFile(id);
  const out = { id, markdown: doc.markdown };
  if (typeof doc.metadata?.source === "string") out.source = doc.metadata.source;
  return json(out);
}

const UPLOAD = { id: "string", markdown: "string", source: "string?", force_override: "bool?" };

/** `POST /files`: creates a file. */
export async function create(app, req) {
  const o = await ownerOf(app, req);
  const upload = body(req, UPLOAD);
  const parts = o.newNames(upload.id);
  if (await isFile(app, o.org, upload.id)) throw ApiError.conflict("a file has this id; edit it instead");
  await fits(app, o.org, upload.id, true);
  await noParts(app, o.org, upload.id);
  return json({ ids: await index(app, o, parts, upload) }, 201);
}

/** `PUT /files`: replaces a file's text. */
export async function edit(app, req) {
  const o = await ownerOf(app, req);
  const upload = body(req, UPLOAD);
  const parts = o.names(upload.id);
  if (!(await isFile(app, o.org, upload.id))) throw noFile(upload.id);
  await noParts(app, o.org, upload.id);
  await watchers.notMade(app, o.org, upload.id);
  const indexed = await index(app, o, parts, upload);
  // Edited by hand, the page isn't the watchers' to overwrite any more.
  await watchers.afterEdit(app, o.org, upload.id);
  return json({ ids: indexed });
}

/**
 * Saves `markdown`, read from `source`, as the file `id`, as a `PUT` without a hand edit does: its
 * images keep their descriptions. For watchers, which a hand edit stops. Unlike a person's save,
 * it isn't refused while `id` has parts: it replaces them, as they are the watched page's.
 */
export async function save(app, o, id, markdown, source) {
  return index(app, o, names(id), { id, markdown, source, force_override: false });
}

/**
 * Indexes `upload` at `parts` on the org's OpenRouter key, unless it is the file as stored, text
 * and source. Its media is described first, except the files the stored version links to already.
 */
async function index(app, o, parts, upload) {
  if (upload.markdown.trim().length === 0) throw ApiError.badRequest("a file can't be empty");
  const stored = await readDoc(app, o.org, upload.id);
  if (stored && stored.markdown === upload.markdown && (stored.metadata?.source ?? undefined) === (upload.source ?? undefined)) {
    log.info({ id: upload.id }, "unchanged, so not indexed again");
    return [upload.id];
  }
  const retriever = app.retriever(o);
  const meta = upload.source === undefined || upload.source === null ? {} : { source: upload.source };
  const indexed = await indexing(() =>
    rag.addDocument(
      retriever,
      new MediaDescriptor(o.keys.openrouter()),
      app.http,
      o.org,
      parts,
      upload.markdown,
      stored?.markdown ?? "",
      upload.force_override,
      meta,
    ),
  );
  log.info({ id: upload.id, parts: indexed.length }, "indexed");
  logDegraded(indexed);
  await uploads.record(app, o.org, upload.id, upload.markdown);
  return indexed.map(([id]) => id);
}

/**
 * Logs what indexing or removing documents did less well than it should have, such as a chunker
 * failure that left a page cut by size, or old chunks left behind.
 */
export function logDegraded(outcomes) {
  for (const [id, outcome] of outcomes) {
    for (const d of outcome.degradations) log.warn({ id, degradation: describeDegradation(d) }, "degraded");
  }
}

const RENAME = { from: "string", to: "string" };

/** `POST /files/rename`: moves a file to another id, which re-indexes it. */
export async function rename(app, req) {
  const o = await ownerOf(app, req);
  const r = body(req, RENAME);
  o.names(r.from);
  const to = o.newNames(r.to);
  if (r.from === r.to) throw ApiError.badRequest("the new id is the old one");
  if (await isFile(app, o.org, r.to)) throw ApiError.conflict("a file has the new id");
  await fits(app, o.org, r.to, true);
  await noParts(app, o.org, r.to);
  const moves = await watchers.planMove(app, o.org, r.from, r.to, false);
  const moved = await moveFile(app, app.retriever(o), o.org, r.from, to);
  await watchers.applyMove(app, o.org, moves);
  await keepParent(app, o.org, r.from);
  return json({ ids: moved });
}

/**
 * Indexes `from`'s text and metadata at `to`, without describing its media again, then removes
 * `from`. The new path is in every chunk's context, so it is chunked and embedded again.
 */
async function moveFile(app, retriever, org, from, to) {
  const doc = await readDoc(app, org, from);
  if (!doc) throw noFile(from);
  const indexed = await indexing(() => rag.addDescribedDocument(retriever, org, to, doc.markdown, doc.metadata ?? {}));
  logDegraded(indexed);
  // The first id indexed is the file's; any after it, its parts.
  if (indexed.length > 0) await uploads.carry(app, org, from, indexed[0][0]);
  const removed = await indexing(() => retriever.removeDocument(from, org));
  logDegraded([[from, removed]]);
  return indexed.map(([id]) => id);
}

/** `DELETE /files?id=`: deletes a file. Its parts stay. */
export async function remove(app, req) {
  const o = await ownerOf(app, req);
  const id = query(req, "id");
  o.names(id);
  await watchers.notMade(app, o.org, id);
  const files = await uploads.of(app, o.org, id);
  const removed = await indexing(() => app.retriever(o).removeDocument(id, o.org));
  // Nothing to remove may still leave a row without chunks, from a removal that failed halfway.
  if (removed.staleDeleted === 0) {
    let wasRow;
    try {
      wasRow = await rag.removeChunklessDocument(app.dynamo, DOCS_TABLE, o.org, id);
    } catch (e) {
      throw ApiError.internal(e);
    }
    if (!wasRow) throw noFile(id);
  }
  logDegraded([[id, removed]]);
  await uploads.free(app, files);
  await watchers.afterDelete(app, o.org, id, false);
  await keepParent(app, o.org, id);
  return noContent();
}

/** `POST /folders`: creates a folder, kept while empty. */
export async function createFolder(app, req) {
  const o = await ownerOf(app, req);
  const folder = body(req, { id: "string" });
  o.newNames(folder.id);
  await fits(app, o.org, folder.id, false);
  await updateFolders(app, o.org, "ADD", [folder.id]);
  return { status: 201, body: undefined };
}

async function mapLimited(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  return out;
}

/** `DELETE /folders?id=`: deletes a folder, with the files and folders under it. */
export async function removeFolder(app, req) {
  const o = await ownerOf(app, req);
  const id = query(req, "id");
  o.innerNames(id);
  const retriever = app.retriever(o);
  const inside = `${id}${SEP}`;
  const removed = await mapLimited(await ids(app, o.org, inside), CONCURRENCY, async (doc) => {
    const files = await uploads.of(app, o.org, doc);
    const outcome = await indexing(() => retriever.removeDocument(doc, o.org));
    await uploads.free(app, files);
    return [doc, outcome];
  });
  logDegraded(removed);
  await watchers.afterDelete(app, o.org, id, true);
  const gone = (await folders(app, o.org)).filter((f) => f === id || f.startsWith(inside));
  await updateFolders(app, o.org, "DELETE", gone);
  await keepParent(app, o.org, id);
  return noContent();
}

/**
 * `POST /folders/rename`: moves a folder, with every file and folder under it. Every file is
 * re-indexed. If one fails, the rest may have moved; renaming again moves what is left.
 */
export async function renameFolder(app, req) {
  const o = await ownerOf(app, req);
  const r = body(req, RENAME);
  const org = o.org;
  o.innerNames(r.from);
  o.newNames(r.to);
  const inside = `${r.from}${SEP}`;
  if (r.from === r.to || r.to.startsWith(inside)) throw ApiError.badRequest("a folder can't move to itself or into itself");
  await fits(app, org, r.to, false);
  const retriever = app.retriever(o);
  const target = (id) => `${r.to}${id.slice(r.from.length)}`;
  const docs = await ids(app, org, inside);
  // Checked before any file moves. A part's id is its file's, plus `~n`.
  const tooLong = docs.filter((id) => !id.includes(PART)).map(target).filter((to) => bytes(to) > MAX_NEW_ID_BYTES);
  if (tooLong.length > 0) {
    throw ApiError.badRequest(`these ids would be over ${MAX_NEW_ID_BYTES} bytes: ${tooLong.join(", ")}`);
  }
  const occupied = new Set(await ids(app, org, `${r.to}${SEP}`));
  const blocked = docs.map(target).filter((to) => occupied.has(to) || [...occupied].some((id) => id.startsWith(`${to}${PART}`)));
  if (blocked.length > 0) throw ApiError.conflict(`these ids are taken: ${blocked.join(", ")}`);

  const moves = await watchers.planMove(app, org, r.from, r.to, true);
  // Files before parts: indexing `X` at its new path removes any `X~n` already there.
  const parts = docs.filter((id) => id.includes(PART));
  const files = docs.filter((id) => !id.includes(PART));
  const moved = [];
  for (const batch of [files, parts]) {
    const done = await mapLimited(batch, CONCURRENCY, (from) => moveFile(app, retriever, org, from, target(from).split(SEP)));
    moved.push(...done.flat());
  }
  await watchers.applyMove(app, org, moves);

  const kept = (await folders(app, org)).filter((f) => f === r.from || f.startsWith(inside));
  await updateFolders(app, org, "ADD", kept.map(target));
  await updateFolders(app, org, "DELETE", kept);
  await keepParent(app, org, r.from);
  moved.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return json({ ids: moved });
}
