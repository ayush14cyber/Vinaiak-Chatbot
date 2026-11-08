// Signing in to the portal's pages. Google's ID token is kept in an httpOnly cookie, so the pages'
// scripts never hold it. The pages reach this API through their own origin (Vercel rewrites their
// `/api`), so the cookie is first-party.

import { nowSecs } from "./dynamo.js";
import { body } from "./http.js";

/**
 * The cookie holding the token. `__Host-` makes browsers refuse it unless it's `Secure`, on
 * `Path=/`, and set by this host alone.
 */
export const COOKIE = "__Host-id_token";

/** The session cookie holding `value` for `maxAge` seconds. */
function cookie(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

/** `POST /session {credential}`: checks Google's ID token, then keeps it in the cookie until it expires. */
export async function signIn(app, req) {
  const { credential } = body(req, { credential: "string" });
  // Verified, it's a JWT: only base64url and dots, so it can't break out of the cookie.
  const user = await app.verifier.verify(credential);
  const maxAge = Math.max(user.exp - nowSecs(), 0);
  return { status: 204, headers: { "set-cookie": cookie(credential, maxAge) } };
}

/** `DELETE /session`: signs out, dropping the cookie. */
export async function signOut() {
  return { status: 204, headers: { "set-cookie": cookie("", 0) } };
}
