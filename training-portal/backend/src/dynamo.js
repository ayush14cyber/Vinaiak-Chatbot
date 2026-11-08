// DynamoDB attribute values and items serialization helpers.

import { ConditionalCheckFailedException, TransactionCanceledException } from "@aws-sdk/client-dynamodb";

import { ApiError } from "./http.js";

export const S = (value) => ({ S: value });
export const N = (value) => ({ N: String(value) });
export const L = (values) => ({ L: values });
export const BOOL = (value) => ({ BOOL: value });

/** The string `key` of `item`, or `""`. */
export const string = (item, key) => (typeof item?.[key]?.S === "string" ? item[key].S : "");

/** The number `key` of `item`, or 0. */
export function number(item, key) {
  const n = item?.[key]?.N;
  if (n === undefined) return 0;
  const parsed = Number.parseInt(n, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** Unix seconds. */
export const nowSecs = () => Math.floor(Date.now() / 1000);

/** Whether `e` is a failed condition. */
export const conditionFailed = (e) => e instanceof ConditionalCheckFailedException || e?.name === "ConditionalCheckFailedException";

/** Whether `e` is a cancelled transaction. */
export const transactionCanceled = (e) => e instanceof TransactionCanceledException || e?.name === "TransactionCanceledException";

/** Runs `send`, an AWS call, its failure logged and answered as an internal error. */
export async function aws(send) {
  try {
    return await send();
  } catch (e) {
    throw ApiError.internal(e);
  }
}
