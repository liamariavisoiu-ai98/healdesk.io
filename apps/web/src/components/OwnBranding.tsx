"use client";

import { useEffect, useId, useRef, useState } from "react";

import { track } from "@/lib/analytics";
import { site } from "@/lib/site";

/**
 * "See it in your own branding", under the two agent cards: a visitor types
 * their clinic's website and their email, and gets their own AYA, built from
 * that site in its name, colours and services, by email.
 *
 * ## The shape (the owner's pick of 9 October 2026, "Browser bar, but Apple")
 *
 * A Safari window. Its address bar is the field, because typing your own
 * address into a browser is what the visitor will do to see the result. The
 * page inside it is a sketch of a clinic's site with the chat in its corner,
 * and it takes the name read off the domain as it is typed, so the promise
 * is visible before it is kept. "Show me" drops a sheet from the top of the
 * window, the way macOS asks a question of the window it belongs to, for the
 * one thing still needed: where to send it.
 *
 * ## What happens on send
 *
 * api/own-demo records the request and builds the demo after answering, with
 * the same pipeline as the operator's console (lib/demo/build.ts), and the
 * link goes to the address given, never back to this page: the address has
 * to be real for the demo to be seen. The team hears about every request at
 * hello@ (lib/demo/own-demo.ts). The window then shows Safari's blue loading
 * line and says where the link will arrive.
 *
 * Nothing typed here is tracked: the analytics event says only that a demo
 * was asked for (lib/analytics.ts).
 */

type Phase = "domain" | "email" | "sending" | "done";

/** "peachy-studio.com" as "Peachy Studio": the name the sketch shows while the visitor types. */
function nameFromDomain(value: string): string | null {
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0];
  if (!host || !host.includes(".")) return null;
  const label = host.split(".")[0] ?? "";
  const name = label
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  return name.length >= 2 ? name : null;
}

function hostOf(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0]!;
}

const LOCK = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden className="size-[13px] shrink-0">
    <rect x="3.2" y="7" width="9.6" height="7" rx="1.6" />
    <path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7" />
  </svg>
);

/** Safari's own toolbar glyphs, drawn simply and greyed: decoration, not controls. */
function ToolbarGlyph({ d, className = "" }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={`size-[18px] ${className}`}>
      <path d={d} />
    </svg>
  );
}

