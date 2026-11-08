#!/usr/bin/env node
// The watcher Lambda: runs the watchers, every hour on a schedule, or one just created. Elsewhere,
// `watcher --org ORG [--id ID]` runs that org's watchers, or one of them, once.
//
// On Lambda, this file is the handler (`watcher.handler`); its event is `{org?, id?}`.

import { pathToFileURL } from "node:url";

import { App } from "../app.js";
import { run } from "../watchers.js";

/** Time left for the run's last batch once no other may start. */
const MARGIN_MS = 120_000;

let app;

/** The Lambda handler. */
export async function handler(event, context) {
  app ??= App.withoutSignIn();
  const job = { org: event?.org ?? undefined, id: event?.id ?? undefined };
  const left = context?.getRemainingTimeInMillis?.() ?? 900_000;
  await run(app, job, Date.now() + Math.max(left - MARGIN_MS, 0));
}

async function main(args) {
  const job = {};
  for (let at = 0; at < args.length; at++) {
    const arg = args[at];
    if (arg === "--org") job.org = args[++at];
    else if (arg === "--id") job.id = args[++at];
    else throw new Error(`unknown argument \`${arg}\``);
  }
  // Every org's watchers would include real orgs'.
  if (!job.org) throw new Error("give --org");
  await run(App.withoutSignIn(), job, null);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain && process.env.AWS_LAMBDA_FUNCTION_NAME === undefined) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  });
}
