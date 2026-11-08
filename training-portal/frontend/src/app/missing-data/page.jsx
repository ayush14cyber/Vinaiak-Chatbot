"use client";

import clsx from "clsx";
import { Check, ChevronDown, CloudOff, Inbox, RefreshCw, ShieldOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Landing } from "@/components/landing";
import { useApi, useSession } from "@/components/session-provider";
import { Notice, Shell, Splash } from "@/components/shell";
import { Badge, Button, Card, MarkdownView, Spinner } from "@/components/ui";
import { message } from "@/lib/api";
import { ago } from "@/lib/time";

export default function MissingDataPage() {
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
        <Reports />
      ) : (
        <Notice
          icon={<ShieldOff className="size-6" />}
          title="No approved org"
          action={<Button onClick={() => router.push("/")}>Back home</Button>}
        >
          Once your org is approved, what its chatbot couldn&apos;t find in your topics shows up
          here.
        </Notice>
      )}
    </Shell>
  );
}

/** What the org's chatbot couldn't find, one card per conversation, newest first. */
function Reports() {
  const api = useApi();
  const [reports, setReports] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    () =>
      api.dataNotFound().then(
        (reports) => {
          setReports(reports);
          setError(null);
        },
        (e) => setError(message(e)),
      ),
    [api],
  );

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
          <h1 className="font-serif text-4xl text-white sm:text-5xl">Missing data</h1>
          <p className="mt-2 max-w-2xl text-sm text-zinc-500">
            What your chatbot couldn&apos;t find in your topics while answering visitors, newest
            first. Add it to your topics, then resolve the report: that deletes it, with its
            conversation.
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

      {error && !reports ? (
        <Notice
          icon={<CloudOff className="size-6" />}
          title="Couldn't load the reports"
          action={<Button onClick={refresh}>Try again</Button>}
        >
          {error}
        </Notice>
      ) : !reports ? (
        <div className="grid place-items-center pt-32">
          <Spinner className="size-5 text-zinc-500" />
        </div>
      ) : reports.length === 0 ? (
        <Card className="mt-8 flex flex-col items-center px-6 py-20 text-center">
          <div className="grid size-14 place-items-center rounded-2xl bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-400/20">
            <Inbox className="size-6" />
          </div>
          <h2 className="mt-6 font-serif text-3xl text-white">Nothing missing</h2>
          <p className="mt-2 text-sm text-zinc-400">
            When your chatbot can&apos;t find what a visitor asks for, it shows up here.
          </p>
        </Card>
      ) : (
        <div className="mt-8 grid gap-4">
          {reports.map((report) => (
            <ReportCard
              key={report.session_id}
              report={report}
              onResolved={() =>
                setReports((all) => all?.filter((r) => r.session_id !== report.session_id) ?? null)
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ReportCard({ report, onResolved }) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [resolving, setResolving] = useState(false);

  async function resolve() {
    setResolving(true);
    try {
      await api.dismissDataNotFound(report.session_id);
      onResolved();
    } catch (e) {
      toast.error("Couldn't resolve it", { description: message(e) });
      setResolving(false);
    }
  }

  return (
    <Card className="px-5 py-5 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-[13px] text-zinc-500">
          <Badge tone="amber">{report.items.length} missing</Badge>
          <span title={new Date(report.reported_at * 1000).toLocaleString()}>
            {ago(report.reported_at)}
          </span>
        </p>
        <Button
          size="sm"
          icon={<Check className="size-3.5" />}
          loading={resolving}
          onClick={resolve}
          title="Deletes this report and its conversation"
        >
          Resolve
        </Button>
      </div>
      <ul className="mt-4 space-y-2">
        {report.items.map((item, i) => (
          <li key={i} className="flex gap-3 text-[15px] leading-6 text-zinc-100">
            <span className="mt-2.5 size-1.5 shrink-0 rounded-full bg-amber-300/70" />
            {item}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="mt-4 flex items-center gap-1.5 text-[13px] text-zinc-400 transition hover:text-zinc-100"
      >
        <ChevronDown className={clsx("size-3.5 transition", open && "rotate-180")} />
        {open ? "Hide" : "Show"} the conversation ({report.conversation.length}{" "}
        {report.conversation.length === 1 ? "message" : "messages"})
      </button>
      {open && (
        <div className="mt-4 space-y-3 border-t border-white/[0.06] pt-4">
          {report.conversation.map((turn, i) =>
            turn.role === "user" ? (
              <p
                key={i}
                className="ml-auto w-fit max-w-[85%] rounded-2xl bg-violet-500/15 px-4 py-2.5 text-[14px] leading-6 whitespace-pre-wrap text-violet-50 ring-1 ring-violet-400/20"
              >
                {turn.text}
              </p>
            ) : (
              <div
                key={i}
                className="max-w-[85%] rounded-2xl bg-white/[0.04] px-4 py-3 text-[14px] ring-1 ring-white/[0.06]"
              >
                <MarkdownView>{turn.text}</MarkdownView>
              </div>
            ),
          )}
        </div>
      )}
    </Card>
  );
}