export function OwnBranding() {
  const [phase, setPhase] = useState<Phase>("domain");
  const [domain, setDomain] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [domainError, setDomainError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const domainRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const ids = useId();

  const name = nameFromDomain(domain);
  const sheetOpen = phase === "email" || phase === "sending";

  useEffect(() => {
    if (phase === "email") emailRef.current?.focus();
  }, [phase]);

  const showMe = (event: React.FormEvent) => {
    event.preventDefault();
    if (!nameFromDomain(domain)) {
      setDomainError("Type your clinic's website, like yourclinic.com.");
      domainRef.current?.focus();
      return;
    }
    setDomainError(null);
    setPhase("email");
  };

  const cancel = () => {
    setPhase("domain");
    setEmailError(null);
    domainRef.current?.focus();
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (phase === "sending") return;
    setEmailError(null);
    setPhase("sending");
    try {
      const response = await fetch("/api/own-demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain, email, company }),
      });
      const data = (await response.json().catch(() => null)) as { error?: string; field?: string } | null;
      if (!response.ok) {
        const message = data?.error ?? "Something went wrong. Try again.";
        if (data?.field === "domain") {
          setDomainError(message);
          setPhase("domain");
          domainRef.current?.focus();
        } else {
          setEmailError(message);
          setPhase("email");
        }
        return;
      }
      track("own_demo_requested");
      setPhase("done");
    } catch {
      setEmailError("Network error. Try again.");
      setPhase("email");
    }
  };

  return (
    <div className="mt-16 sm:mt-24">
      <div className="mx-auto max-w-[640px] text-center">
        <h3 className="font-display text-ink text-[clamp(28px,3.2vw,40px)] leading-[1.08] font-normal tracking-[-0.025em] text-balance">
          See it in your own branding
        </h3>
        <p className="text-muted mx-auto mt-3 max-w-[52ch] text-[clamp(16px,1.15vw,18px)] leading-[1.55] font-medium">
          Type your clinic&rsquo;s website. We build your own free AI assistant from it, with your
          name, colours and services, and email you the link.
        </p>
      </div>

      {/* The window. */}
      <div className="relative mx-auto mt-8 max-w-[920px] overflow-hidden rounded-[14px] border border-black/10 bg-white shadow-[0_0_0_0.5px_rgb(0_0_0/0.06),0_30px_70px_-30px_rgb(23_42_58/0.45),0_12px_24px_-16px_rgb(23_42_58/0.25)]">
        {/* The toolbar, Safari's: lights, sidebar and arrows, the address field, then share, new tab and tabs. */}
        <form onSubmit={showMe} noValidate className="relative z-20 flex h-[52px] items-center gap-3 border-b border-black/[0.08] bg-[#f6f6f6] px-3.5 sm:gap-4">
          <span className="flex shrink-0 gap-2" aria-hidden>
            <i className="size-3 rounded-full border border-black/10 bg-[#ff5f57]" />
            <i className="size-3 rounded-full border border-black/10 bg-[#febc2e]" />
            <i className="size-3 rounded-full border border-black/10 bg-[#28c840]" />
          </span>
          <span className="hidden shrink-0 items-center gap-3 text-[#a3a3a3] md:flex" aria-hidden>
            <ToolbarGlyph d="M4 5h16v14H4zM9 5v14" />
            <ToolbarGlyph d="m14.5 6-6 6 6 6" />
            <ToolbarGlyph d="m9.5 6 6 6-6 6" className="opacity-50" />
          </span>

          <div className="relative mx-auto flex h-[34px] min-w-0 flex-1 items-center gap-1.5 rounded-[9px] bg-[#e8e8ea] pr-1 pl-3 transition-[background-color,box-shadow] focus-within:bg-white focus-within:shadow-[0_0_0_3.5px_rgb(0_113_227/0.35)] sm:max-w-[520px]">
            <span className="text-[#8e8e93]">{LOCK}</span>
            <label htmlFor={`${ids}-domain`} className="sr-only">
              Your clinic&rsquo;s website
            </label>
            <input
              ref={domainRef}
              id={`${ids}-domain`}
              type="text"
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              autoCapitalize="none"
              placeholder="yourclinic.com"
              value={domain}
              onChange={(event) => {
                setDomain(event.target.value);
                setDomainError(null);
                if (phase === "done") setPhase("domain");
              }}
              disabled={phase === "sending"}
              aria-invalid={domainError ? true : undefined}
              aria-describedby={domainError ? `${ids}-domain-error` : undefined}
              className="h-full min-w-0 flex-1 bg-transparent text-center text-[15px] font-medium text-[#1d1d1f] outline-none placeholder:text-[#8e8e93] focus:text-left"
            />
            <button
              type="submit"
              disabled={phase === "sending"}
              className="h-[26px] shrink-0 rounded-[7px] bg-[#0071e3] px-3 text-[13.5px] font-semibold text-white transition-colors hover:bg-[#0077ed] disabled:opacity-60"
            >
              Show me
            </button>
            {/* Safari's loading line, along the bottom of the field, while the demo is being built. */}
            {phase === "done" ? (
              <span aria-hidden className="safari-progress absolute inset-x-2 bottom-0 h-[2px] overflow-hidden rounded-full">
                <span className="block h-full w-1/3 rounded-full bg-[#0071e3]" />
              </span>
            ) : null}
          </div>

          <span className="hidden shrink-0 items-center gap-3.5 text-[#a3a3a3] md:flex" aria-hidden>
            <ToolbarGlyph d="M12 3v12M7.5 7.5 12 3l4.5 4.5M5 12v8h14v-8" />
            <ToolbarGlyph d="M12 5v14M5 12h14" />
            <ToolbarGlyph d="M8 8h11v11H8zM5 16V5h11" />
          </span>
        </form>

        {/* The sheet: macOS asks its question from the top of the window it belongs to. */}
        <div
          role="dialog"
          aria-modal="false"
          aria-labelledby={`${ids}-sheet-title`}
          aria-hidden={!sheetOpen}
          inert={!sheetOpen}
          className={[
            "absolute inset-x-0 top-[52px] z-10 mx-auto w-[min(440px,calc(100%-24px))] rounded-b-[14px] border border-t-0 border-black/10 bg-white/95 px-5 pt-5 pb-4 shadow-[0_18px_40px_-12px_rgb(0_0_0/0.35)] backdrop-blur-xl transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)]",
            sheetOpen ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-[110%] opacity-0",
          ].join(" ")}
          onKeyDown={(event) => {
            if (event.key === "Escape") cancel();
          }}
        >
          <form onSubmit={submit} noValidate>
            <div className="flex items-start gap-3">
              <img src="/icon.png" alt="" className="size-10 shrink-0 rounded-[10px] shadow-[0_0_0_1px_rgb(0_0_0/0.06)]" />
              <div className="min-w-0 text-left">
                <p id={`${ids}-sheet-title`} className="text-[15.5px] leading-snug font-semibold text-[#1d1d1f]">
                  Send me my own free AI assistant in my own branding
                </p>
                <p className="mt-1 text-[13.5px] leading-snug text-[#6e6e73]">
                  Built from <span className="font-semibold text-[#1d1d1f]">{hostOf(domain) || "your website"}</span>. We email
                  you the link when it&rsquo;s built, usually within a few minutes.
                </p>
              </div>
            </div>

            <label htmlFor={`${ids}-email`} className="sr-only">
              Your email
            </label>
            <input
              ref={emailRef}
              id={`${ids}-email`}
              type="email"
              autoComplete="email"
              required
              placeholder="you@yourclinic.com"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setEmailError(null);
              }}
              disabled={phase === "sending"}
              aria-invalid={emailError ? true : undefined}
              aria-describedby={`${ids}-email-note`}
              className="mt-4 h-[38px] w-full rounded-[8px] border border-black/15 bg-white px-3 text-[15px] text-[#1d1d1f] outline-none transition-shadow placeholder:text-[#8e8e93] focus:border-[#0071e3] focus:shadow-[0_0_0_3.5px_rgb(0_113_227/0.3)]"
            />
            {/* For bots only: people never see it, and api/own-demo builds nothing when it is filled. */}
            <input
              type="text"
              name="company"
              tabIndex={-1}
              autoComplete="off"
              value={company}
              onChange={(event) => setCompany(event.target.value)}
              aria-hidden
              className="absolute -left-[9999px] h-px w-px opacity-0"
            />
            {emailError ? (
              <p id={`${ids}-email-note`} className="text-red-deep mt-2 text-[13.5px] font-semibold" role="alert">
                {emailError}
              </p>
            ) : (
              <p id={`${ids}-email-note`} className="mt-2 text-[12.5px] leading-snug text-[#6e6e73]">
                One email with your link, because you asked.{" "}
                <a href="/privacy#own-demo" className="underline underline-offset-2">
                  What we do with it
                </a>
              </p>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={cancel}
                className="h-[30px] rounded-[7px] border border-black/10 bg-white px-3.5 text-[13.5px] font-medium text-[#1d1d1f] shadow-[0_1px_1px_rgb(0_0_0/0.06)] transition-colors hover:bg-[#f5f5f7]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={phase === "sending" || !email.trim()}
                className="h-[30px] rounded-[7px] bg-[#0071e3] px-3.5 text-[13.5px] font-semibold text-white shadow-[0_1px_1px_rgb(0_0_0/0.1)] transition-colors hover:bg-[#0077ed] disabled:opacity-50"
              >
                {phase === "sending" ? "Sending…" : "Send it to me"}
              </button>
            </div>
          </form>
        </div>

        {/* The page in the window: a clinic's site, sketched, with the chat in its corner. */}
        <div className="relative h-[300px] overflow-hidden bg-white sm:h-[340px]" aria-live="polite">
          {phase === "done" ? (
            <div className="absolute inset-0 z-[1] grid place-items-center bg-white/85 px-6 text-center backdrop-blur-[2px]">
              <div>
                <p className="font-display text-ink text-[clamp(22px,2.4vw,28px)] leading-tight font-medium tracking-[-0.02em]">
                  Building {hostOf(domain)}&rsquo;s assistant…
                </p>
                <p className="text-muted mx-auto mt-2 max-w-[44ch] text-[15.5px] font-medium">
                  Check <span className="text-ink font-semibold">{email.trim()}</span>. The link arrives when
                  it&rsquo;s ready, usually within a few minutes. Questions? Write to{" "}
                  <a href={`mailto:${site.email}`} className="text-ink font-semibold underline underline-offset-2">
                    {site.email}
                  </a>
                  .
                </p>
              </div>
            </div>
          ) : null}

          <div aria-hidden className="absolute inset-0 px-6 py-5 sm:px-10 sm:py-7">
            <div className="flex items-center gap-3">
              <span className="grid size-7 place-items-center rounded-md bg-[#e8e8ea] text-[12px] font-bold text-[#6e6e73]">
                {(name ?? "Y").charAt(0)}
              </span>
              <span className="text-[15px] font-semibold text-[#1d1d1f]">{name ?? "Your Clinic"}</span>
              <span className="ml-auto hidden gap-5 sm:flex">
                <i className="h-2.5 w-12 rounded-full bg-[#ececee]" />
                <i className="h-2.5 w-14 rounded-full bg-[#ececee]" />
                <i className="h-2.5 w-10 rounded-full bg-[#ececee]" />
              </span>
            </div>
            <div className="mt-8 grid grid-cols-1 gap-8 sm:grid-cols-[1.15fr_1fr]">
              <div className="space-y-3">
                <i className="block h-3 w-1/3 rounded-full bg-[#f0f0f2]" />
                <i className="block h-6 w-[88%] rounded-lg bg-[#ececee]" />
                <i className="block h-6 w-[64%] rounded-lg bg-[#ececee]" />
                <i className="block h-3 w-[76%] rounded-full bg-[#f0f0f2]" />
                <i className="mt-5 block h-9 w-36 rounded-full bg-[#e2e2e5]" />
              </div>
              <i className="hidden h-[190px] rounded-2xl bg-[#f2f2f4] sm:block" />
            </div>
          </div>

          {/* The chat, in the clinic's corner, in its name. */}
          <div aria-hidden className="absolute right-4 bottom-4 w-[min(270px,calc(100%-32px))] sm:right-6 sm:bottom-6">
            <div className="overflow-hidden rounded-2xl bg-white shadow-[0_14px_36px_-12px_rgb(23_42_58/0.4),0_0_0_1px_rgb(0_0_0/0.05)]">
              <div className="bg-red flex items-center gap-2 px-3 py-2 text-white">
                <span className="grid size-6 place-items-center rounded-full bg-white text-[11px] font-bold text-[#1d1d1f]">
                  {(name ?? "Y").charAt(0)}
                </span>
                <span className="truncate text-[13px] font-semibold">{name ?? "Your Clinic"}</span>
              </div>
              <p className="m-2.5 rounded-xl rounded-bl-sm bg-[#f1f1f1] px-3 py-2 text-[12.5px] leading-snug text-[#1d1d1f]">
                Hi, I&rsquo;m {name ? `${name}’s` : "your clinic’s"} AI assistant. Ask me about prices, opening hours
                or booking a consultation.
              </p>
            </div>
            <span className="bg-red mt-2 ml-auto grid size-11 place-items-center rounded-full text-white shadow-[0_8px_20px_-8px_rgb(23_42_58/0.5)]">
              <svg viewBox="0 0 24 24" fill="currentColor" className="size-5">
                <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4h0A2.5 2.5 0 0 1 4 13.5z" />
              </svg>
            </span>
          </div>
        </div>
      </div>

      {domainError ? (
        <p id={`${ids}-domain-error`} className="text-red-deep mt-3 text-center text-[14.5px] font-semibold" role="alert">
          {domainError}
        </p>
      ) : null}
    </div>
  );
}
