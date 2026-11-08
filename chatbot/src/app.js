// The chatbot's routes: `POST /login`, then, with its token and on the same site, `POST /chat`
// and `POST /reset`. Every call is logged once it has ended (`call-log.js`).

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { S3VectorsClient } from "@aws-sdk/client-s3vectors";
import express from "express";
import { awsConfig, httpClient } from "training-portal-backend";

import { createJwt, verifyAndLoadSession } from "./auth.js";
import { callLog } from "./call-log.js";
import { MAX_BODY_BYTES, chat, reset } from "./chat.js";
import { ApiError, asApiError } from "./errors.js";

/** Largest body of the other routes (2 MB default limit). */
const DEFAULT_BODY_BYTES = 2 * 1024 * 1024;

/** What the routes use: AWS clients, `fetch`, and the secrets. */
export function configsFromEnv() {
  const env = (name) => {
    const value = process.env[name];
    if (value === undefined) throw new Error(`${name} isn't set`);
    return value;
  };
  const config = awsConfig();
  return {
    dynamo: new DynamoDBClient(config),
    s3: new S3Client(config),
    s3v: new S3VectorsClient(config),
    http: httpClient(),
    jwtSecret: env("JWT_SECRET"),
    grecaptchaKey: env("GRECAPTCHA_KEY"),
  };
}

/** Sends `error`: an `ApiError` as `{code, message}`, else as Express answers it. */
function fail(res, error) {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (error instanceof ApiError || !error?.status) {
    const e = asApiError(error);
    res.locals.failure = e.message;
    res.status(e.status).json(e.body());
    return;
  }
  res.locals.failure = error.message;
  res.status(error.status).type("text/plain").send(error.message);
}

/** A handler answering through `fail` when it throws. */
const route = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (e) {
    fail(res, e);
  }
};

/** The chatbot's Express app. */
export function app(configs) {
  const server = express();
  server.disable("x-powered-by");
  server.use(callLog());

  const raw = (limit) => express.raw({ type: () => true, limit });
  const signedIn = (handler) =>
    route(async (req, res) => {
      const call = await verifyAndLoadSession(configs, req, req.callLog);
      await handler(req, res, call);
    });

  server.post(
    "/login",
    raw(DEFAULT_BODY_BYTES),
    route(async (req, res) => res.json(await createJwt(configs, req, req.callLog))),
  );
  server.post(
    "/chat",
    raw(MAX_BODY_BYTES),
    signedIn((req, res, call) => chat(configs, req, res, call, req.callLog)),
  );
  server.post(
    "/reset",
    raw(DEFAULT_BODY_BYTES),
    signedIn(async (req, res, call) => {
      await reset(configs, call);
      res.status(204).end();
    }),
  );
  server.use((req, res) => res.status(404).end());
  // A body too large, or one Express couldn't read.
  server.use((err, req, res, _next) => {
    const status = err.status ?? 500;
    const message = status === 413 ? "Failed to buffer the request body: length limit exceeded" : err.message;
    res.locals.failure = message;
    res.status(status).type("text/plain").send(message);
  });
  return server;
}
