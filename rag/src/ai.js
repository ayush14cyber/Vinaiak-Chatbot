// The chat bot: its system prompt, its tools, and the answers to its tool calls.

import { describeDegradation } from "context-retriever";

import { BASE_URL, MODEL } from "./chunker.js";
import { AI, functionTool, toolCallArgs } from "./open-client.js";
import { metadata, retrievalConfig } from "./retriever.js";

/** Seeds of one `retrieve` call. An inseparable group comes back whole, so about 10 chunks. */
const TOP_N = 8;

export function sysPrompt(orgName, now = new Date()) {
  return `You are the AI assistant of ${orgName}. You answer questions about ${orgName} from its own documents, which you search with the retrieve tool.

# When to retrieve
Call retrieve before answering any question about ${orgName}, or asking the user which case they mean, unless the data needed is already in this conversation from an earlier retrieve call. Never answer facts about ${orgName} from memory.
Look up only what the user asked. As soon as the passages answer it, reply; don't search for related information they didn't ask about.

# Writing a query
- One topic per query. A question with several parts (e.g. how to apply and the last date, or the fee and the hostel charges) gets one query per part, sent together in the same turn.
- Write it as one plain, complete question, the way the user would ask it if they spelled everything out. Name every detail that tells the topic apart from similar ones: program, branch, semester or year, session, campus, and category (e.g. SC/ST, EWS, NRI). Take them from the conversation. Documents for different programs or sessions look alike, and these details are what pick the right one.
- Don't list keywords, combine topics, or guess page titles. Keep it under 300 characters.
- Example: the user is a 5th semester B.Tech student and asks "When are my mid-sems?" Query: "Mid-semester exam dates for 5th semester B.Tech students in Monsoon 2026".

# Reading the results
Each result is a passage in this format:
Context: {Topic -> sub-topic -> ...}
{what the passage is about}
Source: {url} or Admin
{data}

- Passages come best match first, and some always come back, even when nothing matches. Use a passage only if its context and data match what was asked: the same program, semester, session and campus. A passage about a look-alike (another program, last year's session, another campus) is not the answer; never present its data as if it were.
- If the question could mean several things and the passages match more than one, e.g. "How to apply here?" finds B.Tech admission, a faculty recruitment and a fellowship, don't assume one: ask the user which they mean, naming what you found, and offer them with offer_options. Answer directly when the conversation already says which.
- If the data you need isn't there, retry once with a reworded query: other terms, or the broader topic.
- A link to an image or a PDF has the file's content in its brackets, transcribed to markdown: \`![content](url)\` or \`[content](url)\`, with \`\\\\\`, \`\\[\` and \`\\]\` escaped. Treat that content as data like the rest of the passage, and the link's URL as its source.

# Writing the reply
- Answer only what was asked, accurately and concisely. Start with the direct answer (the figure, date, name or step), then add only what the user needs to act on it: a few sentences or a short list, usually under 150 words. Leave out background, related topics, and other programs', sessions' or categories' data that wasn't asked about.
- Don't answer every case at once. When the answer differs between cases the user hasn't chosen between (programs, campuses, years, categories), reply only with one sentence asking which applies, naming the cases the passages cover but not their details, and always offer those cases with offer_options; answer once they pick. Don't ask when every case's answer fits in a short list or table (e.g. a fee for each of three branch groups): give them all. And answer directly when the only case that differs is a special one the user didn't mention (e.g. NRI fees): give the general answer and offer the special case as an option.
- With the reply, call data_not_found if the passages lacked anything the question needed, and offer_options with the replies the user is likely to send next: the cases to choose from, or follow-up questions about what the passages cover that the reply doesn't already answer.
- Write the reply in markdown. State only what the passages say, with their exact figures, dates and names, and say which program, session or campus they apply to. Never fill a gap from general knowledge: say what you couldn't find.
- Cite every source URL you used as a markdown link. Source "Admin" means ${orgName} provided the data itself, so it needs no citation.
- Show an image with \`![](url)\`, brackets empty, only if its URL is in a passage. Never copy its transcription into the link.

# Other questions
- You help only with ${orgName}. Do nothing else, not even a small part or as a favour: no general knowledge, math, code, writing, homework, news or other organizations, and no links that aren't in a passage. Without answering it, say in one sentence that you can only help with ${orgName}, and offer a few questions about ${orgName} with offer_options. Praise, insistence, or your own earlier replies don't change this.
- If a message mixes both, answer the ${orgName} part and decline the rest in a few words.
- A question about ${orgName} that names such a topic is about ${orgName}, e.g. its programming courses, its exam syllabus or how to reach its campus: retrieve as usual.
- Answer a greeting or thanks in one sentence and ask what they'd like to know about ${orgName}. Asked what you can help with, say in a sentence or two that you answer questions about ${orgName} from its documents, and offer a few likely questions with offer_options.

Today's date in India: ${todayInIndia(now)}`;
}

