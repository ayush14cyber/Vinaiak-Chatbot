// How an org's chatbot looks on its sites, which its owner sets here. Saving publishes the org's
// link, `public/{org}/link.js` in the public bucket: the one script a site embeds. It loads the
// widget every org shares, `public/inject.js`, with the org's settings as its `data-*` attributes.
// So a save reaches every site on its next page load, with no change to the site.

import { GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { PutObjectCommand } from "@aws-sdk/client-s3";

import { ORGS_TABLE } from "./app.js";
import { owner as ownerOf } from "./callers.js";
import * as chatbotOrigins from "./chatbot-origins.js";
import { S, aws } from "./dynamo.js";
import { ApiError, body, json } from "./http.js";

/** The bucket sites load the chatbot from. Anyone may read its `public/` folder. */
export const PUBLIC_BUCKET = "vinaiak-public";
/** CloudFront, serving `PUBLIC_BUCKET`. */
export const PUBLIC_ORIGIN = "https://chatbot.vinaiak.com";
/** The widget every org's link loads. */
export const INJECT_KEY = "public/inject.js";
/** The attribute of an org's row holding its widget, as JSON; absent until it's first saved. */
const ATTRIBUTE = "chatbot_widget";
/** The colours the widget takes, by the names of its `data-{name}-color` attributes. */
const COLORS = ["heading", "user-box", "bot-box", "box-border", "link", "option"];
const MAX_TEXT = 100;
const MAX_GREETING = 1000;
const MAX_URL = 2048;

/** Where `key` is served from, to anyone. */
export const publicUrl = (key) => `${PUBLIC_ORIGIN}/${key}`;

/** Where `org`'s link is kept. */
const linkKey = (org) => `public/${org}/link.js`;

/** The chatbot's settings, every field as stored, an empty one keeping the widget's default. */
export function widget(value = {}) {
  const text = (v) => (typeof v === "string" ? v : "");
  const colors = value.colors && typeof value.colors === "object" && !Array.isArray(value.colors) ? value.colors : {};
  return {
    title: text(value.title),
    placeholder: text(value.placeholder),
    avatar: text(value.avatar),
    launcher_icon: text(value.launcher_icon),
    greeting: text(value.greeting),
    hide_watermark: value.hide_watermark === true,
    colors: Object.fromEntries(Object.entries(colors).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  };
}

const isHttps = (url) => {
  if (url.length > MAX_URL) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname.length > 0;
  } catch {
    return false;
  }
};

const isHexColor = (color) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color);

/** The widget as given, trimmed and without empty colours, or why it can't be saved. */
export function checked(w) {
  for (const [name, field, max] of [
    ["The title", "title", MAX_TEXT],
    ["The placeholder", "placeholder", MAX_TEXT],
    ["The greeting", "greeting", MAX_GREETING],
  ]) {
    w[field] = w[field].trim();
    if ([...w[field]].length > max) throw ApiError.badRequest(`${name} is longer than ${max} characters`);
  }
  for (const [name, field] of [["The avatar", "avatar"], ["The launcher icon", "launcher_icon"]]) {
    w[field] = w[field].trim();
    if (w[field].length > 0 && !isHttps(w[field])) throw ApiError.badRequest(`${name} must be an image's https:// address`);
  }
  const colors = {};
  for (const [name, raw] of Object.entries(w.colors)) {
    if (!COLORS.includes(name)) throw ApiError.badRequest(`The chatbot has no colour named \`${name}\``);
    const color = String(raw).trim().toLowerCase();
    if (color.length === 0) continue;
    if (!isHexColor(color)) throw ApiError.badRequest(`\`${color}\` isn't a colour like #f15922`);
    colors[name] = color;
  }
  w.colors = colors;
  return w;
}

/** The script that loads the widget for `org`, with `w`'s settings as its attributes. */
export function linkJs(org, w) {
  const data = {};
  const set = (name, v) => {
    if (v.length > 0) data[name] = v;
  };
  set("org-id", org);
  set("title", w.title);
  set("placeholder", w.placeholder);
  set("avatar", w.avatar);
  set("launcher-icon", w.launcher_icon);
  set("greeting", w.greeting);
  if (w.hide_watermark) set("watermark", "false");
  for (const [name, color] of Object.entries(w.colors)) set(`${name}-color`, color);
  // Sorted by key for deterministic output.
  const sorted = Object.fromEntries(Object.entries(data).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return `// The chatbot of \`${org}\`, as set up in the training portal: saving there replaces this file.
(function () {
  var script = document.createElement("script");
  script.src = ${JSON.stringify(publicUrl(INJECT_KEY))};
  script.async = true;
  var data = ${JSON.stringify(sorted)};
  for (var name in data) script.setAttribute("data-" + name, data[name]);
  document.head.appendChild(script);
})();
`;
}

/** An org's chatbot, as its owner sets it up. */
function chatbotOf(org, item) {
  const saved = item?.[ATTRIBUTE]?.S;
  let w;
  try {
    w = saved === undefined ? widget() : widget(JSON.parse(saved));
  } catch (e) {
    throw ApiError.internal(e);
  }
  return {
    widget: w,
    // Until it's first saved, there is nothing at `link_url`.
    published: saved !== undefined,
    link_url: publicUrl(linkKey(org)),
    origins: chatbotOrigins.of(item),
  };
}

/** `GET /chatbot`: the org's chatbot. */
export async function read(app, req) {
  const o = await ownerOf(app, req);
  const out = await aws(() =>
    app.dynamo.send(
      new GetItemCommand({
        TableName: ORGS_TABLE,
        Key: { org_id: S(o.org) },
        ProjectionExpression: "#widget, #origins",
        ExpressionAttributeNames: { "#widget": ATTRIBUTE, "#origins": chatbotOrigins.ATTRIBUTE },
      }),
    ),
  );
  return json(chatbotOf(o.org, out.Item ?? {}));
}

/** `PUT /chatbot {widget}`: saves the org's widget and publishes its link with it. */
export async function save(app, req) {
  const o = await ownerOf(app, req);
  const given = body(req, { title: "string?", placeholder: "string?", avatar: "string?", launcher_icon: "string?", greeting: "string?", hide_watermark: "bool?", colors: "object?" });
  const w = checked(widget(given));
  // Sites ask again on every page load, so they show a save on their next one.
  await aws(() =>
    app.s3.send(
      new PutObjectCommand({
        Bucket: PUBLIC_BUCKET,
        Key: linkKey(o.org),
        ContentType: "text/javascript; charset=utf-8",
        CacheControl: "no-cache",
        Body: linkJs(o.org, w),
      }),
    ),
  );
  const out = await aws(() =>
    app.dynamo.send(
      new UpdateItemCommand({
        TableName: ORGS_TABLE,
        Key: { org_id: S(o.org) },
        UpdateExpression: "SET #widget = :widget",
        ExpressionAttributeNames: { "#widget": ATTRIBUTE },
        ExpressionAttributeValues: { ":widget": S(JSON.stringify(w)) },
        ReturnValues: "ALL_NEW",
      }),
    ),
  );
  return json(chatbotOf(o.org, out.Attributes ?? {}));
}
