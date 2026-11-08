"use client";

import clsx from "clsx";
import {
  Bot,
  ChevronRight,
  Download,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Globe,
  Pencil,
  Plus,
  Puzzle,
  Radar,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { forgetPages, message } from "@/lib/api";
import { ago } from "@/lib/time";
import { counts, existing, idOf, invalidName, isPart, nodeAt, partName } from "@/lib/tree";
import { Editor } from "./editor";
import { ConnectAiDialog } from "./keys";
import { useApi } from "./session-provider";
import { Notice } from "./shell";
import { Badge, Button, Card, Dialog, Field, Indeterminate, Input, Spinner } from "./ui";

/**
 * @typedef {{ org_id: string; org_name: string }} Org
 */

/**
 * A dialog the dashboard has open, on the topic at `path`.
 * @typedef {| { kind: "folder"; parent: string[] }
 *   | { kind: "rename"; path: string[] }
 *   | { kind: "delete"; path: string[] }
 *   | { kind: "parts"; ids: string[] }
 *   | { kind: "watch"; parent: string[] }
 *   | { kind: "keys" }} Open
 */

export function Dashboard({ org }) {
  const api = useApi();
  const [tree, setTree] = useState(null);
  const [error, setError] = useState(null);
  const [path, setPath] = useState([]);
  const [editing, setEditing] = useState(null);
  const [open, setOpen] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  /** Counts the topics the user picked, so a reload doesn't override one picked while it ran. */
  const picks = useRef(0);

  const pick = useCallback((next) => {
    picks.current++;
    setPath(next);
  }, []);

  /** Reloads the tree, then selects `select`, or what's left of the selection. */
  const reload = useCallback(
    (select) => {
      const before = picks.current;
      return api.tree().then(
        (next) => {
          setTree(next);
          setError(null);
          const target = select && picks.current === before ? select : undefined;
          setPath((current) => existing(next, target ?? current));
        },
        (e) => setError(message(e)),
      );
    },
    [api],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Reloads the tree, and drops the pages read so far, which may have changed elsewhere. */
  async function refresh() {
    setRefreshing(true);
    forgetPages();
    await reload();
    setRefreshing(false);
  }

  if (error && !tree) {
    return (
      <Notice
        icon={<RefreshCw className="size-6" />}
        title="Couldn't load your topics"
        action={<Button onClick={() => void reload()}>Try again</Button>}
      >
        {error}
      </Notice>
    );
  }
  if (!tree) {
    return (
      <div className="grid place-items-center pt-40">
        <Spinner className="size-5 text-zinc-500" />
      </div>
    );
  }

  const node = nodeAt(tree, path) ?? tree;
  // The selected page's parts, which block saving it until they're renamed.
  const parts = path.length
    ? (nodeAt(tree, path.slice(0, -1))?.children ?? [])
        .map((child) => child.name)
        .filter((name) => name.startsWith(`${path[path.length - 1]}~`))
    : [];
  const total = counts(tree);
  const actions = {
    newPage: (parent) => setEditing({ mode: "create", parent }),
    importPage: (parent) => setEditing({ mode: "create", parent, importing: true }),
    newFolder: (parent) => setOpen({ kind: "folder", parent }),
    newWatcher: (parent) => setOpen({ kind: "watch", parent }),
  };

  return (
    <div className="animate-rise">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-4xl text-white sm:text-5xl">
            Choose the topic you want to edit
          </h1>
          <p className="mt-2 text-sm text-zinc-500">
            {total.files} {total.files === 1 ? "page" : "pages"} in {total.folders}{" "}
            {total.folders === 1 ? "folder" : "folders"} ·{" "}
            <span className="font-mono">{org.org_id}</span>
          </p>
        </div>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen({ kind: "keys" })}
            icon={<Bot className="size-3.5" />}
          >
            Connect an AI
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={refresh}
            loading={refreshing}
            icon={<RefreshCw className="size-3.5" />}
          >
            Refresh
          </Button>
        </div>
      </div>

      <Card className="mt-8 overflow-hidden">
        <TopicRows tree={tree} path={path} onSelect={pick} />
        {tree.children.length === 0 && tree.outside && (
          <div className="border-t border-white/[0.06] px-6 py-14 text-center">
            <h2 className="font-serif text-3xl text-white">Nothing here for you</h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-zinc-400">
              The folders you were given were renamed or deleted. Ask a Vinaiak admin for new ones.
            </p>
          </div>
        )}
        {tree.children.length === 0 && !tree.outside && (
          <div className="border-t border-white/[0.06] px-6 py-14 text-center">
            <h2 className="font-serif text-3xl text-white">Nothing here yet</h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-zinc-400">
              Start with a page about your organisation, import one from your website, or set up
              folders for your topics first.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              <Button
                variant="primary"
                icon={<FilePlus className="size-4" />}
                onClick={() => actions.newPage([])}
              >
                New page
              </Button>
              <Button icon={<Download className="size-4" />} onClick={() => actions.importPage([])}>
                Import from web
              </Button>
              <Button
                icon={<FolderPlus className="size-4" />}
                onClick={() => actions.newFolder([])}
              >
                New folder
              </Button>
              <Button icon={<Radar className="size-4" />} onClick={() => actions.newWatcher([])}>
                New watcher
              </Button>
            </div>
          </div>
        )}
      </Card>

      {tree.children.length > 0 && (
        <Inspector
          key={idOf(path)}
          org={org}
          path={path}
          node={node}
          parts={parts}
          onOpen={() => setEditing({ mode: "edit", path })}
          onNewPage={() => actions.newPage(path)}
          onImport={() => actions.importPage(path)}
          onNewFolder={() => actions.newFolder(path)}
          onNewWatcher={() => actions.newWatcher(path)}
          onRename={() => setOpen({ kind: "rename", path })}
          onDelete={() => setOpen({ kind: "delete", path })}
          onStopped={() => void reload(path)}
        />
      )}

      {editing && (
        <Editor
          editing={editing}
          watched={editing.mode === "edit" && nodeAt(tree, editing.path)?.watcher === "file"}
          locked={editing.mode === "edit" && !!nodeAt(tree, editing.path)?.by_watcher}
          orgName={org.org_name}
          onClose={() => setEditing(null)}
          onSaved={(ids) => {
            setEditing(null);
            void reload(ids[0].split("|"));
            if (ids.length > 1) setOpen({ kind: "parts", ids });
          }}
        />
      )}

      {open?.kind === "folder" && (
        <NewFolderDialog
          parent={open.parent}
          onClose={() => setOpen(null)}
          onDone={(created) => {
            setOpen(null);
            void reload(created);
          }}
        />
      )}
      {open?.kind === "rename" && (
        <RenameDialog
          path={open.path}
          node={nodeAt(tree, open.path)}
          onClose={() => setOpen(null)}
          onDone={(renamed) => {
            setOpen(null);
            void reload(renamed);
          }}
        />
      )}
      {open?.kind === "delete" && (
        <DeleteDialog
          path={open.path}
          node={nodeAt(tree, open.path)}
          onClose={() => setOpen(null)}
          onDone={() => {
            setOpen(null);
            void reload(open.path);
          }}
        />
      )}
      {open?.kind === "watch" && (
        <WatcherDialog
          parent={open.parent}
          onClose={() => setOpen(null)}
          onDone={(created) => {
            setOpen(null);
            void reload(created);
          }}
        />
      )}
      {open?.kind === "keys" && (
        <ConnectAiDialog orgName={org.org_name} onClose={() => setOpen(null)} />
      )}
      {open?.kind === "parts" && (
        <PartsDialog
          ids={open.ids}
          onClose={() => {
            setOpen(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

/** One row per level of the selected path, like the topic picker it replaces. */
function TopicRows({ tree, path, onSelect }) {
  const rows = [];
  let node = tree;
  for (let depth = 0; node; depth++) {
    const parent = path.slice(0, depth);
    // A folder gets a row, even empty; the root only once it has a topic.
    if (!node.file && (depth > 0 || node.children.length > 0)) {
      rows.push({ parent, nodes: node.children });
    }
    const selected = path[depth];
    node = selected ? node.children.find((child) => child.name === selected) : undefined;
  }

  return (
    <div>
      <div className="flex justify-center px-6 py-6">
        <Pill
          label={tree.name}
          icon={<FolderOpen className="size-4" />}
          selected={path.length === 0}
          root
          onClick={() => onSelect([])}
        />
      </div>
      {rows.map(({ parent, nodes }) => (
        <div key={idOf(parent) || "root"} className="animate-rise border-t border-white/[0.06]">
          <div className="topic-row overflow-x-auto">
            <div className="mx-auto flex w-max items-center gap-2 px-6 py-4">
              {nodes.map((child) => {
                const selected = path[parent.length] === child.name;
                const folder = child.children.length > 0;
                return (
                  <Pill
                    key={child.name}
                    label={child.name}
                    selected={selected}
                    part={isPart(child.name)}
                    watched={!!child.watcher}
                    count={folder ? child.children.length : undefined}
                    icon={
                      child.file ? (
                        <FileText className="size-4" />
                      ) : selected ? (
                        <FolderOpen className="size-4" />
                      ) : (
                        <Folder className="size-4" />
                      )
                    }
                    onClick={() => onSelect([...parent, child.name])}
                  />
                );
              })}
              {nodes.length === 0 && (
                <span className="px-2 text-sm text-zinc-500">This folder is empty.</span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function Pill({
  label,
  icon,
  selected,
  root = false,
  part = false,
  watched = false,
  count,
  onClick,
}) {
  const ref = useRef(null);
  // A row wider than the screen scrolls; keep the selected topic in view.
  useEffect(() => {
    if (selected)
      ref.current?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [selected]);
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className={clsx(
        "inline-flex items-center gap-2 rounded-full whitespace-nowrap transition outline-none focus-visible:ring-2 focus-visible:ring-violet-400/70",
        root ? "px-5 py-2.5 text-lg" : "px-4 py-2 text-[15px]",
        selected
          ? "bg-white/[0.09] text-white shadow-[0_0_22px_rgb(255_255_255/0.22)] ring-1 ring-white/70"
          : part
            ? "bg-amber-500/[0.07] text-amber-100 ring-1 ring-amber-400/30 hover:bg-amber-500/15"
            : "bg-white/[0.04] text-zinc-300 ring-1 ring-white/[0.07] hover:bg-white/[0.08] hover:text-white",
      )}
    >
      <span className={selected ? "text-violet-300" : "text-zinc-500"}>{icon}</span>
      {label}
      {watched && <Radar className="size-3.5 text-sky-300" aria-label="watched" />}
      {count !== undefined && (
        <span className="text-[12px] text-zinc-500 tabular-nums">{count}</span>
      )}
      {part && <Puzzle className="size-3.5 text-amber-300" aria-label="part" />}
    </button>
  );
}

/** The selected topic, and what can be done with it. */
function Inspector({
  org,
  path,
  node,
  parts,
  onOpen,
  onNewPage,
  onImport,
  onNewFolder,
  onNewWatcher,
  onRename,
  onDelete,
  onStopped,
}) {
  const root = path.length === 0;
  const name = root ? org.org_name : path[path.length - 1];
  const folder = node.children.length > 0;
  const inside = counts(node);
  const part = isPart(name);

  return (
    <Card className="animate-rise mt-6 p-6 sm:p-8">
      <div className="flex flex-wrap items-center gap-1 text-[13px] text-zinc-500">
        {[org.org_name, ...path.slice(0, -1)].map((segment, i) =>
          root ? null : (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="size-3" />}
              {segment}
            </span>
          ),
        )}
        {root && <span>Your organisation</span>}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h2 className="font-serif text-4xl text-white">{name}</h2>
        <div className="flex gap-1.5">
          {node.file && <Badge tone="violet">Page</Badge>}
          {folder && (
            <Badge>
              {inside.files} {inside.files === 1 ? "page" : "pages"} inside
            </Badge>
          )}
          {!root && !node.file && !folder && !node.watcher && <Badge>Empty folder</Badge>}
          {node.watcher && (
            <Badge tone="sky">
              <Radar className="size-3" />
              {node.watcher === "file" ? "File watcher" : "Directory watcher"}
            </Badge>
          )}
          {part && (
            <Badge tone="amber">
              <Puzzle className="size-3" /> Part
            </Badge>
          )}
        </div>
      </div>

      {part && (
        <p className="mt-4 max-w-2xl rounded-2xl bg-amber-500/[0.06] px-4 py-3 text-sm leading-6 text-amber-100/90 ring-1 ring-amber-400/20">
          “{name.split("~")[0]}” was too long to read as one page, so it was split into parts. Give
          this part a name of its own; until then “{name.split("~")[0]}” can&apos;t be edited.
        </p>
      )}

      {node.file && parts.length > 0 && (
        <p className="mt-4 max-w-2xl rounded-2xl bg-amber-500/[0.06] px-4 py-3 text-sm leading-6 text-amber-100/90 ring-1 ring-amber-400/20">
          This page was split into parts: {parts.map((p) => `“${p}”`).join(", ")}. Name{" "}
          {parts.length === 1 ? "it" : "them"} before saving changes here.
        </p>
      )}

      {node.outside && (
        <p className="mt-4 max-w-2xl text-sm leading-6 text-zinc-400">
          This is above the folders given to you. Pick one of them to change what&apos;s in it.
        </p>
      )}

      {node.watcher && (
        <WatcherStatus
          id={idOf(path)}
          name={name}
          locked={!!node.by_watcher}
          onStopped={onStopped}
        />
      )}

      <div className="mt-6 flex flex-wrap gap-2">
        {part && (
          <Button variant="primary" icon={<Pencil className="size-4" />} onClick={onRename}>
            Name this part
          </Button>
        )}
        {node.file && (
          <Button
            variant={part ? "secondary" : "primary"}
            icon={<FileText className="size-4" />}
            onClick={onOpen}
          >
            Open page
          </Button>
        )}
        {/* Only a folder holds pages and folders. */}
        {!node.file && !node.outside && (
          <>
            <Button icon={<FilePlus className="size-4" />} onClick={onNewPage}>
              New page {root ? "" : "inside"}
            </Button>
            <Button icon={<Download className="size-4" />} onClick={onImport}>
              Import from web
            </Button>
            <Button icon={<FolderPlus className="size-4" />} onClick={onNewFolder}>
              New folder {root ? "" : "inside"}
            </Button>
            <Button icon={<Radar className="size-4" />} onClick={onNewWatcher}>
              New watcher {root ? "" : "inside"}
            </Button>
          </>
        )}
        {/* A folder given to the admin is theirs to fill, not to move or delete. */}
        {!root && !node.outside && !node.assigned && (
          <>
            <span className="mx-1 hidden w-px bg-white/10 sm:block" />
            {!part && (
              <Button variant="ghost" icon={<Pencil className="size-4" />} onClick={onRename}>
                Rename
              </Button>
            )}
            {/* A directory watcher's page: it would import it again. */}
            {!node.by_watcher && (
              <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={onDelete}>
                Delete
              </Button>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

/** What a watched topic follows, when it last looked, and ways to change or stop it. */
function WatcherStatus({ id, name, locked, onStopped }) {
  const api = useApi();
  const [watcher, setWatcher] = useState(null);
  const [error, setError] = useState(null);
  const [stopping, setStopping] = useState(false);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    api.watcher(id).then(setWatcher, (e) => setError(message(e)));
  }, [api, id]);

  async function stop() {
    setStopping(true);
    try {
      await api.stopWatching(id);
      toast.success("Stopped watching", {
        description:
          watcher?.kind === "directory"
            ? "Its pages stay, and no longer change with the site."
            : "The page stays, and no longer changes with the site.",
      });
      onStopped();
    } catch (e) {
      toast.error("Couldn't stop watching", { description: message(e) });
      setStopping(false);
    }
  }

  if (error) return <p className="mt-4 text-sm text-rose-300">{error}</p>;
  if (!watcher) return <Spinner className="mt-4 size-4 text-zinc-500" />;
  const watched = watcher.watch_changes ?? 0;
  // What the last level follows: its links become pages.
  const last = watcher.levels?.at(-1);
  const limit = last?.limit;
  return (
    <div className="mt-4 max-w-2xl space-y-3 rounded-2xl bg-sky-500/[0.05] px-4 py-3 text-sm leading-6 text-zinc-300 ring-1 ring-sky-400/15">
      <p>
        {watcher.kind === "file"
          ? "Checked every hour; when the page changes, it's imported again."
          : `Checked every hour; each new link${
              limit ? ` among the ${last?.reverse ? "last" : "first"} ${limit}` : ""
            } becomes a page here, and a page whose link goes${
              limit ? " or falls out of them" : ""
            } is deleted.${
              watched === 0
                ? ""
                : watched >= (limit ?? MAX_LINKS)
                  ? " Each page is watched for changes too."
                  : ` The ${watcher.watch_reverse ? "last" : "first"} ${watched === 1 ? "link's page is" : `${watched} links' pages are`} watched for changes too.`
            }`}
      </p>
      <a
        href={watcher.url}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-1.5 truncate text-sky-300 hover:underline"
      >
        <Globe className="size-3.5 shrink-0" />
        <span className="truncate">{watcher.url}</span>
      </a>
      {watcher.levels && (
        <p className="text-[13px] text-zinc-400">
          Links in <Levels levels={watcher.levels} />
          {watcher.pages !== undefined &&
            ` · ${watcher.pages} ${watcher.pages === 1 ? "page" : "pages"} so far`}
        </p>
      )}
      <p className="text-[13px] text-zinc-500">
        {watcher.checked_at ? `Checked ${ago(watcher.checked_at)}` : "Not checked yet"}
        {watcher.changed_at && ` · last changed ${ago(watcher.changed_at)}`}
      </p>
      {watcher.error && (
        <p className="rounded-xl bg-amber-500/[0.06] px-3 py-2 text-[13px] text-amber-100/90 ring-1 ring-amber-400/20">
          The last check failed: {watcher.error}
        </p>
      )}
      <div className="flex flex-wrap gap-1">
        {watcher.kind === "directory" && (
          <Button
            variant="ghost"
            size="sm"
            icon={<Pencil className="size-3.5" />}
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
        )}
        {!locked && (
          <Button variant="ghost" size="sm" loading={stopping} onClick={stop}>
            Stop watching
          </Button>
        )}
      </div>
      {editing && (
        <EditWatcherDialog
          name={name}
          watcher={watcher}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setWatcher(saved);
            setEditing(false);
          }}
        />
      )}
    </div>
  );
}

/** Changes how many links each level of a directory watcher follows, and how many pages it watches. */
function EditWatcherDialog({ name, watcher, onClose, onSaved }) {
  const api = useApi();
  const levels = watcher.levels ?? [];
  const [inputs, setInputs] = useState(() =>
    levels.map((level) => ({ count: level.limit?.toString() ?? "", reverse: level.reverse })),
  );
  const [watch, setWatch] = useState({
    count: String(watcher.watch_changes ?? 0),
    reverse: watcher.watch_reverse ?? false,
  });
  const [busy, setBusy] = useState(false);
  const limits = inputs.map(readLimit);
  const watching = readWatch(watch, limits.at(-1)?.limit ?? MAX_LINKS);
  const settings = {
    levels: limits.map(({ limit, reverse }) => ({ limit, reverse })),
    ...watching.watching,
  };
  const changed =
    settings.levels.some(
      (set, i) => set.limit !== levels[i]?.limit || set.reverse !== levels[i]?.reverse,
    ) ||
    settings.watch_changes !== (watcher.watch_changes ?? 0) ||
    settings.watch_reverse !== (watcher.watch_reverse ?? false);
  const canSave = changed && !limits.some((limit) => limit.error) && !watching.error && !busy;

  async function submit(e) {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    try {
      const saved = await api.editWatcher(watcher.id, settings);
      toast.success(`Saved “${name}”`, {
        description:
          "It checks the list again now; pages come and go as it's done. Refresh to see them.",
      });
      onSaved(saved);
    } catch (e) {
      toast.error("Couldn't save the watcher", { description: message(e) });
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      locked={busy}
      wide
      title={`Edit “${name}”`}
      description={
        <>
          It follows the links in <Levels levels={levels} /> at {host(watcher.url)}. To follow
          another page or selectors, delete it and create a new watcher.
        </>
      }
    >
      <form onSubmit={submit} className="space-y-5">
        {levels.map((level, i) => (
          <LimitField
            key={i}
            level={i}
            levels={levels.length}
            selector={levels.length > 1 ? level.selector : undefined}
            input={inputs[i]}
            error={limits[i].error}
            onChange={(input) => setInputs((all) => all.map((old, j) => (j === i ? input : old)))}
          />
        ))}
        <WatchField input={watch} error={watching.error} most={watching.most} onChange={setWatch} />
        {busy && <Indeterminate />}
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!canSave}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** `url`'s host, or `url` if it has none. */
function host(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Whether `url` is an http or https address. */
function isWebUrl(url) {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Links found are shown up to this many. */
const SHOWN_LINKS = 10;
/** Most links a directory watcher follows, as the backend allows. */
const MAX_LINKS = 200;

/**
 * A count as typed, from the top of a list, or the bottom when `reverse`.
 * @typedef {{ count: string; reverse: boolean }} CountInput
 */

/**
 * A level of a new directory watcher as typed: its selector, and its limit.
 * @typedef {CountInput & { selector: string }} LevelInput
 */

/** A level just added: no selector yet, following all its links. */
const NEW_LEVEL = { selector: "", count: "", reverse: false };

/** `input` as a level's limit: empty follows all its links. With what's wrong with it. */
function readLimit(input) {
  const limit = input.count.trim() ? Number(input.count) : undefined;
  const error =
    limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= MAX_LINKS)
      ? `Give a number from 1 to ${MAX_LINKS}, or leave it empty for all.`
      : null;
  return { limit: error ? undefined : limit, reverse: input.reverse, error };
}

/**
 * `input` as how many pages to watch, empty for none: at most `most`, the links the last level
 * follows. With what's wrong with it.
 */
function readWatch(input, most) {
  const count = input.count.trim() ? Number(input.count) : 0;
  const error =
    Number.isInteger(count) && count >= 0 && count <= most
      ? null
      : `Give a number from 0 to ${most}${most < MAX_LINKS ? ", the links it follows" : ""}.`;
  const watching = { watch_changes: error ? 0 : count, watch_reverse: input.reverse };
  return { watching, most, error };
}

/** Of `links`, those `limit` follows: the first, or the last when `reverse`, in their order. */
function follow(links, { limit, reverse }) {
  if (limit === undefined || links.length <= limit) return links;
  return reverse ? links.slice(links.length - limit) : links.slice(0, limit);
}

/** How many of the links a level `level` (from 0) of `levels` follows. */
function LimitField({ level, levels, selector, input, error, onChange }) {
  const last = level === levels - 1;
  const label =
    levels === 1
      ? "Follow only"
      : `Level ${level + 1}${selector ? ` (${selector})` : ""}: follow only`;
  return (
    <CountField
      label={label}
      error={error}
      hint={
        last
          ? "For a long list, like notices: only this many become pages, from the top, or the bottom for a list with the newest last. A page whose link falls out of them is deleted. Empty follows all."
          : "Only this many of these links are read for the next level's list, from the top or the bottom. Empty reads them all, up to 50 pages in all."
      }
      input={input}
      min={1}
      max={MAX_LINKS}
      placeholder="All"
      onChange={onChange}
    />
  );
}

/** How many of the pages of the links a directory watcher follows it watches for changes. */
function WatchField({ input, error, most, onChange }) {
  return (
    <CountField
      label="Watch pages for changes"
      error={error}
      hint="How many of its pages, from the top or the bottom of the links it follows, are imported again when they change, not only when they first appear. 0 watches none."
      input={input}
      min={0}
      max={most}
      placeholder="0"
      onChange={onChange}
    />
  );
}

/** A count, and which end of the list it counts from. */
function CountField({ label, hint, error, input, min, max, placeholder, onChange }) {
  return (
    <Field label={label} error={error} hint={hint}>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={input.count}
          onChange={(e) => onChange({ ...input, count: e.target.value })}
          placeholder={placeholder}
          className="block max-w-32"
        />
        <div
          role="group"
          aria-label="Count from"
          className="inline-flex rounded-full bg-black/30 p-1 ring-1 ring-white/10 ring-inset"
        >
          {[false, true].map((reverse) => (
            <button
              key={String(reverse)}
              type="button"
              aria-pressed={input.reverse === reverse}
              onClick={() => onChange({ ...input, reverse })}
              className={clsx(
                "rounded-full px-3 py-1.5 text-[13px] transition",
                input.reverse === reverse
                  ? "bg-white/10 text-zinc-100"
                  : "text-zinc-400 hover:text-zinc-200",
              )}
            >
              {reverse ? "From the bottom" : "From the top"}
            </button>
          ))}
        </div>
      </div>
    </Field>
  );
}

/** A directory watcher's levels: each selector, and how many of its links it follows. */
function Levels({ levels }) {
  return levels.map((level, i) => (
    <span key={i}>
      {i > 0 && " › "}
      <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[12px] text-zinc-200">
        {level.selector}
      </code>
      {level.limit !== undefined && ` (${level.reverse ? "last" : "first"} ${level.limit})`}
    </span>
  ));
}

/** A new watcher in `parent`: a page that follows a web page, or a folder that follows a list's links. */
function WatcherDialog({ parent, onClose, onDone }) {
  const api = useApi();
  const [kind, setKind] = useState(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  /**
   * One per level: the list on the page, then on each page the links the level above follows lead
   * to, and how many of its links each follows.
   */
  const [levels, setLevels] = useState([NEW_LEVEL]);
  const [watch, setWatch] = useState({ count: "", reverse: false });
  /** The links found, and what found them: the address and levels. */
  const [found, setFound] = useState(null);
  const [finding, setFinding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showLinks, setShowLinks] = useState(SHOWN_LINKS);
  const nameError = name ? invalidName(name) : null;
  const urlError = url && !isWebUrl(url.trim()) ? "Give an http or https address." : null;
  const limits = levels.map(readLimit);
  const given = levels.map((level, i) => ({
    selector: level.selector.trim(),
    limit: limits[i].limit,
    reverse: limits[i].reverse,
  }));
  const last = given[given.length - 1];
  const watching = readWatch(watch, last.limit ?? MAX_LINKS);
  const limitError = limits.some((limit) => limit.error);
  // What finds the links: the address, the selectors, and the limits above the last level, which
  // pick the pages read. The last level's limit is applied here, to what was found.
  const query = JSON.stringify([
    url.trim(),
    given.map((level, i) => (i === given.length - 1 ? level.selector : level)),
  ]);
  // Links found for another address or levels don't count.
  const links = found?.for === query ? found : null;
  const followed = links ? follow(links.links, last) : [];
  const tooMany = !!links && followed.length > links.max;
  const ready =
    !!name && !nameError && !!url && !urlError && !limitError && !watching.error && !busy;
  const canCreate = ready && (kind === "file" || (!!links && followed.length > 0 && !tooMany));
  const setLevel = (i, level) =>
    setLevels((all) => all.map((old, j) => (j === i ? { ...old, ...level } : old)));

  async function findLinks() {
    setFinding(true);
    try {
      const result = await api.watchedLinks(url.trim(), given);
      setFound({ ...result, for: query });
    } catch (e) {
      toast.error("Couldn't find links", { description: message(e) });
    } finally {
      setFinding(false);
    }
  }

  async function submit(e) {
    e.preventDefault();
    if (!canCreate) return;
    setBusy(true);
    const path = [...parent, name];
    try {
      if (kind === "file") {
        await api.watchPage(idOf(path), url.trim());
        toast.success(`Watching “${name}”`, {
          description: "It's imported, and checked every hour.",
        });
      } else {
        const { links } = await api.watchLinks(idOf(path), url.trim(), given, watching.watching);
        toast.success(`Importing ${links} ${links === 1 ? "page" : "pages"} into “${name}”`, {
          description: "They appear as they're saved; refresh to see them.",
        });
      }
      onDone(path);
    } catch (e) {
      toast.error("Couldn't create the watcher", { description: message(e) });
      setBusy(false);
    }
  }

  const where = parent.length ? `Inside ${parent.join(" › ")}` : "At the top of your topics";
  if (!kind) {
    return (
      <Dialog
        open
        onClose={onClose}
        title="New watcher"
        description={`${where}. It keeps topics in sync with your website, checking every hour.`}
      >
        <div className="space-y-2">
          <KindChoice
            icon={<FileText className="size-4" />}
            title="File watcher"
            detail="A page that follows one web page, and is imported again when it changes."
            onClick={() => setKind("file")}
          />
          <KindChoice
            icon={<Folder className="size-4" />}
            title="Directory watcher"
            detail="A folder that follows a list of links, like notices: each new link becomes a page."
            onClick={() => setKind("directory")}
          />
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      locked={busy}
      wide={kind === "directory"}
      title={kind === "file" ? "New file watcher" : "New directory watcher"}
      description={where}
    >
      <form onSubmit={submit} className="space-y-5">
        <Field label={kind === "file" ? "Page name" : "Folder name"} error={nameError}>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={kind === "file" ? "Fees" : "Notices"}
          />
        </Field>
        <Field
          label="Web address"
          error={urlError}
          hint={
            kind === "file"
              ? "Its main content is imported now, and again whenever it changes."
              : undefined
          }
        >
          <Input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={
              kind === "file" ? "https://example.org/fees" : "https://example.org/notices"
            }
          />
        </Field>
        {kind === "directory" && (
          <>
            {levels.map((level, i) => (
              <div
                key={i}
                className={clsx(
                  "space-y-4",
                  levels.length > 1 && "rounded-2xl px-4 py-3 ring-1 ring-white/[0.07]",
                )}
              >
                <Field
                  label={
                    i === 0
                      ? levels.length > 1
                        ? "Level 1: selector of the list"
                        : "Selector of the list"
                      : `Level ${i + 1}: selector of the list on each page those links lead to`
                  }
                  hint={
                    i === 0 ? (
                      <>
                        Not a web developer? Install{" "}
                        <a
                          href="https://selectorgadget.com/"
                          target="_blank"
                          rel="noreferrer"
                          className="text-sky-300 hover:underline"
                        >
                          SelectorGadget
                        </a>
                        , open the page, click the list of links, and copy the selector it shows.
                      </>
                    ) : undefined
                  }
                >
                  <div className="flex gap-2">
                    <Input
                      value={level.selector}
                      onChange={(e) => setLevel(i, { selector: e.target.value })}
                      placeholder={i === 0 ? ".notice-list a" : ".notices a"}
                      className="font-mono"
                    />
                    {i > 0 && (
                      <Button
                        variant="ghost"
                        aria-label={`Remove level ${i + 1}`}
                        title={`Remove level ${i + 1}`}
                        icon={<Trash2 className="size-4" />}
                        onClick={() => setLevels((all) => all.filter((_, j) => j !== i))}
                        disabled={busy}
                      />
                    )}
                  </div>
                </Field>
                <LimitField
                  level={i}
                  levels={levels.length}
                  input={level}
                  error={limits[i].error}
                  onChange={(input) => setLevel(i, input)}
                />
              </div>
            ))}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button
                variant="ghost"
                icon={<Plus className="size-4" />}
                onClick={() => setLevels((all) => [...all, NEW_LEVEL])}
                disabled={busy}
              >
                Add a level
              </Button>
              <Button
                onClick={findLinks}
                loading={finding}
                disabled={
                  !url || !!urlError || given.some((level) => !level.selector) || limitError || busy
                }
              >
                Find links
              </Button>
            </div>
            {levels.length === 1 && (
              <p className="-mt-3 text-[13px] text-zinc-500">
                Is the list split over pages, like one per year? Add a level for the list on each of
                them.
              </p>
            )}
            <WatchField
              input={watch}
              error={watching.error}
              most={watching.most}
              onChange={setWatch}
            />
            {links && (
              <div className="rounded-2xl bg-white/[0.03] px-4 py-3 ring-1 ring-white/[0.07]">
                <p
                  className={clsx(
                    "text-sm",
                    followed.length && !tooMany ? "text-zinc-200" : "text-amber-200",
                  )}
                >
                  {links.links.length === 0
                    ? "What it selects has no links."
                    : tooMany
                      ? `It finds ${links.links.length} links, over the ${links.max} a watcher follows. Narrow the ${levels.length > 1 ? "selectors" : "selector"}, or follow fewer.`
                      : followed.length < links.links.length
                        ? `It finds ${links.links.length} links; the ${last.reverse ? "last" : "first"} ${followed.length === 1 ? "becomes a page" : `${followed.length} become pages`}.`
                        : `It finds ${links.links.length} ${links.links.length === 1 ? "link" : "links"}; each becomes a page.`}
                </p>
                {followed.length > 0 && (
                  <ul className="mt-2 space-y-1 text-[13px]">
                    {followed.slice(0, showLinks).map((link) => (
                      <li key={link.url} className="truncate text-zinc-400">
                        <span className="text-zinc-200">{link.text || "(no text)"}</span>{" "}
                        <span className="text-zinc-500">{link.url}</span>
                      </li>
                    ))}
                    {followed.length > showLinks && (
                      <li className="text-zinc-500">
                        and {followed.length - showLinks} more.{" "}
                        <Button
                          variant="ghost"
                          onClick={() => setShowLinks(Number.MAX_SAFE_INTEGER)}
                        >
                          Show
                        </Button>
                      </li>
                    )}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
        {busy && <Indeterminate />}
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => setKind(null)} disabled={busy} className="mr-auto">
            Back
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!canCreate}>
            {kind === "file" ? "Import and watch" : "Watch"}
          </Button>
        </div>
        {kind === "directory" && ready && !links && (
          <p className="text-right text-[12px] text-zinc-500">
            Find the links first, to see what it imports.
          </p>
        )}
      </form>
    </Dialog>
  );
}

/** One kind of watcher to make. */
function KindChoice({ icon, title, detail, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-2xl bg-white/[0.03] px-4 py-3 text-left ring-1 ring-white/[0.07] transition ring-inset hover:bg-white/[0.07]"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-sky-500/10 text-sky-300">
        {icon}
      </span>
      <span>
        <span className="block text-sm font-medium text-zinc-100">{title}</span>
        <span className="block text-[13px] text-zinc-400">{detail}</span>
      </span>
    </button>
  );
}

function NewFolderDialog({ parent, onClose, onDone }) {
  const api = useApi();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const error = name ? invalidName(name) : null;

  async function submit(e) {
    e.preventDefault();
    if (!name || error) return;
    setBusy(true);
    try {
      await api.createFolder(idOf([...parent, name]));
      toast.success(`Folder “${name}” created`);
      onDone([...parent, name]);
    } catch (e) {
      toast.error(message(e));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      locked={busy}
      title="New folder"
      description={parent.length ? `Inside ${parent.join(" › ")}` : "At the top of your topics"}
    >
      <form onSubmit={submit} className="space-y-5">
        <Field label="Name" error={error}>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Admissions"
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!name || !!error}>
            Create folder
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RenameDialog({ path, node, onClose, onDone }) {
  const api = useApi();
  const old = path[path.length - 1];
  const part = isPart(old);
  const [name, setName] = useState(part ? partName(old) : old);
  const [busy, setBusy] = useState(false);
  const error = name === old ? null : invalidName(name);
  const folder = !!node && !node.file;
  const pages = node ? counts(node).files + (node.file ? 1 : 0) : 0;

  async function submit(e) {
    e.preventDefault();
    if (!name || name === old || error) return;
    setBusy(true);
    const to = [...path.slice(0, -1), name];
    try {
      if (folder) await api.renameFolder(idOf(path), idOf(to));
      else await api.renameFile(idOf(path), idOf(to));
      toast.success(`Renamed to “${name}”`);
      onDone(to);
    } catch (e) {
      toast.error("Couldn't rename it", { description: message(e) });
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      locked={busy}
      title={part ? "Name this part" : `Rename “${old}”`}
      description={
        pages > 0
          ? `Its new name is part of what your assistant reads, so ${
              pages === 1 ? "the page is" : `all ${pages} pages are`
            } read again. It can take a minute.`
          : undefined
      }
    >
      <form onSubmit={submit} className="space-y-5">
        <Field label="New name" error={error}>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => e.target.select()}
          />
        </Field>
        {busy && <Indeterminate />}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={busy}
            disabled={!name || name === old || !!error}
          >
            Rename
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteDialog({ path, node, onClose, onDone }) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const name = path[path.length - 1];
  const id = idOf(path);
  const isFolder = !!node && !node.file;
  const inside = node ? counts(node).files : 0;

  async function remove() {
    setBusy(true);
    try {
      if (isFolder) await api.deleteFolder(id);
      else await api.deleteFile(id);
      toast.success(isFolder ? `Deleted the folder “${name}”` : `Deleted “${name}”`);
      onDone();
    } catch (e) {
      toast.error("Couldn't delete it", { description: message(e) });
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      locked={busy}
      title={`Delete “${name}”?`}
      description={
        isFolder
          ? `This deletes the folder and the ${inside} ${inside === 1 ? "page" : "pages"} inside it. Your assistant forgets them at once.`
          : "Your assistant forgets this page at once. This can't be undone."
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={busy}
            onClick={() => void remove()}
            icon={<Trash2 className="size-4" />}
          >
            {isFolder ? "Delete folder" : "Delete page"}
          </Button>
        </>
      }
    />
  );
}

/** After a save split a page into parts: name each part so it reads as a topic of its own. */
function PartsDialog({ ids, onClose }) {
  const api = useApi();
  const first = ids[0].split("|");
  const base = first[first.length - 1];
  const parts = ids.slice(1);
  const [names, setNames] = useState(() => parts.map((id) => partName(id.split("|").pop() ?? id)));
  const [done, setDone] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const errors = names.map((name) => invalidName(name));

  async function renameAll() {
    setBusy(true);
    for (const [i, id] of parts.entries()) {
      if (done.has(id)) continue;
      const to = idOf([...first.slice(0, -1), names[i]]);
      try {
        await api.renameFile(id, to);
        setDone((d) => new Set(d).add(id));
      } catch (e) {
        toast.error(`Couldn't rename ${id}`, { description: message(e) });
        setBusy(false);
        return;
      }
    }
    toast.success("All parts named");
    onClose();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      locked={busy}
      title={`“${base}” was split into ${ids.length} parts`}
      description="It was too long to read as one page. Name the other parts so each reads as a topic of its own."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Later
          </Button>
          <Button
            variant="primary"
            onClick={renameAll}
            loading={busy}
            disabled={errors.some(Boolean)}
          >
            Name the parts
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {parts.map((id, i) => (
          <Field key={id} label={id.split("|").pop() ?? id} error={errors[i]}>
            <div className="flex items-center gap-2">
              <Input
                value={names[i]}
                disabled={busy || done.has(id)}
                onChange={(e) =>
                  setNames((all) => all.map((n, j) => (j === i ? e.target.value : n)))
                }
              />
              {done.has(id) && <Badge tone="emerald">Done</Badge>}
            </div>
          </Field>
        ))}
      </div>
    </Dialog>
  );
}
