// What a watched page says, compared so that what moves on its own isn't a change.
//
// A page is reduced to lines of text, and each line's dates, times, "x ago"s, countdowns and
// counters are set apart as marks, leaving its shape. Two snapshots show the same page when their
// shapes are equal and each mark that differs is noise: one that always moves, like "5 minutes
// ago", a countdown or a visitor count, or a date or time that is now, like a clock or "Today: 26
// Oct". A date that moved anywhere else, like a deadline, is a change, as is any other text.
//
// A rendered page is reduced to its main content as Firecrawl's `onlyMainContent` keeps it, which
// is what gets saved, and to its text and addresses: markup, tokens, nonces, class names,
// cache-busting and tracking parameters don't count either.

import { createHash } from "node:crypto";

import * as cheerio from "cheerio";

/** What Firecrawl's `onlyMainContent` drops unless it holds `#main`: its `excludeNonMainTags`. */
const NON_MAIN = [
  "header", "footer", "nav", "aside", ".header", ".top", ".navbar", "#header", ".footer", ".bottom",
  "#footer", ".sidebar", ".side", ".aside", "#sidebar", ".modal", ".popup", "#modal", ".overlay",
  ".ad", ".ads", ".advert", "#ad", ".lang-selector", ".language", "#language-selector", ".social",
  ".social-media", ".social-links", "#social", ".menu", ".navigation", "#nav", ".breadcrumbs",
  "#breadcrumbs", ".share", "#share", ".widget", "#widget", ".cookie", "#cookie",
];

/** Elements with nothing to read. */
const UNREAD = new Set([
  "script", "style", "noscript", "template", "iframe", "svg", "canvas", "object", "embed", "head",
  "meta", "link", "input",
]);

/** Elements that start and end a line. */
const BLOCKS = new Set([
  "address", "article", "aside", "blockquote", "br", "caption", "dd", "details", "dialog", "div",
  "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5",
  "h6", "header", "hr", "li", "main", "nav", "ol", "option", "p", "pre", "section", "summary",
  "table", "tr", "ul",
]);

/** How far a time may be from now and still be now. */
const TIME_SLACK_MINUTES = 15;
/** The offset of the zone, besides UTC, that a clock may show now in: India's. */
const LOCAL_OFFSET_MINUTES = 330;
/** Most bytes of marks kept; a page with more is compared exactly. */
const MAX_MARK_BYTES = 100_000;
/** Most lines whose hashes are kept, to say which changed. */
const MAX_LINE_HASHES = 3000;
/** Hex digits of a line's hash. */
const LINE_HASH_HEX = 12;
/** How much of a line a reason quotes. */
export const QUOTED_CHARS = 160;

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const lineHash = (line) => sha256(line).slice(0, LINE_HASH_HEX);
const collapse = (text) => text.split(/\s+/u).filter(Boolean).join(" ");

/** `text`, cut to `QUOTED_CHARS`. */
function quote(text) {
  const chars = Array.from(text);
  return chars.length > QUOTED_CHARS ? `${chars.slice(0, QUOTED_CHARS).join("")}…` : text;
}

/**
 * A page as compared: `shape`, the SHA-256 of its lines with each mark replaced by its kind;
 * `marks`, each its kind's letter then its text; `lines`, a short hash of each line's shape;
 * `text`, its lines, to quote when saying why it changed (not stored).
 */
export class Snapshot {
  constructor(shape, marks, lines, text = []) {
    this.shape = shape;
    this.marks = marks;
    this.lines = lines;
    this.text = text;
  }

  /** The main content of the page at `base`, as `webscrap` rendered and cleaned it. */
  static ofPage(html, base) {
    return Snapshot.ofLines(pageLines(html, base));
  }

  /** Markdown, as Firecrawl scraped it. */
  static ofMarkdown(markdown) {
    const lines = splitLines(markdown)
      .map((line) => collapse(line.replace(URL_RE(), (url) => cleanUrl(url, null))))
      .filter((line) => line.length > 0);
    return Snapshot.ofLines(lines);
  }

