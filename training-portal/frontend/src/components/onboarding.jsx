"use client";

import clsx from "clsx";
import { ArrowRight, Check, CircleAlert, Hourglass, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { message } from "@/lib/api";
import { useApi, useSession } from "./session-provider";
import { Notice } from "./shell";
import { Badge, Button, Card, Field, Input, Spinner } from "./ui";

/** Why `id` can't be an org id, if it can't: the backend's rules, checked as the user types. */
function invalidOrgId(id) {
  if (id.length < 3 || id.length > 63) return "Use 3 to 63 characters.";
  if (!/^[a-z0-9.-]+$/.test(id)) return "Use lowercase letters, digits, hyphens and dots only.";
  if (!/^[a-z0-9]/.test(id) || !/[a-z0-9]$/.test(id))
    return "Start and end with a letter or a digit.";
  return null;
}

/** An org id suggested from its name: `IIT (ISM) Dhanbad` → `iit-ism-dhanbad`. */
const slug = (name) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");

const createSteps = [
  "Sign in with Google",
  "Claim your organisation",
  "A Vinaiak admin approves it",
];
const joinSteps = [
  "Sign in with Google",
  "Ask to join your organisation",
  "A Vinaiak admin lets you in",
];

export function Register() {
  const api = useApi();
  const { refreshMe, profile } = useSession();
  const [joining, setJoining] = useState(false);
  const [orgName, setOrgName] = useState("");
  const [typedId, setTypedId] = useState(null);
  const [check, setCheck] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const orgId = typedId ?? slug(orgName);
  const formatError = orgId ? invalidOrgId(orgId) : null;

  useEffect(() => {
    if (!orgId || formatError) return;
    const timer = setTimeout(() => {
      api
        .available(orgId)
        .then((result) => setCheck({ id: orgId, ...result }))
        .catch((error) => setCheck({ id: orgId, available: false, reason: message(error) }));
    }, 350);
    return () => clearTimeout(timer);
  }, [api, orgId, formatError]);

  const status = !orgId
    ? "empty"
    : formatError
      ? "invalid"
      : check?.id !== orgId
        ? "checking"
        : check.available
          ? "available"
          : "taken";
  const canSubmit = status === "available" && orgName.trim().length > 0 && !submitting;

  async function submit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await api.register(orgId, orgName.trim());
      toast.success("Request sent", { description: "An admin will review it shortly." });
      await refreshMe();
    } catch (error) {
      toast.error(message(error));
      setSubmitting(false);
    }
  }

  const steps = joining ? joinSteps : createSteps;
  return (
    <div className="animate-rise mx-auto grid max-w-5xl items-center gap-12 pt-8 lg:grid-cols-[1fr_440px]">
      <div>
        <h1 className="font-serif text-5xl leading-tight text-white sm:text-6xl">
          {joining ? "Join" : "Claim"} your <em className="text-violet-300">organisation</em>.
        </h1>
        <p className="mt-5 max-w-md text-[16px] leading-7 text-zinc-400">
          {joining ? (
            <>
              Already on Vinaiak? Ask to join it with its id. A Vinaiak admin lets you in, and picks
              the folders you can change.
            </>
          ) : (
            <>
              Your organisation gets its own topics and its own Vinaiak AI assistant. Pick an id for
              it, which can&apos;t be changed later.
            </>
          )}
        </p>
        <ol className="mt-10 space-y-4">
          {steps.map((step, i) => (
            <li key={step} className="flex items-center gap-3 text-sm">
              <span
                className={clsx(
                  "grid size-7 place-items-center rounded-full text-[12px] font-semibold ring-1",
                  i === 0 && "bg-emerald-500/15 text-emerald-300 ring-emerald-400/30",
                  i === 1 && "bg-violet-500/20 text-violet-200 ring-violet-400/40",
                  i === 2 && "bg-white/[0.04] text-zinc-500 ring-white/10",
                )}
              >
                {i === 0 ? <Check className="size-3.5" /> : i + 1}
              </span>
              <span className={i === 2 ? "text-zinc-500" : "text-zinc-200"}>
                {step}
                {i === 0 && profile && <span className="text-zinc-500"> · {profile.email}</span>}
              </span>
            </li>
          ))}
        </ol>
      </div>
      <Card className="p-7">
        <div className="mb-6 flex gap-1 rounded-full bg-white/[0.03] p-1 ring-1 ring-white/[0.06] ring-inset">
          <ModeButton active={!joining} onClick={() => setJoining(false)}>
            Create one
          </ModeButton>
          <ModeButton active={joining} onClick={() => setJoining(true)}>
            Join one
          </ModeButton>
        </div>
        {joining ? (
          <JoinForm />
        ) : (
          <form onSubmit={submit} className="space-y-6">
            <Field label="Organisation name">
              <Input
                autoFocus
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="IIT (ISM) Dhanbad"
                maxLength={100}
              />
            </Field>
            <Field
              label="Organisation id"
              error={status === "invalid" ? formatError : status === "taken" ? check?.reason : null}
              hint="Lowercase letters, digits, hyphens and dots. It can't be changed later."
            >
              <div className="relative">
                <Input
                  value={orgId}
                  onChange={(e) => setTypedId(e.target.value.toLowerCase().replace(/\s+/g, "-"))}
                  placeholder="iit-ism-dhanbad"
                  spellCheck={false}
                  className="pr-28 font-mono"
                />
                <span className="absolute inset-y-0 right-3 flex items-center">
                  <IdStatus status={status} />
                </span>
              </div>
            </Field>
            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="w-full"
              disabled={!canSubmit}
              loading={submitting}
              icon={<ArrowRight className="size-4" />}
            >
              Request access
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}

function ModeButton({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        "flex-1 rounded-full px-3 py-1.5 text-[13px] transition",
        active ? "bg-white/[0.1] text-white" : "text-zinc-400 hover:text-zinc-100",
      )}
    >
      {children}
    </button>
  );
}

