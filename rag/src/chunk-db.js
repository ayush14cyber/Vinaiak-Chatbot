// Vector store backed by AWS S3 Vectors (vectors) + AWS DynamoDB (a side index for
// `listDocumentChunkIds`, as S3 Vectors has no list-by-metadata operation).
//
// Side index: partition key `org_id` (the namespace), sort key `doc_id`, the path to the topic
// joined by `|`, like `UG|B.TECH|CSE|Admission`, so a directory is listed with
// `begins_with(doc_id, "UG|B.TECH|")`. Schema: `{org_id, doc_id, chunks: SS}`. A row is deleted once
// it lists no chunk, so `begins_with` only lists live documents.
//
// The namespace is both the DynamoDB partition key and the S3 Vectors index name.

import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  ConflictException,
  CreateIndexCommand,
  DeleteVectorsCommand,
  GetVectorsCommand,
  PutVectorsCommand,
  QueryVectorsCommand,
} from "@aws-sdk/client-s3vectors";
import { PluginError, ids } from "context-retriever";

const S = (value) => ({ S: value });

function perm(ctx, e) {
  return PluginError.permanent(ctx, e?.message ?? String(e));
}

function ns(namespace) {
  if (namespace === null || namespace === undefined) {
    throw PluginError.permanent(
      "chunk_db::namespace",
      "namespace is required (maps to DynamoDB org_id and S3 Vectors index_name)",
    );
  }
  return namespace;
}

// ---- the wire format of a chunk in S3 Vectors metadata ----
//
// `data` holds the whole chunk as JSON:
// `{"meta": {doc, group, group_ord, part_ord, group_len, cohesion, state_fp,
// content_fp, chars, metadata}, "text", "context", "topic", "placement"}`. The fingerprints are
// unsigned 64-bit JSON numbers, kept exact as `BigInt`s.

/** `chunk` as the `data` string stored with its vector. */
export function encodeChunk(chunk) {
  const { meta, payload } = chunk;
  const metadata = {};
  for (const key of Object.keys(meta.metadata).sort(ids.cmpStr)) metadata[key] = meta.metadata[key];
  const wire = {
    meta: {
      doc: meta.doc,
      group: meta.group,
      group_ord: meta.groupOrd,
      part_ord: meta.partOrd,
      group_len: meta.groupLen,
      cohesion: meta.cohesion,
      state_fp: "\u0000state_fp\u0000",
      content_fp: "\u0000content_fp\u0000",
      chars: meta.chars,
      metadata,
    },
    text: payload.text,
    context: payload.context,
    topic: payload.topic ?? null,
    placement: payload.placement,
  };
  // A NUL is escaped in any JSON string, so the placeholders can't appear in the text.
  return JSON.stringify(wire)
    .replace(JSON.stringify("\u0000state_fp\u0000"), meta.stateFp.toString())
    .replace(JSON.stringify("\u0000content_fp\u0000"), meta.contentFp.toString());
}

/** The chunk `id` from its stored `data` string. */
export function decodeChunk(id, data) {
  const wire = JSON.parse(data, (key, value, context) =>
    (key === "state_fp" || key === "content_fp") && typeof value === "number" ? BigInt(context.source) : value,
  );
  const m = wire?.meta;
  if (!m || typeof wire.text !== "string" || typeof wire.context !== "string") {
    throw new Error("missing field in the stored chunk");
  }
  return {
    id,
    meta: {
      doc: m.doc,
      group: m.group,
      groupOrd: m.group_ord,
      partOrd: m.part_ord,
      groupLen: m.group_len,
      cohesion: m.cohesion,
      stateFp: BigInt(m.state_fp),
      contentFp: BigInt(m.content_fp),
      chars: m.chars,
      metadata: m.metadata ?? {},
    },
    payload: { text: wire.text, context: wire.context, topic: wire.topic ?? null, placement: wire.placement },
  };
}

function parseMetadata(id, metadata) {
  if (!metadata || typeof metadata !== "object") {
    throw PluginError.permanent("chunk_db::parse_metadata", "missing or non-object metadata");
  }
  if (typeof metadata.data !== "string") {
    throw PluginError.permanent("chunk_db::parse_metadata", "metadata.data field is missing or not a string");
  }
  try {
    return decodeChunk(id, metadata.data);
  } catch (e) {
    throw perm("chunk_db::parse_metadata", e);
  }
}

/** Groups `items` by `key`, in first-seen order. */
function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const k = key(item);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(item);
  }
  return groups;
}

