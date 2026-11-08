// Serves the API: on Lambda, behind the AWS Lambda Web Adapter, on `PORT` (8080 by default), with
// response streaming so a slow call can answer before Vercel gives up on it (see `http.js`);
// elsewhere on `LOCAL_ADDR`.

import { log } from "rag/log";

import { App } from "./app.js";
import { router } from "./index.js";

const LOCAL_HOST = "127.0.0.1";
const LOCAL_PORT = 3000;

const onLambda = process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined;
const app = App.fromEnv();
const host = onLambda ? "0.0.0.0" : LOCAL_HOST;
const port = onLambda ? Number(process.env.PORT ?? 8080) : LOCAL_PORT;

const server = router(app).listen(port, host, () => log.info({}, `serving on http://${host}:${port}`));
// A call may run up to the 870 s deadline.
server.requestTimeout = 0;
server.headersTimeout = 60_000;
