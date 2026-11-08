"use client";

import {
  Check,
  CloudOff,
  FolderTree,
  Globe,
  Inbox,
  KeyRound,
  LogIn,
  RefreshCw,
  ShieldOff,
  UserMinus,
  X,
} from "lucide-react";
import clsx from "clsx";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Landing } from "@/components/landing";
import { useApi, useSession } from "@/components/session-provider";
import { Notice, Shell, Splash } from "@/components/shell";
import { Badge, Button, Card, Dialog, Field, Input, Spinner, inputClass } from "@/components/ui";
import { message, openOrg } from "@/lib/api";
import { ago } from "@/lib/time";
import { idOf, SEP } from "@/lib/tree";

export default function AdminPage() {
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
      {me.admin ? (
        <Admin />
      ) : (
        <Notice
          icon={<ShieldOff className="size-6" />}
          title="Admins only"
          action={<Button onClick={() => router.push("/")}>Back home</Button>}
        >
          {me.email} can&apos;t review requests.
        </Notice>
      )}
    </Shell>
  );
}

/**
 * @typedef {{ request: RegistrationRequest; approve: boolean }} Decision
 */

/**
 * The registration requests, the accounts asking to join an org, then the approved orgs with their
 * provider keys and admins.
 */
function Admin() {
  const api = useApi();
  const router = useRouter();
  const { refreshMe } = useSession();
  const [requests, setRequests] = useState(null);
  const [orgs, setOrgs] = useState(null);
  const [admins, setAdmins] = useState([]);
  const [granting, setGranting] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [deciding, setDeciding] = useState(null);
  const [keying, setKeying] = useState(null);
  const [placing, setPlacing] = useState(null);

  // The backend sorts the requests and admins oldest first, and the orgs by name.
  const load = useCallback(
    () =>
      Promise.all([api.requests(), api.orgs(), api.admins()]).then(
        ([requests, orgs, admins]) => {
          setRequests(requests);
          setOrgs(orgs);
          setAdmins(admins);
          setError(null);
        },
        (e) => setError(message(e)),
      ),
    [api],
  );

  /** Acts as `org`'s admin, on its topics. */
  async function open(org) {
    openOrg(org.org_id);
    await refreshMe();
    router.push("/");
  }

  const joining = admins.filter((admin) => !admin.folders);

  useEffect(() => {
    void load();
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  return (
    <div className="animate-rise">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-4xl text-white sm:text-5xl">Registration requests</h1>
          <p className="mt-2 text-sm text-zinc-500">
            {requests === null
              ? "Loading…"
              : requests.length === 0
                ? "Nobody is waiting."
                : `${requests.length} ${requests.length === 1 ? "organisation is" : "organisations are"} waiting, oldest first.`}
          </p>
        </div>
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

      {error && !requests ? (
        <Notice
          icon={<CloudOff className="size-6" />}
          title="Couldn't load the requests"
          action={<Button onClick={refresh}>Try again</Button>}
        >
          {error}
        </Notice>
      ) : !requests ? (
        <div className="grid place-items-center pt-32">
          <Spinner className="size-5 text-zinc-500" />
        </div>
      ) : requests.length === 0 ? (
        <Card className="mt-8 flex flex-col items-center px-6 py-20 text-center">
          <div className="grid size-14 place-items-center rounded-2xl bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-400/20">
            <Inbox className="size-6" />
          </div>
          <h2 className="mt-6 font-serif text-3xl text-white">All caught up</h2>
          <p className="mt-2 text-sm text-zinc-400">New organisations show up here to approve.</p>
        </Card>
      ) : (
        <div className="mt-8 grid gap-4 md:grid-cols-2">
          {requests.map((request) => (
            <RequestCard
              key={request.org_id}
              request={request}
              onDecide={(approve) => setDeciding({ request, approve })}
            />
          ))}
        </div>
      )}

      {joining.length > 0 && (
        <JoinRequests joining={joining} onLetIn={setGranting} onRefuse={setRemoving} />
      )}

      {orgs && (
        <Orgs
          orgs={orgs}
          admins={admins}
          onSetKeys={setKeying}
          onSetOrigins={setPlacing}
          onOpen={(org) => void open(org)}
          onFolders={setGranting}
          onRemove={setRemoving}
        />
      )}

      {granting && (
        <FoldersDialog
          admin={granting}
          onClose={() => setGranting(null)}
          onDone={(folders) => {
            const { email } = granting;
            setGranting(null);
            setAdmins((all) => all.map((a) => (a.email === email ? { ...a, folders } : a)));
          }}
        />
      )}

      {removing && (
        <RemoveAdminDialog
          admin={removing}
          onClose={() => setRemoving(null)}
          onDone={() => {
            const { email } = removing;
            setRemoving(null);
            setAdmins((all) => all.filter((a) => a.email !== email));
          }}
        />
      )}

      {deciding && (
        <DecideDialog
          decision={deciding}
          onClose={() => setDeciding(null)}
          onDone={() => {
            const { org_id } = deciding.request;
            setDeciding(null);
            setRequests((all) => all?.filter((r) => r.org_id !== org_id) ?? null);
            // An approved request shows up among the orgs.
            if (deciding.approve) void load();
          }}
        />
      )}

      {keying && (
        <KeysDialog
          org={keying}
          onClose={() => setKeying(null)}
          onDone={() => {
            const { org_id } = keying;
            setKeying(null);
            setOrgs(
              (all) =>
                all?.map((org) =>
                  org.org_id === org_id
                    ? { ...org, openrouter_key: true, firecrawl_key: true, mongodb_key: true }
                    : org,
                ) ?? null,
            );
          }}
        />
      )}

      {placing && (
        <OriginsDialog
          org={placing}
          onClose={() => setPlacing(null)}
          onDone={(chatbot_origins) => {
            const { org_id } = placing;
            setPlacing(null);
            setOrgs(
              (all) =>
                all?.map((org) => (org.org_id === org_id ? { ...org, chatbot_origins } : org)) ??
                null,
            );
          }}
        />
      )}
    </div>
  );
}

/** How a folder given to an admin reads: `""` is the whole org. */
const folderLabel = (folder) =>
  folder === "" ? "Whole organisation" : folder.split(SEP).join(" › ");

/** Whether the folder `outer` is above `inner`, name by name: `""` is above every other. */
function above(outer, inner) {
  if (outer === inner) return false;
  if (outer === "") return true;
  const names = inner.split(SEP);
  return outer.split(SEP).every((name, i) => names[i] === name);
}

/** The accounts asking to join an org. */
function JoinRequests({ joining, onLetIn, onRefuse }) {
  return (
    <section className="mt-16">
      <h2 className="font-serif text-3xl text-white">Asking to join</h2>
      <p className="mt-2 text-sm text-zinc-500">
        Let each one in with the folders they may change, oldest first.
      </p>
      <Card className="mt-6 divide-y divide-white/[0.06]">
        {joining.map((admin) => (
          <div key={admin.email} className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4">
            <div className="min-w-48 flex-1">
              <p className="truncate font-medium text-white">{admin.email}</p>
              <p className="mt-0.5 truncate text-[13px] text-zinc-500">
                {admin.org_name} <span className="font-mono text-violet-300">{admin.org_id}</span> ·
                asked {ago(admin.requested_at)}
              </p>
            </div>
            <span className="flex items-center gap-2">
              <Button
                size="sm"
                variant="primary"
                icon={<FolderTree className="size-3.5" />}
                onClick={() => onLetIn(admin)}
              >
                Let in
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={<X className="size-3.5" />}
                onClick={() => onRefuse(admin)}
              >
                Refuse
              </Button>
            </span>
          </div>
        ))}
      </Card>
    </section>
  );
}

function Orgs({ orgs, admins, onSetKeys, onSetOrigins, onOpen, onFolders, onRemove }) {
  const keyless = orgs.some((org) => !org.openrouter_key || !org.firecrawl_key);
  return (
    <section className="mt-16">
      <h2 className="font-serif text-3xl text-white">Organisations</h2>
      <p className="mt-2 text-sm text-zinc-500">
        Each one&apos;s models, imports and reranking bill to its own OpenRouter, Firecrawl and
        MongoDB keys.
        {keyless &&
          " One without its OpenRouter and Firecrawl keys can't save or import pages until you set them."}
      </p>
      {orgs.length === 0 ? (
        <p className="mt-6 text-sm text-zinc-500">None approved yet.</p>
      ) : (
        <Card className="mt-6 divide-y divide-white/[0.06]">
          {orgs.map((org) => (
            <div key={org.org_id} className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-linear-to-br from-violet-500/25 to-sky-500/20 font-serif text-lg text-violet-100 ring-1 ring-white/10">
                {org.org_name.slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-48 flex-1">
                <p className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate font-medium text-white">{org.org_name}</span>
                  <span className="truncate font-mono text-[12px] text-violet-300">
                    {org.org_id}
                  </span>
                </p>
                <p
                  className="mt-0.5 truncate text-[13px] text-zinc-500"
                  title={new Date(org.approved_at * 1000).toLocaleString()}
                >
                  {org.owner_email} · approved {ago(org.approved_at)}
                </p>
                <p
                  className="mt-0.5 truncate text-[13px] text-zinc-500"
                  title={org.chatbot_origins.join("\n")}
                >
                  {org.chatbot_origins.length > 0
                    ? `Chatbot on ${org.chatbot_origins.join(", ")}`
                    : "No chatbot origins yet"}
                </p>
              </div>
              <span className="flex items-center gap-2">
                <KeyStatus org={org} />
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<KeyRound className="size-3.5" />}
                  onClick={() => onSetKeys(org)}
                >
                  Set keys
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Globe className="size-3.5" />}
                  onClick={() => onSetOrigins(org)}
                >
                  Origins
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<LogIn className="size-3.5" />}
                  onClick={() => onOpen(org)}
                >
                  Open as admin
                </Button>
              </span>
              <OrgAdmins
                admins={admins.filter((a) => a.org_id === org.org_id && a.folders)}
                onFolders={onFolders}
                onRemove={onRemove}
              />
            </div>
          ))}
        </Card>
      )}
    </section>
  );
}

