"use client";

import clsx from "clsx";
import { CloudOff, Globe, Monitor, RotateCcw, ShieldOff, Smartphone } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Snippet } from "@/components/keys";
import { Landing } from "@/components/landing";
import { useApi, useSession } from "@/components/session-provider";
import { Notice, Shell, Splash } from "@/components/shell";
import { Badge, Button, Card, Field, Input, Spinner, inputClass } from "@/components/ui";
import { message } from "@/lib/api";

/** The widget's own colours, which a colour left empty keeps. */
const DEFAULT_COLORS = {
  heading: "#f15922",
  "user-box": "#ffb056",
  "bot-box": "#ffffff",
  "box-border": "#ef8812",
  link: "#8a2be2",
  option: "#f9a23f",
};

const COLOR_LABELS = {
  heading: "Header",
  "user-box": "Visitor's messages",
  "bot-box": "Replies",
  "box-border": "Replies' glow",
  link: "Links",
  option: "Suggested replies",
};

/** How long the preview waits for the typing to stop before it reloads. */
const PREVIEW_DELAY = 700;

export default function ChatbotPage() {
  const { hydrated, signedIn, me, meError, refreshMe } = useSession();
  const router = useRouter();

  if (!hydrated) return <Splash />;
  if (signedIn === false) return <Landing />;
  if (meError) {
    return (
      <Shell>
        <Notice
          icon={<CloudOff className="size-6" />}
          title="Couldn't reach the portal"
          action={<Button onClick={() => void refreshMe()}>Try again</Button>}
        >
          {meError}
        </Notice>
      </Shell>
    );
  }
  if (!me) return <Splash />;
  return (
    <Shell>
      {me.status === "approved" && me.org ? (
        <Settings org={me.org.org_id} />
      ) : (
        <Notice
          icon={<ShieldOff className="size-6" />}
          title="No approved org"
          action={<Button onClick={() => router.push("/")}>Back home</Button>}
        >
          Once your org is approved, you can set up how its chatbot looks on your sites here.
        </Notice>
      )}
    </Shell>
  );
}

