"use client";

import { BookOpen, Check, Copy, Download, KeyRound, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { message } from "@/lib/api";
import { ago } from "@/lib/time";
import { useApi } from "./session-provider";
import { Button, Dialog, Input, Spinner } from "./ui";

/** The backend's limit on a key's name. */
const MAX_NAME_CHARS = 60;

/** A link styled as a small secondary button. */
const linkButton =
  "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-zinc-200 ring-1 ring-white/10 transition ring-inset hover:bg-white/[0.08]";

/** The org's API keys, which let an AI train the assistant through the API without Google. */
export function ConnectAiDialog({ orgName, onClose }) {
  const api = useApi();
  const [keys, setKeys] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [created, setCreated] = useState(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  /** The key whose revoke waits for a confirm, and the one being revoked. */
  const [confirming, setConfirming] = useState(null);
  const [revoking, setRevoking] = useState(null);

  const load = useCallback(
    () =>
      api.keys().then(
        (all) => {
          setKeys(all);
          setLoadError(null);
        },
        (e) => setLoadError(message(e)),
      ),
    [api],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      const made = await api.createKey(name.trim());
      setCreated(made);
      const { id, prefix, email, created_at } = made;
      setKeys((all) => [...(all ?? []), { id, name: made.name, prefix, email, created_at }]);
      setName("");
    } catch (e) {
      toast.error("Couldn't create a key", { description: message(e) });
    }
    setCreating(false);
  }

  async function revoke(key) {
    setRevoking(key.id);
    try {
      await api.revokeKey(key.id);
      setKeys((all) => all?.filter((k) => k.id !== key.id) ?? null);
      if (created?.id === key.id) setCreated(null);
      toast.success(`Revoked “${key.name}”`);
    } catch (e) {
      toast.error("Couldn't revoke it", { description: message(e) });
    }
    setRevoking(null);
    setConfirming(null);
  }

  const skill = `${window.location.origin}/train.md`;

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      locked={creating || !!revoking}
      title="Connect an AI"
      description={
        <>
          Give an AI agent, such as Claude Code, a key and it can train {orgName}&apos;s assistant
          for you. A key can do anything you can do with your topics, including deleting them, but
          it can&apos;t see or make keys. Revoke it when you no longer use it.
        </>
      }
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl bg-white/[0.03] px-4 py-3 ring-1 ring-white/[0.08] ring-inset">
          <BookOpen className="size-4 shrink-0 text-violet-300" />
          <p className="min-w-0 flex-1 text-[13px] leading-5 text-zinc-400">
            Your AI learns the portal from the{" "}
            <span className="font-medium text-zinc-200">training skill</span>. To keep it in Claude
            Code, save it in <code className="font-mono text-zinc-300">.claude/skills/train/</code>.
          </p>
          <span className="flex gap-1">
            <a href="/train.md" target="_blank" className={linkButton}>
              View
            </a>
            <a href="/train.md" download="SKILL.md" className={linkButton}>
              <Download className="size-3.5" />
              Download
            </a>
          </span>
        </div>

        {created && (
          <div className="animate-rise space-y-4 rounded-2xl bg-emerald-500/[0.06] p-4 ring-1 ring-emerald-400/20 ring-inset">
            <p className="text-sm leading-6 text-emerald-100">
              <span className="font-medium">“{created.name}” is ready.</span> Copy it now: it
              won&apos;t be shown again.
            </p>
            <Snippet
              label="1. Set it in your AI's environment"
              text={`export PORTAL_TOKEN=${created.key}`}
            />
            <Snippet
              label="2. Ask your AI"
              text={`Follow ${skill} to train our Vinaiak assistant on <link to your source eg. website>`}
            />
            <p className="text-[13px] leading-5 text-zinc-400">
              Then tell it what to teach, such as a page of your website.
            </p>
          </div>
        )}

        <section>
          <h3 className="text-[13px] font-medium text-zinc-300">Keys</h3>
          {keys === null ? (
            loadError ? (
              <p className="mt-2 text-sm text-rose-300">
                {loadError}{" "}
                <button
                  type="button"
                  onClick={() => void load()}
                  className="underline underline-offset-2"
                >
                  Try again
                </button>
              </p>
            ) : (
              <Spinner className="mt-3 size-4 text-zinc-500" />
            )
          ) : keys.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-500">No keys yet.</p>
          ) : (
            <ul className="mt-2 divide-y divide-white/[0.06] rounded-2xl ring-1 ring-white/[0.08] ring-inset">
              {keys.map((key) => (
                <li key={key.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-violet-500/10 text-violet-300">
                    <KeyRound className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-zinc-100">{key.name}</span>
                    {confirming === key.id ? (
                      <span className="block text-[12px] text-rose-300">
                        Whatever uses it loses access at once.
                      </span>
                    ) : (
                      <span className="block text-[12px] text-zinc-500">
                        <span className="font-mono">{key.prefix}…</span> · created{" "}
                        {ago(key.created_at)}
                        {key.email && ` by ${key.email}`}
                      </span>
                    )}
                  </span>
                  {confirming === key.id ? (
                    <span className="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirming(null)}
                        disabled={!!revoking}
                      >
                        Keep
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        loading={revoking === key.id}
                        onClick={() => revoke(key)}
                      >
                        Revoke
                      </Button>
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Trash2 className="size-3.5" />}
                      onClick={() => setConfirming(key.id)}
                      disabled={!!revoking}
                    >
                      Revoke
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <form onSubmit={create}>
          <label htmlFor="key-name" className="text-[13px] font-medium text-zinc-300">
            New key
          </label>
          <div className="mt-2 flex items-center gap-2">
            <Input
              id="key-name"
              value={name}
              maxLength={MAX_NAME_CHARS}
              onChange={(e) => setName(e.target.value)}
              placeholder="Claude Code on my laptop"
            />
            <Button
              type="submit"
              variant="primary"
              loading={creating}
              disabled={!name.trim()}
              icon={<KeyRound className="size-4" />}
            >
              Create key
            </Button>
          </div>
          <p className="mt-2 text-[13px] text-zinc-500">
            Name it after the AI or computer that will use it, so you know which one to revoke.
          </p>
        </form>
      </div>
    </Dialog>
  );
}

/** Text to copy, such as a key. */
export function Snippet({ label, text }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy it. Select the text and copy it yourself.");
    }
  }

  return (
    <div>
      <div className="mb-1.5 text-[13px] font-medium text-zinc-300">{label}</div>
      <div className="flex items-start gap-2 rounded-xl bg-black/40 py-2 pr-2 pl-3.5 ring-1 ring-white/10 ring-inset">
        <pre className="min-w-0 flex-1 py-0.5 font-mono text-[12.5px] leading-5 break-all whitespace-pre-wrap text-zinc-200 select-all">
          {text}
        </pre>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy"
          title="Copy"
          className="grid size-7 shrink-0 place-items-center rounded-lg text-zinc-400 transition hover:bg-white/[0.08] hover:text-zinc-100"
        >
          {copied ? <Check className="size-4 text-emerald-300" /> : <Copy className="size-4" />}
        </button>
      </div>
    </div>
  );
}