  static ofLines(input) {
    const lines = withoutGalleries(input);
    let shape = "";
    const marks = [];
    let hashes = [];
    for (const line of lines) {
      const start = shape.length;
      if (COUNTDOWN_PART.test(line) || isTyping(line)) {
        shape = addMark("m", line, shape, marks);
      } else if (isStat(line)) {
        shape = addMark("c", line, shape, marks);
      } else {
        // Addresses are kept as they are: a link to a new day's notice is a change.
        let at = 0;
        for (const url of line.matchAll(URL_RE())) {
          shape = markText(line.slice(at, url.index), shape, marks);
          shape += url[0];
          at = url.index + url[0].length;
        }
        shape = markText(line.slice(at), shape, marks);
      }
      hashes.push(lineHash(shape.slice(start)));
      shape += "\n";
    }
    const text = [...lines];
    const exactly = marks.reduce((n, m) => n + Buffer.byteLength(m, "utf8"), 0) > MAX_MARK_BYTES;
    if (exactly) hashes = lines.map(lineHash);
    if (hashes.length > MAX_LINE_HASHES) hashes = [];
    if (exactly) return new Snapshot(sha256(`exactly\n${lines.join("\n")}`), [], hashes, text);
    return new Snapshot(sha256(shape), marks, hashes, text);
  }

  /** Why this isn't the page `old` was, `now` being Unix seconds: `null` if what differs is noise. */
  changedFrom(old, now) {
    if (this.shape !== old.shape || this.marks.length !== old.marks.length) return this.textChangedFrom(old);
    for (let i = 0; i < this.marks.length; i++) {
      const [n, o] = [this.marks[i], old.marks[i]];
      // A mark starts with its kind's letter.
      if (n !== o && !isNoise(n, now)) return `«${quote(o.slice(1))}» became «${quote(n.slice(1))}»`;
    }
    return null;
  }

  /** Whether this is the page `old` was. */
  sameAs(old, now) {
    return this.changedFrom(old, now) === null;
  }

  /** Which lines changed since `old`: the first and last lines that differ, and what the first says now. */
  textChangedFrom(old) {
    const [next, prev] = [this.lines, old.lines];
    if (next.length === 0 || prev.length === 0) return `its text changed; it has ${this.text.length} lines`;
    let sameStart = 0;
    while (sameStart < Math.min(next.length, prev.length) && next[sameStart] === prev[sameStart]) sameStart++;
    let sameEnd = 0;
    const room = Math.min(next.length, prev.length) - sameStart;
    while (sameEnd < room && next[next.length - 1 - sameEnd] === prev[prev.length - 1 - sameEnd]) sameEnd++;
    const removed = prev.length - sameStart - sameEnd;
    const added = next.length - sameStart - sameEnd;
    if (removed + added === 0) return `its text changed, though no line did; it has ${next.length} lines`;
    let reason = `from line ${sameStart + 1} of ${next.length}, ${removed} removed and ${added} added`;
    if (added > 0 && this.text[sameStart] !== undefined) reason += `; the first now «${quote(this.text[sameStart])}»`;
    return reason;
  }
}

/** `text`'s lines: no final empty one, no `\r`. */
function splitLines(text) {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/** An image or a link without text, as a page's lines or markdown has it. */
const MEDIA = () =>
  /\[?!\[[^\]]*\]\([^)\s]*\)(?:\]\([^)\s]*\))?(?:\s*\(https?:\/\/[^)\s]*\))?|\[\s*\]\([^)\s]*\)|\(https?:\/\/[^)\s]*\)/g;

/** How many images and links without text a gallery has at least. */
const GALLERY_ITEMS = 3;
/** A gallery in a shape. */
const GALLERY = "\u0001g";

/**
 * `lines` with each gallery, a run of lines of only images and links like photos or a strip of
 * logos, as one line `GALLERY`: a gallery is often a different few on each visit.
 */