export class ChunkDb {
  /**
   * @param {import("@aws-sdk/client-dynamodb").DynamoDBClient} dynamo
   * @param {import("@aws-sdk/client-s3vectors").S3VectorsClient} s3v
   * @param {string} table DynamoDB table holding `{org_id, doc_id, chunks}` rows
   * @param {string} bucket S3 Vectors bucket; each namespace is one index inside it
   */
  constructor(dynamo, s3v, table, bucket) {
    this.dynamo = dynamo;
    this.s3v = s3v;
    this.table = table;
    this.bucket = bucket;
  }

  /**
   * Removes `chunkIds` from `doc`'s side-index row, then the row itself once it lists no chunk,
   * so a `begins_with` listing of a directory never shows a removed document.
   */
  async removeFromSideindex(namespace, doc, chunkIds) {
    let out;
    try {
      out = await this.dynamo.send(
        new UpdateItemCommand({
          TableName: this.table,
          Key: { org_id: S(namespace), doc_id: S(doc) },
          UpdateExpression: "DELETE chunks :c",
          ExpressionAttributeValues: { ":c": { SS: chunkIds } },
          ReturnValues: "UPDATED_NEW",
        }),
      );
    } catch (e) {
      throw perm("chunk_db::sideindex_delete", e);
    }
    // Removing a set's last element removes the attribute, not the row.
    if (out.Attributes?.chunks) return;
    // Conditional, so a row a concurrent upsert has just added chunks to stays.
    try {
      await this.dynamo.send(
        new DeleteItemCommand({
          TableName: this.table,
          Key: { org_id: S(namespace), doc_id: S(doc) },
          ConditionExpression: "attribute_not_exists(chunks)",
        }),
      );
    } catch (e) {
      if (!(e instanceof ConditionalCheckFailedException)) throw perm("chunk_db::sideindex_delete_row", e);
    }
  }

  async upsert(records, namespace) {
    const index = ns(namespace);
    if (records.length === 0) return;

    // Built first, so a chunk it can't take fails the upsert before anything is written.
    const puts = records.map((r) => ({
      key: r.chunk.id,
      data: { float32: Array.from(r.embedding) },
      metadata: { doc: r.chunk.meta.doc, data: encodeChunk(r.chunk) },
    }));
    // The side index is written before the vectors, as `delete` removes them the other way round,
    // so it lists every vector there is. A failure in between leaves it listing a chunk with no
    // vector, which the next save or delete clears; never a vector nothing lists.
    const byDoc = groupBy(records, (r) => r.chunk.meta.doc);
    await Promise.all(
      [...byDoc].map(async ([doc, recs]) => {
        try {
          await this.dynamo.send(
            new UpdateItemCommand({
              TableName: this.table,
              Key: { org_id: S(index), doc_id: S(doc) },
              UpdateExpression: "ADD chunks :c",
              ExpressionAttributeValues: { ":c": { SS: recs.map((r) => r.chunk.id) } },
            }),
          );
        } catch (e) {
          throw perm("chunk_db::sideindex_add", e);
        }
      }),
    );
    try {
      await this.s3v.send(new PutVectorsCommand({ vectorBucketName: this.bucket, indexName: index, vectors: puts }));
    } catch (e) {
      throw perm("chunk_db::put_vectors", e);
    }
  }

  async query(request) {
    const index = ns(request.namespace);
    // S3 Vectors returns at most 100 results per page, so a deeper topK is read page by page.
    const hits = [];
    let nextToken;
    while (true) {
      let out;
      try {
        out = await this.s3v.send(
          new QueryVectorsCommand({
            vectorBucketName: this.bucket,
            indexName: index,
            queryVector: { float32: Array.from(request.vector) },
            topK: request.topK,
            filter: request.filter ?? undefined,
            returnMetadata: true,
            returnDistance: true,
            nextToken,
          }),
        );
      } catch (e) {
        throw perm("chunk_db::query_vectors", e);
      }
      const vectors = out.vectors ?? [];
      for (const v of vectors) {
        const stored = parseMetadata(v.key, v.metadata);
        // S3 Vectors returns a cosine distance; the engine wants higher-is-better similarity.
        hits.push({ id: v.key, meta: stored.meta, similarity: 1 - (v.distance ?? 0), payload: stored.payload });
      }
      nextToken = out.nextToken;
      if (!nextToken || vectors.length === 0 || hits.length >= request.topK) break;
    }
    // The engine rejects more than topK hits.
    return hits.slice(0, request.topK);
  }