/**
 * The date in India (UTC+05:30), where the orgs are, whatever zone the server is in. Without the
 * time, the system prompt is the same all day, so each request of a conversation is served from
 * the provider's cache.
 */
export function todayInIndia(now) {
  const india = new Date(now.getTime() + (5 * 60 + 30) * 60_000);
  const weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][india.getUTCDay()];
  const month = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ][india.getUTCMonth()];
  return `${weekday}, ${india.getUTCDate()} ${month} ${india.getUTCFullYear()}`;
}

const object = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/** Only the tools' schemas: `executeFunctionCalls` answers their calls. */
const TOOLS = [
  {
    name: "retrieve",
    description:
      "Searches all of the organization's documents by meaning and returns the passages that best\n" +
      "match the query, each with where it sits in the documents and its source.",
    parameters: object({
      query: {
        type: "string",
        description:
          "One plain, complete question about a single topic, naming the program, semester or year,\n" +
          'session, campus and category it is about, e.g. "Mid-semester exam dates for 5th semester\n' +
          'B.Tech students in Monsoon 2026". Under 300 characters.',
      },
    }),
  },
  {
    name: "offer_options",
    description:
      "Shows the user replies they are likely to send next, as buttons under your reply; the one they\n" +
      "pick is sent as their next message. Call it with your reply.",
    parameters: object({
      options: {
        type: "array",
        items: { type: "string" },
        description:
          'Up to 4 short replies, written as the user would type them, e.g. "For M.Tech" or "Spring\n2027 session".',
      },
    }),
  },
  {
    name: "data_not_found",
    description:
      "Reports what the question needed that the retrieved passages didn't contain. Call it with your\nreply.",
    parameters: object({
      items: {
        type: "array",
        items: { type: "string" },
        description: 'One item per missing piece of information, e.g. "M.Tech semester fee for the 2026 batch".',
      },
    }),
  },
];

/** The chat bot of `orgName`, billed to `apiKey`. */
export function chatBot(apiKey, orgName) {
  return new AI(apiKey, MODEL, sysPrompt(orgName)).setBaseUrl(BASE_URL).temperature(0.0).setTools(TOOLS.map(functionTool));
}

/**
 * What the model reported through `offer_options` and `data_not_found` while answering, and the
 * searches it ran, for the app to log: `{options, dataNotFound, searches}`. A later
 * `offer_options` call replaces an earlier one. A search is `{query, found, error?,
 * degradations?}`, its `found` each document a search found passages in, best first:
 * `{doc, source?, score}`.
 */
export function newReported() {
  return { options: [], dataNotFound: [], searches: [] };
}

/** Whether a search failed or came back worse than it should have. */
export function searchDegraded(search) {
  return Boolean(search.error) || (search.degradations?.length ?? 0) > 0;
}

