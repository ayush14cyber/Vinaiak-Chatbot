import assert from "node:assert/strict";
import { test } from "node:test";

import { Snapshot, QUOTED_CHARS, civil, pageLines } from "../src/snapshot.js";

/** 2026-10-26, a Monday. */
const OCT_26 = 20_752;
/** Unix seconds at `hour`:`minute` UTC on the day `days`. */
const at = (days, hour, minute) => days * 86_400 + hour * 3600 + minute * 60;
const lines = (text) => {
  const all = text.split("\n");
  if (all[all.length - 1] === "") all.pop();
  return all;
};
const page = (text) => Snapshot.ofLines(lines(text));
const same = (old, next, now) => page(next).sameAs(page(old), now);

test("days are dates", () => {
  assert.deepEqual(civil(0), [1970, 1, 1]);
  assert.deepEqual(civil(19_782), [2024, 2, 29]);
  assert.deepEqual(civil(OCT_26), [2026, 10, 26]);
  assert.deepEqual(civil(-1), [1969, 12, 31]);
});

test("main content as text and addresses", () => {
  const html = `<nav><a href="/">Home</a></nav>
            <div class="sidebar">Latest: <a href="/n/9">Holiday</a></div>
            <div class="menu"><div id="main">
              <h1 class="css-1x2y3z">Fees <small>2026–27</small></h1>
              <p>Tuition is ₹1,00,000 a <b>year</b>.<script>var t = 1;</script></p>
              <form><input type="hidden" name="csrf" value="a8f3"></form>
              <table><tr><th>Hostel</th><td>₹40,000</td></tr></table>
              <a href="fees.pdf?utm_source=site&v=1698#p2">Fee notice</a>
              <img src="/i/f.png?ver=3.2" alt="Fee chart">
              <a href="https://youtu.be/watch?v=dQw4w9WgXcQ">Video</a>
            </div></div>
            <div class="cookie">We use cookies</div>`;
  assert.deepEqual(pageLines(html, "https://x.edu/fees/"), [
    "Fees 2026–27",
    "Tuition is ₹1,00,000 a year.",
    "| Hostel | ₹40,000",
    "Fee notice (https://x.edu/fees/fees.pdf) ![Fee chart](https://x.edu/i/f.png) Video (https://youtu.be/watch?v=dQw4w9WgXcQ)",
  ]);
});

test("markup and tracking are not changes", () => {
  const base = "https://x.edu/";
  const old = `<p class="a1">Fees: ₹1,00,000</p><input type="hidden" value="tok1"><a href="/f.pdf?utm_source=x;">Notice</a>`;
  const next = `<p class="b7" data-id="9">Fees: ₹1,00,000</p><input type="hidden" value="tok2"><a href="/f.pdf?utm_source=y">Notice</a>`;
  assert.ok(Snapshot.ofPage(next, base).sameAs(Snapshot.ofPage(old, base), at(OCT_26, 10, 0)));
});

test("clocks and today are noise", () => {
  const now = at(OCT_26, 10, 32);
  assert.ok(same("Time: 09:32:10", "Time: 10:32:41", now));
  assert.ok(same("Server time 3:02 PM IST", "Server time 4:02 PM IST", now));
  assert.ok(same("Today is Sunday, 25 October 2026", "Today is Monday, 26 October 2026", now));
  assert.ok(same("Updated 2026-10-25T18:00:00Z", "Updated 2026-10-26T10:30:00Z", now));
  assert.ok(same("As on 25/10/2026", "As on 26/10/2026", now));
});

test("what always moves is noise", () => {
  const now = at(OCT_26, 10, 32);
  assert.ok(same("Posted 5 minutes ago", "Posted 2 hours ago", now));
  assert.ok(same("Visitors: 1,23,456", "Visitors: 1,23,501", now));
  assert.ok(same("12,001 views", "12,019 views", now));
  assert.ok(same("Admissions close in 05 Days 12 Hours 30 Minutes", "Admissions close in 04 Days 23 Hours 59 Minutes", now));
  assert.ok(same("05\n05 Days\n12 Hours", "05\n04 Days\n23 Hours", now));
});

test("content that moves is a change", () => {
  let now = at(OCT_26, 18, 0);
  assert.ok(!same("Last date: 15 November 2026", "Last date: 30 November 2026", now));
  assert.ok(!same("Exam at 10:30 AM", "Exam at 11:00 AM", now));
  assert.ok(!same("Tuition: ₹1,00,000", "Tuition: ₹1,10,000", now));
  assert.ok(!same("Hostel open", "Hostel closed", now));
  assert.ok(!same("Exam lasts 2 hours 30 minutes", "Exam lasts 3 hours", now));
  now = at(OCT_26 + 1, 9, 0);
  assert.ok(!same("[Notice](https://x.edu/n/2026-10-26.pdf)", "[Notice](https://x.edu/n/2026-10-27.pdf)", now));
  assert.ok(same("Results on 26 Oct", "Results on 27 Oct", now));
  assert.ok(!same("Results soon", "Results on 27 Oct", now));
});

