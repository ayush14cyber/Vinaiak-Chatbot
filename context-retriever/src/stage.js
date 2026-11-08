// What the read path's stages share: the candidate helpers and the text meter.

import { byteLength } from "./text.js";

/** Measured peak resident payload text, so the memory bound is verifiable in production. */
export class TextMeter {
  constructor() {
    this.current = 0;
    this.peak = 0;
    this.loaded = 0;
  }

  enter(bytes, chunks) {
    this.loaded += chunks;
    this.current += bytes;
    this.peak = Math.max(this.peak, this.current);
  }

  leave(bytes) {
    this.current -= bytes;
  }
}

/** Payload bytes, as the meter counts them. */
export const payloadBytes = (payload) => byteLength(payload.text) + byteLength(payload.context);

/** Exempt from the narrowing cut: a sibling of an `Inseparable` hit. */
export const cutExempt = (candidate) => candidate.provenance.kind === "sibling";

/** What the deep pass did, when it did nothing. */
export function emptySummary() {
  return { deepScored: 0, rerankCalls: 0, batchesFailed: 0, rerankChars: 0 };
}