function withoutGalleries(lines) {
  const out = [];
  let run = [];
  let items = 0;
  const endRun = () => {
    if (items >= GALLERY_ITEMS) out.push(GALLERY);
    else out.push(...run);
    run = [];
    items = 0;
  };
  for (const line of lines) {
    const media = (line.match(MEDIA()) ?? []).length;
    const onlyMedia = media > 0 && !/[\p{Alphabetic}\p{N}]/u.test(line.replace(MEDIA(), ""));
    if (onlyMedia) {
      run.push(line);
      items += media;
    } else {
      endRun();
      out.push(line);
    }
  }
  endRun();
  return out;
}

/** Whether `line` is being typed out: it ends with its cursor, its only `|`. */
const isTyping = (line) =>
  Buffer.byteLength(line, "utf8") > 1 && line.endsWith("|") && (line.match(/\|/g) ?? []).length === 1;

const STAT = /^[#>*_\s]*(\d[\d,.]*)\s*(?:\+|%|k|m|cr|lakhs?|crores?)?\+?(?:\s+[a-z][a-z&'.-]*){0,3}[*_\s]*$/i;

/** Whether `line` is a statistic, like "5885", "1250 Students" or "50+ Years of Excellence". */
function isStat(line) {
  const c = STAT.exec(line);
  if (!c) return false;
  const n = c[1];
  const year = n.length === 4 && (n.startsWith("19") || n.startsWith("20")) && /^\d+$/.test(n);
  return !year && datesIn(line).length === 0;
}

/** The lines of the main content of `html`, with the addresses of its links and images. */
export function pageLines(html, base) {
  const $ = cheerio.load(html, null, false);
  const dropped = new Set();
  for (const selector of NON_MAIN) {
    $(selector).each((_, el) => {
      if ($(el).find("#main").length === 0) dropped.add(el);
    });
  }

  const lines = [];
  let line = "";
  const endLine = () => {
    const text = collapse(line);
    if (text.length > 0) lines.push(text);
    line = "";
  };
  const walk = (node) => {
    if (node.type === "text") {
      line += node.data;
      return;
    }
    const isElement = node.type === "tag" || node.type === "script" || node.type === "style";
    if (isElement) {
      const name = node.name;
      if (dropped.has(node) || UNREAD.has(name)) return;
      if (BLOCKS.has(name)) endLine();
      if (name === "img" && node.attribs.src !== undefined) {
        line += ` ![${node.attribs.alt ?? ""}](${cleanUrl(node.attribs.src, base)}) `;
      } else if (name === "td" || name === "th") {
        line += " | ";
      }
    }
    for (const child of node.children ?? []) walk(child);
    if (isElement) {
      if (node.name === "a" && node.attribs.href !== undefined) line += ` (${cleanUrl(node.attribs.href, base)}) `;
      if (BLOCKS.has(node.name)) endLine();
    }
  };
  for (const node of $.root().contents().toArray()) walk(node);
  endLine();
  return lines;
}

/**
 * `raw` resolved against `base`, or as it is without one, without its `#fragment` or the query
 * parameters that change on their own: cache-busting, tracking, sessions and signatures.
 */
export function cleanUrl(input, base) {
  const raw = input.trim();
  let url;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return raw;
  }
  url.hash = "";
  if (url.search.length > 0 || url.href.endsWith("?")) {
    const kept = [...url.searchParams].filter(([key, value]) => !volatileParam(key, value));
    url.search = kept.length === 0 ? "" : new URLSearchParams(kept).toString();
  }
  const at = url.pathname.toLowerCase().indexOf(";jsessionid=");
  if (at >= 0) url.pathname = url.pathname.slice(0, at);
  return url.href;
}

const VOLATILE = new Set([
  "fbclid", "gclid", "dclid", "msclkid", "yclid", "igshid", "mc_cid", "mc_eid", "_ga", "_gl", "sid",
  "phpsessid", "jsessionid", "sessionid", "session_id", "nonce", "_token", "csrf", "csrf_token",
  "signature", "sig", "expires", "key-pair-id", "policy", "cachebust", "cachebuster", "nocache",
]);
const CACHE_BUSTING = new Set(["v", "ver", "version", "t", "ts", "time", "timestamp", "_", "cb", "r", "rnd", "rand", "random"]);