/** The chatbot's look, its preview, and the line a site embeds. */
function Settings({ org }) {
  const api = useApi();
  const [chatbot, setChatbot] = useState(null);
  const [widget, setWidget] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    () =>
      api.chatbot().then(
        (chatbot) => {
          setChatbot(chatbot);
          setWidget(chatbot.widget);
          setError(null);
        },
        (e) => setError(message(e)),
      ),
    [api],
  );

  useEffect(() => {
    void load();
  }, [load]);

  if (!chatbot || !widget) {
    return error ? (
      <Notice
        icon={<CloudOff className="size-6" />}
        title="Couldn't load your chatbot"
        action={<Button onClick={() => void load()}>Try again</Button>}
      >
        {error}
      </Notice>
    ) : (
      <div className="grid place-items-center pt-32">
        <Spinner className="size-5 text-zinc-500" />
      </div>
    );
  }

  const changed = comparable(widget) !== comparable(chatbot.widget);
  const change = (update) => setWidget({ ...widget, ...update });

  async function save() {
    if (!widget || !chatbot) return;
    setSaving(true);
    try {
      const saved = await api.saveChatbot(widget);
      setChatbot(saved);
      setWidget(saved.widget);
      toast.success(
        chatbot.published
          ? "Saved. Your sites show it on their next page load."
          : "Saved. Your chatbot's link is live.",
      );
    } catch (e) {
      toast.error("Couldn't save it", { description: message(e) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="animate-rise">
      <div>
        <h1 className="font-serif text-4xl text-white sm:text-5xl">Chatbot</h1>
        <p className="mt-2 max-w-2xl text-sm text-zinc-500">
          How your chatbot looks on your sites. Saving updates every site that embeds it, on its
          next page load.
        </p>
      </div>

      <Embed chatbot={chatbot} />

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card className="space-y-5 px-5 py-6 sm:px-6">
          <h2 className="text-[15px] font-semibold text-white">Look</h2>
          <Field label="Title" hint="In the chat's header.">
            <Input
              value={widget.title}
              maxLength={100}
              placeholder="AI Assistant"
              onChange={(e) => change({ title: e.target.value })}
            />
          </Field>
          <Field label="Input placeholder" hint="In the message box, before the visitor types.">
            <Input
              value={widget.placeholder}
              maxLength={100}
              placeholder="Ask me anything"
              onChange={(e) => change({ placeholder: e.target.value })}
            />
          </Field>
          <Field label="Greeting" hint="The chatbot's first message, in markdown. Empty for none.">
            <textarea
              value={widget.greeting}
              maxLength={1000}
              rows={3}
              placeholder="Hi! How may I help you today?"
              onChange={(e) => change({ greeting: e.target.value })}
              className={clsx(inputClass, "resize-y py-2.5")}
            />
          </Field>
          <Field
            label="Avatar"
            hint="An image's https:// address, in the header and beside replies."
          >
            <Input
              type="url"
              value={widget.avatar}
              placeholder="https://example.org/logo.png"
              onChange={(e) => change({ avatar: e.target.value })}
            />
          </Field>
          <Field
            label="Launcher icon"
            hint="The round button that opens the chat. vinaiak's assistant when empty."
          >
            <Input
              type="url"
              value={widget.launcher_icon}
              placeholder="https://example.org/icon.gif"
              onChange={(e) => change({ launcher_icon: e.target.value })}
            />
          </Field>

          <div>
            <div className="mb-2 text-[13px] font-medium text-zinc-300">Colours</div>
            <div className="grid gap-2 sm:grid-cols-2">
              {Object.keys(DEFAULT_COLORS).map((name) => (
                <ColorSetting
                  key={name}
                  name={name}
                  value={widget.colors[name]}
                  onChange={(color) => change({ colors: { ...widget.colors, [name]: color } })}
                />
              ))}
            </div>
          </div>

          <label className="flex items-start gap-3 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={!widget.hide_watermark}
              onChange={(e) => change({ hide_watermark: !e.target.checked })}
              className="mt-1 size-4 accent-violet-500"
            />
            <span>
              Show &ldquo;Developed by vinaiak AI&rdquo;
              <span className="block text-[13px] text-zinc-500">At the bottom of the header.</span>
            </span>
          </label>

          <div className="flex flex-wrap justify-end gap-2 border-t border-white/[0.06] pt-5">
            {changed && (
              <Button
                variant="ghost"
                icon={<RotateCcw className="size-3.5" />}
                onClick={() => setWidget(chatbot.widget)}
                disabled={saving}
              >
                Discard changes
              </Button>
            )}
            <Button
              variant="primary"
              onClick={save}
              loading={saving}
              disabled={!changed && chatbot.published}
            >
              {chatbot.published ? "Save" : "Save and publish"}
            </Button>
          </div>
        </Card>

        <Preview org={org} widget={widget} />
      </div>
    </div>
  );
}

/** Where the chatbot works, and the line that adds it to a site. */
function Embed({ chatbot }) {
  return (
    <Card className="mt-8 space-y-4 px-5 py-6 sm:px-6">
      <h2 className="text-[15px] font-semibold text-white">Add it to your site</h2>
      {chatbot.published ? (
        <Snippet
          label="Paste this into each page, before </body>"
          text={`<script src="${chatbot.link_url}" async></script>`}
        />
      ) : (
        <p className="text-sm text-zinc-400">
          Save once to publish your chatbot&apos;s link: the one line your site embeds.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-zinc-500">
        <Globe className="size-3.5" />
        {chatbot.origins.length ? (
          <>
            It works on
            {chatbot.origins.map((origin) => (
              <Badge key={origin}>{origin}</Badge>
            ))}
            Ask the portal&apos;s admin to add another site.
          </>
        ) : (
          "It works on no site yet. Ask the portal's admin to add yours."
        )}
      </div>
    </Card>
  );
}

function ColorSetting({ name, value, onChange }) {
  const shown = sixDigits(value || DEFAULT_COLORS[name]);
  return (
    <div className="flex items-center gap-3 rounded-xl bg-black/20 px-3 py-2 ring-1 ring-white/[0.06] ring-inset">
      <input
        type="color"
        value={shown}
        onChange={(e) => onChange(e.target.value)}
        aria-label={COLOR_LABELS[name]}
        className="size-8 shrink-0 cursor-pointer rounded-lg bg-transparent [&::-moz-color-swatch]:rounded-md [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch]:rounded-md [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-zinc-200">{COLOR_LABELS[name]}</div>
        <div className="font-mono text-[12px] text-zinc-500">{value ? shown : "Default"}</div>
      </div>
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          title="Back to the default"
          aria-label={`${COLOR_LABELS[name]}: back to the default`}
          className="grid size-7 shrink-0 place-items-center rounded-lg text-zinc-500 transition hover:bg-white/[0.08] hover:text-zinc-100"
        >
          <RotateCcw className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/**
 * The chatbot as it would look, live: the widget on a stand-in site, set up as edited. It
 * reloads once the typing stops, and can chat: replies bill to the org's own key.
 */
function Preview({ org, widget }) {
  const [device, setDevice] = useState("desktop");
  const settings = encodeURIComponent(JSON.stringify(attributes(org, widget)));
  const [shown, setShown] = useState(settings);

  useEffect(() => {
    const timer = setTimeout(() => setShown(settings), PREVIEW_DELAY);
    return () => clearTimeout(timer);
  }, [settings]);

  return (
    <Card className="px-5 py-6 sm:px-6 lg:sticky lg:top-24">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold text-white">Preview</h2>
        <div className="flex rounded-full bg-black/30 p-1 ring-1 ring-white/[0.06] ring-inset">
          <DeviceButton active={device === "desktop"} onClick={() => setDevice("desktop")}>
            <Monitor className="size-3.5" /> Desktop
          </DeviceButton>
          <DeviceButton active={device === "phone"} onClick={() => setDevice("phone")}>
            <Smartphone className="size-3.5" /> Phone
          </DeviceButton>
        </div>
      </div>
      <p className="mt-2 text-[13px] text-zinc-500">
        Unsaved changes show here first. Try it too: its replies bill to your org&apos;s key.
      </p>
      <div className="mt-4 flex justify-center overflow-hidden rounded-2xl ring-1 ring-white/10">
        <iframe
          key={`${device}:${shown}`}
          src={`/chatbot-preview#${shown}`}
          title="Preview of your chatbot"
          className={clsx(
            "block bg-zinc-100",
            // Wider than tall on desktop, so the widget shows as it does on a computer's screen.
            device === "phone" ? "h-[720px] w-[390px] max-w-full" : "h-[540px] w-full",
          )}
        />
      </div>
    </Card>
  );
}

function DeviceButton({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        "flex items-center gap-1.5 rounded-full px-3 py-1 text-[13px] transition",
        active ? "bg-white/[0.1] text-white" : "text-zinc-400 hover:text-zinc-100",
      )}
    >
      {children}
    </button>
  );
}

/** The widget's `data-*` attributes for `widget`, as the org's link sets them. */
function attributes(org, widget) {
  const data = { "org-id": org };
  const set = (name, value) => {
    if (value?.trim()) data[name] = value.trim();
  };
  set("title", widget.title);
  set("placeholder", widget.placeholder);
  set("avatar", widget.avatar);
  set("launcher-icon", widget.launcher_icon);
  set("greeting", widget.greeting);
  if (widget.hide_watermark) data.watermark = "false";
  for (const [name, color] of Object.entries(widget.colors)) set(`${name}-color`, color);
  return data;
}

/** `widget` as text that's the same for the same settings, whatever order its colours were set in. */
function comparable(widget) {
  const colors = Object.entries(widget.colors)
    .filter(([, color]) => color)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({ ...widget, colors });
}

/** `#rgb` as `#rrggbb`, which a colour input needs. */
function sixDigits(color) {
  return /^#[0-9a-f]{3}$/i.test(color)
    ? `#${[...color.slice(1)].map((digit) => digit + digit).join("")}`
    : color;
}
