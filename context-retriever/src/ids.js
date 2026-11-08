// Identity: document, group and chunk ids, and the fingerprints that decide what has to be
// re-embedded.
//
// The id scheme is positional, not content-addressed:
// - Upsert overwrites in place, so a changed part needs no delete.
// - `siblings` is pure arithmetic over `groupLen`, so sibling expansion needs only point lookup.
// - Stale slots after a re-index lie in a derivable, bounded id region.
//
// A document id is the caller's identity string: non-empty, at most 256 bytes, and without `'#'`,
// the chunk-id separator. Chunk ids are `"{doc}#g{group}.p{part}"`, group ids `"{doc}#g{group}"`.

import { normalizeWs } from "./text.js";

const encoder = new TextEncoder();

/** `"{doc}#g{g}.p{p}"`. */
export function chunkId(doc, g, p) {
  return `${doc}#g${g}.p${p}`;
}

/** `"{doc}#g{g}"`. All parts of a group share it. */
export function groupId(doc, g) {
  return `${doc}#g${g}`;
}

/** Every id in a chunk's group in reading order, derived arithmetically. */
export function siblings(doc, groupOrd, groupLen) {
  const ids = [];
  for (let p = 0; p < groupLen; p++) ids.push(chunkId(doc, groupOrd, p));
  return ids;
}

/** The `doc` prefix of a chunk or group id: everything before the last `'#'`. */
export function documentOf(id) {
  const at = id.lastIndexOf("#");
  return at < 0 ? id : id.slice(0, at);
}

const DIGITS = /^[0-9]+$/;
const U32_MAX = 4294967295;

/** `[groupOrd, partOrd]` of a chunk id, or `null` if it is malformed. */
export function position(id) {
  const at = id.lastIndexOf("#");
  if (at <= 0) return null;
  const rest = id.slice(at + 1);
  const dot = rest.indexOf(".");
  if (dot < 0) return null;
  const g = rest.slice(0, dot);
  const p = rest.slice(dot + 1);
  if (!g.startsWith("g") || !p.startsWith("p")) return null;
  const gs = g.slice(1);
  const ps = p.slice(1);
  if (!DIGITS.test(gs) || !DIGITS.test(ps)) return null;
  const gn = Number(gs);
  const pn = Number(ps);
  if (gn > U32_MAX || pn > U32_MAX) return null;
  return [gn, pn];
}

/** Compares two strings by code point, as Rust compares `String`s. */
export function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

const PRIME_LO = 0x1b3;

/**
 * FNV-1a 64, length-framed per field, as a `BigInt`.
 *
 * Framing is load-bearing: without it `["ab", ""]` and `["a", "b"]` hash identically. These values
 * are persisted in the vector store, so changing this function forces a full re-index. It computes
 * exactly what the Rust engine computed, so an index it wrote stays valid.
 *
 * @param {Array<Uint8Array|string>} fields bytes, or strings hashed as UTF-8
 */
export function fnv1a64(fields) {
  // The 64-bit hash as two 32-bit halves. Multiplying by the prime, 2^40 + 0x1b3, is
  // `hash * 0x1b3 + (hash << 40)`.
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  const step = (byte) => {
    lo = (lo ^ byte) >>> 0;
    const low = lo * PRIME_LO;
    const carry = Math.floor(low / 0x100000000);
    const shifted = (lo * 256) % 0x100000000;
    hi = (hi * PRIME_LO + carry + shifted) % 0x100000000;
    lo = low % 0x100000000;
  };
  for (const field of fields) {
    const bytes = typeof field === "string" ? encoder.encode(field) : field;
    // Frame: the field's byte length, little-endian, before its bytes.
    let len = bytes.length;
    for (let b = 0; b < 8; b++) {
      step(len % 256);
      len = Math.floor(len / 256);
    }
    for (let i = 0; i < bytes.length; i++) step(bytes[i]);
  }
  return (BigInt(hi) << 32n) | BigInt(lo);
}

/** `n` as 4 little-endian bytes. */
function u32le(n) {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}

/**
 * Fingerprint of everything that makes a stored slot reusable without re-embedding: context,
 * text, topic, placement, `groupLen`, cohesion, embedder fingerprint, metadata.
 *
 * `groupLen` and `cohesion` are included on purpose: excluding them leaves textually unchanged
 * parts carrying a stale `groupLen` after a re-chunk. `metadata` is included, so changing a
 * document's metadata re-embeds it; keep volatile values out of it.
 *
 * @param {Record<string,string>} metadata hashed in key order
 */
export function stateFp(context, text, topic, placement, groupLen, cohesion, embedderFp, metadata) {
  const hasTopic = topic !== null && topic !== undefined;
  const fields = [
    context,
    text,
    hasTopic ? "1" : "0",
    hasTopic ? topic : "",
    placement,
    u32le(groupLen),
    cohesion,
    embedderFp,
  ];
  for (const key of Object.keys(metadata).sort(cmpStr)) {
    fields.push(key, metadata[key]);
  }
  return fnv1a64(fields);
}

/**
 * Fingerprint of the whitespace-normalized body alone: no context, no topic. Used only for
 * cross-document duplicate suppression.
 */
export function contentFp(text) {
  return fnv1a64([normalizeWs(text)]);
}
