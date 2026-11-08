// Who is calling: a Google ID token in the session cookie (`session.js`), verified on every
// request. An org's admin can instead send one of their API keys as `Authorization: Bearer`
// (`keys.js`). What an admin may change is their folders (`admins.js`).

import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";

import { ApiError, caller } from "./http.js";

/** The header naming the org the master admin opened, to act as its root admin. */
const OPENED_ORG = "x-org";

/** The org the master admin opened, if the call names one. Only an account in `ADMIN_EMAILS` may. */
export function openedOrg(req) {
  const org = req.headers[OPENED_ORG];
  return typeof org === "string" ? org : null;
}

const GOOGLE_KEYS = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
/** How long fetched keys are used before fetching them again. */
const KEYS_TTL_MS = 60 * 60 * 1000;
/** The least time between fetches, so tokens naming unknown keys can't make every request fetch. */
const MIN_REFETCH_MS = 60 * 1000;

const signIn = () => ApiError.unauthorized("sign in with Google");

/** Verifies Google ID tokens issued to one OAuth client. */
export class Verifier {
  constructor(clientId, keys) {
    this.clientId = clientId;
    this.keys = keys;
  }

  /** Verifies tokens Google issued to `clientId`, against Google's published keys. */
  static google(clientId, http) {
    return new Verifier(clientId, { kind: "google", http, url: GOOGLE_KEYS, cache: null, fetching: null });
  }

  /** Verifies tokens signed with `jwks` instead of Google's: for tests, or none, to sign no one in. */
  static withKeys(clientId, jwks) {
    return new Verifier(clientId, { kind: "fixed", jwks });
  }

  /** The signed-in Google account of `token`: `{sub, email (lowercased), exp}`. */
  async verify(token) {
    let kid;
    try {
      kid = decodeProtectedHeader(token).kid;
    } catch {
      throw signIn();
    }
    if (!kid) throw signIn();
    let jwks = await this.jwks(false);
    if (!jwks.keys.some((key) => key.kid === kid)) jwks = await this.jwks(true);
    if (!jwks.keys.some((key) => key.kid === kid)) throw signIn();
    let claims;
    try {
      ({ payload: claims } = await jwtVerify(token, createLocalJWKSet(jwks), {
        algorithms: ["RS256"],
        audience: this.clientId,
        issuer: GOOGLE_ISSUERS,
        requiredClaims: ["exp", "aud", "iss", "sub"],
        clockTolerance: 60,
      }));
    } catch {
      throw signIn();
    }
    if (typeof claims.sub !== "string" || typeof claims.email !== "string") throw signIn();
    if (claims.email_verified !== true) {
      throw ApiError.forbidden("verify your Google account's email first");
    }
    return { sub: claims.sub, email: claims.email.toLowerCase(), exp: claims.exp };
  }

  /**
   * The signing keys: cached, or fetched when `refetch` (a token named a key the cache lacks) or
   * when the cache is older than `KEYS_TTL_MS`. If fetching fails, the cached keys are used, and
   * fetched again after `MIN_REFETCH_MS`.
   */
  async jwks(refetch) {
    const keys = this.keys;
    if (keys.kind === "fixed") return keys.jwks;
    const fresh = () => {
      if (!keys.cache) return null;
      const limit = refetch ? MIN_REFETCH_MS : KEYS_TTL_MS;
      return Date.now() - keys.cache.at < limit ? keys.cache.jwks : null;
    };
    const cached = fresh();
    if (cached) return cached;
    // One fetch at a time; others wait for it.
    keys.fetching ??= (async () => {
      try {
        const jwks = await fetchKeys(keys.http, keys.url);
        keys.cache = { jwks, at: Date.now() };
        return jwks;
      } catch (error) {
        // Google publishes a key long before signing with it, so the last keys still verify
        // almost every token, where failing would sign everyone out.
        if (!keys.cache) throw error;
        console.warn(JSON.stringify({ level: "WARN", msg: `${error.message}, so the keys fetched before are used` }));
        keys.cache = { jwks: keys.cache.jwks, at: Date.now() - (KEYS_TTL_MS - MIN_REFETCH_MS) };
        return keys.cache.jwks;
      } finally {
        keys.fetching = null;
      }
    })();
    return keys.fetching;
  }
}

async function fetchKeys(http, url) {
  let res;
  try {
    res = await http(url);
  } catch (e) {
    throw ApiError.upstream(`fetching Google's keys failed: ${e.message}`);
  }
  if (!res.ok) throw ApiError.upstream(`fetching Google's keys failed: HTTP status ${res.status}`);
  try {
    const jwks = await res.json();
    if (!Array.isArray(jwks?.keys)) throw new Error("missing field `keys`");
    return jwks;
  } catch (e) {
    throw ApiError.upstream(`Google's keys don't parse: ${e.message}`);
  }
}

/** The Google ID token in the request's session cookie. */
export function idToken(req, cookie) {
  const header = req.headers.cookie;
  const values = Array.isArray(header) ? header : header ? [header] : [];
  for (const value of values) {
    for (const pair of value.split(";")) {
      const trimmed = pair.trim();
      if (trimmed.startsWith(`${cookie}=`)) return trimmed.slice(cookie.length + 1);
    }
  }
  throw signIn();
}