/** Whether a query parameter is one that changes on its own. */
function volatileParam(rawKey, value) {
  const key = rawKey.toLowerCase();
  const numeric = value.length > 0 && /^[0-9.]+$/.test(value);
  return (
    key.startsWith("utm_") ||
    key.startsWith("x-amz-") ||
    key.startsWith("x-goog-") ||
    VOLATILE.has(key) ||
    // Cache-busting, when it's a number or a version; `?v=` is also YouTube's video.
    (numeric && CACHE_BUSTING.has(key))
  );
}

/** Starts a mark in a shape; no page's text has it. */
const MARK = "\u0001";

const MONTH = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?`;
const WEEKDAY = String.raw`(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b\.?,?\s+`;
const TIME = String.raw`\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:\s*[ap]\.?\s?m\b\.?)?(?:\s*(?:[+-]\d{2}:?\d{2}|z\b|ist\b|utc\b|gmt\b))?`;
const UNIT = String.raw`(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b`;

const MARKS_SOURCE = (() => {
  const iso = String.raw`\d{4}-\d{1,2}-\d{1,2}(?:[t\s]+${TIME})?`;
  const numeric = String.raw`\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})\b(?:,?\s+${TIME})?`;
  const dayMonth = String.raw`(?:${WEEKDAY})?\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH}(?:,?\s+\d{4}\b)?(?:,?\s+(?:at\s+)?${TIME})?`;
  const monthDay = String.raw`(?:${WEEKDAY})?${MONTH}\s+\d{1,2}(?:st|nd|rd|th)?\b(?:,?\s+\d{4}\b)?(?:,?\s+(?:at\s+)?${TIME})?`;
  const ago = String.raw`(?:\d+|an?|one|a\s+few|few)\s+(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|months?|years?|yrs?)\s+ago\b|just\s+now\b|(?:a\s+)?moments?\s+ago\b|(?:in|after)\s+\d+\s+(?:seconds?|minutes?|hours?|days?|weeks?)\b|\d+\s+(?:seconds?|minutes?|hours?|days?|weeks?)\s+(?:left|remaining|to\s+go)\b`;
  // Three units at least: "2 hours 30 minutes" may be a duration.
  const countdown = String.raw`(?:(?:in|after)\s+)?\d+\s*${UNIT}(?:[\s:,|]*\d+\s*${UNIT}){2,}`;
  // A countdown as days:hours:minutes:seconds, or a clock with seconds: either moves every second.
  const ticking = String.raw`\d{1,3}(?::\d{2}){2,3}\b`;
  const counter = String.raw`(?:visitors?|visits?|views?|hits?|page\s*views?|visitor\s*(?:count|no\.?|number)|users?\s+online|online\s+users?|downloads?|readers?)\s*[:\-–]?\s*\d[\d,]*|\d[\d,]*\s+(?:visitors?|views?|hits?|downloads?|readers?|(?:people|users?)\s+online)\b`;
  return String.raw`\b(?:(?<date>${iso}|${numeric}|${dayMonth}|${monthDay})|(?<moving>${countdown}|${ticking}|${ago})|(?<counter>${counter})|(?<time>${TIME}))`;
})();
const MARKS = () => new RegExp(MARKS_SOURCE, "gi");

/** A line that is one box of a countdown, like "12 Hours". */
const COUNTDOWN_PART = /^\d+\s*(?:days?|hours?|hrs?|minutes?|mins?|seconds?|secs?)$/i;

/** An address in a line. */
const URL_RE = () => /https?:\/\/[^\s)\]>"']+/g;

/** `text` added to `shape`, each of its marks replaced by its kind and added to `marks`. */
function markText(text, shape, marks) {
  let at = 0;
  for (const m of text.matchAll(MARKS())) {
    const g = m.groups;
    const kind = g.date !== undefined ? "d" : g.moving !== undefined ? "m" : g.counter !== undefined ? "c" : "t";
    shape += text.slice(at, m.index);
    shape = addMark(kind, m[0], shape, marks);
    at = m.index + m[0].length;
  }
  return shape + text.slice(at);
}

function addMark(letter, text, shape, marks) {
  marks.push(`${letter}${text}`);
  return `${shape}${MARK}${letter}`;
}

/** Whether the mark `mark` moves on its own `now`. */
function isNoise(mark, now) {
  const kind = mark[0];
  const text = mark.slice(1);
  if (kind === "m" || kind === "c") return true;
  if (kind === "d") return isToday(text, now);
  if (kind === "t") return isNow(text, now);
  return false;
}

const divEuclid = (a, b) => Math.floor(a / b);
const remEuclid = (a, b) => ((a % b) + b) % b;

/** Whether the date in `text` is today somewhere, from UTC-12 to UTC+14. */
function isToday(text, now) {
  const first = divEuclid(now - 12 * 3600, 86_400);
  const last = divEuclid(now + 14 * 3600, 86_400);
  const today = [];
  for (let d = first; d <= last; d++) today.push(civil(d));
  return datesIn(text).some(([year, month, day]) =>
    today.some(([y, m, dd]) => m === month && dd === day && (year === null || year === y)),
  );
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The dates `text` may mean, `[year | null, month, day]`: a numeric date may be day first or month first. */
export function datesIn(text) {
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (iso) return [[Number(iso[1]), Number(iso[2]), Number(iso[3])]];
  const numeric = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/.exec(text);
  if (numeric) {
    let year = Number(numeric[3]);
    if (year < 100) year += 2000;
    const [a, b] = [Number(numeric[1]), Number(numeric[2])];
    return [[year, b, a], [year, a, b]];
  }
  const cleaned = text.replace(new RegExp(TIME, "g"), " ");
  const named = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.exec(cleaned);
  const month = named ? MONTHS.indexOf(named[1].toLowerCase()) + 1 : null;
  const day = /\b(\d{1,2})(?:st|nd|rd|th)?\b/.exec(cleaned);
  const year = /\b(\d{4})\b/.exec(cleaned);
  if (month && day) return [[year ? Number(year[1]) : null, month, Number(day[1])]];
  return [];
}

/** Whether the time in `text` is now, in UTC or the local zone. */
function isNow(text, now) {
  const c = /(\d{1,2}):(\d{2})(?::\d{2})?(?:\.\d+)?(?:\s*([ap])\.?\s?m\b)?/i.exec(text);
  if (!c) return false;
  const [hour, minute] = [Number(c[1]), Number(c[2])];
  let hours;
  if (c[3] !== undefined) hours = hour <= 12 ? [(hour % 12) + (c[3].toLowerCase() === "p" ? 12 : 0)] : [];
  // Without a.m. or p.m., 3:05 may be 15:05.
  else if (hour < 12) hours = [hour, hour + 12];
  else if (hour === 12) hours = [12, 0];
  else if (hour < 24) hours = [hour];
  else hours = [];
  const utc = remEuclid(Math.trunc(now / 60), 1440);
  const local = remEuclid(utc + LOCAL_OFFSET_MINUTES, 1440);
  return hours.some((h) => {
    const at = h * 60 + minute;
    return [utc, local].some((n) => {
      const apart = remEuclid(at - n, 1440);
      return Math.min(apart, 1440 - apart) <= TIME_SLACK_MINUTES;
    });
  });
}

/** The date `days` after 1970-01-01: Howard Hinnant's `civil_from_days`. */
export function civil(days) {
  const z = days + 719_468;
  const era = divEuclid(z, 146_097);
  const doe = remEuclid(z, 146_097);
  const yoe = Math.trunc((doe - Math.trunc(doe / 1460) + Math.trunc(doe / 36_524) - Math.trunc(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.trunc(yoe / 4) - Math.trunc(yoe / 100));
  const mp = Math.trunc((5 * doy + 2) / 153);
  const day = doy - Math.trunc((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (month <= 2 ? 1 : 0), month, day];
}
