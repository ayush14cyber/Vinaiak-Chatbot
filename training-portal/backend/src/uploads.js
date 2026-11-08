// Files a person uploads into a page: PDFs and images, kept in the public bucket at
// `public/{org}/files/{random}/{name}` and linked from the page's markdown by their public URL, so
// saving the page describes them and the chatbot can cite them.
//
// `POST /files/uploads` hands out a presigned `PUT` for each file, which the browser sends straight
// to S3, as a Function URL takes 6 MB at most. Its type and size are signed, so S3 takes no other.
//
// Each file is uploaded for one page, which its upload is tagged with. Saving that page records the
// files it links to, of those uploaded for it, on its row of `DOCS_TABLE`, as `files`. The set only
// grows. A move carries the set to the page's new row, and deleting the page deletes its files.

import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { MAX_PDF_BYTES } from "rag";
import { log } from "rag/log";

import { DOCS_TABLE } from "./app.js";
import { owner as ownerOf } from "./callers.js";
import { PUBLIC_BUCKET, PUBLIC_ORIGIN, publicUrl } from "./chatbot-widget.js";
import { S, aws, conditionFailed } from "./dynamo.js";
import { ApiError, body, describe, json } from "./http.js";
import { sha256 } from "./keys.js";

/** The largest upload: the largest PDF a save describes. */
export const MAX_BYTES = MAX_PDF_BYTES;
/** Most files uploaded at once. */
const MAX_FILES = 20;
/** How long a presigned upload may take to start, in seconds. */
const EXPIRES = 15 * 60;
/** Random bytes naming a file's folder, so two files of one name don't meet. */
const ID_BYTES = 16;
/** Longest file name kept, in chars, its extension included. */
const MAX_NAME_CHARS = 100;
/** Tries at deleting a file. */
const DELETE_TRIES = 3;
/** Files deleted at once. */
const CONCURRENCY = 8;
/** A page row's attribute listing the uploads it linked to. */
const FILES = "files";
/** The metadata an upload is tagged with the page it's for by. */
const PAGE = "page";

/** The types a page can upload, those a save describes, with the extensions its key may end in. */
const TYPES = {
  "application/pdf": ["pdf"],
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/webp": ["webp"],
  "image/gif": ["gif"],
};

/**
 * `POST /files/uploads {id, files: [{name, type, size}]}`: where to upload each file for the page
 * `id`, and the URL to link it by once it's there.
 */
export async function create(app, req) {
  const o = await ownerOf(app, req);
  const r = body(req, { id: "string", files: "array" });
  o.names(r.id);
  const tag = pageTag(r.id);
  if (r.files.length === 0 || r.files.length > MAX_FILES) {
    throw ApiError.badRequest(`upload from 1 to ${MAX_FILES} files at once`);
  }
  const uploads = [];
  for (const file of r.files) {
    if (typeof file?.name !== "string" || typeof file?.type !== "string" || !Number.isInteger(file?.size) || file.size < 0) {
      throw ApiError.unprocessable("Failed to deserialize the JSON body into the target type: `files`: invalid type");
    }
    const name = fileName(file.name, file.type);
    if (file.size === 0 || file.size > MAX_BYTES) {
      throw ApiError.badRequest(`\`${file.name}\` is empty or over ${MAX_BYTES >> 20} MB, the most a save reads`);
    }
    const key = `public/${o.org}/files/${randomBytes(ID_BYTES).toString("hex")}/${name}`;
    uploads.push(await presign(app.s3, key, file.type, file.size, tag));
  }
  return json({ uploads });
}

/** A presigned `PUT` of `key`, which S3 takes only with `contentType`, `size`, and the page `tag`. */
export async function presign(s3, key, contentType, size, tag) {
  let url;
  try {
    url = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: PUBLIC_BUCKET, Key: key, ContentType: contentType, ContentLength: size, Metadata: { [PAGE]: tag } }),
      {
        expiresIn: EXPIRES,
        signableHeaders: new Set(["content-type", "content-length"]),
        unhoistableHeaders: new Set([`x-amz-meta-${PAGE}`]),
      },
    );
  } catch (e) {
    throw ApiError.internal(e);
  }
  // S3 checks only the headers the signature covers, so the browser sends just those, less
  // `content-length`, which it sets itself.
  const signed = (new URL(url).searchParams.get("X-Amz-SignedHeaders") ?? "").split(";");
  const candidates = { "content-type": contentType, [`x-amz-meta-${PAGE}`]: tag };
  const headers = {};
  for (const name of Object.keys(candidates).sort()) if (signed.includes(name)) headers[name] = candidates[name];
  return { url, headers, public_url: publicUrl(key) };
}

/**
 * `name` made safe for a key and a URL, and ending in an extension of `contentType`, which must be
 * one a save describes.
 */
