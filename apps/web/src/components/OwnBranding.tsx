"use client";

import { useEffect, useId, useRef, useState } from "react";

import { HealdeskSoul } from "@/components/HealdeskSoul";
import { track } from "@/lib/analytics";
import { readableOn } from "@/lib/demo/colour";
import { greetingLead } from "@/lib/demo/greeting";
import { site } from "@/lib/site";
import { REDUCED_MOTION, useMediaQuery } from "@/lib/use-media-query";

/**
 * "See it in your own branding", under the two agent cards: a visitor types
 * their clinic's website, sees AYA on it, and gets their own AYA, built from
 * that site in its name, colours and services, by email.
 *
 * ## The shape (the owner's picks of 9 and 12 October 2026)
 *
 * A Safari window ("Browser bar, but Apple"), standing in a stage the width of
 * the cards above ("Centred on a stage"): the heading and one line centred in
 * it, the window coming up out of its foot. The address pill is the field,
 * because typing your own address into a browser is what the visitor will do
 * to see the result, and "Show me" sits inside it.
 *
 * ## Drawing the eye to the address bar (owner, 12 October 2026)
 *
 * The address bar is the one thing to use here, and it read as part of a
 * picture. So, until the visitor touches it:
 *
 *   - it types made-up clinics' addresses into itself and deletes them,
 *     with a caret, showing what goes there (`useGhostAddress`; while the
 *     section is on screen, never with reduced motion);
 *   - Safari's blue focus ring breathes round it once the window is in view;
 *   - and what is in it, theirs or the example, is echoed live in a
 *     greeting from AYA's chat in the page's corner, "Hi, I'm AYA on
 *     glowmedspa.com", before they press Show me.
 *
 * The window has no tab bar (owner, 12 October 2026): its "Start Page" tab,
 * and the echo of the address in it, were a second line of chrome between
 * the address bar and the page.
 *
 * The first touch, a press or focus, stops the typing and the ring for
 * good; the echo follows what they type.
 *
 * ## What the window shows ("The visitor's own site, live")
 *
 * It first held a sketch of a clinic's site, with "Your Clinic" in it, a chat
 * bubble in healdesk's red and rows of grey bars, and it read as generated.
 * Now it shows no one's clinic but the visitor's own:
 *
 *   1. idle: the soul and a line. Nothing invented.
 *   2. "Show me": Safari's loading line runs and the window says it is
 *      reading the host, while api/own-demo/preview fetches the front page.
 *   3. Their site: its own photograph, its logo and name in a header, and
 *      AYA's chat in the corner in their colour, opening with the same
 *      greeting a built demo opens with (lib/demo/greeting.ts), the dots
 *      first. The picture, logo and colour are the ones a build will wear
 *      (lib/demo/scrape.ts `brandOf`).
 *   4. The email sheet drops from the top of the window, by itself after a
 *      beat, or on "Email it to me".
 *
 * A site that cannot be read is not a reason to turn the visitor away: the
 * preview falls back to the name on a neutral page and still goes to the
 * sheet, because the build may well manage what a quick fetch did not. Only an
 * address that is not a public website stops here, and says so at once.
 *
 * ## What happens on send
 *
 * api/own-demo records the request and builds the demo after answering, with
 * the same pipeline as the operator's console (lib/demo/build.ts), and the
 * link goes to the address given, never back to this page: the address has to
 * be real for the demo to be seen. The team hears about every request at
 * hello@ (lib/demo/own-demo.ts). The window then shows Safari's blue loading
 * line over the visitor's site and says where the link will arrive.
 *
 * Nothing typed here is tracked: the analytics event says only that a demo
 * was asked for (lib/analytics.ts). The preview keeps nothing (the Privacy
 * page says so).
 */

type Phase = "idle" | "reading" | "shown" | "email" | "sending" | "done";

/** What the preview route sends, once checked. */
type Preview = {
  host: string;
  name: string | null;
  logoUrl: string | null;
  image: string | null;
  color: string | null;
};

