// Pure text helpers: whitespace normalization, the UTF-8-safe size splitter, and the single place
// context is woven into embedded text.

/**
 * Where context sits relative to the body when embedding. Affects embeddings only; retrieval
 * results always carry `context` and `text` as separate fields. The values are also the stable
 * tags mixed into fingerprints: changing one forces a re-index.
 */
export const ContextPlacement = Object.freeze({
  /** `"{context}\n\n{text}"`: Anthropic contextual retrieval. Default. */
  Prepend: "prepend",
  /** `"{text}\n\n{context}"`. */
  Append: "append",
  /** `"{context}\n\n{text}\n\n{context}"`: helps long parts whose tail drifts. */
  Both: "both",
  /** Body only; use when the chunker already rewrote context into the body. */
  None: "none",
});

/** The number of Unicode scalar values (characters) in `text`. */
export function charCount(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // A low surrogate belongs to the char its high surrogate started.
    if (c < 0xdc00 || c > 0xdfff) n++;
  }
  return n;
}

/** Bytes of `text` in UTF-8. */
export function byteLength(text) {
  return Buffer.byteLength(text, "utf8");
}

/** `text` split at whitespace runs, without empty pieces. */
export function splitWhitespace(text) {
  return text.split(/\s+/u).filter((word) => word.length > 0);
}

/** Collapse whitespace runs to single spaces and trim. */
export function normalizeWs(text) {
  return splitWhitespace(text).join(" ");
}

/**
 * The lines of `text`, each keeping its `'\n'` (the last may have none), so they concatenate back
 * to `text` exactly.
 */
export function linesInclusive(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

const isSentenceEnd = (c) => c === "." || c === "!" || c === "?" || c === "।";

/**
 * Largest `i` in `floor+1..=hardEnd` such that `pred(chars[i-1], chars[i-2])`, i.e. the break
 * lands *after* the matching char.
 */
function scanBack(chars, floor, hardEnd, pred) {
  for (let i = hardEnd; i > floor; i--) {
    const cur = chars[i - 1];
    if (cur === undefined) return null;
    const prev = i >= 2 ? chars[i - 2] : undefined;
    if (pred(cur, prev)) return i;
  }
  return null;
}

/** The largest break index in `(floor, hardEnd]` by separator preference, or `hardEnd`. */
function findBreak(chars, start, hardEnd) {
  // Never emit a piece under half the window just because a separator sits early.
  const floor = start + Math.floor((hardEnd - start) / 2);
  // 1. Blank line: break after the second newline of a `\n\s*\n` run.
  const blank = scanBack(
    chars,
    floor,
    hardEnd,
    (c, prev) => c === "\n" && (prev === "\n" || prev === "\r"),
  );
  if (blank !== null) return blank;
  // 2. Any single newline.
  const newline = scanBack(chars, floor, hardEnd, (c) => c === "\n");
  if (newline !== null) return newline;
  // 3. Sentence end, optionally followed by the space we break after.
  const sentence = scanBack(
    chars,
    floor,
    hardEnd,
    (c, prev) => (c === " " && prev !== undefined && isSentenceEnd(prev)) || isSentenceEnd(c),
  );
  if (sentence !== null) return sentence;
  // 4. Any char boundary.
  return hardEnd;
}

/**
 * Size-driven split preferring, in order: blank line, single newline, sentence end
 * (`. ! ? ।`), then any char boundary.
 *
 * Every piece is at most `maxChars` chars; splits only on char boundaries; makes at least one
 * char of progress per iteration; `overlapChars` is clamped to `maxChars / 2`, and a `maxChars`
 * of 0 is treated as 1. Nothing is trimmed, so with `overlapChars == 0` the pieces concatenate
 * back to the input exactly.
 */
export function sizeSplit(text, maxChars, overlapChars) {
  const max = Math.max(maxChars, 1);
  const overlap = Math.min(overlapChars, Math.floor(max / 2));
  const chars = Array.from(text);
  if (chars.length === 0) return [];
  if (chars.length <= max) return [text];

  const out = [];
  let start = 0;
  while (start < chars.length) {
    const hardEnd = Math.min(start + max, chars.length);
    const end = hardEnd >= chars.length ? chars.length : findBreak(chars, start, hardEnd);
    out.push(chars.slice(start, end).join(""));
    if (end >= chars.length) break;
    // Step back by the overlap, but never below one char of progress.
    start = Math.max(Math.max(end - overlap, 0), start + 1);
  }
  return out;
}

/**
 * `breadcrumb.join(" -> ")` + group context + optional topic, breadcrumb omitted when empty,
 * joined by newlines. The order is part of `stateFp`, so changing it forces a re-index.
 */
export function renderContext(breadcrumb, groupContext, topic) {
  const segments = [];
  if (breadcrumb.length > 0) {
    const trail = breadcrumb
      .map((s) => normalizeWs(s))
      .filter((s) => s.length > 0)
      .join(" -> ");
    if (trail.length > 0) segments.push(trail);
  }
  const body = groupContext.trim();
  if (body.length > 0) segments.push(body);
  if (topic !== null && topic !== undefined) {
    const t = topic.trim();
    if (t.length > 0) segments.push(t);
  }
  return segments.join("\n");
}

/** The only place context is woven into embedded/reranked text. */
export function embedText(context, text, placement) {
  if (context.length === 0) return text;
  switch (placement) {
    case ContextPlacement.Prepend:
      return `${context}\n\n${text}`;
    case ContextPlacement.Append:
      return `${text}\n\n${context}`;
    case ContextPlacement.Both:
      return `${context}\n\n${text}\n\n${context}`;
    default:
      return text;
  }
}