/** An org's admins, each with the folders they may change. */
function OrgAdmins({ admins, onFolders, onRemove }) {
  if (admins.length === 0) return null;
  return (
    <ul className="w-full space-y-1 border-t border-white/[0.04] pt-3">
      {admins.map((admin) => (
        <li key={admin.email} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
          <span className="min-w-0 truncate text-zinc-200">{admin.email}</span>
          <span
            className="min-w-0 flex-1 truncate text-zinc-500"
            title={admin.folders?.map(folderLabel).join("\n")}
          >
            {admin.folders?.map(folderLabel).join(", ")}
          </span>
          <Button
            size="sm"
            variant="ghost"
            icon={<FolderTree className="size-3.5" />}
            onClick={() => onFolders(admin)}
          >
            Folders
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<UserMinus className="size-3.5" />}
            onClick={() => onRemove(admin)}
          >
            Remove
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** The folders under `node`, depth first, each as its path. */
function folderPaths(node, path = []) {
  return node.children.flatMap((child) => {
    const at = [...path, child.name];
    return child.file ? [] : [at, ...folderPaths(child, at)];
  });
}

/**
 * Picks the folders an admin may change, from their org's tree: lets an account asking to join in,
 * or changes an admin's.
 */
function FoldersDialog({ admin, onClose, onDone }) {
  const api = useApi();
  const [tree, setTree] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [picked, setPicked] = useState(() => new Set(admin.folders ?? []));
  const [busy, setBusy] = useState(false);
  const joining = !admin.folders;

  useEffect(() => {
    api.tree(admin.org_id).then(setTree, (e) => setLoadError(message(e)));
  }, [api, admin.org_id]);

  const rows = [
    { id: "", name: "Whole organisation", depth: 0 },
    ...(tree ? folderPaths(tree) : []).map((path) => ({
      id: idOf(path),
      name: path[path.length - 1],
      depth: path.length,
    })),
  ];
  // Given before, then deleted or renamed: shown so they can be taken away.
  const gone = tree ? [...picked].filter((id) => !rows.some((row) => row.id === id)) : [];

  // A folder inside a picked one is theirs already, so it can't be picked too.
  function toggle(id) {
    setPicked((all) => {
      if (all.has(id)) return new Set([...all].filter((folder) => folder !== id));
      return new Set([...[...all].filter((folder) => !above(id, folder)), id]);
    });
  }
  const covered = (id) => [...picked].some((folder) => above(folder, id));

  async function save(e) {
    e.preventDefault();
    if (picked.size === 0) return;
    setBusy(true);
    try {
      const { folders } = await api.setAdmin(admin.email, [...picked]);
      toast.success(joining ? `Let ${admin.email} in` : `Saved ${admin.email}'s folders`);
      onDone(folders);
    } catch (e) {
      toast.error("Couldn't save the folders", { description: message(e) });
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      locked={busy}
      title={joining ? `Let ${admin.email} into ${admin.org_name}?` : `${admin.email}'s folders`}
      description="They can change what's in these folders, but not rename or delete the folders themselves. They see the folders above them only as a path."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="admin-folders"
            variant="primary"
            loading={busy}
            disabled={picked.size === 0}
            icon={<Check className="size-4" />}
          >
            {joining ? "Let in" : "Save folders"}
          </Button>
        </>
      }
    >
      <form id="admin-folders" onSubmit={save}>
        {loadError ? (
          <p className="text-sm text-rose-300">{loadError}</p>
        ) : !tree ? (
          <div className="grid place-items-center py-10">
            <Spinner className="size-5 text-zinc-500" />
          </div>
        ) : (
          <ul className="max-h-80 overflow-y-auto rounded-2xl p-2 ring-1 ring-white/[0.08] ring-inset">
            {[
              ...rows,
              ...gone.map((id) => ({ id, name: `${folderLabel(id)} (gone)`, depth: 1 })),
            ].map((row) => (
              <li key={row.id}>
                <label
                  className={clsx(
                    "flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm",
                    covered(row.id)
                      ? "text-zinc-500"
                      : "cursor-pointer text-zinc-200 hover:bg-white/[0.04]",
                  )}
                  style={{ paddingLeft: `${0.5 + row.depth}rem` }}
                >
                  <input
                    type="checkbox"
                    checked={picked.has(row.id) || covered(row.id)}
                    disabled={covered(row.id)}
                    onChange={() => toggle(row.id)}
                    className="size-4 accent-violet-500"
                  />
                  <span className="truncate">{row.name}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </form>
    </Dialog>
  );
}

/** Removes an admin, revoking their API keys, or refuses an account asking to join. */
function RemoveAdminDialog({ admin, onClose, onDone }) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const joining = !admin.folders;

  async function remove() {
    setBusy(true);
    try {
      await api.removeAdmin(admin.email);
      toast.success(joining ? `Refused ${admin.email}` : `Removed ${admin.email}`);
      onDone();
    } catch (e) {
      toast.error(joining ? "Couldn't refuse them" : "Couldn't remove them", {
        description: message(e),
      });
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      locked={busy}
      title={joining ? `Refuse ${admin.email}?` : `Remove ${admin.email}?`}
      description={
        joining
          ? `They won't join ${admin.org_name}, and can ask again.`
          : `They lose ${admin.org_name}'s topics at once, and their API keys are revoked.`
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => void remove()}
            loading={busy}
            icon={joining ? <X className="size-4" /> : <UserMinus className="size-4" />}
          >
            {joining ? "Refuse" : "Remove"}
          </Button>
        </>
      }
    />
  );
}

function KeyStatus({ org }) {
  const missing = [
    !org.openrouter_key && "OpenRouter",
    !org.firecrawl_key && "Firecrawl",
    !org.mongodb_key && "MongoDB",
  ].filter((name) => name !== false);
  if (missing.length === 0) return <Badge tone="emerald">Keys set</Badge>;
  const last = missing.pop();
  return (
    <Badge tone="amber">
      No {missing.length > 0 ? `${missing.join(", ")} or ${last} keys` : `${last} key`}
    </Badge>
  );
}

function RequestCard({ request, onDecide }) {
  return (
    <Card className="flex flex-col p-6">
      <div className="flex items-start gap-4">
        <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-linear-to-br from-violet-500/25 to-sky-500/20 font-serif text-xl text-violet-100 ring-1 ring-white/10">
          {request.org_name.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-medium text-white">{request.org_name}</h2>
          <p className="mt-0.5 truncate font-mono text-[13px] text-violet-300">{request.org_id}</p>
        </div>
        <Badge tone="amber">Pending</Badge>
      </div>
      <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
        <dt className="text-zinc-500">Owner</dt>
        <dd className="truncate text-zinc-200">{request.owner_email}</dd>
        <dt className="text-zinc-500">Asked</dt>
        <dd
          className="text-zinc-200"
          title={new Date(request.requested_at * 1000).toLocaleString()}
        >
          {ago(request.requested_at)}
        </dd>
      </dl>
      <div className="mt-6 flex gap-2">
        <Button
          variant="primary"
          className="flex-1"
          icon={<Check className="size-4" />}
          onClick={() => onDecide(true)}
        >
          Approve
        </Button>
        <Button
          variant="danger"
          className="flex-1"
          icon={<X className="size-4" />}
          onClick={() => onDecide(false)}
        >
          Reject
        </Button>
      </div>
    </Card>
  );
}

/**
 * @typedef {{ openrouter_key: string; firecrawl_key: string; mongodb_key: string }} Keys
 */

const NO_KEYS = { openrouter_key: "", firecrawl_key: "", mongodb_key: "" };

function DecideDialog({ decision: { request, approve }, onClose, onDone }) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [keys, setKeys] = useState(NO_KEYS);
  const [origins, setOrigins] = useState("");
  const ready =
    !approve ||
    (!!keys.openrouter_key.trim() && !!keys.firecrawl_key.trim() && !!keys.mongodb_key.trim());

  async function decide(e) {
    e?.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      if (approve) await api.approve(request.org_id, keys, originsIn(origins));
      else await api.reject(request.org_id);
      toast.success(approve ? `Approved ${request.org_name}` : `Rejected ${request.org_name}`);
      onDone();
    } catch (e) {
      toast.error(approve ? "Couldn't approve it" : "Couldn't reject it", {
        description: message(e),
      });
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      wide={approve}
      onClose={onClose}
      locked={busy}
      title={approve ? `Approve ${request.org_name}?` : `Reject ${request.org_name}?`}
      description={
        approve
          ? `${request.owner_email} gets the portal for ${request.org_id} and can start teaching its assistant. Its models, imports and reranking bill to the keys below, so make each one just for it: each provider's dashboard then shows its usage.`
          : `The request is dropped and ${request.org_id} is free to claim again. ${request.owner_email} can send a new request.`
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type={approve ? "submit" : "button"}
            form={approve ? "approve-keys" : undefined}
            variant={approve ? "primary" : "danger"}
            onClick={approve ? undefined : () => void decide()}
            loading={busy}
            disabled={!ready}
            icon={approve ? <Check className="size-4" /> : <X className="size-4" />}
          >
            {approve ? "Approve" : "Reject"}
          </Button>
        </>
      }
    >
      {approve && (
        <form id="approve-keys" onSubmit={decide} className="space-y-5">
          <KeyFields keys={keys} onChange={setKeys} />
          <OriginsField value={origins} onChange={setOrigins} optional />
        </form>
      )}
    </Dialog>
  );
}

/** Replaces an approved org's keys. A field left blank keeps the org's current key. */
function KeysDialog({ org, onClose, onDone }) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [keys, setKeys] = useState(NO_KEYS);
  const openrouter = !!keys.openrouter_key.trim();
  const firecrawl = !!keys.firecrawl_key.trim();
  const mongodb = !!keys.mongodb_key.trim();
  const ready =
    (openrouter || firecrawl || mongodb) &&
    (openrouter || org.openrouter_key) &&
    (firecrawl || org.firecrawl_key) &&
    (mongodb || org.mongodb_key);

  async function save(e) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      await api.setKeys(org.org_id, keys);
      toast.success(`Saved ${org.org_name}'s keys`);
      onDone();
    } catch (e) {
      toast.error("Couldn't save the keys", { description: message(e) });
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      locked={busy}
      title={`${org.org_name}'s keys`}
      description={
        !org.openrouter_key || !org.firecrawl_key
          ? `${org.org_name} can't save or import pages until it has its OpenRouter and Firecrawl keys.`
          : org.mongodb_key
            ? "Replace any key. One left blank stays as it is."
            : `Give ${org.org_name} a MongoDB key to rerank its searches. A key it has may be left blank.`
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="org-keys"
            variant="primary"
            loading={busy}
            disabled={!ready}
            icon={<KeyRound className="size-4" />}
          >
            Save keys
          </Button>
        </>
      }
    >
      <form id="org-keys" onSubmit={save}>
        <KeyFields keys={keys} onChange={setKeys} org={org} />
      </form>
    </Dialog>
  );
}

const link = "underline underline-offset-2 hover:text-zinc-300";

/**
 * The OpenRouter, Firecrawl and MongoDB keys, checked with each provider when saved. With `org`, a
 * field for a key it has may be left blank.
 */
function KeyFields({ keys, onChange, org }) {
  const keep = "Leave blank to keep the current key";
  return (
    <div className="space-y-5">
      <Field
        label="OpenRouter key"
        hint={
          <>
            Runs its models. Create one on{" "}
            <a
              href="https://openrouter.ai/settings/keys"
              target="_blank"
              rel="noreferrer"
              className={link}
            >
              OpenRouter
            </a>
            .
          </>
        }
      >
        <Input
          autoFocus
          value={keys.openrouter_key}
          onChange={(e) => onChange({ ...keys, openrouter_key: e.target.value })}
          placeholder={org?.openrouter_key ? keep : "sk-or-v1-…"}
          autoComplete="off"
          spellCheck={false}
          className="font-mono placeholder:font-sans"
        />
      </Field>
      <Field
        label="Firecrawl key"
        hint={
          <>
            Imports web pages. Create one on{" "}
            <a
              href="https://www.firecrawl.dev/app/api-keys"
              target="_blank"
              rel="noreferrer"
              className={link}
            >
              Firecrawl
            </a>
            .
          </>
        }
      >
        <Input
          value={keys.firecrawl_key}
          onChange={(e) => onChange({ ...keys, firecrawl_key: e.target.value })}
          placeholder={org?.firecrawl_key ? keep : "fc-…"}
          autoComplete="off"
          spellCheck={false}
          className="font-mono placeholder:font-sans"
        />
      </Field>
      <Field
        label="MongoDB key"
        hint={
          <>
            Reranks its searches with Voyage AI. Create a model API key under AI Models in a{" "}
            <a href="https://cloud.mongodb.com" target="_blank" rel="noreferrer" className={link}>
              MongoDB Atlas
            </a>{" "}
            project.
          </>
        }
      >
        <Input
          value={keys.mongodb_key}
          onChange={(e) => onChange({ ...keys, mongodb_key: e.target.value })}
          placeholder={org?.mongodb_key ? keep : "al-…"}
          autoComplete="off"
          spellCheck={false}
          className="font-mono placeholder:font-sans"
        />
      </Field>
    </div>
  );
}

/** The origins in `text`: one per line, or split by commas or spaces, which no origin has. */
function originsIn(text) {
  return text.split(/[\s,]+/).filter(Boolean);
}

/**
 * The sites an org's chatbot may be embedded on. The portal only keeps them for the chatbot; the
 * backend reads each as an origin and answers them as stored.
 */
function OriginsField({ value, onChange, optional }) {
  return (
    <Field
      label="Chatbot origins"
      hint={
        <>
          The sites whose pages may show its chatbot, one per line. A bare domain is read as
          https://.{optional && " Optional: you can set them later."}
        </>
      }
    >
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={"https://www.example.org\nhttps://admissions.example.org"}
        rows={3}
        autoComplete="off"
        spellCheck={false}
        className={`${inputClass} block resize-y py-2.5 font-mono placeholder:font-sans`}
      />
    </Field>
  );
}

/** Replaces an approved org's chatbot origins; emptying the field removes them. */
function OriginsDialog({ org, onClose, onDone }) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState(org.chatbot_origins.join("\n"));
  const changed = originsIn(text).join("\n") !== org.chatbot_origins.join("\n");

  async function save(e) {
    e.preventDefault();
    if (!changed) return;
    setBusy(true);
    try {
      const { chatbot_origins } = await api.setChatbotOrigins(org.org_id, originsIn(text));
      toast.success(`Saved ${org.org_name}'s chatbot origins`);
      onDone(chatbot_origins);
    } catch (e) {
      toast.error("Couldn't save the origins", { description: message(e) });
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      locked={busy}
      title={`${org.org_name}'s chatbot origins`}
      description="Only these sites may embed its chatbot. Emptying the field removes them all."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="org-origins"
            variant="primary"
            loading={busy}
            disabled={!changed}
            icon={<Globe className="size-4" />}
          >
            Save origins
          </Button>
        </>
      }
    >
      <form id="org-origins" onSubmit={save}>
        <OriginsField value={text} onChange={setText} />
      </form>
    </Dialog>
  );
}