const READ_TIMEOUT_MS = 9_000;
/** How long their site is on its own before the sheet comes down, and when the greeting replaces the dots. */
const SHEET_AFTER_MS = 2_800;
const GREET_AFTER_MS = 1_000;

/** Healdesk's ink, for a site with no colour of its own. */
const NEUTRAL = "#172a3a";

const HEX = /^#[0-9a-f]{6}$/i;
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,[a-z0-9+/=]+$/i;

function hostOf(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0]!;
}

/** "peachy-studio.com" as "Peachy Studio": the name shown until the site gives its own. */
function nameFromDomain(value: string): string | null {
  const host = hostOf(value);
  if (!host || !host.includes(".")) return null;
  const label = host.split(".")[0] ?? "";
  const name = label
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  return name.length >= 2 ? name : null;
}

/** Whatever came back, as a Preview: only strings of the shapes we draw, nothing else reaches the page. */
function cleanPreview(data: unknown, host: string): Preview {
  const o = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
  const image = (value: unknown) => (typeof value === "string" && DATA_IMAGE.test(value) ? value : null);
  const color = text(o.color, 7);
  return { host, name: text(o.name, 80), logoUrl: image(o.logoUrl), image: image(o.image), color: color && HEX.test(color) ? color : null };
}

type Read = { refused: string } | { preview: Preview };

/** Ask for the preview. Everything but "that is not a public website" becomes a bare preview. */
async function readSite(domain: string, host: string): Promise<Read> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
  try {
    const response = await fetch("/api/own-demo/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain }),
      signal: controller.signal,
    });
    if (response.status === 422) {
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      return { refused: data?.error ?? "That doesn't look like a public website." };
    }
    const data = response.ok ? await response.json().catch(() => null) : null;
    return { preview: cleanPreview(data, host) };
  } catch {
    return { preview: cleanPreview(null, host) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Made-up clinics' addresses, which the empty address bar types for itself.
 * Invented names, and only ever shown as text: nothing is fetched for them.
 */
const EXAMPLES = ["glowmedspa.com", "lumenaesthetics.com", "brightsmiledental.com", "harbourfertility.com", "novaskinclinic.com"] as const;

/**
 * The example the address bar is typing, as far as it has got: a character
 * at a time, a pause to read it, deleted quicker, a beat, the next. Empty
 * while `run` is false.
 */
function useGhostAddress(run: boolean): string {
  const [text, setText] = useState("");
  useEffect(() => {
    if (!run) return;
    let word = 0;
    let at = 0;
    let erasing = false;
    let timer = 0;
    const tick = () => {
      const example = EXAMPLES[word % EXAMPLES.length]!;
      if (!erasing) {
        at += 1;
        setText(example.slice(0, at));
        if (at >= example.length) {
          erasing = true;
          timer = window.setTimeout(tick, 1800);
          return;
        }
        timer = window.setTimeout(tick, 55 + Math.random() * 60);
        return;
      }
      at -= 1;
      setText(example.slice(0, at));
      if (at <= 0) {
        erasing = false;
        word += 1;
        timer = window.setTimeout(tick, 520);
        return;
      }
      timer = window.setTimeout(tick, 26);
    };
    timer = window.setTimeout(tick, 700);
    return () => window.clearTimeout(timer);
  }, [run]);
  return run ? text : "";
}

const LOCK = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden className="size-[13px] shrink-0">
    <rect x="3.2" y="7" width="9.6" height="7" rx="1.6" />
    <path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7" />
  </svg>
);

const RELOAD = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="size-[14px] shrink-0">
    <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3" />
  </svg>
);

