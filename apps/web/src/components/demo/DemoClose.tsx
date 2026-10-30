"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { Audience } from "@healdesk/catalog";
import { useBuy } from "@/components/BuyModal";
import { OfferCountdown } from "@/components/checkout/SetupOfferBanner";
import { sendDemoEvent } from "@/components/demo/DemoViewed";
import { type DemoOfferTerms, type Recommendation, recommendation } from "@/lib/demo/close";
import type { DemoEventName } from "@/lib/demo/events";
import type { RoiInputs } from "@/lib/demo/roi";
import { usd } from "@/lib/pricing";
import { site } from "@/lib/site";

/**
 * The personalised demo's close (lib/demo/close.ts says what it is and why
 * it runs beside the old one): one shared state for the page, and the parts
 * every section draws from it, so the price, the setup offer and the plan
 * the button opens checkout on are the same figure everywhere.
 *
 *   - `ActivateButton`: the page's one call to action, "Activate my AYA",
 *     with the offer under it. On a demo an operator built it goes through
 *     /demo/[slug]/onboard to /get-started; on a homepage demo it opens the
 *     purchase over the page (components/BuyModal.tsx). Either way checkout
 *     opens on the recommended package at this clinic's steps.
 *   - `OfferPrice`: the setup fee struck through, today's figure, the dollars
 *     saved and the clock; once the clock runs out, the list fee and nothing
 *     else. Never a reset timer.
 *   - `CloseCard`: shown in the voice or chat panel when a demo conversation
 *     there ends, never as a modal, and dismissable.
 *   - `MobileActivateBar`: on a phone, once the visitor has scrolled past the
 *     demo, the button pinned to the bottom of the screen.
 *
 * The owner's inputs (missed calls and messages, a visit's price, the booking
 * rate) live here because they move the steps, so the price on every button
 * moves with them. They are never sent anywhere: the events this page sends
 * (lib/demo/events.ts) carry a name and one word.
 */

export type ClosePlacement = "top-bar" | "header" | "close-card" | "coverage" | "value" | "closing" | "mobile-bar";

type Channel = "voice" | "chat";

type CloseValue = {
  slug: string;
  clinicName: string;
  logoUrl: string | null;
  selfServe: boolean;
  /** Who the clinic serves (demoAudience): a vet's people are clients, and it signs the DPA, never a BAA. */
  audience: Audience;
  inputs: RoiInputs;
  setInputs: (next: RoiInputs) => void;
  rec: Recommendation;
  track: (name: DemoEventName, detail?: string) => void;
  activate: (placement: ClosePlacement) => void;
  ended: Record<Channel, boolean>;
  markEnded: (channel: Channel) => void;
  offerEnded: () => void;
};

const Ctx = createContext<CloseValue | null>(null);

export function useDemoClose(): CloseValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("useDemoClose outside DemoCloseProvider");
  return value;
}

export function DemoCloseProvider({
  slug,
  clinicName,
  logoUrl,
  selfServe,
  audience = "patients",
  initialInputs,
  terms,
  initialEnded = { voice: false, chat: false },
  children,
}: {
  /** Which demo conversations have ended already: none, on a real page. */
  initialEnded?: Record<Channel, boolean>;
  slug: string;
  clinicName: string;
  logoUrl: string | null;
  selfServe: boolean;
  audience?: Audience;
  initialInputs: RoiInputs;
  terms: DemoOfferTerms;
  children: ReactNode;
}) {
  const router = useRouter();
  const buy = useBuy();
  const [inputs, setInputs] = useState(initialInputs);
  const [ended, setEnded] = useState<Record<Channel, boolean>>(initialEnded);
  // Read again the moment the offer's clock runs out, so every figure drops it together.
  const [now, setNow] = useState(() => Date.now());
  const rec = useMemo(() => recommendation(inputs, terms, now), [inputs, terms, now]);

  const track = useCallback((name: DemoEventName, detail?: string) => sendDemoEvent(slug, name, detail), [slug]);

  useEffect(() => {
    track("demo_viewed");
  }, [track]);

  const activate = useCallback(
    (placement: ClosePlacement) => {
      if (selfServe && buy) {
        track("cta_clicked", placement);
        buy.open({ plan: rec.plan.id });
        return;
      }
      // The onboard route records the press itself, and sets the demo's cookie.
      const params = new URLSearchParams({ plan: rec.plan.id, from: placement });
      // A route handler that sets the demo's cookie and redirects: a full
      // navigation is the point, which a client-side push would skip.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign(`/demo/${slug}/onboard?${params.toString()}`);
    },
    [buy, rec.plan.id, selfServe, slug, track],
  );

  const markEnded = useCallback(
    (channel: Channel) => {
      setEnded((current) => {
        if (current[channel]) return current;
        track("demo_ended", channel);
        return { ...current, [channel]: true };
      });
    },
    [track],
  );

  const offerEnded = useCallback(() => {
    setNow(Date.now());
    router.refresh();
  }, [router]);

  const value = useMemo<CloseValue>(
    () => ({ slug, clinicName, logoUrl, selfServe, audience, inputs, setInputs, rec, track, activate, ended, markEnded, offerEnded }),
    [slug, clinicName, logoUrl, selfServe, audience, inputs, rec, track, activate, ended, markEnded, offerEnded],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Called once, the first time `ref` is at least half on screen. */
export function useSeenOnce(ref: RefObject<Element | null>, onSeen: () => void, threshold = 0.5) {
  const seen = useRef(false);
  const callback = useRef(onSeen);
  useEffect(() => {
    callback.current = onSeen;
  }, [onSeen]);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !seen.current) {
          seen.current = true;
          callback.current();
          observer.disconnect();
        }
      },
      { threshold },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, threshold]);
}

