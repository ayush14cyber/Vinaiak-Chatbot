# Training portal frontend

A static Next.js site (`output: "export"`, no server functions) for the portal API in `../backend`.

- `/`: sign in with Google, claim an org, wait for approval, then manage the org's topic tree.
- `/admin`: approve or reject registration requests. Only accounts in the backend's `ADMIN_EMAILS` see it.

## Setup

```sh
cp .env.example .env.local   # the backend's Function URL and Google client id
npm install
npm run dev                  # http://localhost:3000
npm run build                # static site in out/
```

The Google OAuth client must list the site's origin (e.g. `http://localhost:3000`) under
**Authorized JavaScript origins**, or Google's sign-in button won't load.

`out/` can be served from any static host. It has `index.html`, `admin.html` and assets, so the
host must serve `/admin` from `admin.html`, as S3 website hosting, CloudFront with a rewrite,
Netlify and Vercel do.

## Sign-in

Google Identity Services gives the page an ID token, kept in `sessionStorage` and sent as
`Authorization: Bearer`. The backend verifies it on every call. It lasts an hour; when it
expires, the page asks Google again, which signs a returning account straight back in.
