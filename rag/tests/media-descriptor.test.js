import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { Media, MediaDescriptor, Step, context, describe, escape, parseLinks, pieces, splice, steps } from "../src/media-descriptor.js";

const urls = (md) => parseLinks(md).map((link) => link.url);
const slice = (md, [a, b]) => md.slice(a, b);

test("a description stays its link's text", () => {
  const description = "| Fee | [1] |\nSee [the notice](https://x.com/n.pdf), \\ and ] or [ alone, ending \\";
  const md = "A [photo](https://x.com/a.png) here";
  const escaped = escape(description);
  const described = splice(md, [[parseLinks(md)[0].text, escaped]]);
  assert.deepEqual(urls(described), ["https://x.com/a.png"]);
  assert.equal(slice(described, parseLinks(described)[0].text), escaped);
});

/**
 * An OpenAI-compatible API that answers every request with `status` and an error, counting them.
 * A `HEAD` it answers as a PNG's server would, without counting it.
 */
async function failingApi(status) {
  const calls = { count: 0 };
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.method === "HEAD") {
        res.writeHead(200, { "content-type": "image/png", "content-length": 0 });
        return res.end();
      }
      calls.count += 1;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "refused", code: status } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  return [`http://127.0.0.1:${server.address().port}`, calls];
}

function describeAt(url) {
  const md = "Fees\n![fees](https://x.com/fees.png)\n";
  return describe(new MediaDescriptor("key", url).ai, md, parseLinks(md)[0], Media.Image);
}

test("a refused key isn't tried again", async () => {
  const [url, calls] = await failingApi(402);
  await assert.rejects(describeAt(url));
  assert.equal(calls.count, 1);
});

test("a file too large keeps its text", async () => {
  const [url, calls] = await failingApi(413);
  assert.equal(await describeAt(url), null);
  assert.equal(calls.count, 1);
});

test("a file that fails is marked, and described again on the next save", async () => {
  const [url, calls] = await failingApi(402);
  const md = `# Fees\n![fees](${url}/fees.png)\n`;
  const run = async (api, markdown, previous) =>
    (await new MediaDescriptor("key", api).describeMedia(fetch, markdown, previous, false)).join("");
  const saved = await run(url, md, "");
  assert.equal(saved, md.replace("![fees]", "![fees ]"), "kept, marked");
  assert.equal(calls.count, 1);
  assert.equal(await run(url, saved, saved), saved);
  assert.equal(calls.count, 2);
  const [tooLarge] = await failingApi(413);
  assert.equal(await run(tooLarge, saved, saved), md);
});

test("parses links and images", () => {
  const md = "see [a](https://x.com/a.pdf) and ![b c](https://x.com/b.png)";
  const links = parseLinks(md);
  assert.equal(links.length, 2);
  assert.equal(slice(md, links[0].text), "a");
  assert.equal(slice(md, links[0].range), "[a](https://x.com/a.pdf)");
  assert.equal(slice(md, links[1].text), "b c");
  assert.equal(links[1].url, "https://x.com/b.png");
});

test("parses destination forms, and skips non-links", () => {
  for (const md of ['[a](https://x.com/a.png "title")', "[a](https://x.com/a.png 'title')", "[a](https://x.com/a.png (title))", "[a]( https://x.com/a.png )"]) {
    assert.deepEqual(urls(md), ["https://x.com/a.png"], md);
  }
  assert.deepEqual(urls("[a](<https://x.com/a b.png>)"), ["https://x.com/a b.png"]);
  assert.deepEqual(urls("[a](https://x.com/f(1).png)"), ["https://x.com/f(1).png"]);
  assert.deepEqual(urls("[a](img/a.png)"), ["img/a.png"]);
  for (const md of ["[a] (https://x.com/a.png)", "\\[a](https://x.com/a.png)", "[a](https://x.com/a.png", "[a](https://x.com/a.png title)", "[a]"]) {
    assert.deepEqual(urls(md), [], md);
  }
});