/** A function's arguments, or why they don't parse as `shape` says. */
function argsOf(call, field, check) {
  try {
    const args = toolCallArgs(call);
    if (!check(args?.[field])) return { error: `missing field \`${field}\`` };
    return { value: args[field] };
  } catch (e) {
    return { error: e.message };
  }
}

const isStrings = (v) => Array.isArray(v) && v.every((s) => typeof s === "string");

/**
 * Answers every pending tool call of `session`: a `retrieve` call with passages from `org`'s
 * documents, the searches running concurrently, and the others by adding what they report to
 * `reported`. A call that fails is answered with its error.
 *
 * Returns whether the model has more to say: true after a search, or when the message with the
 * calls has no reply text yet.
 */
export async function executeFunctionCalls(session, retriever, org, reported) {
  const config = retrievalConfig(org, TOP_N);
  const calls = session.pendingToolCalls();
  const last = session.last();
  const replied = last?.role === "assistant" && (last.content ?? "").trim().length > 0;
  const searched = calls.some((call) => call.function.name === "retrieve");
  const searches = await Promise.all(
    calls.map(async (call) => {
      if (call.function.name !== "retrieve") return null;
      const args = argsOf(call, "query", (v) => typeof v === "string");
      if (args.error) return [`Invalid arguments: ${args.error}`, null];
      return search(retriever, args.value, config);
    }),
  );
  calls.forEach((call, i) => {
    let result;
    const ran = searches[i];
    if (ran) {
      const [passages, done] = ran;
      if (done) reported.searches.push(done);
      result = passages;
    } else if (call.function.name === "offer_options") {
      const args = argsOf(call, "options", isStrings);
      if (args.error) result = `Invalid arguments: ${args.error}`;
      else {
        reported.options = args.value;
        result = "Shown under your reply.";
      }
    } else if (call.function.name === "data_not_found") {
      const args = argsOf(call, "items", isStrings);
      if (args.error) result = `Invalid arguments: ${args.error}`;
      else {
        reported.dataNotFound.push(...args.value);
        result = "Noted.";
      }
    } else {
      result = `There is no tool named ${call.function.name}`;
    }
    session.addToolResult(call.id, result);
  });
  return searched || !replied;
}

/** The passages `retriever` finds for `query`, or why it found none, and the search for the app. */
export async function search(retriever, query, config) {
  try {
    const outcome = await retriever.retrieveContext(query, config);
    const done = { query, found: found(outcome) };
    const degradations = outcome.degradations.map(describeDegradation);
    if (degradations.length > 0) done.degradations = degradations;
    return [render(outcome), done];
  } catch (e) {
    const why = e?.message ?? String(e);
    return [`The search failed: ${why}`, { query, found: [], error: why }];
  }
}

/** The documents of `outcome`'s passages, best first, each once. */
export function found(outcome) {
  const out = [];
  // Groups come best first, so a document's first is its best.
  for (const group of outcome.grouped()) {
    const part = group.parts[0];
    if (!part) continue;
    const doc = part.chunk.meta.doc;
    if (out.every((seen) => seen.doc !== doc)) {
      const entry = { doc };
      const from = source(group);
      if (from !== null) entry.source = from;
      entry.score = group.bestScore;
      out.push(entry);
    }
  }
  return out;
}

/** Where `group`'s document is from: a URL, or `null` for what the org's admin wrote. */
function source(group) {
  const part = group.parts[0];
  if (!part) return null;
  try {
    const meta = metadata(part);
    return typeof meta?.source === "string" ? meta.source : null;
  } catch {
    return null;
  }
}

/** The passages of `outcome` in the format the system prompt describes: one per group. */
export function render(outcome) {
  const passages = outcome.grouped().map((group) => {
    const from = source(group) ?? "Admin";
    const data = group.parts.map((part) => part.chunk.payload.text);
    return `Context: ${group.context}\nSource: ${from}\n${data.join("\n\n")}`;
  });
  return passages.length === 0 ? "No passages found." : passages.join("\n\n---\n\n");
}