export function OwnBranding() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [domain, setDomain] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [domainError, setDomainError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  /** The greeting has replaced the dots. */
  const [greeted, setGreeted] = useState(false);
  const domainRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  /** Which preview the page is waiting for: an answer to an older one is dropped. */
  const request = useRef(0);
  /** The sheet has been opened for this preview, by the page or by the visitor, so it will not open by itself again. */
  const handedOver = useRef(false);
  /** The visitor opened the sheet, so focus goes into it; opened by the page, the page leaves focus alone. */
  const byVisitor = useRef(false);
  const ids = useId();
  const stage = useRef<HTMLDivElement>(null);
  const reduce = useMediaQuery(REDUCED_MOTION);
  /** The window is on screen. */
  const [inView, setInView] = useState(false);
  /** The visitor has pressed or focused the address bar: the typing and the ring stop for good. */
  const [touched, setTouched] = useState(false);
  /** The empty address bar is typing its examples. */
  const typing = inView && !touched && !reduce && phase === "idle" && domain === "";
  const ghost = useGhostAddress(typing);
  /** What the address bar holds, theirs or the example, for AYA's greeting. */
  const echo = hostOf(domain) || ghost;

  useEffect(() => {
    const el = stage.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setInView(Boolean(entry?.isIntersecting)), { threshold: 0.35 });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const host = preview?.host ?? hostOf(domain);
  const name = preview?.name ?? nameFromDomain(domain) ?? host;
  const sheetOpen = phase === "email" || phase === "sending";

  // Their site has appeared: the dots give way to the greeting, then the sheet comes down.
  useEffect(() => {
    if (phase !== "shown") return;
    const greet = window.setTimeout(() => setGreeted(true), GREET_AFTER_MS);
    const sheet = handedOver.current
      ? undefined
      : window.setTimeout(() => {
          handedOver.current = true;
          byVisitor.current = false;
          setPhase("email");
        }, SHEET_AFTER_MS);
    return () => {
      window.clearTimeout(greet);
      window.clearTimeout(sheet);
    };
  }, [phase]);

  useEffect(() => {
    if (phase === "email" && byVisitor.current) emailRef.current?.focus();
  }, [phase]);

  /** Back to the start: whatever was read, and any answer still on its way, is dropped. */
  const reset = () => {
    request.current += 1;
    setPreview(null);
    setPhase("idle");
  };

  const showMe = async (event: React.FormEvent) => {
    event.preventDefault();
    if (phase === "reading" || phase === "sending" || phase === "done") return;
    if (!nameFromDomain(domain)) {
      setDomainError("Type your clinic's website, like yourclinic.com.");
      domainRef.current?.focus();
      return;
    }
    setDomainError(null);
    if (phase !== "idle") {
      // Their site is up already: this is "Email it to me".
      handedOver.current = true;
      byVisitor.current = true;
      setPhase("email");
      return;
    }

    const id = (request.current += 1);
    handedOver.current = false;
    setGreeted(false);
    setPreview(null);
    setPhase("reading");
    const result = await readSite(domain, hostOf(domain));
    if (id !== request.current) return;
    if ("refused" in result) {
      setDomainError(result.refused);
      setPhase("idle");
      domainRef.current?.focus();
      return;
    }
    setPreview(result.preview);
    setPhase("shown");
  };

  const cancel = () => {
    setEmailError(null);
    setPhase("shown");
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
          reset();
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

  const colour = preview?.color ?? NEUTRAL;
  const ink = readableOn(colour);
  const initial = name.charAt(0).toUpperCase();
  const buttonLabel = phase === "reading" ? "Reading…" : phase === "sending" ? "Sending…" : phase === "done" ? "Sent" : phase === "idle" ? "Show me" : "Email it to me";
  const loading = phase === "reading" || phase === "sending" || phase === "done";
  const status =
    phase === "reading"
      ? `Reading ${host}.`
      : phase === "shown" || phase === "email"
        ? `Showing ${host} with ${site.agent} on it.`
        : phase === "done"
          ? `Building ${host}'s assistant. The link will be emailed to ${email.trim()}.`
          : "";

  return (
    <div ref={stage} data-reveal className="own-stage relative mt-16 overflow-hidden rounded-lg border border-black/[0.06] px-5 pt-12 sm:mt-24 sm:px-10 sm:pt-16">
      <div className="mx-auto max-w-[760px] text-center">
        <h3 className="heading-sub text-ink mx-auto">
          See it in your own branding
        </h3>
        <p className="text-muted mx-auto mt-3 max-w-[54ch] text-[clamp(16px,1.15vw,18px)] leading-[1.55] font-medium text-balance">
          Type your website and see {site.agent} on it. We&rsquo;ll email you your own, free.
        </p>
      </div>

      <p className="sr-only" aria-live="polite">
        {status}
      </p>

      {domainError ? (
        <p id={`${ids}-domain-error`} className="text-red-deep mt-4 text-center text-[14.5px] font-semibold" role="alert">
          {domainError}
        </p>
      ) : null}

      {/* The window, coming up out of the stage's foot. */}
      <div className="relative mx-auto mt-8 max-w-[760px] overflow-hidden rounded-t-md border border-b-0 border-black/10 bg-white shadow-lg ring-1 ring-black/[0.06]">
        {/* The toolbar, reduced to Safari's own: lights and the address pill. */}
        <form onSubmit={showMe} noValidate className="relative z-20 flex h-[52px] items-center gap-3 border-b border-black/[0.08] bg-[#f6f6f6] px-3.5">
          <span className="flex shrink-0 gap-2" aria-hidden>
            <i className="size-3 rounded-full border border-black/10 bg-[#ff5f57]" />
            <i className="size-3 rounded-full border border-black/10 bg-[#febc2e]" />
            <i className="size-3 rounded-full border border-black/10 bg-[#28c840]" />
          </span>

          <div
            onPointerDown={() => setTouched(true)}
            data-pulse={(inView && !touched && phase === "idle") || undefined}
            className="own-address relative mx-auto flex h-[34px] min-w-0 flex-1 items-center gap-1.5 rounded-sm bg-[#e8e8ea] pr-1 pl-3 transition-[background-color,box-shadow] focus-within:bg-white focus-within:ring-[3.5px] focus-within:ring-[rgb(0_113_227/0.35)] sm:max-w-[500px]"
          >
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
              placeholder={typing ? "" : "yourclinic.com"}
              value={domain}
              onFocus={() => setTouched(true)}
              onChange={(event) => {
                setDomain(event.target.value);
                setDomainError(null);
                // A different address is a different site: start again.
                if (phase !== "idle" && phase !== "sending") reset();
              }}
              disabled={phase === "sending"}
              aria-invalid={domainError ? true : undefined}
              aria-describedby={domainError ? `${ids}-domain-error` : undefined}
              className="h-full min-w-0 flex-1 bg-transparent text-center text-[15px] font-medium text-[#1d1d1f] outline-none placeholder:text-[#8e8e93] focus:text-left"
            />
            {/* The example it is typing, with Safari's caret, drawn over the
                empty field; the field itself is untouched. */}
            {typing ? (
              <span aria-hidden className="pointer-events-none absolute inset-y-0 right-[84px] left-8 flex items-center justify-center text-[15px] font-medium text-[#8e8e93]">
                {ghost}
                <i className="own-caret" />
              </span>
            ) : null}
            {phase !== "idle" && phase !== "reading" ? <span className="hidden text-[#8e8e93] sm:block">{RELOAD}</span> : null}
            <button
              type="submit"
              disabled={phase === "reading" || phase === "sending" || phase === "done"}
              aria-label={buttonLabel}
              className="h-[26px] shrink-0 rounded-sm bg-[#0071e3] px-3 text-[13.5px] font-semibold text-white transition-colors hover:bg-[#0077ed] disabled:opacity-60"
            >
              {/* "Email it to me" leaves a phone's pill no room for the address. */}
              {buttonLabel === "Email it to me" ? (
                <>
                  <span className="sm:hidden">Email it</span>
                  <span className="hidden sm:inline">{buttonLabel}</span>
                </>
              ) : (
                buttonLabel
              )}
            </button>
            {/* Safari's loading line, along the bottom of the pill, while a site is being read or a demo built. */}
            {loading ? (
              <span aria-hidden className="safari-progress absolute inset-x-2 bottom-0 h-[2px] overflow-hidden rounded-full">
                <span className="block h-full w-1/3 rounded-full bg-[#0071e3]" />
              </span>
            ) : null}
          </div>

          {/* The lights' width again on the right, so the pill sits in the middle of the window. */}
          <span className="hidden w-[52px] shrink-0 sm:block" aria-hidden />
        </form>

        {/* The sheet: macOS asks its question from the top of the window it belongs to. */}
        <div
          role="dialog"
          aria-modal="false"
          aria-labelledby={`${ids}-sheet-title`}
          aria-hidden={!sheetOpen}
          inert={!sheetOpen}
          className={[
            "absolute inset-x-0 top-[52px] z-10 mx-auto w-[min(440px,calc(100%-24px))] rounded-b-md border border-t-0 border-black/10 bg-white/95 px-5 pt-5 pb-4 shadow-lg backdrop-blur-xl transition-[transform,opacity] duration-base ease-out",
            sheetOpen ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-[110%] opacity-0",
          ].join(" ")}
          onKeyDown={(event) => {
            if (event.key === "Escape") cancel();
          }}
        >
          <form onSubmit={submit} noValidate>
            <div className="flex items-start gap-3">
              <img src="/icon.png" alt="" className="size-10 shrink-0 rounded-sm ring-1 ring-black/[0.06]" />
              <div className="min-w-0 text-left">
                <p id={`${ids}-sheet-title`} className="text-[15.5px] leading-snug font-semibold text-[#1d1d1f]">
                  Send me my own free AI assistant in my own branding
                </p>
                <p className="mt-1 text-[13.5px] leading-snug text-[#6e6e73]">
                  Built from <span className="font-semibold text-[#1d1d1f]">{host || "your website"}</span>. The link
                  arrives by email when it&rsquo;s ready.
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
              className="mt-4 h-[38px] w-full rounded-sm border border-black/15 bg-white px-3 text-[15px] text-[#1d1d1f] outline-none transition-shadow placeholder:text-[#8e8e93] focus:border-[#0071e3] focus:ring-[3.5px] focus:ring-[rgb(0_113_227/0.3)]"
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
                One email, with your link.{" "}
                <a href="/privacy#own-demo" className="underline underline-offset-2">
                  How we use it
                </a>
              </p>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={cancel}
                className="h-[30px] rounded-sm border border-black/10 bg-white px-3.5 text-[13.5px] font-medium text-[#1d1d1f] shadow-sm transition-colors hover:bg-[#f5f5f7]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={phase === "sending" || !email.trim()}
                className="h-[30px] rounded-sm bg-[#0071e3] px-3.5 text-[13.5px] font-semibold text-white shadow-sm transition-colors hover:bg-[#0077ed] disabled:opacity-50"
              >
                {phase === "sending" ? "Sending…" : "Send it to me"}
              </button>
            </div>
          </form>
        </div>

        {/* The page in the window. */}
        <div className="relative h-[310px] overflow-hidden bg-white sm:h-[350px]">
          {phase === "idle" || phase === "reading" ? (
            <div className="own-rise absolute inset-0 grid place-content-center justify-items-center gap-3 px-6 text-center">
              <HealdeskSoul size={64} />
              <p className="font-display text-ink text-[clamp(22px,2.4vw,28px)] leading-tight font-normal tracking-[-0.02em]">
                {phase === "reading" ? (
                  <>
                    Reading <span className="font-medium">{host}</span>&hellip;
                  </>
                ) : (
                  <>Your site, with {site.agent} on it.</>
                )}
              </p>
            </div>
          ) : null}

          {/* AYA's chat in the page's corner, greeting from whatever is in the
              address bar, as it is typed. */}
          {phase === "idle" || phase === "reading" ? (
            <div aria-hidden className="own-rise absolute right-4 bottom-4 flex items-end gap-2.5 sm:right-6 sm:bottom-6">
              <p className="max-w-[230px] rounded-md rounded-br-sm bg-white px-3.5 py-2.5 text-left text-[13px] leading-snug text-[#1d1d1f] shadow-md ring-1 ring-black/5">
                Hi, I&rsquo;m {site.agent} on <span className="font-semibold break-all">{echo || "your site"}</span>
              </p>
              <span className="bg-ink grid size-11 shrink-0 place-items-center rounded-full text-white shadow-md">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" className="size-5">
                  <path d="M4 5.5h16v10.5H9.5L5.5 19.5V16H4z" />
                </svg>
              </span>
            </div>
          ) : null}

          {phase === "idle" || phase === "reading" ? null : (
            <div aria-hidden className="own-rise absolute inset-0">
              {/* Their header: their logo, or their name. */}
              <div className="flex h-[52px] items-center gap-3 border-b border-black/[0.06] bg-white px-5">
                {preview?.logoUrl ? (
                  <img src={preview.logoUrl} alt="" className="max-h-7 w-auto max-w-[160px] object-contain" />
                ) : (
                  <>
                    <span className="grid size-7 place-items-center rounded-sm text-[13px] font-bold" style={{ background: colour, color: ink }}>
                      {initial}
                    </span>
                    <span className="truncate text-[15px] font-semibold text-[#1d1d1f]">{name}</span>
                  </>
                )}
              </div>

              {/* Their photograph, or, where the site gave none, its name on a wash of its colour. */}
              <div className="absolute inset-x-0 top-[52px] bottom-0 overflow-hidden">
                {preview?.image ? (
                  <>
                    <img src={preview.image} alt="" className="size-full object-cover" />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/25 via-transparent to-transparent" />
                  </>
                ) : (
                  <div
                    className="flex size-full items-start px-6 pt-6 sm:items-center sm:px-12 sm:pt-0"
                    style={{ background: `color-mix(in srgb, ${colour} 14%, white)` }}
                  >
                    {/* Kept to the left, clear of the chat in the right-hand corner. */}
                    <span className="font-display text-ink max-w-[11ch] text-left text-[clamp(26px,3.6vw,44px)] leading-[1.05] font-normal tracking-[-0.025em] text-balance">
                      {name}
                    </span>
                  </div>
                )}
              </div>

              {/* AYA, in their corner, in their colour. */}
              <div className="own-widget absolute right-4 bottom-4 w-[min(268px,calc(100%-32px))] sm:right-6 sm:bottom-6">
                <div className="overflow-hidden rounded-md bg-white shadow-md ring-1 ring-black/5">
                  <div className="flex items-center gap-2.5 px-3.5 py-2.5" style={{ background: colour, color: ink }}>
                    <span className="grid size-7 shrink-0 place-items-center rounded-full text-[12px] font-bold" style={{ background: ink, color: colour }}>
                      {initial}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] leading-tight font-semibold">{name}</span>
                      <span className="block text-[11px] leading-tight opacity-80">AI assistant</span>
                    </span>
                  </div>
                  <div className="px-3 pt-3 pb-2.5">
                    <p className="rounded-md rounded-bl-sm bg-[#f1f1f1] px-3 py-2 text-[12.5px] leading-snug text-[#1d1d1f]">
                      {greeted ? (
                        <span className="morph-text">{greetingLead(name)}</span>
                      ) : (
                        <span className="typing-dots text-[#6e6e73]">
                          <i />
                          <i />
                          <i />
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 border-t border-black/[0.06] px-3 py-2">
                    <span className="flex-1 text-[12px] text-[#8e8e93]">Type a message&hellip;</span>
                    <span className="grid size-6 place-items-center rounded-full" style={{ background: colour, color: ink }}>
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="size-3.5">
                        <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
                      </svg>
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {phase === "done" ? (
            <div className="own-rise absolute inset-0 z-[1] grid place-items-center bg-white/85 px-6 text-center backdrop-blur-[2px]">
              <div>
                <p className="font-display text-ink text-[clamp(22px,2.4vw,28px)] leading-tight font-medium tracking-[-0.02em]">
                  Building {host}&rsquo;s assistant&hellip;
                </p>
                <p className="text-muted mx-auto mt-2 max-w-[44ch] text-[15.5px] font-medium">
                  We&rsquo;ll email <span className="text-ink font-semibold">{email.trim()}</span> the link when it&rsquo;s
                  ready. Questions:{" "}
                  <a href={`mailto:${site.email}`} className="text-ink font-semibold underline underline-offset-2">
                    {site.email}
                  </a>
                  .
                </p>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
