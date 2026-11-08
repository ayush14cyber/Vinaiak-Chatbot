// Small helpers shared by the stages.

/**
 * `fn` over every item, at most `limit` at once, the results in input order. The bounded
 * concurrency primitive at every fan-out point.
 */
export async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  const workers = [];
  for (let i = 0; i < Math.min(Math.max(limit, 1), items.length); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/** Settles `promise` into `{ok, value}` or `{ok: false, error}`, never throwing. */
export async function settle(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

/** `items` cut into batches of at most `size`. */
export function batches(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** `x` within `lo..=hi`. */
export function clamp(x, lo, hi) {
  return Math.min(Math.max(x, lo), hi);
}
