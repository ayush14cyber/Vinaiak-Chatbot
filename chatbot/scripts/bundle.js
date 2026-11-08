// Bundles the chatbot Lambda into `dist/`: `server.mjs`, run by the AWS Lambda Web Adapter layer
// through `run.sh` (handler `run.sh`, env `AWS_LAMBDA_EXEC_WRAPPER=/opt/bootstrap`,
// `AWS_LWA_INVOKE_MODE=response_stream`), on Node 22.

import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = `${root}dist`;

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await build({
  entryPoints: [`${root}src/main.js`],
  outfile: `${dist}/server.mjs`,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: "linked",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "info",
});
await writeFile(`${dist}/run.sh`, "#!/bin/bash\nexec node server.mjs\n");
await chmod(`${dist}/run.sh`, 0o755);
