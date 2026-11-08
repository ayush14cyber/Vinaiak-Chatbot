"use client";

import clsx from "clsx";
import { LoaderCircle, X } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * @typedef {"primary" | "secondary" | "ghost" | "danger"} Variant
 */

const variants = {
  primary:
    "bg-linear-to-b from-violet-500 to-violet-600 text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.25),0_10px_30px_-10px_rgb(139_92_246/0.7)] hover:from-violet-400 hover:to-violet-500",
  secondary:
    "bg-white/[0.06] text-zinc-100 ring-1 ring-inset ring-white/10 hover:bg-white/[0.1] hover:ring-white/20",
  ghost: "text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100",
  danger:
    "bg-rose-500/10 text-rose-300 ring-1 ring-inset ring-rose-400/25 hover:bg-rose-500/20 hover:text-rose-200",
};

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  className,
  children,
  disabled,
  ...props
}) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={clsx(
        "inline-flex shrink-0 items-center justify-center gap-2 rounded-full font-medium transition outline-none select-none",
        "focus-visible:ring-2 focus-visible:ring-violet-400/70 disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" && "h-8 px-3 text-[13px]",
        size === "md" && "h-10 px-4 text-sm",
        size === "lg" && "h-12 px-6 text-[15px]",
        variants[variant],
        className,
      )}
      {...props}
    >
      {loading ? <Spinner className="size-4" /> : icon}
      {children}
    </button>
  );
}

export function Spinner({ className }) {
  return <LoaderCircle className={clsx("animate-spin", className)} aria-hidden />;
}

export const inputClass =
  "w-full rounded-xl bg-black/30 px-3.5 text-sm text-zinc-100 ring-1 ring-inset ring-white/10 transition placeholder:text-zinc-500 outline-none focus:bg-black/40 focus:ring-2 focus:ring-violet-400/60";

export function Input({ className, ...props }) {
  return <input className={clsx(inputClass, "h-11", className)} {...props} />;
}

export function Field({ label, hint, error, children }) {
  return (
    <label className="block space-y-2">
      <span className="text-[13px] font-medium text-zinc-300">{label}</span>
      {children}
      {error ? (
        <span className="block text-[13px] text-rose-300">{error}</span>
      ) : hint ? (
        <span className="block text-[13px] text-zinc-500">{hint}</span>
      ) : null}
    </label>
  );
}

export function Card({ className, children }) {
  return (
    <div
      className={clsx(
        "rounded-3xl border border-white/[0.08] bg-zinc-900/60 shadow-[0_30px_80px_-40px_rgb(0_0_0/0.8)] backdrop-blur-xl",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Badge({ tone = "zinc", children }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset",
        tone === "zinc" && "bg-white/5 text-zinc-300 ring-white/10",
        tone === "violet" && "bg-violet-500/10 text-violet-300 ring-violet-400/25",
        tone === "amber" && "bg-amber-500/10 text-amber-300 ring-amber-400/25",
        tone === "emerald" && "bg-emerald-500/10 text-emerald-300 ring-emerald-400/25",
        tone === "sky" && "bg-sky-500/10 text-sky-300 ring-sky-400/25",
      )}
    >
      {children}
    </span>
  );
}

/**
 * A modal. Escape and the backdrop close it unless `locked`, e.g. while it saves. It renders into
 * `body`: an animated ancestor would otherwise contain it, and the page's nav would cover it.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  locked = false,
  wide = false,
}) {
  useEffect(() => {
    if (!open || locked) return;
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, locked, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={locked ? undefined : onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        className={clsx(
          "animate-rise relative max-h-[calc(100dvh-2rem)] w-full overflow-y-auto rounded-3xl border border-white/10 bg-zinc-900 p-6 shadow-2xl",
          wide ? "max-w-xl" : "max-w-md",
        )}
      >
        {!locked && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute top-4 right-4 rounded-full p-1.5 text-zinc-500 transition hover:bg-white/5 hover:text-zinc-200"
          >
            <X className="size-4" />
          </button>
        )}
        <h2 className="pr-8 text-lg font-semibold text-white">{title}</h2>
        {description && <p className="mt-1.5 text-sm leading-6 text-zinc-400">{description}</p>}
        {children && <div className="mt-5">{children}</div>}
        {footer && <div className="mt-6 flex flex-wrap justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** A bar that runs while the work it stands for has no measurable progress. */
export function Indeterminate({ className }) {
  return (
    <div className={clsx("relative h-1 overflow-hidden rounded-full bg-white/5", className)}>
      <div className="animate-indeterminate absolute inset-y-0 w-2/5 rounded-full bg-linear-to-r from-transparent via-violet-400 to-transparent" />
    </div>
  );
}

/** Markdown as the assistant reads it. An image shows its description under it. */
export function MarkdownView({ children }) {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          img: ({ src, alt }) => (
            <Figure src={typeof src === "string" ? src : undefined} alt={alt} />
          ),
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}

/** A linked image or PDF with its description under it; the description alone if it won't load. */
function Figure({ src, alt }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="my-4 block overflow-hidden rounded-2xl border border-white/10 bg-black/30">
      {src && !failed && (
        // eslint-disable-next-line @next/next/no-img-element -- remote images in a static site
        <img
          src={src}
          alt=""
          onError={() => setFailed(true)}
          className="max-h-80 w-full border-b border-white/10 object-contain"
        />
      )}
      <span className="block px-4 py-2.5 text-[13px] leading-5 text-zinc-400">{alt || src}</span>
    </span>
  );
}

/** Vinaiak's logo, beside its name wherever it shows, so it's decorative. */
export function Logo({ className }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a static site
    <img src="/vinaiak.png" alt="" aria-hidden className={clsx("object-contain", className)} />
  );
}