test("a nested link comes first", () => {
  const md = "[![chart](https://x.com/c.png)](https://x.com/page)";
  const links = parseLinks(md);
  assert.equal(links[0].url, "https://x.com/c.png");
  assert.equal(slice(md, links[0].text), "chart");
  assert.deepEqual(links[1].range, [0, md.length]);
});

test("the context window", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  const md = `${lines}\n[a](https://x.com/a.png)\n${lines}`;
  assert.equal(
    context(md, parseLinks(md)[0]),
    "line 15\nline 16\nline 17\nline 18\nline 19\n[a](https://x.com/a.png)\nline 0\nline 1\nline 2",
  );
  const short = "top\n[a](https://x.com/a.png)\nend";
  assert.equal(context(short, parseLinks(short)[0]), short);
  const multi = "0\n1\n2\n3\n4\n5\n[a\nb](https://x.com/a.png)\n6\n7\n8\n9";
  assert.equal(context(multi, parseLinks(multi)[0]), "1\n2\n3\n4\n5\n[a\nb](https://x.com/a.png)\n6\n7\n8");
});

const STORED =
  "## Faculty\n![Photo of Prof. A. Kumar](https://x.com/kumar.jpg)\nSee [the fees](https://x.com/fees.pdf) and [our site](https://x.com).";
const stepsOf = (md, previous, force) => steps(md, parseLinks(md), previous, force);

test("what a link needs, given the stored version", () => {
  for (const force of [false, true]) {
    assert.deepEqual(stepsOf(`${STORED}\nOne more line.`, STORED, force), [Step.Keep, Step.Keep, Step.Keep]);
    assert.deepEqual(stepsOf("![](https://x.com/new.png) [notice](https://x.com/notice.pdf)", "", force), [Step.Describe, Step.Describe]);
  }
  for (const alt of ["kumar", ""]) {
    assert.deepEqual(stepsOf(`![${alt}](https://x.com/kumar.jpg)`, STORED, false), [Step.restore("Photo of Prof. A. Kumar")]);
  }
  assert.deepEqual(stepsOf("[home](https://x.com)", STORED, false), [Step.restore("our site")]);
  assert.deepEqual(stepsOf("![Photo of Prof. Ajay Kumar](https://x.com/kumar.jpg)", STORED, true), [Step.Keep]);
  assert.deepEqual(stepsOf("![](https://x.com/kumar.jpg) [](https://x.com/fees.pdf)", STORED, true), [Step.Describe, Step.Describe]);
  assert.deepEqual(stepsOf("![Photo of Prof. A. Kumar ](https://x.com/kumar.jpg)", STORED, true), [Step.Describe]);
  const failed = "![kumar ](https://x.com/kumar.jpg)";
  for (const [md, force] of [[failed, false], [failed, true], ["![kumar](https://x.com/kumar.jpg)", false]]) {
    assert.deepEqual(stepsOf(md, failed, force), [Step.Describe], md);
  }
  const twice = "![](https://x.com/a.png) ![First](https://x.com/a.png) ![Second](https://x.com/a.png)";
  assert.deepEqual(stepsOf("![alt](https://x.com/a.png)", twice, false), [Step.restore("First")]);
  assert.deepEqual(stepsOf("![alt](https://x.com/a.png)", "![](https://x.com/a.png)", false), [Step.Describe]);
});

test("pieces", () => {
  assert.deepEqual(pieces("a\n\nb\n", 100), ["a\n\nb\n"]);
  assert.deepEqual(pieces("éé\néé\n", 6), ["éé\néé\n"]);
  assert.deepEqual(pieces("1234\n5678\n\n9abc\ndefg\nhijk\n", 20), ["1234\n5678\n\n", "9abc\ndefg\nhijk\n"]);
  assert.deepEqual(pieces("\n1234\n5678\n9abc\ndefg\n", 12), ["\n1234\n5678\n", "9abc\ndefg\n"]);
  const long = "x".repeat(30);
  assert.deepEqual(pieces(`ab\n${long}\ncd`, 10), ["ab\n", `${long}\n`, "cd"]);
  assert.deepEqual(pieces("", 10), []);
  assert.deepEqual(pieces("\n \n\n", 2), []);
});