/** The clinic's logo, or its initial in its own colour when it has none. */
export function ClinicMark({ size = 36 }: { size?: number }) {
  const { clinicName, logoUrl } = useDemoClose();
  if (logoUrl) {
    return (
      <span
        className="grid shrink-0 place-items-center overflow-hidden rounded-full bg-white ring-1 ring-black/5"
        style={{ width: size, height: size }}
      >
        <img src={logoUrl} alt="" className="max-h-[70%] max-w-[80%] object-contain" />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="font-display grid shrink-0 place-items-center rounded-full font-semibold"
      style={{ width: size, height: size, fontSize: size * 0.45, background: "var(--clinic)", color: "var(--clinic-ink)" }}
    >
      {clinicName.trim().charAt(0).toUpperCase()}
    </span>
  );
}

export const ACTIVATE_LABEL = "Activate my AYA";

/** The offer as one short line, for under a button: "Setup $697, not $1,394 · ends in 01d 22h 20m". */
export function OfferSubLabel({ className = "" }: { className?: string }) {
  const { rec, offerEnded } = useDemoClose();
  const s = rec.setup;
  if (!s.endsAt) return <span className={className}>Setup {usd.format(s.listUsd)} · billing starts when {site.agent} answers</span>;
  return (
    <span className={className}>
      Setup {usd.format(s.dueUsd)}, not {usd.format(s.listUsd)} · ends in{" "}
      <OfferCountdown endsAt={s.endsAt} onEnd={offerEnded} />
    </span>
  );
}

const ARROW = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="size-5" aria-hidden>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

export function ActivateButton({
  placement,
  size = "lg",
  subLabel = true,
  className = "",
}: {
  placement: ClosePlacement;
  size?: "sm" | "lg";
  /** The offer under the label; off where the offer is printed right beside it. */
  subLabel?: boolean;
  className?: string;
}) {
  const { activate } = useDemoClose();
  const big = size === "lg";
  return (
    <span className={`inline-flex flex-col items-center gap-2 ${className}`}>
      <button
        type="button"
        onClick={() => activate(placement)}
        className={`duration-fast inline-flex items-center justify-center gap-2 rounded-full font-bold shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 ${
          big ? "min-h-14 w-full px-8 text-base sm:w-auto" : "min-h-10 px-4 text-sm sm:px-5"
        }`}
        style={{ background: "var(--clinic)", color: "var(--clinic-ink)", outlineColor: "var(--clinic)" }}
      >
        {ACTIVATE_LABEL}
        {big ? ARROW : null}
      </button>
      {subLabel ? <OfferSubLabel className="text-xs font-semibold tabular-nums opacity-80" /> : null}
    </span>
  );
}

/**
 * The offer in full: the badge, the setup fee struck through, today's figure,
 * the dollars saved and the clock; the monthly price at this clinic's steps.
 * `tone` is the surface it sits on.
 */
export function OfferPrice({ tone = "dark", placement }: { tone?: "dark" | "light"; placement: "close-card" | "closing" }) {
  const { rec, track, offerEnded, clinicName, audience } = useDemoClose();
  const ref = useRef<HTMLDivElement>(null);
  const s = rec.setup;
  useSeenOnce(ref, () => {
    if (s.endsAt) track("offer_seen", placement);
  });
  const dim = tone === "dark" ? "text-white/60" : "text-muted";
  return (
    <div ref={ref} className="tabular-nums">
      <p className={`text-xs font-bold tracking-[0.08em] uppercase ${dim}`}>{rec.plan.name.split(",")[0]} · Recommended for {clinicName}</p>
      <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
        <span className="font-display text-4xl leading-none font-medium tracking-[-0.02em]">{usd.format(rec.monthlyUsd)}</span>
        <span className={`text-sm font-semibold ${dim}`}>/month at your volume</span>
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        {s.percent !== null ? (
          <span className="rounded-full bg-[#87d68d] px-2.5 py-1 text-xs font-bold text-[#172a3a]">{s.percent}% off setup</span>
        ) : null}
        <span className="text-base font-semibold">
          Setup{" "}
          {s.endsAt ? (
            <>
              <s className={`${dim} font-medium`}>{usd.format(s.listUsd)}</s> <strong className="font-bold">{usd.format(s.dueUsd)}</strong>
            </>
          ) : (
            <strong className="font-bold">{usd.format(s.listUsd)}</strong>
          )}
        </span>
      </div>
      {s.endsAt ? (
        <p className="mt-2 text-sm font-semibold">
          You save {usd.format(s.savedUsd)} · ends in <OfferCountdown endsAt={s.endsAt} onEnd={offerEnded} />
        </p>
      ) : (
        <p className={`mt-2 text-xs ${dim}`}>Your demo&rsquo;s setup offer has ended. This is the standard setup fee.</p>
      )}
      <p className={`mt-3 text-xs ${dim}`}>
        {rec.plan.includedVoiceMinutes > 0 ? `${rec.plan.includedVoiceMinutes} voice minutes` : null}
        {rec.plan.includedVoiceMinutes > 0 && rec.plan.includedChatConversations > 0 ? " and " : null}
        {rec.plan.includedChatConversations > 0 ? `${rec.plan.includedChatConversations} chat conversations` : null} a month. Monthly
        billing starts the day {site.agent} first answers a {audience === "clients" ? "client" : "patient"}.
      </p>
    </div>
  );
}

/** "That was your AYA": inside the panel whose conversation just ended. */
export function CloseCard({ channel }: { channel: Channel }) {
  const { ended, clinicName, rec, track, activate, offerEnded } = useDemoClose();
  const [dismissed, setDismissed] = useState(false);
  const shownRef = useRef(false);
  const show = ended[channel] && !dismissed;

  useEffect(() => {
    if (show && !shownRef.current) {
      shownRef.current = true;
      track("close_card_shown", channel);
    }
  }, [show, channel, track]);

  if (!show) return null;
  const s = rec.setup;
  return (
    <section
      aria-label={`Activate ${clinicName}'s AYA`}
      className="hd-close-card relative mt-4 rounded-md border border-white/[0.08] bg-[#0B1520] p-5 text-white shadow-md sm:p-6"
    >
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="absolute top-2 right-2 grid size-11 place-items-center rounded-full text-white/55 transition-colors hover:text-white"
      >
        <span aria-hidden className="text-lg leading-none">&times;</span>
      </button>
      <div className="flex items-center gap-3 pr-8">
        <ClinicMark size={40} />
        <div className="min-w-0">
          <p className="font-display text-lg leading-tight font-medium">That was your {site.agent}.</p>
          <p className="text-xs text-white/65">She has already read {clinicName}&rsquo;s website.</p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-white/[0.08] pt-4 tabular-nums">
        <p className="text-sm font-semibold">
          <span className="font-display text-2xl font-medium">{usd.format(rec.monthlyUsd)}</span>
          <span className="text-white/60">/mo</span>
        </p>
        <p className="text-sm font-semibold">
          Setup{" "}
          {s.endsAt ? (
            <>
              <s className="font-medium text-white/50">{usd.format(s.listUsd)}</s> {usd.format(s.dueUsd)}
            </>
          ) : (
            usd.format(s.listUsd)
          )}
        </p>
      </div>
      {s.endsAt ? (
        <p className="mt-1 text-xs font-semibold text-[#87d68d] tabular-nums">
          You save {usd.format(s.savedUsd)} · ends in <OfferCountdown endsAt={s.endsAt} onEnd={offerEnded} />
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => {
          track("close_card_cta", channel);
          activate("close-card");
        }}
        className="duration-fast mt-4 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full px-6 text-base font-bold transition-all hover:-translate-y-0.5"
        style={{ background: "var(--clinic)", color: "var(--clinic-ink)" }}
      >
        Make her live
        {ARROW}
      </button>
    </section>
  );
}

/**
 * On a phone, once the demo panels have scrolled out of view upward: the one
 * button, pinned to the bottom. `after` is the element it waits to pass.
 */
export function MobileActivateBar({ after }: { after: RefObject<HTMLElement | null> }) {
  const { activate, rec, offerEnded } = useDemoClose();
  const [visible, setVisible] = useState(false);
  // A scroll check rather than an IntersectionObserver: a fling that carries
  // the marker from below the screen to above it in one frame never
  // intersects, so an observer would never say it was passed.
  useEffect(() => {
    const el = after.current;
    if (!el) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      setVisible(el.getBoundingClientRect().top < 0);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [after]);

  return (
    <div
      aria-hidden={!visible}
      className={`duration-base fixed inset-x-0 bottom-0 z-40 border-t border-white/[0.08] bg-[#0B1520]/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-white backdrop-blur transition-transform ease-out sm:hidden ${
        visible ? "visible translate-y-0" : "pointer-events-none invisible translate-y-full"
      }`}
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1 text-xs leading-tight font-semibold tabular-nums">
          <p className="text-sm">
            {usd.format(rec.monthlyUsd)}/mo
            {rec.setup.endsAt ? <span className="text-[#87d68d]"> · save {usd.format(rec.setup.savedUsd)}</span> : null}
          </p>
          {rec.setup.endsAt ? (
            <span className="block truncate text-white/65">
              ends in <OfferCountdown endsAt={rec.setup.endsAt} onEnd={offerEnded} />
            </span>
          ) : (
            <span className="block truncate text-white/65">Setup {usd.format(rec.setup.listUsd)}</span>
          )}
        </div>
        <button
          type="button"
          tabIndex={visible ? 0 : -1}
          onClick={() => activate("mobile-bar")}
          className="min-h-11 shrink-0 rounded-full px-5 text-sm font-bold"
          style={{ background: "var(--clinic)", color: "var(--clinic-ink)" }}
        >
          {ACTIVATE_LABEL}
        </button>
      </div>
    </div>
  );
}

/**
 * The sticky bar along the top: the offer in dollars while it holds, with its
 * clock, and the demo's own week beside it in a quieter voice. Once the offer
 * has ended, only the demo's week: no clock restarts.
 */
export function TopOfferBar({ demoClock, copyLink }: { demoClock: ReactNode; copyLink: ReactNode }) {
  const { rec, clinicName, track, offerEnded } = useDemoClose();
  const s = rec.setup;
  const live = s.endsAt !== null;
  useEffect(() => {
    if (live) track("offer_seen", "top-bar");
    // Once per page view, while the offer holds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div
      className="sticky top-0 z-50 border-b border-white/[0.08] bg-[#0B1520] px-4 py-2.5 text-white sm:px-8"
      role="region"
      aria-label="Your demo offer"
    >
      <div className="mx-auto flex max-w-page flex-wrap items-center justify-center gap-x-4 gap-y-1 text-center text-xs font-semibold tabular-nums">
        {live ? (
          <>
            <span className="rounded-full bg-[#87d68d] px-2.5 py-0.5 text-xs font-bold text-[#172a3a]">{s.percent}% off setup</span>
            <span>
              <s className="text-white/50">{usd.format(s.listUsd)}</s> <strong>{usd.format(s.dueUsd)}</strong>
              <span className="hidden sm:inline"> · you save {usd.format(s.savedUsd)}</span> · ends in{" "}
              <OfferCountdown endsAt={s.endsAt!} onEnd={offerEnded} />
            </span>
          </>
        ) : null}
        <span className="flex items-center gap-2 text-xs text-white/60">
          <span className="hidden sm:inline">Private demo for {clinicName} · live for</span>
          <span className="sm:hidden">Demo live for</span>
          {demoClock}
        </span>
        <span className="hidden sm:inline">{copyLink}</span>
      </div>
    </div>
  );
}
