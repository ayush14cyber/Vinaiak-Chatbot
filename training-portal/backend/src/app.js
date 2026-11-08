// What every route shares: the AWS clients, the outbound HTTP client, who may sign in, and the
// org's retriever.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { S3VectorsClient } from "@aws-sdk/client-s3vectors";
import { retriever as rag } from "rag";

import { Verifier } from "./auth.js";

export const REGION = "ap-south-1";
/** Registration requests waiting for an admin, by `org_id`. */
export const PENDING_TABLE = "pending_organisations";
/** Approved orgs, by `org_id`, with the folders they keep while empty. */
export const ORGS_TABLE = "organisations";
/** `rag`'s side index of every org's documents: `org_id`, `doc_id`, `chunks`. */
export const DOCS_TABLE = "org_documents";
/** The S3 Vectors bucket, with one index per org named by its id. */
export const VECTOR_BUCKET = "training-portal-vectors";
/** Index of `PENDING_TABLE` and `ORGS_TABLE` on `owner_sub`. */
export const BY_OWNER = "by_owner";
/** The orgs' API keys, by their SHA-256. */
export const KEYS_TABLE = "org_api_keys";
/** The index of `KEYS_TABLE` by org. */
export const BY_ORG = "by_org";
/** Every org's watchers, by `org_id` and the `id` of what they keep. */
export const WATCHERS_TABLE = "org_watchers";
/** Each org admin's folders, by email. */
export const ADMINS_TABLE = "org_admins";
/** The Lambda that runs the watchers. */
export const WATCHER_FUNCTION = "training-portal-watcher";
/** The largest request body: a Lambda Function URL takes 6 MB. */
export const MAX_BODY = 6 << 20;
/**
 * The longest an outbound call takes, unless it sets its own: a media link's `HEAD`, or fetching
 * Google's keys.
 */
const HTTP_TIMEOUT_MS = 10_000;

/**
 * `fetch`, giving up after `HTTP_TIMEOUT_MS` unless the call sets its own `timeoutMs`.
 *
 * @returns {(url: string, init?: RequestInit & {timeoutMs?: number}) => Promise<Response>}
 */
export function httpClient() {
  return (url, { timeoutMs = HTTP_TIMEOUT_MS, ...init } = {}) =>
    fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/** The AWS clients' config: the usual credential chain, in `REGION`. */
export const awsConfig = () => ({ region: REGION });

export class App {
  /**
   * @param {Verifier} verifier who may sign in
   * @param {string[]} admins the emails of the accounts that approve and reject registrations
   */
  constructor(verifier, admins, config = awsConfig()) {
    this.dynamo = new DynamoDBClient(config);
    this.s3v = new S3VectorsClient(config);
    this.s3 = new S3Client({ ...config, requestChecksumCalculation: "WHEN_REQUIRED" });
    this.lambda = new LambdaClient(config);
    this.http = httpClient();
    this.verifier = verifier;
    /** Lowercased. */
    this.admins = admins.map((email) => email.toLowerCase());
  }

  /** The app for the watcher Lambda, which signs no one in. */
  static withoutSignIn(config = awsConfig()) {
    return new App(Verifier.withKeys("", { keys: [] }), [], config);
  }

  /** The app, configured by env: `GOOGLE_CLIENT_ID`, and `ADMIN_EMAILS`, comma-separated. */
  static fromEnv() {
    const env = (name) => {
      const value = process.env[name];
      if (value === undefined) throw new Error(`${name} isn't set`);
      return value;
    };
    const admins = env("ADMIN_EMAILS")
      .split(",")
      .map((email) => email.trim())
      .filter((email) => email.length > 0);
    if (admins.length === 0) throw new Error("ADMIN_EMAILS lists no email");
    return new App(Verifier.google(env("GOOGLE_CLIENT_ID"), httpClient()), admins);
  }

  /**
   * The retriever for `owner`'s org, whose models bill to the org's OpenRouter key, and its
   * reranker to its MongoDB key.
   */
  retriever(owner) {
    return rag.build(owner.keys.openrouter(), owner.keys.mongodb(), this.dynamo, this.s3v, DOCS_TABLE, VECTOR_BUCKET);
  }

  isAdmin(email) {
    return this.admins.includes(email);
  }
}