  async get(chunkIds, namespace) {
    const index = ns(namespace);
    if (chunkIds.length === 0) return [];
    let out;
    try {
      out = await this.s3v.send(
        new GetVectorsCommand({
          vectorBucketName: this.bucket,
          indexName: index,
          keys: [...chunkIds],
          returnData: false,
          returnMetadata: true,
        }),
      );
    } catch (e) {
      throw perm("chunk_db::get_vectors", e);
    }
    return (out.vectors ?? []).map((v) => parseMetadata(v.key, v.metadata));
  }

  async delete(chunkIds, namespace) {
    const index = ns(namespace);
    if (chunkIds.length === 0) return;
    try {
      await this.s3v.send(new DeleteVectorsCommand({ vectorBucketName: this.bucket, indexName: index, keys: [...chunkIds] }));
    } catch (e) {
      throw perm("chunk_db::delete_vectors", e);
    }
    // Shrink the side-index sets per doc. A chunk id carries its doc prefix.
    const byDoc = groupBy(chunkIds, (id) => ids.documentOf(id));
    await Promise.all([...byDoc].map(([doc, docIds]) => this.removeFromSideindex(index, doc, docIds)));
  }

  async listDocumentChunkIds(doc, namespace) {
    const index = ns(namespace);
    let out;
    try {
      out = await this.dynamo.send(
        new GetItemCommand({
          TableName: this.table,
          Key: { org_id: S(index), doc_id: S(doc) },
          ConsistentRead: true,
        }),
      );
    } catch (e) {
      throw perm("chunk_db::sideindex_get", e);
    }
    return out.Item?.chunks?.SS ?? [];
  }

  storeCapabilities() {
    // S3 Vectors caps topK at 10,000 per query (paged by `query`).
    return { maxTopK: 10_000 };
  }

  upsertBatchSize() {
    // S3 Vectors PutVectors cap.
    return 500;
  }

  getBatchSize() {
    // S3 Vectors GetVectors cap. DeleteVectors takes 500, but the engine batches deletes by this.
    return 100;
  }
}

/**
 * Creates `namespace`'s S3 Vectors index in `bucket`, laid out for `ChunkDb`: `dimensions` wide,
 * cosine, with `data` stored but not filterable (S3 Vectors caps filterable metadata at 2 KB per
 * vector). An index that already exists counts as created.
 */
export async function createIndex(s3v, bucket, namespace, dimensions) {
  try {
    await s3v.send(
      new CreateIndexCommand({
        vectorBucketName: bucket,
        indexName: namespace,
        dataType: "float32",
        dimension: dimensions,
        distanceMetric: "cosine",
        metadataConfiguration: { nonFilterableMetadataKeys: ["data"] },
      }),
    );
  } catch (e) {
    if (!(e instanceof ConflictException)) throw perm("chunk_db::create_index", e);
  }
}

/**
 * Removes `doc`'s side-index row if it lists no chunk, as `removeFromSideindex` leaves one when
 * its second write fails. Returns whether there was one.
 */
export async function removeChunklessRow(dynamo, table, namespace, doc) {
  try {
    await dynamo.send(
      new DeleteItemCommand({
        TableName: table,
        Key: { org_id: S(namespace), doc_id: S(doc) },
        ConditionExpression: "attribute_exists(doc_id) AND attribute_not_exists(chunks)",
      }),
    );
    return true;
  } catch (e) {
    if (e instanceof ConditionalCheckFailedException) return false;
    throw perm("chunk_db::remove_chunkless_row", e);
  }
}

/**
 * `namespace`'s doc ids starting with `prefix`, in order: every document when `prefix` is empty,
 * a directory when it ends with `|`.
 */
export async function listDocIds(dynamo, table, namespace, prefix) {
  const out = [];
  let start;
  do {
    let page;
    try {
      page = await dynamo.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: prefix ? "org_id = :o AND begins_with(doc_id, :p)" : "org_id = :o",
          ExpressionAttributeValues: prefix ? { ":o": S(namespace), ":p": S(prefix) } : { ":o": S(namespace) },
          ProjectionExpression: "doc_id",
          ExclusiveStartKey: start,
        }),
      );
    } catch (e) {
      throw perm("chunk_db::list_doc_ids", e);
    }
    for (const item of page.Items ?? []) if (item.doc_id?.S !== undefined) out.push(item.doc_id.S);
    start = page.LastEvaluatedKey;
  } while (start);
  return out;
}
