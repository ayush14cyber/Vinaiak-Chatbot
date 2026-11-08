import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { S3Client } from "@aws-sdk/client-s3";
import { SignJWT, importPKCS8 } from "jose";

import { Verifier } from "../src/auth.js";
import * as origins from "../src/chatbot-origins.js";
import * as widgetMod from "../src/chatbot-widget.js";
import { build } from "../src/tree.js";
import * as uploads from "../src/uploads.js";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

// ---- tree ----

const file = (name) => ({ name, file: true, children: [] });
const folder = (name, children = []) => ({ name, file: false, children });
const mark = (node, field, value = true) => ({ ...node, [field]: value });
const order = (node) => {
  const { name, file: f, watcher, by_watcher, outside, assigned, children } = node;
  const out = { name, file: f };
  if (watcher) out.watcher = watcher;
  if (by_watcher) out.by_watcher = by_watcher;
  if (outside) out.outside = outside;
  if (assigned) out.assigned = assigned;
  out.children = children.map(order);
  return out;
};
const eq = (a, b) => assert.deepEqual(order(a), order(b));

test("tree: nests paths and keeps empty folders", () => {
  const docs = ["Admissions|MBA", "Admissions|UG|Fees", "Admissions|UG|Fees~1", "Clubs"];
  const kept = ["Admissions|PhD", "Admissions|UG", "Notices"];
  const admissions = folder("Admissions", [file("MBA"), folder("PhD"), folder("UG", [file("Fees"), file("Fees~1")])]);
  eq(build("ISM Dhanbad", docs, kept, [], [], [""]), folder("ISM Dhanbad", [admissions, file("Clubs"), folder("Notices")]));
  eq(build("Org", [], [], [], [], [""]), folder("Org"));
});

test("tree: marks watched files and folders", () => {
  const docs = ["Notices|Exams", "Notices|Fees", "Notices|Mine", "Hours"];
  const watchers = [["Notices", "directory"], ["Notices|Fees", "file"], ["Hours", "file"], ["Events", "directory"]];
  const made = ["Notices|Exams", "Notices|Fees", "Notices|Gone"];
  const notices = [mark(file("Exams"), "by_watcher"), mark(mark(file("Fees"), "watcher", "file"), "by_watcher"), file("Mine")];
  eq(
    build("Org", docs, [], watchers, made, [""]),
    folder("Org", [mark(folder("Events"), "watcher", "directory"), mark(file("Hours"), "watcher", "file"), mark(folder("Notices", notices), "watcher", "directory")]),
  );
});

test("tree: an admin sees their folders under the path to them", () => {
  const docs = ["Notices|Exams|Mid-sem", "Notices|Exams|Mid-sem~1", "Notices|Fees", "Notices-old|Exams|A", "UG|Fees"];
  const exams = folder("Exams", [file("Mid-sem"), file("Mid-sem~1"), folder("Old")]);
  eq(
    build("Org", docs, ["Notices|Exams|Old", "Clubs"], [["Notices|Fees", "file"]], [], ["Notices|Exams", "UG"]),
    mark(folder("Org", [mark(folder("Notices", [mark(exams, "assigned")]), "outside"), mark(folder("UG", [file("Fees")]), "assigned")]), "outside"),
  );
  eq(build("Org", ["Notices|Fees"], [], [], [], ["Notices|Exams"]), mark(folder("Org"), "outside"));
});

// ---- uploads ----

test("uploads: a file name is safe and ends in its type", () => {
  const name = (n, t) => uploads.fileName(n, t);
  assert.equal(name("Fee structure 2026.pdf", "application/pdf"), "Fee-structure-2026.pdf");
  assert.equal(name("../../link.js", "application/pdf"), "link.js.pdf");
  assert.equal(name("Photo.JPEG", "image/jpeg"), "Photo.jpeg");
  assert.equal(name("scan", "image/png"), "scan.png");
  assert.equal(name("notice.pdf", "image/png"), "notice.pdf.png");
  assert.equal(name("शुल्क.pdf", "application/pdf"), "file.pdf");
  assert.equal(name("a  &  b?.gif", "image/gif"), "a-b.gif");
  const long = name("x".repeat(300), "image/webp");
  assert.ok(long.endsWith(".webp"));
  for (const t of ["text/html", "image/svg+xml", "application/javascript", ""]) assert.throws(() => name("page", t), t);
});

test("uploads: a page's uploads are found by their URLs", () => {
  const O = widgetMod.PUBLIC_ORIGIN;
  const md = `![Campus](${O}/public/demo/files/0a1b/campus.jpg)\nSee [the fees](${O}/public/demo/files/ff00/Fees-2026.pdf), or ${O}/public/demo/files/ff00/Fees-2026.pdf.\nAnother org's: ${O}/public/other/files/0a1b/x.pdf, a prefix of ours: ${O}/public/demo2/files/0a1b/y.pdf, its link: ${O}/public/demo/link.js, and elsewhere: https://example.edu/public/demo/files/0a1b/z.pdf`;
  assert.deepEqual([...uploads.keysIn(md, "demo")], ["public/demo/files/0a1b/campus.jpg", "public/demo/files/ff00/Fees-2026.pdf"]);
});

