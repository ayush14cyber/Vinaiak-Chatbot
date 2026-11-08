import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";

/** The portal API, the backend's Lambda Function URL. On Vercel, `vercel.json` proxies `/api` to it. */
const PORTAL_API = "https://4lw55iclpbzm3p7twzkuotf76y0odhyj.lambda-url.ap-south-1.on.aws";

const base = {
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default function config(phase) {
  if (phase === PHASE_DEVELOPMENT_SERVER) {
    // `next dev` proxies `/api` itself, as Vercel does. `PORTAL_API` points it at another
    // backend, such as one run locally. A static export can't have rewrites, so dev isn't one.
    const target = (process.env.PORTAL_API ?? PORTAL_API).replace(/\/+$/, "");
    return {
      ...base,
      // Vercel serves a static export's `.html` files without the extension, so pages link to
      // `/chatbot-preview`; dev serves `public/` files only by their names.
      rewrites: async () => [
        { source: "/api/:path*", destination: `${target}/:path*` },
        { source: "/chatbot-preview", destination: "/chatbot-preview.html" },
      ],
      // A save can take minutes, and Next's proxy gives up after 30 s by default.
      experimental: { proxyTimeout: 15 * 60 * 1000 },
    };
  }
  // A static site: every page renders in the browser and calls the API through `/api`, so there
  // are no server functions to host. `next build` writes it to `out/`.
  return { ...base, output: "export" };
}
