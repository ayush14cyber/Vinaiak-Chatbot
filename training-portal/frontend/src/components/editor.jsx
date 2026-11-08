"use client";

import clsx from "clsx";
import { ChevronRight, Download, Globe, Info, Paperclip, Radar, Save, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { MAX_UPLOAD_BYTES, UPLOAD_TYPES, message, upload } from "@/lib/api";
import { idOf, invalidName } from "@/lib/tree";
import { useApi } from "./session-provider";
import { Badge, Button, Dialog, Indeterminate, Input, MarkdownView, Spinner } from "./ui";

/**
 * What the editor is open on: a new file under `parent`, or an existing one.
 * @typedef {| { mode: "create"; parent: string[]; importing?: boolean }
 *   | { mode: "edit"; path: string[] }} Editing
 */

/**
 * @typedef {"write" | "split" | "preview"} View
 */

/**
 * A file attached to the page. Until the page is saved, its link has `placeholder` for a URL, which
 * the person may move anywhere in the text; saving uploads it and puts its real URL there.
 * @typedef {{ file: File; placeholder: string }} Attached
 */

/** A markdown link to `file` at `url`: an image shows, a PDF is linked. */
const linkTo = (file, url) =>
  `${file.type.startsWith("image/") ? "!" : ""}[${file.name.replace(/[[\]]/g, "")}](${url})`;

/** `bytes` for a person to read. */
const size = (bytes) =>
  bytes < 1 << 20
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1 << 20)).toFixed(1)} MB`;

/** A page's title made into a file name: no `|`, `~` or `#`, which ids reserve. */
const nameFrom = (title) => title.replace(/[|~#]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80);

export function Editor({ editing, watched = false, locked = false, orgName, onClose, onSaved }) {
  const api = useApi();
  const creating = editing.mode === "create";
  const parent = creating ? editing.parent : editing.path.slice(0, -1);
  const id = creating ? null : idOf(editing.path);

  const [loaded, setLoaded] = useState(creating ? { markdown: "" } : null);
  const [loadError, setLoadError] = useState(null);
  const [name, setName] = useState("");
  const [markdown, setMarkdown] = useState(null);
  /** The source of imported text, replacing the loaded one. */
  const [source, setSource] = useState();
  const [view, setView] = useState("split");
  const [importOpen, setImportOpen] = useState(creating && !!editing.importing);
  const [url, setUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [attached, setAttached] = useState([]);
  const nextUpload = useRef(1);
  const picker = useRef(null);

  useEffect(() => {
    if (!id) return;
    api
      .readFile(id)
      .then((file) => setLoaded({ markdown: file.markdown, source: file.source }))
      .catch((error) => setLoadError(message(error)));
  }, [api, id]);

  // Edits live in their own state; until the first, the loaded text shows.
  const text = markdown ?? loaded?.markdown ?? "";
  const currentSource = source ?? loaded?.source;
  const from = currentSource ? host(currentSource) : "a web page";
  const dirty =
    (markdown !== null && markdown !== loaded?.markdown) ||
    source !== undefined ||
    (creating && name.length > 0);
  const nameError = creating && name ? invalidName(name) : null;
  // An unchanged page isn't sent: saving it would do nothing.
  const canSave =
    !locked &&
    !!loaded &&
    dirty &&
    text.trim().length > 0 &&
    (!creating || (!!name && !nameError)) &&
    !saving;
  /**
   * A hand edit of a saved page: its images and PDFs keep the text typed for them, so a description
   * can be corrected. After an import they get their saved descriptions back instead.
   */
  const handEdit = !creating && source === undefined;

  const close = () => (dirty && !saving ? setConfirmClose(true) : onClose());

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && !saving && !confirmClose) {
        if (dirty) setConfirmClose(true);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, saving, confirmClose, onClose]);

  async function importPage() {
    setImporting(true);
    try {
      const page = await api.scrape(url.trim());
      setMarkdown(page.markdown);
      setSource(page.source);
      if (creating && !name && page.title) setName(nameFrom(page.title));
      setImportOpen(false);
      toast.success("Page imported", {
        description: `${page.markdown.length.toLocaleString()} characters from ${host(page.source)}`,
      });
    } catch (error) {
      toast.error("Couldn't import that page", { description: message(error) });
    } finally {
      setImporting(false);
    }
  }

  /** Attaches `files`, appending a placeholder link to each to the text. */
  function attach(files) {
    const added = [];
    for (const file of files) {
      const refused = !UPLOAD_TYPES.includes(file.type)
        ? "Attach a PDF, or a PNG, JPEG, WebP or GIF image."
        : file.size === 0
          ? "It's empty."
          : file.size > MAX_UPLOAD_BYTES
            ? `It's over ${MAX_UPLOAD_BYTES >> 20} MB, the most a save reads.`
            : null;
      if (refused) toast.error(`Can't attach ${file.name}`, { description: refused });
      else added.push({ file, placeholder: `upload:${nextUpload.current++}` });
    }
    if (!added.length) return;
    setAttached((all) => [...all, ...added]);
    const before = text.trimEnd();
    const links = added.map(({ file, placeholder }) => linkTo(file, placeholder));
    setMarkdown(`${before}${before ? "\n\n" : ""}${links.join("\n\n")}\n`);
  }

  /** Drops the attached file of `placeholder`, and its link. */
  function detach(placeholder) {
    setAttached((all) => all.filter((attachment) => attachment.placeholder !== placeholder));
    setMarkdown(text.replace(new RegExp(`!?\\[[^\\]]*\\]\\(${placeholder}\\)\\n?`, "g"), ""));
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    const pageId = creating ? idOf([...parent, name]) : id;
    let body = text;
    // Attached files are uploaded first, and their placeholders become their URLs. One whose
    // placeholder was deleted from the text is dropped.
    const sending = attached.filter(({ placeholder }) => body.includes(`(${placeholder})`));
    try {
      if (sending.length) {
        const { uploads } = await api.presignUploads(
          pageId,
          sending.map(({ file }) => file),
        );
        const sent = await Promise.allSettled(
          sending.map(({ file }, i) => upload(uploads[i], file)),
        );
        sending.forEach(({ placeholder }, i) => {
          if (sent[i].status === "fulfilled") {
            body = body.replaceAll(`(${placeholder})`, `(${uploads[i].public_url})`);
          }
        });
        const failed = sending.filter((_, i) => sent[i].status === "rejected");
        // What's uploaded keeps its URL, so saving again doesn't upload it again.
        setMarkdown(body);
        setAttached(failed);
        if (failed.length) {
          throw new Error(
            `${failed.map(({ file }) => file.name).join(", ")} didn't upload. Save again to retry.`,
          );
        }
      } else if (attached.length) {
        setAttached([]);
      }
    } catch (error) {
      toast.error("Couldn't upload the attached files", { description: message(error) });
      setSaving(false);
      return;
    }
    const file = {
      id: pageId,
      markdown: body,
      source: currentSource,
      force_override: handEdit,
    };
    try {
      const { ids } = creating ? await api.createFile(file) : await api.editFile(file);
      toast.success(creating ? "Page created" : "Page saved", {
        description: "Your assistant can answer from it now.",
      });
      onSaved(ids);
    } catch (error) {
      toast.error(creating ? "Couldn't create the page" : "Couldn't save the page", {
        description: message(error),
      });
      setSaving(false);
    }
  }

  // In `body`, like a dialog: the dashboard's animation would otherwise contain the drawer.
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={close} />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={creating ? "New page" : "Edit page"}
        className="relative flex h-full w-full max-w-5xl flex-col border-l border-white/10 bg-zinc-950 shadow-2xl"
      >
        <header className="flex items-start gap-4 border-b border-white/[0.07] px-6 py-5">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1 text-[13px] text-zinc-500">
              {[orgName, ...parent].map((segment, i) => (
                <span key={i} className="flex items-center gap-1">
                  {i > 0 && <ChevronRight className="size-3" />}
                  {segment}
                </span>
              ))}
            </div>
            {creating ? (
              <div className="mt-2">
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Name this page"
                  className="w-full bg-transparent font-serif text-3xl text-white outline-none placeholder:text-zinc-600"
                />
                {nameError && <p className="mt-1 text-[13px] text-rose-300">{nameError}</p>}
              </div>
            ) : (
              <h2 className="mt-2 truncate font-serif text-3xl text-white">
                {editing.path[editing.path.length - 1]}
              </h2>
            )}
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="rounded-full p-2 text-zinc-500 transition hover:bg-white/5 hover:text-zinc-200"
          >
            <X className="size-5" />
          </button>
        </header>

        <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.07] px-6 py-3">
          <Segmented value={view} onChange={setView} />
          {currentSource && (
            <a
              href={currentSource}
              target="_blank"
              rel="noreferrer"
              className="inline-flex max-w-xs items-center gap-1.5 truncate rounded-full bg-sky-500/10 px-3 py-1 text-[12px] text-sky-300 ring-1 ring-sky-400/20 hover:bg-sky-500/15"
            >
              <Globe className="size-3.5 shrink-0" />
              <span className="truncate">{host(currentSource)}</span>
            </a>
          )}
          <div className="ml-auto flex items-center gap-2">
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              accept={UPLOAD_TYPES.join(",")}
              onChange={(e) => {
                attach(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            <Button
              size="sm"
              variant="ghost"
              icon={<Paperclip className="size-3.5" />}
              onClick={() => picker.current?.click()}
              disabled={locked || saving || !loaded}
            >
              Attach files
            </Button>
            <Button
              size="sm"
              variant={importOpen ? "secondary" : "ghost"}
              icon={<Download className="size-3.5" />}
              onClick={() => setImportOpen((open) => !open)}
            >
              Import from web
            </Button>
          </div>
        </div>

        {attached.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.07] bg-white/[0.02] px-6 py-3">
            {attached.map(({ file, placeholder }) => (
              <span
                key={placeholder}
                className="inline-flex max-w-xs items-center gap-1.5 rounded-full bg-white/[0.04] py-1 pr-1 pl-3 text-[12px] text-zinc-300 ring-1 ring-white/[0.07]"
              >
                <Paperclip className="size-3.5 shrink-0 text-zinc-500" />
                <span className="truncate">{file.name}</span>
                <span className="shrink-0 text-zinc-500 tabular-nums">{size(file.size)}</span>
                <button
                  type="button"
                  onClick={() => detach(placeholder)}
                  disabled={saving}
                  aria-label={`Remove ${file.name}`}
                  className="rounded-full p-0.5 text-zinc-500 transition hover:bg-white/10 hover:text-zinc-200"
                >
                  <X className="size-3.5" />
                </button>
              </span>
            ))}
            <p className="w-full text-[12px] text-zinc-500">
              Move each file&apos;s <code className="text-zinc-400">upload:</code> link where it
              belongs. Saving uploads the files and gives the links their real addresses, which
              anyone can open.
            </p>
          </div>
        )}

        {(watched || locked) && (
          <p className="flex items-center gap-2 border-b border-white/[0.07] bg-sky-500/[0.05] px-6 py-2.5 text-[13px] text-sky-100/90">
            <Radar className="size-3.5 shrink-0 text-sky-300" />
            {locked
              ? `A directory watcher made this page from ${from}, so it can't be edited.`
              : `This page follows ${from} and changes with it. Saving your edit stops watching it.`}
          </p>
        )}

        {importOpen && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void importPage();
            }}
            className="animate-rise flex flex-wrap items-center gap-2 border-b border-white/[0.07] bg-white/[0.02] px-6 py-3"
          >
            <Globe className="size-4 text-zinc-500" />
            <Input
              autoFocus
              type="url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.org/admissions"
              className="h-9 min-w-0 flex-1"
            />
            <Button type="submit" size="sm" variant="primary" loading={importing}>
              Import
            </Button>
            <p className="w-full pl-6 text-[12px] text-zinc-500">
              The page&apos;s main content replaces the text below. Its address is saved as the
              page&apos;s source.
            </p>
          </form>
        )}

        <div className="relative min-h-0 flex-1">
          {loadError ? (
            <div className="grid h-full place-items-center p-6 text-center text-sm text-rose-300">
              {loadError}
            </div>
          ) : !loaded ? (
            <div className="grid h-full place-items-center">
              <Spinner className="size-5 text-zinc-500" />
            </div>
          ) : (
            <div
              className={clsx(
                "grid h-full",
                view === "split" && "grid-rows-2 lg:grid-cols-2 lg:grid-rows-1",
              )}
            >
              {view !== "preview" && (
                <textarea
                  value={text}
                  readOnly={locked}
                  onChange={(e) => setMarkdown(e.target.value)}
                  spellCheck={false}
                  placeholder={
                    "# Admissions\n\nWrite in markdown. Link images and PDFs with ![](https://...), or attach them, and they'll be read too."
                  }
                  className="h-full w-full resize-none bg-transparent px-6 py-5 font-mono text-[13px] leading-6 text-zinc-200 outline-none placeholder:text-zinc-600"
                />
              )}
              {view !== "write" && (
                <div
                  className={clsx(
                    "h-full overflow-y-auto px-6 py-5",
                    view === "split" && "border-t border-white/[0.07] lg:border-t-0 lg:border-l",
                  )}
                >
                  {text.trim() ? (
                    <MarkdownView>{text}</MarkdownView>
                  ) : (
                    <p className="text-sm text-zinc-600">The preview shows here.</p>
                  )}
                </div>
              )}
            </div>
          )}
          {saving && <SavingOverlay creating={creating} />}
        </div>

        <footer className="flex flex-wrap items-center gap-3 border-t border-white/[0.07] px-6 py-4">
          <p className="flex items-center gap-1.5 text-[12px] text-zinc-500">
            <Info className="size-3.5" />
            {creating
              ? "Images and PDFs you link or attach are read and described when you save."
              : handEdit
                ? "Images are described in words. End an image's [ ] with a space to have it described again."
                : "This is the text your assistant reads, images described in words."}
          </p>
          <span className="ml-auto text-[12px] text-zinc-600 tabular-nums">
            {text.length.toLocaleString()} chars
          </span>
          <Button variant="ghost" onClick={close} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={save}
            disabled={!canSave}
            loading={saving}
            icon={<Save className="size-4" />}
          >
            {creating ? "Create page" : "Save changes"}
          </Button>
        </footer>
      </section>

      <Dialog
        open={confirmClose}
        onClose={() => setConfirmClose(false)}
        title="Discard your changes?"
        description="They haven't been saved, so your assistant won't see them."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmClose(false)}>
              Keep editing
            </Button>
            <Button variant="danger" onClick={onClose}>
              Discard
            </Button>
          </>
        }
      />
    </div>,
    document.body,
  );
}

