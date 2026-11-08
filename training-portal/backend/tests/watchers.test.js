import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_NEW_ID_BYTES } from "../src/paths.js";
import * as w from "../src/watchers.js";

const { Kind, Watcher, level, MAX_LINKS, MAX_LIST_PAGES, SUFFIX_ROOM } = w;
const link = (url, text) => ({ url, text });
const texts = (links) => links.map((l) => l.text);
const dir = (id, links) =>
  new Watcher(id, Kind.Directory, "https://x.edu/notices", { levels: [level(".notices")], links: new Map(links) });

test("links are absolute http and once each", () => {
  const html = `<ul class="n">
            <li><a href="https://x.edu/n/1">  Fee   <b>notice</b>
                2026 </a></li>
            <li><a href="2.pdf#page=3">Exam dates</a></li>
            <li><a href="https://x.edu/n/1#top">again</a></li>
            <li><a href="mailto:office@x.edu">Mail</a> <a href="javascript:void(0)">JS</a></li>
            <li><a>no href</a></li>
            <li><a href="https://x.edu/notices/#">Opens in a script</a> <a href="">Here</a></li>
        </ul><a href="/n/3"><img alt="x"></a>`;
  assert.deepEqual(w.links(html, "https://x.edu/notices/"), [
    link("https://x.edu/n/1", "Fee notice 2026"),
    link("https://x.edu/notices/2.pdf", "Exam dates"),
    link("https://x.edu/n/3", ""),
  ]);
  assert.equal(w.links(`<a href="https://x.edu/a">A</a>\n<a href="https://x.edu/b">B</a>`, "https://x.edu/notices/").length, 2);
});

test("pages are named by their link", () => {
  assert.equal(w.pageName(link("https://x.edu/n/1", " UG | Fees ~ 2026 #3 ")), "UG / Fees - 2026 3");
  assert.equal(w.pageName(link("https://x.edu/notices/Exam%20Dates.pdf", "")), "Exam Dates.pdf");
  assert.equal(w.pageName(link("https://x.edu/n/42/", " ")), "42");
  assert.equal(w.pageName(link("https://x.edu/", "")), "x.edu");
});

test("ids are free and fit", () => {
  const taken = new Set(["Notices|Fees", "Notices|Fees (2)", "Notices|Exam~1"]);
  assert.equal(w.freeId("Notices", "Fees", taken), "Notices|Fees (3)");
  assert.equal(w.freeId("Notices", "Exam", taken), "Notices|Exam (2)", "its parts take it");
  assert.equal(w.freeId("Notices", "Hours", taken), "Notices|Hours");
  const id = w.freeId("Notices", "é".repeat(200), taken);
  assert.ok(Buffer.byteLength(id) + SUFFIX_ROOM <= MAX_NEW_ID_BYTES);
  assert.ok(id.startsWith("Notices|é"));
});

test("new and gone links", () => {
  const seen = new Map([["https://x.edu/1", "N|One"], ["https://x.edu/2", ""], ["https://x.edu/3", "N|Three"]]);
  const [fresh, gone] = w.compare(seen, [link("https://x.edu/1", "One"), link("https://x.edu/4", "Four")]);
  assert.deepEqual(fresh, [link("https://x.edu/4", "Four")]);
  assert.deepEqual(gone, [["https://x.edu/2", ""], ["https://x.edu/3", "N|Three"]]);
});

test("a selector that finds nothing is an error", () => {
  const rendered = (html, matches) => ({ url: "https://x.edu/", html, matches });
  assert.throws(() => w.matchedLinks(rendered("", 0), () => "nothing"));
  const none = w.matchedLinks(rendered("<p>no links</p>", 1), () => "nothing");
  assert.throws(() => w.foundLinks(none, null));
  const many = Array.from({ length: MAX_LINKS + 1 }, (_, i) => link(`https://x.edu/${i}`, String(i)));
  assert.throws(() => w.foundLinks(many, null), "over the cap");
  assert.equal(w.foundLinks([many[0]], null)[1].length, 1);
  const [all, followed] = w.foundLinks(many, level("a", 3));
  assert.equal(all.length, MAX_LINKS + 1);
  assert.deepEqual(texts(followed), ["0", "1", "2"]);
  assert.deepEqual(texts(w.foundLinks(many, level("a", 3, true))[1]), ["198", "199", "200"]);
});

