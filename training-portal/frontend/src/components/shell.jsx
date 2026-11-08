"use client";

import clsx from "clsx";
import { LogOut, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { openedOrg, openOrg } from "@/lib/api";
import { useSession } from "./session-provider";
import { Logo, Spinner } from "./ui";

/** The page's backdrop: a soft glow over a faint grid. */
export function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10">
      <div className="backdrop-glow absolute inset-0" />
      <div className="grid-lines absolute inset-0" />
    </div>
  );
}

export function Shell({ children }) {
  return (
    <div className="flex min-h-screen flex-col">
      <Backdrop />
      <Nav />
      <OpenedOrg />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pt-8 pb-24 sm:px-6">{children}</main>
      <Footer />
    </div>
  );
}

/** Says whose service this is. */
export function Footer() {
  return (
    <footer className="border-t border-white/[0.06]">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-6 text-[13px] text-zinc-500 sm:px-6">
        <a
          href="https://vinaiak.com/"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 text-zinc-400 transition hover:text-zinc-100"
        >
          <Logo className="size-5" />A service of Vinaiak AI
        </a>
        <span className="sm:ml-auto">
          © {new Date().getFullYear()} Vinaiak. All rights reserved.
        </span>
      </div>
    </footer>
  );
}

function Nav() {
  const { profile, me, signOut } = useSession();
  const pathname = usePathname();
  const links = [
    ...(me?.status === "approved"
      ? [
          { href: "/", label: "Topics" },
          { href: "/missing-data", label: "Missing data" },
          { href: "/chatbot", label: "Chatbot" },
        ]
      : []),
    ...(me?.admin ? [{ href: "/admin", label: "Requests" }] : []),
  ];
  return (
    <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-zinc-950/60 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <Logo className="size-7" />
          <span className="text-[15px] font-semibold tracking-tight text-white">
            Vinaiak <span className="font-normal text-zinc-500">Training</span>
          </span>
        </Link>
        {links.length > 1 || me?.admin ? (
          <nav className="flex items-center gap-1">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={clsx(
                  "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition",
                  pathname === link.href
                    ? "bg-white/[0.08] text-white"
                    : "text-zinc-400 hover:text-zinc-100",
                )}
              >
                {link.href === "/admin" && <ShieldCheck className="size-3.5" />}
                {link.label}
              </Link>
            ))}
          </nav>
        ) : null}
        <div className="ml-auto flex items-center gap-3">
          {profile && (
            <div className="hidden text-right sm:block">
              <div className="text-[13px] leading-4 font-medium text-zinc-100">
                {profile.name ?? profile.email}
              </div>
              {profile.name && (
                <div className="text-[12px] leading-4 text-zinc-500">{profile.email}</div>
              )}
            </div>
          )}
          {profile && <Avatar name={profile.name ?? profile.email} picture={profile.picture} />}
          <button
            type="button"
            onClick={signOut}
            aria-label="Sign out"
            title="Sign out"
            className="rounded-full p-2 text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-100"
          >
            <LogOut className="size-4" />
          </button>
        </div>
      </div>
    </header>
  );
}

/** While the master admin acts as an org's admin, says so, with a way back. */
function OpenedOrg() {
  const { me, refreshMe } = useSession();
  const router = useRouter();
  // `me` loads in the browser only, after the page hydrates.
  if (!me || !openedOrg()) return null;

  async function exit() {
    openOrg(null);
    await refreshMe();
    router.push("/admin");
  }

  return (
    <div className="border-b border-amber-400/20 bg-amber-500/[0.08]">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-[13px] text-amber-100 sm:px-6">
        <ShieldCheck className="size-3.5 shrink-0 text-amber-300" />
        <span className="min-w-0 truncate">
          Viewing <span className="font-medium">{me.org?.org_name ?? openedOrg()}</span> as master
          admin
        </span>
        <button
          type="button"
          onClick={() => void exit()}
          className="ml-auto rounded-full px-2.5 py-0.5 text-amber-200 ring-1 ring-amber-400/30 transition hover:bg-amber-400/10"
        >
          Exit
        </button>
      </div>
    </div>
  );
}

function Avatar({ name, picture }) {
  if (picture) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- Google's avatar, in a static site
      <img
        src={picture}
        alt=""
        referrerPolicy="no-referrer"
        className="size-8 rounded-full ring-1 ring-white/15"
      />
    );
  }
  return (
    <span className="grid size-8 place-items-center rounded-full bg-violet-500/20 text-[13px] font-semibold text-violet-200 ring-1 ring-violet-400/30">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Shown while the session or the account's registration loads. */
export function Splash() {
  return (
    <div className="grid min-h-screen place-items-center">
      <Backdrop />
      <div className="flex flex-col items-center gap-4">
        <Logo className="size-11 animate-pulse" />
        <Spinner className="size-4 text-zinc-500" />
      </div>
    </div>
  );
}

/** A centered message, e.g. when `/me` fails. */
export function Notice({ icon, title, children, action }) {
  return (
    <div className="animate-rise mx-auto mt-16 flex max-w-md flex-col items-center text-center">
      <div className="grid size-14 place-items-center rounded-2xl border border-white/10 bg-white/[0.04] text-zinc-300">
        {icon}
      </div>
      <h1 className="mt-6 font-serif text-4xl text-white">{title}</h1>
      {children && <div className="mt-3 text-[15px] leading-7 text-zinc-400">{children}</div>}
      {action && <div className="mt-8">{action}</div>}
    </div>
  );
}
