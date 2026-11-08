// Makes the images and PDFs linked from a markdown document readable by a text-only LLM: each
// media link's text is replaced by a multimodal model's markdown rendering of the file,
// `[{markdown}](url)`, or of a PDF over 10 pages, its table of contents. The result comes in
// pieces small enough to chunk in one request.

import { PluginError, text as engineText } from "context-retriever";

import { pluginError, retrying } from "./errors.js";
import { log } from "./log.js";
import { AI, ContentPart, OpenAIError, Session, completionMessage } from "./open-client.js";

const CTX = "media_descriptor::describe";
/** Links checked, and files described, at once. */
const CONCURRENCY = 8;
/** The longest one description takes, a PDF's download included. It isn't tried again after this. */
const DESCRIBE_TIMEOUT_MS = 120_000;
/** The largest PDF described, by the `Content-Length` its server gives. */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
/** Lines of the document above and below a link sent along with its file. */
const LINES_ABOVE = 5;
const LINES_BELOW = 3;
const DESCRIPT_MODEL = "anthropic/claude-haiku-5.5";
const BASE_URL = "https://openrouter.ai/api/v1";
/**
 * Most chars in one piece of the described document, as the chunker reads a piece in one
 * request: under 500k tokens even in a script that takes a token per char.
 */
export const PIECE_CHARS = 400_000;

/** System prompt for the descriptor's model. Each request only has the file, its URL and the document around its link. */
const SYSTEM_PROMPT = `Each message has a file (an image or a PDF), its URL, and the part of a markdown document around the link to it: the link is the \`[text](url)\` with that URL. The text in its brackets is the document's current description of the file and may be incomplete.

Rewrite the whole content of the file as markdown, so that a reader who can't see the file misses nothing:
- Transcribe all text, keeping headings, lists and tables.
- Represent each chart or graph as a markdown table of its data, with a sentence on what it shows. Use an HTML table only where markdown can't express it, e.g. merged cells.
- Describe pictures and diagrams in words, numbers or tables.
- Describe a person in a picture only by who they are: their name and designation, inferred from the document around the link, e.g. \`Photo of Prof. A. Kumar, Assistant Professor, Mining Engineering\`. Add nothing about how they look or what is behind them, and nothing more about them from the document, like their background, research or contacts, unless the picture itself shows it. If neither says who they are, write only \`Photo of a person\`.
But a PDF of more than 10 pages isn't rewritten whole: write only its title and its table of contents, its headings in order with the page each starts on.
The document around the link is given only to tell you what the file is about and who is in it; don't describe it. Reply with only the markdown of the file: no preamble, no code fence and not the link itself, as your reply goes between the link's brackets.`;

/** The image extensions a URL's path may end in, to look like an image. */
const IMAGE_EXTENSIONS = new Set(
  (
    "apng avif bmp cgm cur dib djv djvu dds emf exr gif hdr heic heif ico ief jfif jng jp2 jpe " +
    "jpeg jpg jpm jpx jxl ktx ktx2 pbm pct pcx pgm pic pjp pjpeg png pnm ppm psd qoi ras rgb " +
    "sgi svg svgz tga tif tiff wbmp webp wmf xbm xpm xwd"
  ).split(" "),
);

/** The extension of a URL path's last segment, lowercased, if it has one. */
function extension(path) {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : null;
}

/** Whether `path` names a file a model describes, a PDF or an image, by its extension. */
export function pathLooksLikeMedia(path) {
  const ext = extension(path);
  return ext === "pdf" || (ext !== null && IMAGE_EXTENSIONS.has(ext));
}

/** A file a multimodal model reads and describes. */
export const Media = Object.freeze({
  Image: "image",
  Pdf: "pdf",

  fromMime(mime) {
    const essence = mime.split(";")[0].trim().toLowerCase();
    if (essence === "application/pdf") return Media.Pdf;
    if (essence.startsWith("image/")) return Media.Image;
    return null;
  },

  /**
   * The kind of the file at `url`, from the `Content-Type` of a HEAD request, if its path looks
   * like media too. A PDF over `MAX_PDF_BYTES` isn't media to describe.
   *
   * @param {(url: string, init?: object) => Promise<Response>} http
   */
  async of(http, url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (!pathLooksLikeMedia(parsed.pathname)) return null;
    let res;
    try {
      res = await http(url, { method: "HEAD" });
    } catch {
      return null;
    }
    if (!res.ok) return null;
    const type = res.headers.get("content-type");
    if (!type) return null;
    const media = Media.fromMime(type);
    if (media === null) return null;
    const length = Number.parseInt(res.headers.get("content-length") ?? "", 10);
    if (media === Media.Pdf && Number.isFinite(length) && length > MAX_PDF_BYTES) return null;
    return media;
  },
});

const isWs = (c) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

function skipWhitespace(md, i) {
  while (i < md.length && isWs(md[i])) i++;
  return i;
}

