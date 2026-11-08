// Deep re-ranking: narrow the candidate set, then score it in bounded concurrent batches.
//
// A reranker's scores must be comparable across calls, as a cross-encoder's are: it scores each
// (query, chunk) pair on its own. So a batch is only how many items, and how much text, one call
// may carry.

import { PluginError, RetrieveError } from "./errors.js";
import { cmpStr } from "./ids.js";
import { degradation } from "./report.js";
import { cutExempt, emptySummary, payloadBytes } from "./stage.js";
import { mapConcurrent, settle } from "./util.js";

/**
 * Chooses which candidates the model will judge: the top `deepInput` by retrieval score,
 * everything within `keepMargin` of that cutoff, and every sibling of an `Inseparable` hit. At
 * most `2 × deepInput`, in retrieval order, best first.
 */
export function narrow(candidates, plan) {
  const order = candidates.map((_, i) => i);
  order.sort((a, b) => {
    const x = candidates[a];
    const y = candidates[b];
    return y.retrieval - x.retrieval || cmpStr(x.id, y.id);
  });
  if (candidates.length <= plan.deepInput) return order;

  const cutoffAt = order[Math.max(plan.deepInput - 1, 0)];
  const cutoff = cutoffAt === undefined ? 0 : candidates[cutoffAt].retrieval;
  const floor = cutoff - plan.keepMargin;

  let kept = [];
  order.forEach((index, position) => {
    const candidate = candidates[index];
    if (position < plan.deepInput || candidate.retrieval >= floor || cutExempt(candidate)) {
      kept.push(index);
    }
  });

  // Bounded, but the broad pass's own hits come first.
  const hard = plan.deepInput * 2;
  if (kept.length > hard) {
    const exempt = kept.filter((i) => cutExempt(candidates[i]));
    const seeds = kept.filter((i) => !cutExempt(candidates[i]));
    const trimmed = new Set(seeds.slice(0, hard));
    const room = Math.max(hard - trimmed.size, 0);
    for (const i of exempt.slice(0, room)) trimmed.add(i);
    // Back in retrieval order, so the call ceiling cuts the weakest.
    kept = kept.filter((i) => trimmed.has(i));
  }
  return kept;
}