test("uploads: a presigned upload signs its type and size", async () => {
  const s3 = new S3Client({ region: "ap-south-1", credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" }, requestChecksumCalculation: "WHEN_REQUIRED" });
  const key = "public/demo/files/0a1b/Fees.pdf";
  const tag = uploads.pageTag("Admissions|Fees");
  const upload = await uploads.presign(s3, key, "application/pdf", 1234, tag);
  assert.ok(upload.url.startsWith(`https://${widgetMod.PUBLIC_BUCKET}.s3.ap-south-1.amazonaws.com/${key}?`));
  assert.equal(new URL(upload.url).searchParams.get("X-Amz-SignedHeaders"), "content-length;content-type;host;x-amz-meta-page");
  assert.deepEqual(upload.headers, { "content-type": "application/pdf", "x-amz-meta-page": tag });
  assert.equal(upload.public_url, `${widgetMod.PUBLIC_ORIGIN}/${key}`);
});

// ---- chatbot origins ----

test("origins: sites are read as origins", () => {
  assert.deepEqual(
    origins.parse([" https://www.BITMesra.ac.in/ ", "", "bitmesra.ac.in", "https://www.bitmesra.ac.in/admissions?x=1#fees", "http://localhost:3000", "https://www.bitmesra.ac.in:443", "https://भारत.example"]),
    ["https://www.bitmesra.ac.in", "https://bitmesra.ac.in", "http://localhost:3000", "https://xn--h2brj9c.example"],
  );
  assert.deepEqual(origins.parse([]), []);
  assert.deepEqual(origins.parse(["  "]), []);
  for (const given of ["ftp://x.edu", "mailto:a@x.edu", "https://", "not a site"]) {
    assert.throws(() => origins.parse([given]), (e) => e.message.includes(given));
  }
  assert.throws(() => origins.parse(["https://*.x.edu"]), (e) => e.message.includes("wildcard"));
  const list = ["https://b.edu", "https://a.edu"];
  assert.deepEqual(origins.of({ [origins.ATTRIBUTE]: origins.value(list) }), list);
  assert.deepEqual(origins.of({}), []);
});

test("origins: candidate matching", () => {
  const m = origins.matchesCandidate;
  const site = "https://www.bitmesra.ac.in";
  for (const c of [site, "www.bitmesra.ac.in", `${site}/`, "https://WWW.BITMESRA.AC.IN"]) assert.ok(m(site, c), c);
  assert.ok(m("http://localhost:3000", "http://localhost:3000"));
  assert.ok(m("http://localhost:3000", "localhost:3000"));
  for (const c of ["https://bitmesra.ac.in", "https://evil.com", "http://www.bitmesra.ac.in", ""]) assert.ok(!m(site, c), c);
  assert.ok(!m("http://localhost:3000", "localhost:4000"));
});

// ---- chatbot widget ----

const aWidget = () =>
  widgetMod.widget({
    title: "  BIT Admission Assistant ",
    placeholder: "Ask me about BIT Mesra",
    avatar: "https://bitmesra.ac.in/logo.png",
    greeting: 'Hi! How may I assist you with "admission"?\n',
    hide_watermark: true,
    colors: { heading: " #1F6FEB ", option: "" },
  });

test("widget: saved trimmed, and refused by name", () => {
  const c = widgetMod.checked(aWidget());
  assert.equal(c.title, "BIT Admission Assistant");
  assert.equal(c.greeting, 'Hi! How may I assist you with "admission"?');
  assert.deepEqual(c.colors, { heading: "#1f6feb" });
  const refused = (change) => {
    const w = aWidget();
    change(w);
    try {
      widgetMod.checked(w);
    } catch (e) {
      return e.message;
    }
    return "";
  };
  assert.ok(refused((w) => (w.title = "x".repeat(101))).includes("title"));
  assert.ok(refused((w) => (w.avatar = "http://x.edu/a.png")).includes("avatar"));
  assert.ok(refused((w) => (w.launcher_icon = "javascript:alert(1)")).includes("launcher"));
  assert.ok(refused((w) => (w.colors = { link: "red" })).includes("red"));
  assert.ok(refused((w) => (w.colors = { text: "#000" })).includes("`text`"));
});

// ---- sign-in ----

const CLIENT_ID = "test-client.apps.googleusercontent.com";
const verifier = () => Verifier.withKeys(CLIENT_ID, JSON.parse(fixture("test-jwks.json")));
const claims = () => {
  const now = Math.floor(Date.now() / 1000);
  return { iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "1234", email: "Owner@Example.org", email_verified: true, iat: now, exp: now + 600 };
};
const sign = async (kid, c) => new SignJWT(c).setProtectedHeader({ alg: "RS256", kid }).sign(await importPKCS8(fixture("test-key.pem"), "RS256"));

test("auth: accepts a Google token issued to this client", async () => {
  const user = await verifier().verify(await sign("test-key", claims()));
  assert.deepEqual([user.sub, user.email], ["1234", "owner@example.org"]);
});

test("auth: refuses tokens it must not trust", async () => {
  const withField = (k, v) => sign("test-key", { ...claims(), [k]: v });
  const tokens = [
    await withField("aud", "other.apps.googleusercontent.com"),
    await withField("iss", "https://evil.example"),
    await withField("exp", claims().exp - 7200),
    await withField("email_verified", false),
    await sign("other-key", claims()),
    "not.a.token",
  ];
  for (const t of tokens) await assert.rejects(verifier().verify(t));
  const token = await sign("test-key", claims());
  await assert.rejects(verifier().verify(token.slice(0, token.lastIndexOf(".") + 1)));
});
