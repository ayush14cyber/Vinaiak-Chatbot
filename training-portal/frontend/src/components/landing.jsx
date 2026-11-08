"use client";

import { FolderTree, Globe, ScanSearch } from "lucide-react";
import { useEffect, useRef } from "react";
import { GOOGLE_CLIENT_ID } from "@/lib/config";
import { Backdrop, Footer } from "./shell";
import { useSession } from "./session-provider";
import { Logo, Spinner } from "./ui";

const features = [
  {
    icon: FolderTree,
    title: "Organise by topic",
    body: "Arrange what your assistant knows into a tree of topics, the way your people look for it.",
  },
  {
    icon: ScanSearch,
    title: "Pictures understood",
    body: "Images and PDFs in a page are read and described, so their contents become answers too.",
  },
  {
    icon: Globe,
    title: "Import from the web",
    body: "Bring in any public page as editable text, then file it under the right topic.",
  },
];

export function Landing() {
  return (
    <div className="relative flex min-h-screen flex-col">
      <Backdrop />
      <header className="mx-auto flex h-16 w-full max-w-6xl items-center gap-2.5 px-4 sm:px-6">
        <Logo className="size-7" />
        <span className="text-[15px] font-semibold tracking-tight text-white">
          Vinaiak <span className="font-normal text-zinc-500">Training</span>
        </span>
      </header>
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col items-center px-4 pt-20 pb-24 text-center sm:px-6 sm:pt-28">
        <span className="animate-rise rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[12px] font-medium tracking-wide text-zinc-400 uppercase">
          Vinaiak AI · Training portal
        </span>
        <h1 className="animate-rise mt-6 max-w-3xl font-serif text-5xl leading-[1.05] text-white sm:text-7xl">
          Teach your Vinaiak assistant <em className="text-violet-300">everything</em> your
          organisation knows.
        </h1>
        <p className="animate-rise mt-6 max-w-xl text-[17px] leading-8 text-zinc-400">
          Write, import and organise the pages your Vinaiak AI assistant answers from. It reads them
          the moment you save.
        </p>
        <div className="animate-rise mt-10">
          <GoogleButton />
        </div>
        <div className="mt-24 grid w-full gap-4 text-left sm:grid-cols-3">
          {features.map(({ icon: Icon, title, body }) => (
            <div
              key={title}
              className="rounded-3xl border border-white/[0.07] bg-white/[0.025] p-6 backdrop-blur"
            >
              <div className="grid size-10 place-items-center rounded-xl bg-violet-500/10 text-violet-300 ring-1 ring-violet-400/20">
                <Icon className="size-5" />
              </div>
              <h3 className="mt-5 font-medium text-zinc-100">{title}</h3>
              <p className="mt-2 text-sm leading-6 text-zinc-400">{body}</p>
            </div>
          ))}
        </div>
      </main>
      <Footer />
    </div>
  );
}

/** Google's own "Continue with Google" button, and its one-tap prompt. */
export function GoogleButton() {
  const { gisReady } = useSession();
  const slot = useRef(null);

  useEffect(() => {
    if (!gisReady || !slot.current || !window.google) return;
    window.google.accounts.id.renderButton(slot.current, {
      theme: "filled_black",
      size: "large",
      shape: "pill",
      text: "continue_with",
      logo_alignment: "left",
      width: 280,
    });
    window.google.accounts.id.prompt();
  }, [gisReady]);

  if (!GOOGLE_CLIENT_ID) {
    return (
      <p className="text-sm text-rose-300">Set NEXT_PUBLIC_GOOGLE_CLIENT_ID to enable sign-in.</p>
    );
  }
  return (
    <div className="flex h-11 min-w-[280px] items-center justify-center rounded-full">
      {/* Google's iframe is light; on a dark page the browser paints it an opaque white box. */}
      <div ref={slot} style={{ colorScheme: "light" }} />
      {!gisReady && <Spinner className="size-5 text-zinc-500" />}
    </div>
  );
}