test("a limit reads from the top or the bottom", () => {
  const found = ["a", "b", "c", "d"].map((t) => link(`https://x.edu/${t}`, t));
  assert.deepEqual(texts(w.followed(found, 2, false)), ["a", "b"]);
  assert.deepEqual(texts(w.followed(found, 2, true)), ["c", "d"]);
  assert.equal(w.followed(found, 9, true).length, 4);
  assert.equal(w.followed(found, null, true).length, 4);
  assert.deepEqual([w.fromEnd(0, 4, false), w.fromEnd(0, 4, true)], [0, 3]);
  assert.equal(w.fromEnd(3, 4, true), 0);
});

test("levels list their links depth first and once each", () => {
  const merged = w.merge([
    [link("https://x.edu/2026/a", "A"), link("https://x.edu/b", "B")],
    [link("https://x.edu/b", "B again"), link("https://x.edu/2025/c", "C")],
  ]);
  assert.deepEqual(merged.map((l) => l.url), ["https://x.edu/2026/a", "https://x.edu/b", "https://x.edu/2025/c"]);
  assert.equal(merged[1].text, "B");
});

test("a level reads pages, not files, up to the cap", () => {
  const found = [
    link("https://x.edu/2026", "2026"),
    link("https://x.edu/notice.pdf", "Notice"),
    link("https://x.edu/chart.PNG?v=2", "Chart"),
    link("https://x.edu/2025/", "2025"),
  ];
  const all = level(".years a");
  let read = { count: 0 };
  assert.deepEqual(texts(w.nextPages(found, all, 1, read)), ["2026", "2025"]);
  assert.equal(read.count, 2);
  assert.deepEqual(texts(w.nextPages(found, level(".years a", 1, true), 1, read)), ["2025"]);
  assert.equal(read.count, 3);
  assert.throws(() => w.nextPages([link("https://x.edu/a.pdf", "A")], all, 1, read));
  const many = Array.from({ length: MAX_LIST_PAGES - 2 }, (_, i) => link(`https://x.edu/${i}`, ""));
  assert.throws(() => w.nextPages(many, all, 2, read));
  read = { count: 3 };
  w.nextPages(many, level(".months a", 10), 2, read);
  const upTo = Array.from({ length: MAX_LIST_PAGES }, (_, i) => link(`https://x.edu/${i}`, ""));
  w.nextPages(upTo, all, 1, { count: 0 });
});

test("levels a watcher can have", () => {
  assert.throws(() => w.checkLevels([], 0));
  assert.throws(() => w.checkLevels([level("  ")], 0));
  assert.deepEqual(w.checkLevels([level(" .a ", 5)], 5), [level(".a", 5)]);
  assert.throws(() => w.checkLevels([level(".a", 0)], 0));
  assert.throws(() => w.checkLevels([level(".a", MAX_LINKS + 1)], 0));
  assert.throws(() => w.checkLevels([level(".a", 5)], 6));
  w.checkLevels([level(".a")], MAX_LINKS);
});

test("following more at any level is checked again", () => {
  const levels = (a, b) => [level(".y", a), level(".n", b)];
  assert.ok(w.loosens(levels(2, 20), levels(3, 20)));
  assert.ok(w.loosens(levels(2, 20), levels(2, null)));
  assert.ok(!w.loosens(levels(2, 20), levels(1, 5)));
  assert.ok(!w.loosens(levels(null, null), levels(2, 20)));
});

test("a row keeps what it stores", () => {
  const directory = dir("Notices", [["https://x.edu/1", "Notices|One"], ["https://x.edu/2", ""]]).with({ watchChanges: 3, watchReverse: true, checkedAt: 5 });
  assert.deepEqual(Watcher.of(directory.item("org")), directory);
  const withLevels = directory.with({ levels: [level(".y", 2, true), level(".n")] });
  assert.deepEqual(Watcher.of(withLevels.item("org")), withLevels);
  // A row from before levels.
  const old = directory.item("org");
  delete old.levels;
  old.selector = { S: ".notices" };
  assert.deepEqual(Watcher.of(old), directory);
  const before = { ...old, selectors: { L: [{ S: ".y" }, { S: ".n" }] }, limit: { N: "4" }, watch_changes: { BOOL: true } };
  const parsed = Watcher.of(before);
  assert.deepEqual(parsed.levels, [level(".y"), level(".n", 4)]);
  assert.equal(parsed.watchChanges, MAX_LINKS);
  assert.equal(Watcher.of({ ...before, watch_changes: { BOOL: false } }).watchChanges, 0);
});

