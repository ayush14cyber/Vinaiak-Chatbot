// OpenRouter-backed chunker.
//
// The model sees the document as numbered lines and answers with line numbers only, never the
// text. The engine cuts the parts from the document itself, so every line lands in exactly one
// part, whatever the model returns.

import { ChunkPlan, Cohesion, PluginError } from "context-retriever";

import { pluginError, retrying } from "./errors.js";
import { AI, Session, completionMessage, jsonSchemaFormat, messageJson } from "./open-client.js";

export const MODEL = "deepseek/deepseek-v4.1-flash-1017";
export const BASE_URL = "https://openrouter.ai/api/v1";
/** A long document is planned in one request, so this is generous. */
const REQUEST_TIMEOUT_MS = 300_000;
const SYSTEM_PROMPT = `You split a web page, converted to markdown, into chunks for retrieval. Each of its lines is prefixed with its number, \`N: \`.

Group the lines by topic and return the groups in document order, each with:
- \`part_starts\`: the numbers of the lines where the group's parts begin, ascending. A part runs until the next part of any group begins, so every line belongs to exactly one part. Most groups have one part. A list of independent records, such as a staff directory or a list of notices, is one group with one part per record.
- \`inseparable\`: true only when the parts depend on each other to be read correctly: table rows that need the table's header, a numbered procedure, a schedule. False for a list of independent records, even when it is laid out as a table, and for self-contained prose.
- \`context\`: one standalone sentence situating the group in the document, so a part read alone isn't misleading. Name what the document is about. Never begin with "This section".
- \`topic\`: a short label, at most six words.
Never start a part inside a paragraph, a list item, a table or a link's text.`;

/** The model's reply, forced by structured output. */
const SPLIT_SCHEMA = {
  type: "object",
  description: "Reply of the model, forced by structured output.",
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          part_starts: {
            type: "array",
            items: { type: "integer" },
            description: "Numbers of the lines where the group's parts begin, ascending.",
          },
          inseparable: {
            type: "boolean",
            description: "Whether the parts are misleading when read without each other.",
          },
          context: {
            type: "string",
            description: "One standalone sentence situating the group in the document.",
          },
          topic: { type: "string", description: "A short label, at most six words." },
        },
        required: ["part_starts", "inseparable", "context", "topic"],
        additionalProperties: false,
      },
    },
  },
  required: ["groups"],
  additionalProperties: false,
};

/** The model's reply is already a plan in line numbers; the engine does the cutting. */
export function plan(split) {
  if (!Array.isArray(split?.groups)) throw new Error("missing field `groups`");
  return new ChunkPlan(
    split.groups.map((g) => {
      if (!Array.isArray(g.part_starts) || typeof g.inseparable !== "boolean" || typeof g.context !== "string" || typeof g.topic !== "string") {
        throw new Error("a group misses one of `part_starts`, `inseparable`, `context`, `topic`");
      }
      return {
        context: g.context,
        topic: g.topic,
        cohesion: g.inseparable ? Cohesion.Inseparable : Cohesion.Distinct,
        partStarts: g.part_starts,
      };
    }),
    // Nothing is left out. A page comes without its header and footer, from the scraper's main
    // content or a person, and the engine stretches the first part back to line 1.
    [],
  );
}

const CTX = "openrouter::chunk";

export class AgenticChunker {
  constructor(apiKey) {
    this.ai = new AI(apiKey, MODEL, SYSTEM_PROMPT, { timeoutMs: REQUEST_TIMEOUT_MS })
      .setBaseUrl(BASE_URL)
      // A chunker that re-splits differently every run makes every stored fingerprint mismatch.
      .temperature(0.0)
      // The answer is line numbers. Thinking was about 85% of the output tokens.
      .reasoningEffort("low")
      .responseFormat(jsonSchemaFormat(SPLIT_SCHEMA));
  }

  async chunk(doc, budget) {
    let prompt =
      `Document: ${doc.id}\nPath: ${doc.breadcrumb.join(" > ")}\nSplit a topic longer than about ` +
      `${budget.targetChars} characters into subtopics, each a group of its own. Return at most ` +
      `${budget.maxGroups} groups.\n\n`;
    // Numbered as the engine numbers them, so the model's numbers cut where it meant.
    doc.lines().forEach((line, i) => {
      prompt += `${i + 1}: ${line}`;
      if (!line.endsWith("\n")) prompt += "\n";
    });

    // Retried: a failure that remains costs the page its topics, as the engine falls back to a
    // size split. Not after the timeout, though: the save would outlive the portal's deadline.
    const completion = await retrying(async () => {
      const session = new Session();
      session.ask(prompt);
      try {
        return await this.ai.ask(session);
      } catch (e) {
        throw pluginError(CTX, e);
      }
    });
    const message = completionMessage(completion);
    try {
      return plan(messageJson(message));
    } catch (e) {
      throw PluginError.permanent("openrouter::chunk_parse", `${e.message}: ${message.content ?? ""}`);
    }
  }
}