export function fileName(name, contentType) {
  const extensions = TYPES[contentType];
  if (!extensions) throw ApiError.badRequest(`\`${name}\` isn't a PDF, PNG, JPEG, WebP or GIF`);
  // Anything a URL would escape, or a path would split at, becomes a `-`, one for a run.
  let safe = "";
  for (const ch of name) {
    const c = /^[A-Za-z0-9._]$/.test(ch) ? ch : "-";
    if (!(c === "-" && safe.endsWith("-"))) safe += c;
  }
  const dot = safe.lastIndexOf(".");
  let stem = safe;
  let extension = extensions[0];
  if (dot >= 0 && extensions.includes(safe.slice(dot + 1).toLowerCase())) {
    stem = safe.slice(0, dot);
    extension = safe.slice(dot + 1).toLowerCase();
  }
  stem = stem.replace(/^[-.]+|[-.]+$/g, "").slice(0, MAX_NAME_CHARS - extension.length - 1);
  stem = stem.replace(/[-.]+$/, "");
  return `${stem || "file"}.${extension}`;
}

/** What uploads for the page `id` are tagged with: its SHA-256 in hex, as S3's metadata is ASCII. */
export const pageTag = (id) => sha256(id);

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The keys of `org`'s uploads that `markdown` links to, by their public URLs. */
export function keysIn(markdown, org) {
  const pattern = new RegExp(`${escapeRegex(PUBLIC_ORIGIN)}/(public/${escapeRegex(org)}/files/[0-9a-f]+/[A-Za-z0-9._-]+)`, "g");
  // A name never ends in `.`, but a sentence after a bare URL does.
  return [...new Set([...markdown.matchAll(pattern)].map((m) => m[1].replace(/\.+$/, "")))].sort();
}

async function mapLimited(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  return out;
}

/**
 * Records the uploads for the page `id` that `markdown` links to on its row, once it's indexed.
 * A failure only leaves their files behind when the page goes, so it's logged, not thrown.
 */
export async function record(app, org, id, markdown) {
  const tag = pageTag(id);
  const keys = (await mapLimited(keysIn(markdown, org), CONCURRENCY, async (k) => ((await tagOf(app, k)) === tag ? k : null))).filter(Boolean);
  if (keys.length === 0) return;
  try {
    await add(app, org, id, keys);
  } catch (e) {
    log.warn({ id, error: e.message }, "couldn't record the page's uploads");
  }
}

/** The tag of the page the upload `key` was made for, if it's there. */
async function tagOf(app, key) {
  try {
    const head = await app.s3.send(new HeadObjectCommand({ Bucket: PUBLIC_BUCKET, Key: key }));
    return head.Metadata?.[PAGE] ?? null;
  } catch (e) {
    // A file deleted since answers `403` or `404`, as the role may not list the bucket.
    const status = e?.$metadata?.httpStatusCode;
    if (status !== 403 && status !== 404) log.warn({ key, error: describe(e) }, "couldn't read an upload's page");
    return null;
  }
}

/** Carries the uploads recorded on the page `from`'s row to the row of `to`, where it moved. */
export async function carry(app, org, from, to) {
  try {
    const keys = await of(app, org, from);
    if (keys.length > 0) await add(app, org, to, keys);
  } catch (e) {
    log.warn({ from, to, error: e.message }, "couldn't carry the page's uploads");
  }
}

/** Adds `keys` to the page `id`'s uploads. Only to a page's row. */
async function add(app, org, id, keys) {
  try {
    await app.dynamo.send(
      new UpdateItemCommand({
        TableName: DOCS_TABLE,
        Key: { org_id: S(org), doc_id: S(id) },
        UpdateExpression: "ADD #f :f",
        ConditionExpression: "attribute_exists(chunks)",
        ExpressionAttributeNames: { "#f": FILES },
        ExpressionAttributeValues: { ":f": { SS: keys } },
      }),
    );
  } catch (e) {
    if (!conditionFailed(e)) throw ApiError.internal(e);
  }
}

/** The uploads recorded on the page `id`'s row. */
export async function of(app, org, id) {
  const out = await aws(() =>
    app.dynamo.send(
      new GetItemCommand({
        TableName: DOCS_TABLE,
        Key: { org_id: S(org), doc_id: S(id) },
        ProjectionExpression: "#f",
        ExpressionAttributeNames: { "#f": FILES },
        ConsistentRead: true,
      }),
    ),
  );
  return out.Item?.[FILES]?.SS ?? [];
}

/** Deletes the uploads `keys` of a page that's gone, trying each `DELETE_TRIES` times. */
export async function free(app, keys) {
  await mapLimited(keys, CONCURRENCY, async (key) => {
    for (let attempt = 1; attempt <= DELETE_TRIES; attempt++) {
      try {
        await app.s3.send(new DeleteObjectCommand({ Bucket: PUBLIC_BUCKET, Key: key }));
        return;
      } catch (e) {
        if (attempt === DELETE_TRIES) log.warn({ key, error: describe(e) }, "couldn't delete an upload");
        else await sleep(1000 * 2 ** (attempt - 1));
      }
    }
  });
}