test("a gallery is left out", () => {
  const now = at(OCT_26, 10, 0);
  const gallery = (shown) =>
    `Recent uploaded images\n${shown.map((i) => `![Gallery Image](https://x.edu/g/${i}.jpg) (https://x.edu/g/${i})`).join("\n")}\nAbout us`;
  assert.ok(same(gallery([1, 2, 3]), gallery([3, 1, 2]), now));
  assert.ok(same(gallery([1, 2, 3, 4]), gallery([7, 2, 9]), now));
  const md = (a, b, c) =>
    `[![](https://x.edu/${a}.jpg)](https://x.edu/${a}) [![](https://x.edu/${b}.jpg)](https://x.edu/${b}) ![](https://x.edu/${c}.jpg)`;
  assert.ok(Snapshot.ofMarkdown(md(5, 1, 6)).sameAs(Snapshot.ofMarkdown(md(1, 2, 3)), now));
  assert.ok(!same(gallery([1]), gallery([2]), now));
  assert.ok(!same(gallery([1, 2]), gallery([1, 3]), now));
  assert.ok(!same("UG fees\n₹1,00,000\nPG fees\n₹2,00,000", "UG fees\n₹2,00,000\nPG fees\n₹1,00,000", now));
});

test("text being typed is noise", () => {
  const now = at(OCT_26, 10, 0);
  assert.ok(same("Welcome to the new |", "Welcome to the new wo|", now));
  assert.ok(!same("| UG | ₹1,00,000 |", "| UG | ₹1,10,000 |", now));
});

test("counted-up stats and ticking clocks are noise", () => {
  const now = at(OCT_26, 10, 0);
  assert.ok(same("5885\nStudents", "4021\nStudents", now));
  assert.ok(same("1250 Students\n290 Faculty", "1187 Students\n12 Faculty", now));
  assert.ok(same("50+ Years of Excellence", "37+ Years of Excellence", now));
  assert.ok(same("## 98%", "## 41%", now));
  assert.ok(same("Starts in 34:09:52:28", "Starts in 34:09:51:03", now));
  assert.ok(same("Live: 15:21:07", "Live: 16:21:33", now));
  assert.ok(!same("2026 Admissions", "2027 Admissions", now));
  assert.ok(!same("1 Nov", "5 Nov", now));
  assert.ok(!same("Counselling Round 2", "Counselling Round 3", now));
});

test("a date that stays is no change as it becomes today", () => {
  const old = page("Holiday on 27 October 2026\nExam at 10:30 AM");
  for (const now of [at(OCT_26, 9, 0), at(OCT_26 + 1, 5, 0), at(OCT_26 + 1, 5, 0) + 60]) {
    assert.ok(page("Holiday on 27 October 2026\nExam at 10:30 AM").sameAs(old, now));
  }
});

test("markdown signatures and tracking are not changes", () => {
  const old = "![Chart](https://cdn.x.edu/c.png?X-Amz-Signature=ab12&X-Amz-Date=1) [Apply](https://x.edu/apply?utm_campaign=a#form)";
  const next = "![Chart](https://cdn.x.edu/c.png?X-Amz-Signature=cd34&X-Amz-Date=2)  [Apply](https://x.edu/apply?utm_campaign=b)";
  const now = at(OCT_26, 10, 0);
  assert.ok(Snapshot.ofMarkdown(next).sameAs(Snapshot.ofMarkdown(old), now));
  const moved = "![Chart](https://cdn.x.edu/c2.png) [Apply](https://x.edu/apply)";
  assert.ok(!Snapshot.ofMarkdown(moved).sameAs(Snapshot.ofMarkdown(old), now));
});

test("a change says why", () => {
  const now = at(OCT_26, 18, 0);
  const reason = (old, next) => page(next).changedFrom(page(old), now);
  assert.equal(reason("Fees\nUpdated 5 minutes ago", "Fees\nUpdated 2 hours ago"), null);
  assert.equal(reason("Last date: 15 November 2026", "Last date: 30 November 2026"), "«15 November 2026» became «30 November 2026»");
  assert.equal(
    reason("Fees\nUG: ₹1,00,000\nPG: ₹2,00,000\nContact", "Fees\nUG: ₹1,10,000\nPG: ₹2,00,000\nContact"),
    "from line 2 of 4, 1 removed and 1 added; the first now «UG: ₹1,10,000»",
  );
  assert.equal(reason("Fees\nContact", "Fees\nHostel closed\nContact"), "from line 2 of 3, 0 removed and 1 added; the first now «Hostel closed»");
  assert.equal(reason("Fees\nHostel closed\nContact", "Fees\nContact"), "from line 2 of 2, 1 removed and 0 added");
  const base = page("Fees\nContact");
  const stored = new Snapshot(base.shape, base.marks, base.lines, []);
  assert.ok(page("Fees\nHostel\nContact").changedFrom(stored, now).includes("«Hostel»"));
  assert.ok(reason("a", "x".repeat(QUOTED_CHARS + 10)).endsWith("…»"));
  const odd = new Snapshot("other", base.marks, base.lines, base.text);
  assert.equal(page("Fees\nContact").changedFrom(odd, now), "its text changed, though no line did; it has 2 lines");
});

test("a page of too many marks is compared exactly", () => {
  let text = "";
  for (let i = 0; i < 20_000; i++) text += `Row ${i}: 12:00\n`;
  const snapshot = page(text);
  assert.equal(snapshot.marks.length, 0);
  const now = at(OCT_26, 12, 0);
  assert.ok(page(text).sameAs(snapshot, now));
  assert.ok(!page(text.replace("12:00", "12:01")).sameAs(snapshot, now));
});