test("what becomes of a link no longer followed", () => {
  assert.equal(w.gone("N|1", null), "Delete");
  assert.equal(w.gone("N|1", 5), "Delete");
  assert.equal(w.gone("", 5), "Stay");
  assert.equal(w.gone("", MAX_LINKS), "Forget");
  assert.equal(w.gone("", null), "Forget");
});

test("a file is saved as a link; only http has https to try", () => {
  assert.equal(w.mediaPage("Fee [notice]", "https://x.edu/a b.pdf"), "[Fee \\[notice\\]](<https://x.edu/a b.pdf>)");
  assert.equal(w.overHttps("http://x.edu/a"), "https://x.edu/a");
  assert.equal(w.overHttps("https://x.edu/a"), null);
});

test("the first pages are watched", () => {
  const found = [1, 2, 3, 4].map((i) => link(`https://x.edu/n/${i}`, String(i)));
  const seen = new Map([["https://x.edu/n/3", "N|3"], ["https://x.edu/n/4", "N|1"]]);
  let [watch, unwatch] = w.rewatched(found, seen, [3, false], new Set(["N|3"]));
  assert.deepEqual(watch, []);
  assert.deepEqual(unwatch, []);
  [watch, unwatch] = w.rewatched(found, seen, [2, true], new Set(["N|3"]));
  assert.deepEqual(watch, [[found[3], "N|1"]]);
  assert.deepEqual(unwatch, []);
  [watch, unwatch] = w.rewatched(found, seen, [0, false], new Set(["N|3"]));
  assert.deepEqual(unwatch, ["N|3"]);
});

test("a page refuses for good on a client error", () => {
  for (const s of [400, 401, 403, 404, 410, 451]) assert.ok(w.refusesForGood(s), s);
  for (const s of [408, 429, 500, 503, 200]) assert.ok(!w.refusesForGood(s), s);
});

test("hand edits, deletes, stops and moves change watchers", () => {
  const watchers = [new Watcher("One", Kind.File, "https://x.edu/a"), dir("N", [["https://x.edu/1", "N|1"], ["https://x.edu/2", "Other|2"]]), new Watcher("N|1", Kind.File, "https://x.edu/1")];
  assert.deepEqual(w.edited(watchers, "One"), [{ remove: "One" }]);
  assert.deepEqual(w.deleted(watchers, "Other", true), [{ link: { dir: "N", url: "https://x.edu/2", page: "" } }]);
  assert.deepEqual(w.deleted(watchers, "N", true), [{ remove: "N" }, { remove: "N|1" }]);
  assert.deepEqual(w.stopped(watchers, "N"), [{ remove: "N" }, { remove: "N|1" }]);
  const moves = w.moved(watchers, (id) => (id === "Other|2" ? "Else|2" : null));
  assert.deepEqual(moves, [{ link: { dir: "N", url: "https://x.edu/2", page: "Else|2" } }]);
  const folder = w.moved(watchers, (id) => (id === "N" || id.startsWith("N|") ? `M${id.slice(1)}` : null));
  assert.equal(folder.length, 2);
  assert.equal(folder[0].move.to.id, "M");
  assert.equal(folder[0].move.to.links.get("https://x.edu/1"), "M|1");
  assert.throws(() => w.moved(watchers, (id) => (id === "One" ? "N" : null)));
});

test("details show a directory watcher's pages", () => {
  const d = w.details(dir("N", [["https://x.edu/1", "N|1"], ["https://x.edu/2", ""]]).with({ watchChanges: 500 }));
  assert.deepEqual(d, { id: "N", kind: "directory", url: "https://x.edu/notices", levels: [{ selector: ".notices", reverse: false }], watch_changes: MAX_LINKS, watch_reverse: false, pages: 1 });
});