/** Scores the narrowed set. */
export async function rerank(r, query, candidates, deepSet, config, namespace, meter, degradations) {
  const reranker = r.reranker;
  // A documented path, not a degradation: retrieval order with zero model calls.
  if (!reranker || deepSet.length === 0) return emptySummary();

  // ---- batch plan, inside the call ceiling ----
  const declaredChars = r.limits.rerankChars;
  let planned = planBatches(candidates, deepSet, r.limits.rerankBatch, declaredChars);
  const ceiling = config.maxRerankCalls;
  if (planned.length > ceiling) {
    // `deepSet` is in retrieval order, so the cut drops the weakest.
    const before = planned.reduce((n, b) => n + b.length, 0);
    planned = planned.slice(0, ceiling);
    const after = planned.reduce((n, b) => n + b.length, 0);
    degradations.push(degradation("DeepInputReduced", { from: before, to: after }));
  }

  // ---- score ----
  const deadline = config.deadline;
  const results = await mapConcurrent(planned, config.concurrency.rerank, async (batch) => {
    if (deadline !== null && deadline !== undefined && Date.now() >= deadline) return null;
    // Text enters here and is dropped at the end of this call, which bounds resident text.
    const withoutText = batch.map((i) => candidates[i]).filter((c) => !c.payload).map((c) => c.id);
    const fetched = await r.getMany(withoutText, namespace, 1);
    const loadError = fetched.failed.length > 0 ? fetched.failed[fetched.failed.length - 1][1] : null;
    const loaded = fetched.chunks;
    let bytes = 0;
    for (const chunk of loaded.values()) bytes += payloadBytes(chunk.payload);
    meter.enter(bytes, loaded.size);

    const items = [];
    const present = [];
    const missing = [];
    let chars = 0;
    for (const index of batch) {
      const candidate = candidates[index];
      const payload = candidate.payload ?? loaded.get(candidate.id)?.payload;
      if (!payload) {
        // Left out rather than sent without text, and reported.
        missing.push(index);
        continue;
      }
      chars += candidate.meta.chars;
      items.push({
        id: candidate.id,
        context: payload.context,
        topic: payload.topic ?? null,
        text: payload.text,
      });
      present.push(index);
    }

    const out =
      items.length === 0
        ? null
        : await settle(Promise.resolve().then(() => reranker.rerank({ query, items })));
    meter.leave(bytes);
    return { indices: present, chars, missing, loadError, out };
  });

  // ---- one sequential merge pass ----
  const summary = emptySummary();
  let lastError = null;
  const textMissing = new Set();
  let loadError = null;
  let nonFinite = 0;
  let outOfRange = 0;
  let overBudget = 0;
  let largest = 0;

  for (const sent of results) {
    // A call the deadline skipped: `search` reports the deadline.
    if (sent === null) continue;
    for (const i of sent.missing) textMissing.add(i);
    if (sent.loadError) loadError = sent.loadError;
    // No item had text, so no call was made.
    if (sent.out === null) continue;
    summary.rerankCalls += 1;
    summary.rerankChars += sent.chars;
    if (declaredChars > 0 && sent.chars > declaredChars) {
      overBudget += 1;
      largest = Math.max(largest, sent.chars);
    }
    const indices = sent.indices;
    if (sent.out.ok) {
      const scores = sent.out.value;
      if (!Array.isArray(scores) || scores.length !== indices.length) {
        // The whole batch fails: misaligned scores would attribute one chunk's relevance to
        // another.
        const got = Array.isArray(scores) ? scores.length : 0;
        summary.batchesFailed += 1;
        lastError = PluginError.permanent(
          "reranker contract",
          `returned ${got} scores for ${indices.length} items`,
        );
        degradations.push(degradation("RerankContractViolated", { items: indices.length, got }));
        continue;
      }
      indices.forEach((index, n) => {
        const score = scores[n];
        // Out of range or non-finite is missing for this item only, never zero.
        if (typeof score !== "number" || !Number.isFinite(score)) nonFinite += 1;
        else if (score < 0 || score > 1) outOfRange += 1;
        else {
          candidates[index].modelScore = score;
          summary.deepScored += 1;
        }
      });
    } else {
      const error = PluginError.from(sent.out.error);
      summary.batchesFailed += 1;
      lastError = error.flattened();
      degradations.push(degradation("RerankBatchFailed", { items: indices.length, error }));
    }
  }

  if (textMissing.size > 0) {
    degradations.push(degradation("RerankTextMissing", { count: textMissing.size, error: loadError }));
  }
  if (nonFinite + outOfRange > 0) {
    degradations.push(degradation("RerankScoresUnusable", { nonFinite, outOfRange }));
  }
  if (overBudget > 0) {
    degradations.push(
      degradation("RerankCharBudgetExceeded", { calls: overBudget, budget: declaredChars, largest }),
    );
  }

  const attempted = Math.max(summary.rerankCalls, 1);
  if (summary.batchesFailed / attempted > config.maxFailedBatchRatio) {
    if (config.failOnExcessiveDegradation && lastError) {
      throw RetrieveError.rerankCollapsed(summary.batchesFailed, attempted, lastError);
    }
    degradations.push(degradation("RerankCollapsed", { failed: summary.batchesFailed, total: attempted }));
  }
  return summary;
}

/**
 * Cuts the set, in its order, into calls of at most `perBatch` items and `batchChars` chars of
 * text (0 meaning no budget). A call always keeps one item.
 */
function planBatches(candidates, deepSet, perBatch, batchChars) {
  const out = [];
  let current = [];
  let currentChars = 0;
  for (const index of deepSet) {
    const chars = candidates[index]?.meta.chars ?? 0;
    const overflowsChars = batchChars > 0 && current.length > 0 && currentChars + chars > batchChars;
    if (current.length >= perBatch || overflowsChars) {
      out.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(index);
    currentChars += chars;
  }
  if (current.length > 0) out.push(current);
  return out;
}