function Segmented({ value, onChange }) {
  const views = [
    ["write", "Write"],
    ["split", "Split"],
    ["preview", "Preview"],
  ];
  return (
    <div className="inline-flex rounded-full bg-white/[0.04] p-0.5 ring-1 ring-white/[0.07]">
      {views.map(([view, label]) => (
        <button
          key={view}
          type="button"
          onClick={() => onChange(view)}
          className={clsx(
            "rounded-full px-3 py-1 text-[12px] font-medium transition",
            value === view ? "bg-white/[0.1] text-white" : "text-zinc-500 hover:text-zinc-200",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Shown while a page is described and indexed, which takes from seconds to a minute or two. */
function SavingOverlay({ creating }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="absolute inset-0 grid place-items-center bg-zinc-950/80 backdrop-blur-sm">
      <div className="animate-rise w-full max-w-sm px-6 text-center">
        <Badge tone="violet">{creating ? "Creating" : "Saving"}</Badge>
        <h3 className="mt-4 font-serif text-3xl text-white">Teaching your assistant…</h3>
        <p className="mt-2 text-sm leading-6 text-zinc-400">
          Reading linked images and PDFs, splitting the page into passages and indexing them. This
          usually takes under a minute.
        </p>
        <Indeterminate className="mt-6" />
        <p className="mt-3 text-[12px] text-zinc-600 tabular-nums">{seconds}s</p>
      </div>
    </div>
  );
}

function host(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