/** Parses `(url "optional title")` at `start`: the offset after its `)`, and the url. */
function parseDestination(md, start) {
  if (md[start] !== "(") return null;
  let i = skipWhitespace(md, start + 1);
  let url;
  if (md[i] === "<") {
    let close = i + 1;
    while (close < md.length && md[close] !== ">" && md[close] !== "\n") close++;
    if (md[close] !== ">") return null;
    url = md.slice(i + 1, close);
    i = close + 1;
  } else {
    const from = i;
    let depth = 0;
    while (i < md.length) {
      const c = md[i];
      if (c === "\\") i++;
      else if (c === "(") depth++;
      else if (c === ")" && depth === 0) break;
      else if (c === ")") depth--;
      else if (isWs(c)) break;
      i++;
    }
    i = Math.min(i, md.length);
    url = md.slice(from, i);
  }
  const beforeTitle = i;
  i = skipWhitespace(md, i);
  if (i > beforeTitle && (md[i] === '"' || md[i] === "'" || md[i] === "(")) {
    const close = md[i] === "(" ? ")" : md[i];
    const at = md.indexOf(close, i + 1);
    if (at < 0) return null;
    i = skipWhitespace(md, at + 1);
  }
  return md[i] === ")" ? [i + 1, url] : null;
}

/**
 * Inline links of `md`: `[text](url)`, or an image `![text](url)` without its `!`, as
 * `{range: [start, end], text: [start, end], url}`. A link nested in another's text comes before
 * the outer one. Backslash-escaped brackets and parentheses aren't syntax.
 */
export function parseLinks(md) {
  const links = [];
  const opens = [];
  let i = 0;
  while (i < md.length) {
    const c = md[i];
    if (c === "\\") i++;
    else if (c === "[") opens.push(i);
    else if (c === "]") {
      const open = opens.pop();
      if (open !== undefined) {
        const destination = parseDestination(md, i + 1);
        if (destination) {
          const [end, url] = destination;
          links.push({ range: [open, end], text: [open + 1, i], url });
          i = end;
          continue;
        }
      }
    }
    i++;
  }
  return links;
}

