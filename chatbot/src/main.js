// Serves the chatbot: on Lambda behind the AWS Lambda Web Adapter on `PORT` (8080), streamed so a
// reply reaches the browser as it is written; elsewhere on 0.0.0.0:3000.

import { log } from "rag/log";

import { app, configsFromEnv } from "./app.js";

const onLambda = process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined;
const port = onLambda ? Number(process.env.PORT ?? 8080) : 3000;
const server = app(configsFromEnv()).listen(port, "0.0.0.0", () => log.info({}, `serving on http://0.0.0.0:${port}`));
server.requestTimeout = 0;
