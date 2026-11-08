// Bundles the two Lambdas into `dist/`, each a folder to zip and deploy on Node 22:
//
// - `dist/api`: the API, `server.js`, run by the AWS Lambda Web Adapter layer through `run.sh`
//   (handler `run.sh`, env `AWS_LAMBDA_EXEC_WRAPPER=/opt/bootstrap`, `AWS_LWA_INVOKE_MODE=response_stream`).
// - `dist/watcher`: the watcher Lambda, handler `watcher.handler`.

import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = `${root}dist`;

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: "linked",
  // ESM output that still has `require` for the CommonJS dependencies it bundles.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "info",
};

await rm(dist, { recursive: true, force: true });
await mkdir(`${dist}/api`, { recursive: true });
await mkdir(`${dist}/watcher`, { recursive: true });

await build({ ...common, entryPoints: [`${root}src/server.js`], outfile: `${dist}/api/server.mjs` });
await writeFile(`${dist}/api/run.sh`, "#!/bin/bash\nexec node server.mjs\n");
await chmod(`${dist}/api/run.sh`, 0o755);

await build({ ...common, entryPoints: [`${root}src/bin/watcher.js`], outfile: `${dist}/watcher/watcher.mjs` });