/** `text`'s lines: no final empty one, no `\r`. */
function splitLines(text) {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

const newlines = (text) => (text.match(/\n/g) ?? []).length;

/** `LINES_ABOVE` lines above the link, its own lines, and `LINES_BELOW` lines below it. */
export function context(md, link) {
  const first = newlines(md.slice(0, link.range[0]));
  const last = first + newlines(md.slice(link.range[0], link.range[1]));
  const from = Math.max(first - LINES_ABOVE, 0);
  return splitLines(md)
    .slice(from, last + LINES_BELOW + 1)
    .join("\n");
}

/**
 * `text` with `\`, `[` and `]` escaped, so put between a link's brackets, it stays the link's
 * text: `parseLinks` reads past escaped brackets, as markdown does.
 */
export function escape(text) {
  return text.replace(/[\\[\]]/g, (c) => `\\${c}`);
}

/**
 * Markdown rendering of the file at `link`, escaped to stay the link's text, or `null` if the
 * server rejects it with 400, 413 or 415. Transient and rate-limited failures are retried.
 */
export async function describe(ai, md, link, media) {
  const prompt = `The URL: ${link.url}\n\nThe document around the link:\n${context(md, link)}`;
  return retrying(async () => {
    const signal = AbortSignal.timeout(DESCRIBE_TIMEOUT_MS);
    let markdown;
    try {
      markdown = await ask(ai, prompt, link.url, media, signal);
    } catch (e) {
      if (signal.aborted) throw PluginError.permanent(CTX, "deadline has elapsed");
      if (e instanceof OpenAIError && e.kind === "api" && [400, 413, 415].includes(e.status)) return null;
      throw pluginError(CTX, e);
    }
    markdown = markdown.trim();
    return markdown.length > 0 ? escape(markdown) : null;
  });
}

/**
 * Claude reads PDFs only as a file: OpenRouter rejects a PDF as an image URL. It is downloaded,
 * as OpenAI reads a file only in base64.
 */
async function ask(ai, prompt, url, media, signal) {
  const file = media === Media.Pdf ? await ContentPart.downloadFile(url, signal) : ContentPart.imageUrl(url);
  const session = new Session();
  session.ask([ContentPart.text(prompt), file]);
  const completion = await ai.ask(session, { signal });
  return completionMessage(completion).content ?? "";
}

/** `md` with each `[range, replacement]` spliced in. Ranges must be sorted and disjoint. */
export function splice(md, replacements) {
  let out = "";
  let at = 0;
  for (const [[start, end], replacement] of replacements) {
    out += md.slice(at, start) + replacement;
    at = end;
  }
  return out + md.slice(at);
}

/**
 * `md` cut at line breaks into pieces of at most `maxChars` chars, at the last blank line in the
 * second half of a piece if there is one, so a table or a list is cut only if it fills more than
 * half a piece. A line longer than `maxChars` is a piece of its own, and pieces with no text are
 * dropped.
 */
export function pieces(md, maxChars) {
  const out = [];
  // Offset of the current piece, and its length in chars.
  let start = 0;
  let chars = 0;
  // The end of the last blank line in the second half of the current piece, and the piece's
  // chars up to it.
  let blank = null;
  let at = 0;
  for (const line of md.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const len = engineText.charCount(line);
    while (chars > 0 && chars + len > maxChars) {
      const [cut, before] = blank ?? [at, chars];
      blank = null;
      out.push(md.slice(start, cut));
      start = cut;
      chars -= before;
    }
    at += line.length;
    chars += len;
    if (line.trim().length === 0 && chars >= Math.floor(maxChars / 2)) blank = [at, chars];
  }
  out.push(md.slice(start));
  return out.filter((piece) => piece.trim().length > 0);
}

/** What a link of a document needs, given the version stored before it. */
export const Step = Object.freeze({
  /** Kept as it is, unchecked. */
  Keep: { kind: "keep" },
  /** Described if it's media, else kept. */
  Describe: { kind: "describe" },
  /** Given this text, the stored description of its file, if it's media; else kept. */
  restore: (text) => ({ kind: "restore", text }),
});

/**
 * Whether a link's text asks for its file to be described: it ends in a space, which a
 * description, trimmed, never does.
 */
const markedToDescribe = (text) => text.endsWith(" ");

/** What each of `links`, the links of `markdown`, needs, given `previous`. */
export function steps(markdown, links, previous, forceOverride) {
  const stored = parseLinks(previous);
  return links.map((link) => {
    const text = markdown.slice(link.text[0], link.text[1]);
    const texts = stored.filter((old) => old.url === link.url).map((old) => previous.slice(old.text[0], old.text[1]));
    if (texts.length === 0 || (texts.includes(text) && markedToDescribe(text))) return Step.Describe;
    if (texts.includes(text)) return Step.Keep;
    if (forceOverride) return text.trim().length === 0 || markedToDescribe(text) ? Step.Describe : Step.Keep;
    const description = texts.find((old) => old.trim().length > 0 && !markedToDescribe(old));
    return description === undefined ? Step.Describe : Step.restore(description);
  });
}

async function mapOrdered(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export class MediaDescriptor {
  constructor(apiKey, baseUrl = BASE_URL) {
    this.ai = new AI(apiKey, DESCRIPT_MODEL, SYSTEM_PROMPT).setBaseUrl(baseUrl);
  }

  /**
   * Replaces the text of every link to an image or a PDF in `markdown` with the model's markdown
   * rendering of the file, `[{markdown}](url)`, each in its own request, `CONCURRENCY` at once.
   * `http` checks which links are media.
   *
   * A file the server rejects with 400, 413 or 415 keeps its original link text. A file still
   * not described keeps its text with a space after it, which the next save reads as a file to
   * describe.
   *
   * `previous` is the version of the document stored before, or empty for a new one. A link
   * whose file it links to too costs no model call: with the same text, it is kept; with other
   * text, it gets the stored description back; but with `forceOverride`, for a hand edit, other
   * text is kept as typed, and emptied, or ending in a space, the file is described again.
   *
   * The result is cut into pieces of at most `PIECE_CHARS` chars.
   */
  async describeMedia(http, markdown, previous, forceOverride) {
    const links = parseLinks(markdown);
    const linkSteps = steps(markdown, links, previous, forceOverride);
    const kinds = await mapOrdered(links, CONCURRENCY, (link, i) =>
      linkSteps[i].kind === "keep" ? null : Media.of(http, link.url),
    );
    // An inner link comes first, so an outer one around it is dropped: their texts overlap.
    const kept = [];
    links.forEach((link, i) => {
      const kind = kinds[i];
      if (
        kind !== null &&
        kept.every(([other]) => other.range[1] <= link.range[0] || link.range[1] <= other.range[0])
      ) {
        kept.push([link, kind, linkSteps[i]]);
      }
    });
    kept.sort((a, b) => a[0].range[0] - b[0].range[0]);
    const descriptions = await mapOrdered(kept, CONCURRENCY, async ([link, kind, step]) => {
      try {
        return { ok: true, value: step.kind === "restore" ? step.text : await describe(this.ai, markdown, link, kind) };
      } catch (error) {
        return { ok: false, error };
      }
    });
    const replacements = kept.map(([link], i) => {
      const text = markdown.slice(link.text[0], link.text[1]);
      const description = descriptions[i];
      let replacement;
      if (description.ok && description.value !== null) {
        replacement = description.value;
      } else if (description.ok) {
        // It can't be described, so it isn't tried again.
        replacement = text.replace(/ +$/, "");
      } else {
        log.warn(
          { url: link.url, error: description.error.message },
          "not described; it's tried again on the next save",
        );
        replacement = markedToDescribe(text) ? text : `${text} `;
      }
      return [link.text, replacement];
    });
    return pieces(splice(markdown, replacements), PIECE_CHARS);
  }
}
