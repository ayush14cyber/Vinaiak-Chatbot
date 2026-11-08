// The training portal's backend. A Google account registers an org, an admin approves it, and
// its owner then manages a topic tree of files, each indexed through `rag`.
//
// `POST /session {credential}` signs in with a Google ID token, kept in a cookie that every other
// route reads, and `DELETE /session` signs out. Then:
// - any account: `GET /me`, `GET /org-ids/available?id=`, `POST /register`, `POST /join`
// - an admin: `GET /admin/requests`, `POST /admin/approve`, `POST /admin/reject`,
//   `GET /admin/orgs`, `PUT /admin/orgs/keys`, `PUT /admin/orgs/chatbot-origins`,
//   `GET|PUT|DELETE /admin/admins`
// - an approved org's owner: `GET /tree`, `GET|POST|PUT|DELETE /files`, `POST /files/rename`,
//   `POST /files/uploads`, `POST|DELETE /folders`, `POST /folders/rename`, `GET /scrape?url=`,
//   `GET|POST|DELETE /keys`, `GET|POST|PUT|DELETE /watchers` and `POST /watchers/links`,
//   `GET|DELETE /data-not-found`, and `GET|PUT /chatbot`
//
// The owner's routes also take one of the org's API keys as `Authorization: Bearer`, in place of
// the cookie, except `/keys` and the watchers' routes that change or preview watchers.
//
// The watcher Lambda (`src/bin/watcher.js`) runs the watchers every hour (`watchers.run`).
//
// Each org's models and imports bill to its own OpenRouter and Firecrawl keys, which an admin
// gives when approving it (see `provider-keys.js`).

import express from "express";

import * as admins from "./admins.js";
import { MAX_BODY } from "./app.js";
import * as chatbotOrigins from "./chatbot-origins.js";
import * as chatbotWidget from "./chatbot-widget.js";
import * as dataNotFound from "./data-not-found.js";
import * as files from "./files.js";
import { serve } from "./http.js";
import * as keys from "./keys.js";
import * as orgs from "./orgs.js";
import * as providerKeys from "./provider-keys.js";
import * as scrape from "./scrape.js";
import * as session from "./session.js";
import * as uploads from "./uploads.js";
import * as watchers from "./watchers.js";

export * from "./app.js";
export { Verifier } from "./auth.js";
export { ChatbotOrg, chatbotOrg, isAllowedOrigin } from "./chatbot-origins.js";
export * as dataNotFound from "./data-not-found.js";
export { CHAT_BUCKET } from "./data-not-found.js";
export { COOKIE as SESSION_COOKIE } from "./session.js";
export { run as runWatchers } from "./watchers.js";

/** Each route's handlers by method, in the order axum's router listed them. */
const ROUTES = {
  "/session": { post: session.signIn, delete: session.signOut },
  "/me": { get: orgs.me },
  "/org-ids/available": { get: orgs.available },
  "/register": { post: orgs.register },
  "/join": { post: admins.join },
  "/admin/requests": { get: orgs.requests },
  "/admin/approve": { post: orgs.approve },
  "/admin/reject": { post: orgs.reject },
  "/admin/orgs": { get: orgs.list },
  "/admin/orgs/keys": { put: providerKeys.set },
  "/admin/orgs/chatbot-origins": { put: chatbotOrigins.set },
  "/admin/admins": { get: admins.list, put: admins.set, delete: admins.remove },
  "/tree": { get: files.getTree },
  "/files": { get: files.read, post: files.create, put: files.edit, delete: files.remove },
  "/files/rename": { post: files.rename },
  "/files/uploads": { post: uploads.create },
  "/folders": { post: files.createFolder, delete: files.removeFolder },
  "/folders/rename": { post: files.renameFolder },
  "/scrape": { get: scrape.scrape },
  "/watchers": { get: watchers.read, post: watchers.create, put: watchers.edit, delete: watchers.stop },
  "/watchers/links": { post: watchers.preview },
  "/keys": { get: keys.list, post: keys.create, delete: keys.revoke },
  "/data-not-found": { get: dataNotFound.list, delete: dataNotFound.dismiss },
  "/chatbot": { get: chatbotWidget.read, put: chatbotWidget.save },
};

/** The Express app serving `app`'s routes. */
export function router(app) {
  const server = express();
  server.disable("x-powered-by");
  server.set("query parser", "simple");
  // Bodies are kept raw and parsed by each handler after it checks the caller, as axum did.
  server.use(express.raw({ type: () => true, limit: MAX_BODY }));
  for (const [path, methods] of Object.entries(ROUTES)) {
    const route = server.route(path);
    for (const [method, handler] of Object.entries(methods)) route[method](serve((req) => handler(app, req)));
    // Another method on a known path, as axum answers it.
    route.all((req, res) => {
      res.setHeader("cache-control", "no-store");
      res.setHeader("allow", Object.keys(methods).map((m) => m.toUpperCase()).join(","));
      res.status(405).end();
    });
  }
  server.use((req, res) => {
    res.setHeader("cache-control", "no-store");
    res.status(404).end();
  });
  // A body too large, or one Express couldn't read.
  server.use((err, req, res, _next) => {
    res.setHeader("cache-control", "no-store");
    const status = err.status ?? err.statusCode ?? 500;
    const error = status === 413 ? "Failed to buffer the request body: length limit exceeded" : err.message;
    res.status(status).json({ error });
  });
  return server;
}
