# training-portal-backend

The portal API (Express 5) and the watcher runner. See the root README for what each route does.

```sh
GOOGLE_CLIENT_ID=… ADMIN_EMAILS=you@example.com npm start     # http://127.0.0.1:3000
npm run watcher -- --org ORG [--id ID]                         # one org's watchers, once
npm test                                                       # offline tests
npm run bundle                                                 # dist/api and dist/watcher, for Lambda
```

| File | Does |
| --- | --- |
| `src/index.js` | The router (`router(app)`), and what the chatbot imports: `chatbotOrg`, `CHAT_BUCKET`, the table names, `dataNotFound`. |
| `src/server.js` | Listens on 127.0.0.1:3000, or on `PORT` under the Lambda Web Adapter. |
| `src/bin/watcher.js` | The watcher Lambda's handler (`handler`), and the `--org`/`--id` CLI. |
| `src/http.js` | `ApiError`, and `serve()`: no-store, keep-alive past 90 s, the call log, the 870 s deadline. |
| `src/app.js` | Table and bucket names, the AWS clients, `App`. |
| `src/auth.js`, `session.js`, `callers.js`, `owner.js`, `keys.js` | Google sign-in, the cookie, API keys, and who may change what. |
| `src/orgs.js`, `admins.js`, `provider-keys.js`, `chatbot-origins.js` | Registering, approving, admins, each org's keys and chatbot sites. |
| `src/files.js`, `tree.js`, `paths.js`, `uploads.js`, `scrape.js` | The topic tree of pages, uploads to S3, Firecrawl scraping. |
| `src/watchers.js`, `snapshot.js` | File and directory watchers, and comparing pages without the noise that moves on its own. |
| `src/chatbot-widget.js`, `data-not-found.js` | The widget's settings and `link.js`, and the chatbot's missing-data reports. |
