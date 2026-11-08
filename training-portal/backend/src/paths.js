// An org's ids: a file's id is the path down to it, like `UG|BTECH|CSE`; a folder is any path with
// files under it, or one kept while empty. What an admin may change is their folders.

import { ApiError } from "./http.js";

/** Separates the names in an id. */
export const SEP = "|";
/** Marks a part: `Fees~1` is the second part of a file too long to index as one. */
export const PART = "~";
/** Most bytes in an id. The engine appends a chunk suffix to it, and a DynamoDB key holds 1 KB. */
const MAX_ID_BYTES = 512;
/** Most bytes in a new id. The engine indexes ids of up to 256 bytes, and a part's id adds `~n`. */
export const MAX_NEW_ID_BYTES = 248;
/** What the engine's ids can't contain: `#` separates a chunk's number from its document's id. */
const CHUNK_SEP = "#";
/** The prefix the engine keeps for its own ids. */
const RESERVED_PREFIX = "__ctxret";
/** The org's root folder, above every other. */
export const ROOT = "";

export const bytes = (text) => Buffer.byteLength(text, "utf8");

/** The names in `id`, the id of an existing file or folder. */
export function names(id) {
  if (bytes(id) > MAX_ID_BYTES) throw ApiError.badRequest(`an id is at most ${MAX_ID_BYTES} bytes`);
  const parts = id.split(SEP);
  if (parts.some((name) => name.length === 0 || name.trim() !== name)) {
    throw ApiError.badRequest("a name is empty or has spaces around it");
  }
  return parts;
}

/**
 * The names in `id`, an id the user is choosing: also without `~`, which marks a part, and one
 * the engine can index.
 */
export function newNames(id) {
  if (id.includes(PART)) throw ApiError.badRequest("a name can't contain `~`");
  if (id.includes(CHUNK_SEP)) throw ApiError.badRequest("a name can't contain `#`");
  if (id.startsWith(RESERVED_PREFIX)) throw ApiError.badRequest(`an id can't start with \`${RESERVED_PREFIX}\``);
  if (bytes(id) > MAX_NEW_ID_BYTES) throw ApiError.badRequest(`an id is at most ${MAX_NEW_ID_BYTES} bytes`);
  return names(id);
}

/**
 * Whether `folders` cover the path `id`: one of them is `id`, or above it, compared name by name.
 * `""` is above everything. With `strictly`, only above it.
 */
export function covers(folders, id, strictly) {
  const parts = id.split(SEP);
  return folders.some((folder) => {
    const above = folder.length === 0 ? [] : folder.split(SEP);
    const starts = above.every((name, i) => parts[i] === name) && parts.length >= above.length;
    return starts && (!strictly || parts.length > above.length);
  });
}

/** The folder `id` is in, if any. */
export function parent(id) {
  const at = id.lastIndexOf(SEP);
  return at < 0 ? null : id.slice(0, at);
}
