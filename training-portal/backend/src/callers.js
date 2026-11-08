// Who a request is from, checked before anything it asks: a signed-in account, the master admin,
// or an admin of an approved org, signed in or calling with one of their API keys.

import * as admins from "./admins.js";
import { idToken, openedOrg } from "./auth.js";
import { ApiError, caller } from "./http.js";
import * as keys from "./keys.js";
import * as orgs from "./orgs.js";
import { COOKIE } from "./session.js";

/** The signed-in Google account: `{sub, email, exp}`. */
export function user(app, req) {
  return app.verifier.verify(idToken(req, COOKIE));
}

/** A signed-in account listed in `ADMIN_EMAILS`. */
export async function admin(app, req) {
  const u = await user(app, req);
  if (!app.isAdmin(u.email)) throw ApiError.forbidden("only an admin can do this");
  caller(null, "admin");
  return u;
}

/** An admin of an approved org: signed in, or calling with one of their API keys. */
export async function owner(app, req) {
  const o = await ownerOf(app, req);
  caller(o.org, o.byKey ? "api-key" : "cookie");
  return o;
}

async function ownerOf(app, req) {
  const authorization = req.headers.authorization;
  if (authorization !== undefined) {
    const key = authorization.startsWith("Bearer ") ? authorization.slice(7) : null;
    if (!key || !key.startsWith(keys.PREFIX)) {
      throw ApiError.unauthorized("this isn't an API key; create one in the portal");
    }
    const o = await keys.owner(app, key);
    if (!o) throw ApiError.unauthorized("this API key was revoked, or never existed");
    return o;
  }
  const u = await user(app, req);
  const opened = openedOrg(req);
  if (opened !== null) {
    if (!app.isAdmin(u.email)) throw ApiError.forbidden("only the master admin can open an org");
    const org = await orgs.approvedOrg(app, opened);
    if (!org) throw ApiError.forbidden("no approved org has this id");
    org.email = u.email;
    return org;
  }
  const o = await admins.owner(app, u.email);
  if (!o) {
    throw ApiError.forbidden("you aren't an admin of an approved org yet: register one, or join one");
  }
  return o;
}
