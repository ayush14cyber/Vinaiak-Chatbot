// The pure properties: fingerprint stability and framing, UTF-8-safe splitting, dial monotonicity.

import assert from "node:assert/strict";
import { test } from "node:test";

import { Cohesion, ContextPlacement, RetrievalConfig, ids, text } from "../src/index.js";

test("fnv1a64 is stable and field-framed", () => {
  // Pinned goldens, the same values the Rust engine pinned: a change would invalidate every
  // fingerprint already written to a production index.
  assert.equal(ids.fnv1a64([]), 0xcbf29ce484222325n);
  assert.equal(ids.fnv1a64([""]), 0xa8c7f832281a39c5n);
  assert.equal(ids.fnv1a64(["a"]), 0x529a4ddc8ff56bbfn);
  assert.equal(ids.fnv1a64(["a", "b"]), 0x41c80da72d0aec94n);
  assert.equal(ids.fnv1a64(["hello world"]), 0xdd238b944d9d0096n);
  assert.notEqual(ids.fnv1a64(["a", "b"]), ids.fnv1a64(["b", "a"]));
  assert.notEqual(ids.fnv1a64(["ab", ""]), ids.fnv1a64(["a", "b"]));
  assert.notEqual(ids.fnv1a64(["", "ab"]), ids.fnv1a64(["a", "b"]));
  assert.notEqual(ids.fnv1a64(["ab"]), ids.fnv1a64(["a", "b"]));
});

test("stateFp covers groupLen, cohesion, placement, topic presence, embedder and metadata", () => {
  const fp = (overrides = {}) => {
    const a = { context: "ctx", text: "body", topic: "topic", placement: ContextPlacement.Prepend, groupLen: 4, cohesion: Cohesion.Distinct, embedder: "emb/1", metadata: {}, ...overrides };
    return ids.stateFp(a.context, a.text, a.topic, a.placement, a.groupLen, a.cohesion, a.embedder, a.metadata);
  };
  const base = fp();
  assert.equal(base, fp());
  assert.notEqual(base, fp({ groupLen: 5 }));
  assert.notEqual(base, fp({ cohesion: Cohesion.Inseparable }));
  assert.notEqual(base, fp({ placement: ContextPlacement.Append }));
  assert.notEqual(base, fp({ topic: null }));
  assert.notEqual(fp({ topic: "" }), fp({ topic: null }));
  assert.notEqual(base, fp({ embedder: "emb/2" }));
  assert.notEqual(base, fp({ metadata: { org: "1" } }));
  assert.notEqual(fp({ metadata: { org: "1" } }), fp({ metadata: { org: "3" } }));
});

test("contentFp ignores context and whitespace", () => {
  assert.equal(ids.contentFp("Fees are   refundable."), ids.contentFp("  Fees are\n\trefundable.  "));
  assert.notEqual(ids.contentFp("Fees are refundable."), ids.contentFp("Fees are not refundable."));
});

test("chunk ids round-trip", () => {
  const c = ids.chunkId("docs/phd/admission.md", 3, 7);
  assert.equal(c, "docs/phd/admission.md#g3.p7");
  assert.deepEqual(ids.position(c), [3, 7]);
  assert.equal(ids.documentOf(c), "docs/phd/admission.md");
  assert.equal(ids.groupId("docs/phd/admission.md", 3), "docs/phd/admission.md#g3");
  assert.deepEqual(ids.siblings("d", 3, 2), ["d#g3.p0", "d#g3.p1"]);
  for (const bad of ["no-separator", "doc#g3", "doc#3.p7", "doc#g3.7", "doc#gx.p7", "doc#g3.px", "#g3.p7", "doc#g-1.p7"]) {
    assert.equal(ids.position(bad), null, bad);
  }
});

test("sizeSplit is lossless, char-safe and bounded", () => {
  const sample = "नमस्ते दुनिया। ".repeat(50) + "😀".repeat(30) + "\n\nend.";
  const pieces = text.sizeSplit(sample, 37, 0);
  assert.equal(pieces.join(""), sample);
  for (const piece of pieces) assert.ok(text.charCount(piece) <= 37);
  assert.deepEqual(text.sizeSplit("", 10, 0), []);
  assert.deepEqual(text.sizeSplit("short", 10, 3), ["short"]);
  // A blank line is preferred over a sentence end.
  assert.deepEqual(text.sizeSplit("aaaa. bbbb\n\ncccc", 12, 0), ["aaaa. bbbb\n\n", "cccc"]);
});

test("the context renders breadcrumb, context and topic", () => {
  assert.equal(text.renderContext(["BIT  Mesra", "", "UG"], "  fees ", "Fees"), "BIT Mesra -> UG\nfees\nFees");
  assert.equal(text.embedText("", "body", ContextPlacement.Both), "body");
});

test("every derived knob is monotone in recall", () => {
  let previous = null;
  for (let i = 0; i <= 100; i++) {
    const plan = new RetrievalConfig(8).withRecall(i / 100).resolve({});
    if (previous) {
      assert.ok(plan.fanOut >= previous.fanOut);
      assert.ok(plan.maxCandidates >= previous.maxCandidates);
      assert.ok(plan.deepInput >= previous.deepInput);
      assert.ok(plan.neighborWindow >= previous.neighborWindow);
      assert.ok(plan.siblingInherit >= previous.siblingInherit);
      assert.ok(plan.keepMargin >= previous.keepMargin);
      assert.ok(plan.minScore <= previous.minScore);
      assert.ok(plan.minResults >= previous.minResults);
      assert.ok(plan.hardCapMultiplier >= previous.hardCapMultiplier);
      assert.ok(!previous.expandDistinct || plan.expandDistinct);
      assert.equal(plan.modelWeight, previous.modelWeight);
    }
    previous = plan;
  }
});

test("the dial's table holds at its documented points", () => {
  const at = (r) => new RetrievalConfig(8).withRecall(r).resolve({});
  assert.deepEqual([at(0).fanOut, at(0.5).fanOut, at(0.8).fanOut, at(1).fanOut], [50, 224, 549, 1000]);
  assert.deepEqual([at(0).deepInput, at(0.5).deepInput, at(0.8).deepInput, at(1).deepInput], [16, 64, 147, 256]);
  assert.deepEqual([at(0).minResults, at(0.5).minResults, at(0.8).minResults, at(1).minResults], [0, 4, 6, 8]);
  assert.equal(new RetrievalConfig(8).resolve({ maxTopK: 100 }).fanOut, 100);
});
