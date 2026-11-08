// Signing visitors in: `POST /login` checks reCAPTCHA on the site the widget is on and that the
// org's chatbot may be embedded there, then gives an HS256 JWT for a session. Every other route
// checks the token and the site, and claims a request of the session (`verifyAndLoadSession`).

import { randomUUID } from "node:crypto";

import { SignJWT, decodeProtectedHeader, jwtVerify } from "jose";
import { chatbotOrg } from "training-portal-backend";

import { ApiError } from "./errors.js";
import * as session from "./session.js";

/** The training portal, where an org's owner tries its chatbot: allowed for every org. */
export const PORTAL_ORIGIN = "https://train.vinaiak.com";
const SITEVERIFY = "https://www.google.com/recaptcha/api/siteverify";
/** How long a token lasts, in seconds. */
const TOKEN_SECS = 3600;
/** Leeway for `exp`, as jsonwebtoken's default. */
const LEEWAY_SECS = 60;

/** Whether reCAPTCHA's answer passes a human on `hostname`. */
export function passed(res, hostname) {
  return (
    res.success === true &&
    (res.score ?? 0) >= 0.7 &&
    hostname.length > 0 &&
    typeof res.hostname === "string" &&
    res.hostname.toLowerCase() === hostname.toLowerCase()
  );
}

/** Checks the captcha was passed on `hostname`. */
async function verifyCaptcha(http, token, secret, hostname) {
  let res;
  try {
    const answer = await http(SITEVERIFY, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token }),
    });
    res = await answer.json();
  } catch (e) {
    throw ApiError.internal(e);
  }
  if (passed(res, hostname)) return;
  const show = (v) => (v === undefined || v === null ? "None" : `Some(${JSON.stringify(v)})`);
  throw ApiError.captchaFailed(`score ${show(res.score)}, solved on ${show(res.hostname)}, expected ${hostname}`);
}

const keyOf = (secret) => new TextEncoder().encode(secret);

/** A signed token: `{org_id, id, origin, exp, iat}`. */
export function sign(claims, secret) {
  return new SignJWT(claims).setProtectedHeader({ alg: "HS256", typ: "JWT" }).sign(keyOf(secret));
}

/** The claims of `token`, if we signed it, checking `exp` unless `expired` is allowed. */
async function claimsOf(token, secret, { allowExpired = false } = {}) {
  const header = decodeProtectedHeader(token);
  if (header.alg !== "HS256") throw new Error("InvalidAlgorithm");
  const { payload } = await jwtVerify(token, keyOf(secret), {
    algorithms: ["HS256"],
    clockTolerance: LEEWAY_SECS,
    // Checked below, so an expired one can still be read.
    currentDate: allowExpired ? new Date(0) : undefined,
  });
  for (const field of ["org_id", "id", "origin"]) if (typeof payload[field] !== "string") throw new Error(`missing field \`${field}\``);
  if (!Number.isInteger(payload.exp)) throw new Error("missing field `exp`");
  return payload;
}

/**
 * The session of `token`, an earlier login's, to continue: if we signed it, for this org and site.
 * It may have expired, as its session outlives it.
 */
export async function previousSession(token, secret, orgId, origin) {
  try {
    const t = await claimsOf(token, secret, { allowExpired: true });
    return t.org_id === orgId && t.origin === origin ? t.id : null;
  } catch {
    return null;
  }
}

/** The `Origin` header, which every call must have. */
export function originOf(req) {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin.length === 0) throw headerMissing("origin");
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw headerInvalid("origin");
  }
  // As the `Origin` header type prints it.
  return { text: origin === "null" ? "null" : `${url.protocol}//${url.host}`, hostname: url.hostname };
}

/** The bearer token of `req`, if it has one. */
export function bearer(req) {
  const auth = req.headers.authorization;
  if (typeof auth !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return match ? match[1] : null;
}

/** A header the call needs but lacks: 400 Bad Request. */
export class HeaderError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}
const headerMissing = (name) => new HeaderError(`Header of type \`${name}\` was missing`);
const headerInvalid = (name) => new HeaderError(`invalid HTTP header (${name})`);

/**
 * `POST /login {google_captcha_token, org_id}`: signs a visitor in. With an earlier login's token,
 * it continues that conversation if the session is still stored; otherwise it starts a new one.
 * `{token, resumed}`.
 */
export async function createJwt(configs, req, log) {
  const origin = originOf(req);
  const previous = bearer(req);
  const login = loginBody(req);
  log.org(login.org_id);
  await verifyCaptcha(configs.http, login.google_captcha_token, configs.grecaptchaKey, origin.hostname);

  const host = origin.text;
  let found;
  try {
    found = await chatbotOrg(configs.dynamo, login.org_id);
  } catch (e) {
    throw ApiError.internal(e);
  }
  if (!found || !(found.allows(host) || host.toLowerCase() === PORTAL_ORIGIN.toLowerCase())) {
    throw ApiError.unauthorized(`no approved org with a chatbot on ${host}`);
  }
  if (!found.openrouterKey) throw ApiError.notFound("This org's chatbot isn't set up yet");
  const o = session.org(found.orgName, found.openrouterKey, found.mongodbKey ?? null);
  const prev = previous ? await previousSession(previous, configs.jwtSecret, login.org_id, host) : null;
  let id;
  let resumed = false;
  if (prev && (await session.resume(configs.s3, prev, o))) {
    [id, resumed] = [prev, true];
  } else {
    // A new id even for a session that's gone: its data-not-found report stays until the owner
    // dismisses it, and the new conversation's must not overwrite it.
    id = randomUUID();
    await session.create(configs.s3, id, o);
  }
  log.session(id);
  const now = Math.floor(Date.now() / 1000);
  const token = await sign({ org_id: login.org_id, id, origin: host, exp: now + TOKEN_SECS, iat: now }, configs.jwtSecret);
  return { token, resumed };
}

function loginBody(req) {
  let value;
  try {
    value = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "");
  } catch (e) {
    throw new HeaderError(`Failed to parse the request body as JSON: ${e.message}`);
  }
  for (const field of ["google_captcha_token", "org_id"]) {
    if (typeof value?.[field] !== "string") {
      const e = new HeaderError(`Failed to deserialize the JSON body into the target type: missing field \`${field}\``);
      e.status = 422;
      throw e;
    }
  }
  return value;
}

/** Checks the call's token and site, and claims a request of its session: `{token, session}`. */
export async function verifyAndLoadSession(configs, req, log) {
  const raw = bearer(req);
  if (!raw) throw headerMissing("authorization");
  const origin = originOf(req).text;
  let token;
  try {
    token = await claimsOf(raw, configs.jwtSecret);
  } catch (e) {
    throw ApiError.unauthorized(`invalid session token: ${e.code === "ERR_JWT_EXPIRED" ? "ExpiredSignature" : e.message}`);
  }
  log.org(token.org_id);
  log.session(token.id);
  if (origin !== token.origin) throw ApiError.unauthorized(`a token of ${token.origin} used on ${origin}`);
  return { token, session: await session.claim(configs.s3, token.id) };
}
