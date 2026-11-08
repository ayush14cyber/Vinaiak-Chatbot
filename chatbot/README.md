# chatbot

The chat API (Express 5) an org's widget talks to.

- `POST /login {org_id, google_captcha_token}` → `{token, resumed}`: checks reCAPTCHA on the
  requesting site and that the org's chatbot may run there, then creates or resumes a session in
  S3 (`sessions/{id}.json`) and signs a one-hour HS256 JWT bound to the org, the session and the site.
- `POST /chat {query, images?}` → newline-delimited JSON events: `text`, `function_call`,
  `function_response`, `options`, then `done` or `error`. At most 5 model rounds per message; a
  round whose connection failed before anything came is retried twice. The session (and any
  data-not-found report) is saved before the stream ends.
- `POST /reset` → 204: a new conversation in the same session.

A session allows 50 requests per login; writes use S3's `If-Match`, so parallel requests can't pass
the limit.

```sh
JWT_SECRET=… GRECAPTCHA_KEY=… npm start   # http://0.0.0.0:3000
npm test                                  # offline: S3 and the model are faked
npm run bundle                            # dist/, for Lambda behind the Web Adapter
```