/** Asks to join an org already on Vinaiak, by its id. */
function JoinForm() {
  const api = useApi();
  const { refreshMe } = useSession();
  const [orgId, setOrgId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const formatError = orgId ? invalidOrgId(orgId) : null;
  const canSubmit = !!orgId && !formatError && !submitting;

  async function submit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await api.join(orgId);
      toast.success("Request sent", { description: "A Vinaiak admin will let you in shortly." });
      await refreshMe();
    } catch (error) {
      toast.error(message(error));
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <Field
        label="Organisation id"
        error={formatError}
        hint="Ask an admin of your organisation for it."
      >
        <Input
          autoFocus
          value={orgId}
          onChange={(e) => setOrgId(e.target.value.toLowerCase().replace(/\s+/g, "-"))}
          placeholder="iit-ism-dhanbad"
          spellCheck={false}
          className="font-mono"
        />
      </Field>
      <Button
        type="submit"
        variant="primary"
        size="lg"
        className="w-full"
        disabled={!canSubmit}
        loading={submitting}
        icon={<ArrowRight className="size-4" />}
      >
        Ask to join
      </Button>
    </form>
  );
}

function IdStatus({ status }) {
  switch (status) {
    case "checking":
      return <Spinner className="size-4 text-zinc-500" />;
    case "available":
      return (
        <Badge tone="emerald">
          <Check className="size-3" /> Available
        </Badge>
      );
    case "taken":
      return (
        <Badge tone="amber">
          <CircleAlert className="size-3" /> Taken
        </Badge>
      );
    default:
      return null;
  }
}

/** How often a pending account checks whether it was approved. */
const POLL_MS = 30_000;

export function Pending({ me }) {
  const { refreshMe } = useSession();
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => void refreshMe(), POLL_MS);
    return () => clearInterval(timer);
  }, [refreshMe]);

  async function check() {
    setChecking(true);
    await refreshMe();
    setChecking(false);
  }

  return (
    <Notice
      icon={<Hourglass className="size-6 animate-pulse text-amber-300" />}
      title={me.joining ? "Waiting to join" : "Waiting for approval"}
      action={
        <Button onClick={check} loading={checking} icon={<RefreshCw className="size-4" />}>
          Check again
        </Button>
      }
    >
      {me.joining ? (
        <p>
          A Vinaiak admin lets you into <span className="text-zinc-200">{me.org?.org_name}</span>,
          and picks the folders you can change. You&apos;ll see them as soon as you&apos;re in; this
          page checks on its own.
        </p>
      ) : (
        <p>
          A Vinaiak admin reviews every new organisation. You&apos;ll get your topics as soon as{" "}
          <span className="text-zinc-200">{me.org?.org_name}</span> is approved; this page checks on
          its own.
        </p>
      )}
      <p className="mt-4">
        <Badge tone="amber">
          <span className="font-mono">{me.org?.org_id}</span>
        </Badge>
      </p>
    </Notice>
  );
}
