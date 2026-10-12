"use client";

import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { flushSync } from "react-dom";

import { BookingCard, cardFor, DepositCard, type CardAccent } from "@/components/agent-panel/ChatCards";
import { REDUCED_MOTION, useMediaQuery } from "@/lib/use-media-query";

/**
 * The chat card: one conversation, dressed four ways.
 *
 * The boxes along its top (Website, WhatsApp, Instagram, Messenger) only
 * change how the same thread looks, so a visitor sees at a glance that one
 * assistant answers every place a patient writes. It is make-up, on the
 * owner's instruction of 7 October 2026: nothing is sent to Meta, the
 * conversation carries on unchanged when the box changes, and the assistant
 * behaves the same whichever is selected (the routes are never told which one
 * is showing).
 *
 * It was the personalised demo's chat ("Peachy", components/demo/ClinicChatPanel.tsx
 * on the demo/port branch). On 9 October 2026 the owner asked for the
 * homepage's card to look exactly like it, so the drawing lives here and both
 * pages use it: the demo page as the clinic, in its colour and logo, and the
 * homepage as AYA, in healdesk's red. Each keeps its own conversation logic
 * (the demo's archive lock, the homepage's email gate and pause), which is
 * why this takes the thread and callbacks rather than calling a route itself.
 *
 * ## The typing dots become the answer (the owner's M6, 9 October 2026)
 *
 * An assistant turn with nothing in it yet is a small bubble of three
 * bouncing dots. When the first words land, the same bubble opens out from
 * the dots' footprint to its full size and the words fade in, so the answer
 * visibly grows out of the wait rather than replacing it. The opening is a
 * clip-path, not a size animation, so the text lays out once, at its final
 * width, and never reflows mid-motion.
 *
 * ## The owner's picks of 12 October 2026
 *
 *   - Changing the box morphs one app into the next: the browser's view
 *     transition carries the header, the thread and the composer from one
 *     look to the other, rather than swapping the card, while the boxes'
 *     own pill slides under the one chosen, as the voice card's does.
 *   - The answer streams in word by word, each word fading up out of a
 *     blur as it lands; each app waits its own way (WhatsApp says "typing…"
 *     in its header and draws no bubble until the words come; the others
 *     keep the dots that open into the answer).
 *   - Each app's own receipts and times: WhatsApp's ticks, grey until she
 *     answers and blue once she has; Messenger's "Sent", then the little
 *     avatar that says it was seen; Instagram's "Seen"; the website's "Sent"
 *     and "Seen" with the time; and the date or time over the thread in each
 *     app's way.
 *   - The suggested questions are a row that swipes sideways above the
 *     composer; one pressed flies into the field and sends.
 *   - A question about booking or deposits gets a card under the answer, as
 *     a patient would see one (ChatCards.tsx): times, a 60-second hold, the
 *     booking, the deposit link. Previews: nothing is booked or charged.
 *   - The header is frosted glass over the thread, and gains a soft shadow
 *     once the thread scrolls under it.
 */

export type Skin = "website" | "whatsapp" | "instagram" | "messenger";
/** `at` is when it was said, in epoch milliseconds, for the WhatsApp timestamps. */
export type SkinMessage = { role: "user" | "assistant"; content: string; at?: number };

// ─── Icons, drawn simply: the point is recognition, not a copy of a logo ───

const Icon = {
  globe: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </svg>
  ),
  whatsapp: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden>
      <path d="M3.5 20.5l1.3-4.4A8.7 8.7 0 1 1 8 19.3l-4.5 1.2Z" />
      <path d="M9 8.5c.3 2.6 2.4 5.2 5.4 6l1.3-1.3-1.8-1-.8.7c-1-.4-2.1-1.5-2.5-2.5l.7-.8-1-1.8L9 8.5Z" fill="currentColor" stroke="none" />
    </svg>
  ),
  instagram: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
      <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.3" cy="6.7" r="1" fill="currentColor" stroke="none" />
    </svg>
  ),
  messenger: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2.5C6.5 2.5 2.5 6.5 2.5 11.6c0 2.8 1.2 5.2 3.2 6.9v3.5l3.1-1.7c1 .3 2.1.4 3.2.4 5.5 0 9.5-4 9.5-9.1S17.5 2.5 12 2.5Zm1 12.1-2.4-2.6-4.7 2.6 5.2-5.5 2.5 2.6 4.6-2.6-5.2 5.5Z" />
    </svg>
  ),
  back: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m15 5-7 7 7 7" />
    </svg>
  ),
  phone: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.4 2.1L8.1 9.9a16 16 0 0 0 6 6l1.4-1.2a2 2 0 0 1 2.1-.4c.8.3 1.7.5 2.6.6a2 2 0 0 1 1.7 2Z" />
    </svg>
  ),
  video: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2.5" y="6" width="13" height="12" rx="2.5" />
      <path d="m15.5 10.5 6-3.5v10l-6-3.5" />
    </svg>
  ),
  camera: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden>
      <path d="M4 8h3l2-2.5h6L17 8h3v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  ),
  mic: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 7v10M7 12h10" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  ),
  send: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M3.4 20.6 21 12 3.4 3.4 3.4 10l12.6 2-12.6 2z" />
    </svg>
  ),
  ticks: (
    <svg viewBox="0 0 18 11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m1 6 3 3L10 2M7 8.5l.5.5L14 2" />
    </svg>
  ),
};

const BOXES: { id: Skin; label: string; badge: string; ink: string; icon: ReactNode }[] = [
  { id: "website", label: "Website", badge: "var(--clinic)", ink: "var(--clinic-ink)", icon: Icon.globe },
  { id: "whatsapp", label: "WhatsApp", badge: "#25d366", ink: "#fff", icon: Icon.whatsapp },
  {
    id: "instagram",
    label: "Instagram",
    badge: "linear-gradient(45deg,#feda75,#fa7e1e 30%,#d62976 60%,#962fbf 85%,#4f5bd5)",
    ink: "#fff",
    icon: Icon.instagram,
  },
  { id: "messenger", label: "Messenger", badge: "linear-gradient(45deg,#0099ff,#a033ff 60%,#ff5280)", ink: "#fff", icon: Icon.messenger },
];

function Avatar({
  name,
  logoUrl,
  size,
  ring,
  filled,
}: {
  name: string;
  logoUrl: string | null;
  size: number;
  ring?: boolean;
  /**
   * The mark in white on the brand's colour, rather than in colour on white:
   * the homepage's white header (see `headerTone`). For a one-colour mark on
   * a transparent ground, which healdesk's "h" is.
   */
  filled?: boolean;
}) {
  const inner = (
    <span
      className="grid shrink-0 place-items-center overflow-hidden rounded-full bg-white text-[12px] font-bold"
      style={{
        width: size,
        height: size,
        boxShadow: "0 0 0 1px rgb(0 0 0 / 0.06)",
        ...(filled ? { background: "var(--clinic)" } : {}),
      }}
      aria-hidden
    >
      {logoUrl ? (
        <img
          src={logoUrl}
          alt=""
          referrerPolicy="no-referrer"
          className={`size-full object-contain ${filled ? "p-[5px] brightness-0 invert" : "p-[2px]"}`}
        />
      ) : (
        <span className="grid size-full place-items-center" style={{ background: "var(--clinic)", color: "var(--clinic-ink)" }}>
          {name.slice(0, 1).toUpperCase()}
        </span>
      )}
    </span>
  );
  // Instagram's story ring.
  return ring ? (
    <span className="shrink-0 rounded-full p-[2px]" style={{ background: "linear-gradient(45deg,#feda75,#fa7e1e,#d62976,#962fbf,#4f5bd5)" }}>
      <span className="block rounded-full bg-white p-[2px]">{inner}</span>
    </span>
  ) : (
    inner
  );
}

/** The handle an Instagram account by this name would most likely have, for the header. */
function handleOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24) || "clinic";
}

/**
 * True once the page is running in the browser. Times are shown only then:
 * the server's clock and timezone are not the visitor's, and a time rendered
 * on one and hydrated on the other would disagree.
 */
function useHydrated(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

/**
 * An assistant bubble, which is three dots while it waits and opens round its
 * first words when they land (M6, above). The dots' footprint is measured
 * while they show; the moment text replaces them the bubble is drawn at its
 * full size and clipped back to that footprint, then unclipped from its
 * bottom-left corner, where the dots sat, outwards.
 */
/**
 * Words as they stream in, each in its own span so that each one fades up as
 * it lands: React keeps the spans already there and mounts only the new
 * ones, and the animation runs on mount. Once the answer is complete it is
 * plain text again, so a finished answer never animates twice, when the box
 * changes or the thread re-renders.
 */
function StreamWords({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\s+)/).map((part, i) => (/^\s*$/.test(part) ? part : <span key={i} className="stream-word">{part}</span>))}
    </>
  );
}

function AssistantBubble({
  typing,
  streaming = false,
  className,
  style,
  children,
  after,
}: {
  typing: boolean;
  /** These are the words arriving now: they stream in (StreamWords). */
  streaming?: boolean;
  className: string;
  style?: CSSProperties;
  /** The words. */
  children: string;
  /** Laid over the bubble, such as WhatsApp's time. */
  after?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pill = useRef<{ width: number; height: number } | null>(null);
  const reduce = useMediaQuery(REDUCED_MOTION);
  const [opened, setOpened] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typing) {
      const box = el.getBoundingClientRect();
      pill.current = { width: box.width, height: box.height };
      return;
    }
    const from = pill.current;
    pill.current = null;
    if (!from || reduce || typeof el.animate !== "function") return;
    const box = el.getBoundingClientRect();
    const round = getComputedStyle(el).borderRadius;
    el.animate(
      [
        { clipPath: `inset(${Math.max(0, box.height - from.height)}px ${Math.max(0, box.width - from.width)}px 0 0 round ${round})` },
        { clipPath: `inset(0 0 0 0 round ${round})` },
      ],
      { duration: 380, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
    );
    // The fade belongs to this one opening, not to every later render.
    setOpened(true);
  }, [typing, reduce]);

  useEffect(() => {
    if (!opened) return;
    const id = window.setTimeout(() => setOpened(false), 500);
    return () => window.clearTimeout(id);
  }, [opened]);

  return (
    <div ref={ref} className={className} style={style}>
      {typing ? (
        <span className="typing-dots" role="status" aria-label="Typing">
          <i />
          <i />
          <i />
        </span>
      ) : (
        <span className={`whitespace-pre-wrap ${opened ? "morph-text" : ""}`}>{streaming ? <StreamWords text={children} /> : children}</span>
      )}
      {after}
    </div>
  );
}

/** Each app's colour for a card's button and ring, and for the chips. */
const ACCENT: Record<Skin, CardAccent> = {
  website: { bg: "var(--clinic)", ink: "var(--clinic-ink)" },
  whatsapp: { bg: "#00a884", ink: "#ffffff" },
  instagram: { bg: "#3797f0", ink: "#ffffff" },
  messenger: { bg: "#0a7cff", ink: "#ffffff" },
};

/**
 * A row that a mouse can drag sideways, as a finger swipes it. A drag that
 * moved is not also a press: the click that ends it is swallowed.
 */
function useDragScroll() {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; left: number; moved: boolean } | null>(null);
  return {
    ref,
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== "mouse" || !ref.current) return;
      drag.current = { x: event.clientX, left: ref.current.scrollLeft, moved: false };
    },
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      const el = ref.current;
      const d = drag.current;
      if (!el || !d) return;
      const dx = event.clientX - d.x;
      if (!d.moved && Math.abs(dx) < 5) return;
      d.moved = true;
      el.dataset.dragging = "";
      el.scrollLeft = d.left - dx;
    },
    onPointerUp: () => {
      const el = ref.current;
      if (el) delete el.dataset.dragging;
      window.setTimeout(() => (drag.current = null), 0);
    },
    onPointerLeave: () => {
      const el = ref.current;
      if (el) delete el.dataset.dragging;
      drag.current = null;
    },
    onClickCapture: (event: React.MouseEvent) => {
      if (drag.current?.moved) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
  };
}

/** The page's zoom, read off an element: its drawn width over its laid-out one (0.9 from 640px). */
function zoomOf(el: HTMLElement): number {
  return el.getBoundingClientRect().width / Math.max(1, el.offsetWidth) || 1;
}

export function ChatSkins({
  name,
  logoUrl,
  messages,
  chips,
  onSend,
  input,
  onInput,
  streaming,
  disabled = false,
  disabledPlaceholder,
  placeholder,
  aiNotice,
  error,
  composer,
  footnote,
  headerTone = "brand",
}: {
  /** Whose assistant this is: the clinic's name, or AYA. */
  name: string;
  /** The avatar: the clinic's logo if it fits a circle, AYA's mark on the homepage. */
  logoUrl: string | null;
  /** The whole thread, greeting first. */
  messages: readonly SkinMessage[];
  /** Offered over the composer until the conversation starts. */
  chips: readonly string[];
  onSend: (text: string) => void;
  input: string;
  onInput: (value: string) => void;
  /** An answer is on its way, so Send waits. */
  streaming: boolean;
  /** The whole composer is off: an archived demo, a paused route. */
  disabled?: boolean;
  /** What the field says while it is off. */
  disabledPlaceholder?: string;
  /** The website skin's placeholder; the others use their app's own. */
  placeholder?: string;
  /** WhatsApp's yellow notice at the top of the chat: who is answering. */
  aiNotice: string;
  error?: string | null;
  /** Drawn in place of the skin's composer, such as the homepage's email ask. */
  composer?: ReactNode;
  /** Under the composer, such as a note on what not to type. */
  footnote?: ReactNode;
  /**
   * The website skin's header: in the brand's colour, as a clinic's widget
   * is (the default), or white with the avatar in the brand's colour, as the
   * homepage's AYA card is (owner, 12 October 2026: the solid red bar was the
   * heaviest thing on the page).
   */
  headerTone?: "brand" | "light";
}) {
  const [skin, setSkin] = useState<Skin>("website");
  const scrollRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const hydrated = useHydrated();
  const reduce = useMediaQuery(REDUCED_MOTION);
  // The greeting has no time of its own: it was said when the card opened.
  const [openedAt] = useState(() => Date.now());
  /** The thread has scrolled under the header, which then casts a shadow. */
  const [scrolled, setScrolled] = useState(false);
  /** The header's height, which the thread starts under. */
  const [headH, setHeadH] = useState<number | null>(null);
  /** A pressed suggestion, flying into the field. */
  const [flying, setFlying] = useState<string | null>(null);
  /**
   * The website's Send has turned into its paper plane: the first time the
   * visitor's words wake the button, once, and it stays the plane after
   * (owner, 12 October 2026: it folded on every hover). Set while rendering,
   * the moment there are words, so the fold starts with the button waking.
   */
  const [armed, setArmed] = useState(false);
  if (!armed && input.trim()) setArmed(true);
  const rail = useDragScroll();
  /** This card's names for the view transition, unique on the page. */
  const vt = `chat${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, skin, composer]);

  useEffect(() => {
    const el = headRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeadH(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const time = (at: number | undefined) =>
    hydrated ? new Date(at ?? openedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "";

  const onlyGreeting = messages.length === 1;
  const lastUser = messages.reduce((found, message, i) => (message.role === "user" ? i : found), -1);
  /** She has started on an answer to the visitor's last message: it was read. */
  const seen = lastUser >= 0 && messages.slice(lastUser + 1).some((message) => message.role === "assistant");
  const accent = ACCENT[skin];

  const send = () => {
    if (!input.trim() || streaming || disabled) return;
    onSend(input);
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    send();
  };
  const inputProps = {
    ref: inputRef,
    value: input,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => onInput(event.target.value),
    maxLength: 1000,
    disabled,
    "aria-label": `Message ${name}`,
  };
  const off = disabled ? disabledPlaceholder : undefined;

  /** Another app: one morphs into the next where the browser can (view transitions), at once where it cannot. */
  const switchSkin = (next: Skin) => {
    if (next === skin) return;
    if (typeof document.startViewTransition !== "function" || reduce) {
      setSkin(next);
      return;
    }
    const root = document.documentElement;
    root.classList.add("chat-morph");
    const run = document.startViewTransition(() => {
      flushSync(() => setSkin(next));
    });
    void run.finished.finally(() => root.classList.remove("chat-morph"));
  };

  /**
   * A suggestion pressed: a copy of it flies from the row into the field, its
   * words land there, and it sends. At once with reduced motion, or with the
   * email ask in the composer's place.
   */
  const fly = (event: React.MouseEvent<HTMLButtonElement>, chip: string) => {
    const chipEl = event.currentTarget;
    const field = inputRef.current;
    if (reduce || !field || typeof chipEl.animate !== "function" || flying) {
      onSend(chip);
      return;
    }
    const zoom = zoomOf(chipEl);
    const from = chipEl.getBoundingClientRect();
    const to = field.getBoundingClientRect();
    const ghost = chipEl.cloneNode(true) as HTMLElement;
    Object.assign(ghost.style, {
      position: "fixed",
      left: `${from.left / zoom}px`,
      top: `${from.top / zoom}px`,
      width: `${chipEl.offsetWidth}px`,
      height: `${chipEl.offsetHeight}px`,
      margin: "0",
      zIndex: "90",
      pointerEvents: "none",
    });
    document.body.appendChild(ghost);
    setFlying(chip);
    const dx = (to.left - from.left) / zoom + 6;
    const dy = (to.top + to.height / 2 - (from.top + from.height / 2)) / zoom;
    const tokens = getComputedStyle(document.documentElement);
    const animation = ghost.animate(
      [
        { transform: "translate(0, 0) scale(1)", opacity: 1 },
        { transform: `translate(${dx * 0.55}px, ${dy * 0.55 - 18}px) scale(1.04)`, opacity: 1, offset: 0.5 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.9)`, opacity: 0 },
      ],
      { duration: 560, easing: tokens.getPropertyValue("--ease-in-out").trim() || "ease-in-out" },
    );
    window.setTimeout(() => onInput(chip), 300);
    animation.onfinish = () => {
      ghost.remove();
      setFlying(null);
      onSend(chip);
    };
  };

  // ─── The four costumes ─────────────────────────────────────────────────────

  const header = {
    website:
      headerTone === "light" ? (
        <div className="text-ink flex items-center gap-2.5 px-4 py-3" data-tone="light">
          <Avatar name={name} logoUrl={logoUrl} size={34} filled />
          {/* The name alone: "We typically reply instantly" under it went
              (owner, 12 October 2026). */}
          <p className="min-w-0 truncate text-[15px] leading-tight font-semibold">{name}</p>
        </div>
      ) : (
        <div className="flex items-center gap-2.5 px-4 py-3" data-tone="brand" style={{ color: "var(--clinic-ink)" }}>
          <Avatar name={name} logoUrl={logoUrl} size={34} />
          <p className="min-w-0 truncate text-[15px] leading-tight font-semibold">{name}</p>
        </div>
      ),
    whatsapp: (
      <div className="flex items-center gap-2 px-2.5 py-2.5 text-white">
        <span className="[&_svg]:size-5">{Icon.back}</span>
        <Avatar name={name} logoUrl={logoUrl} size={36} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15.5px] leading-tight font-medium">{name}</p>
          <p className="truncate text-[12.5px] leading-tight opacity-85">{streaming ? "typing…" : "online"}</p>
        </div>
        <span className="flex gap-5 pr-1.5 [&_svg]:size-[21px]">
          {Icon.video}
          {Icon.phone}
        </span>
      </div>
    ),
    instagram: (
      <div className="flex items-center gap-2.5 px-3 py-2.5 text-black">
        <span className="[&_svg]:size-6">{Icon.back}</span>
        <Avatar name={name} logoUrl={logoUrl} size={30} ring />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] leading-tight font-semibold">{name}</p>
          <p className="truncate text-[12.5px] leading-tight text-[#737373]">{handleOf(name)}</p>
        </div>
        <span className="flex gap-5 pr-1 [&_svg]:size-[23px]">
          {Icon.phone}
          {Icon.video}
        </span>
      </div>
    ),
    messenger: (
      <div className="flex items-center gap-2.5 px-3 py-2.5" style={{ color: "#0a7cff" }}>
        <span className="[&_svg]:size-6">{Icon.back}</span>
        <span className="relative">
          <Avatar name={name} logoUrl={logoUrl} size={36} />
          <span className="absolute right-0 bottom-0 size-3 rounded-full border-2 border-white bg-[#31a24c]" />
        </span>
        <div className="min-w-0 flex-1 text-[#050505]">
          <p className="truncate text-[15.5px] leading-tight font-semibold">{name}</p>
          <p className="truncate text-[12.5px] leading-tight text-[#65676b]">Active now</p>
        </div>
        <span className="flex gap-5 pr-1 [&_svg]:size-[22px]">
          {Icon.phone}
          {Icon.video}
        </span>
      </div>
    ),
  }[skin];

  const surface: CSSProperties =
    skin === "whatsapp"
      ? {
          backgroundColor: "#efeae2",
          backgroundImage:
            "radial-gradient(rgb(0 0 0 / 0.045) 1px, transparent 1.2px), radial-gradient(rgb(0 0 0 / 0.03) 1px, transparent 1.2px)",
          backgroundSize: "22px 22px, 22px 22px",
          backgroundPosition: "0 0, 11px 11px",
        }
      : { background: "#ffffff" };

  /** Over the thread, each app's own way of saying when: a date pill, a time, "Today" and a time. */
  const opening =
    skin === "whatsapp" ? (
      <p className="mx-auto mb-1.5 w-fit rounded-sm bg-white/90 px-2.5 py-1 text-[11.5px] font-medium tracking-[0.02em] text-[#54656f] uppercase shadow-sm">Today</p>
    ) : skin === "instagram" ? (
      <p className="pb-1 text-center text-[11.5px] font-medium text-[#737373]">{hydrated ? `Today ${time(messages[0]?.at)}` : "Today"}</p>
    ) : skin === "messenger" ? (
      <p className="pb-1 text-center text-[11.5px] font-medium tracking-[0.04em] text-[#65676b] uppercase">{hydrated ? `Today at ${time(messages[0]?.at)}` : "Today"}</p>
    ) : null;

  /** Under the visitor's last message: each app's receipt, "Sent" until she starts answering. */
  function receipt(message: SkinMessage) {
    if (skin === "whatsapp") return null;
    if (skin === "messenger") {
      return seen ? (
        <div className="receipt-in flex justify-end pr-0.5">
          <span title="Seen">
            <Avatar name={name} logoUrl={logoUrl} size={14} />
          </span>
        </div>
      ) : (
        <p className="flex items-center justify-end gap-1 text-[11.5px] text-[#65676b]">
          <span className="grid size-3 place-items-center rounded-full border border-[#65676b] [&_svg]:size-2">{Icon.ticks}</span>
          Sent
        </p>
      );
    }
    if (skin === "instagram") {
      return <p className="receipt-in pr-1 text-right text-[11.5px] text-[#737373]">{seen ? "Seen" : "Sent"}</p>;
    }
    return (
      <p className="receipt-in pr-1 text-right text-[11.5px] font-medium text-[#8e8e93]">
        {seen ? "Seen" : "Sent"}
        {hydrated ? ` · ${time(message.at)}` : ""}
      </p>
    );
  }

  function bubble(message: SkinMessage, i: number) {
    const mine = message.role === "user";
    const typing = !mine && message.content === "";
    const prev = messages[i - 1];
    const firstOfRun = !prev || prev.role !== message.role;
    const live = streaming && i === messages.length - 1 && !mine;

    if (skin === "whatsapp") {
      // WhatsApp says "typing…" in its header and draws nothing in the chat
      // until the words arrive.
      if (typing) return null;
      const shape = firstOfRun ? (mine ? "rounded-sm rounded-tr-none" : "rounded-sm rounded-tl-none") : "rounded-sm";
      const className = `relative max-w-[82%] px-2.5 pt-1.5 pb-[18px] text-[14.6px] leading-[1.38] text-[#111b21] shadow-sm ${shape}`;
      // Grey ticks until she has started on an answer, blue once she has: read.
      const read = !mine || i < lastUser || seen;
      const stamp = (
        <span className="absolute right-2 bottom-1 flex items-center gap-0.5 text-[11px] text-[#667781]">
          {time(message.at)}
          {mine ? (
            <span className={`wa-ticks [&_svg]:h-[11px] [&_svg]:w-[16px] ${read ? "text-[#53bdeb]" : "text-[#8696a0]"}`}>{Icon.ticks}</span>
          ) : null}
        </span>
      );
      return (
        <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
          {mine ? (
            <div className={className} style={{ background: "#d9fdd3" }}>
              <span className="whitespace-pre-wrap">{message.content}</span>
              {stamp}
            </div>
          ) : (
            <AssistantBubble typing={false} streaming={live} className={`${className} min-w-[64px]`} style={{ background: "#ffffff" }} after={stamp}>
              {message.content}
            </AssistantBubble>
          )}
        </div>
      );
    }

    if (skin === "instagram" || skin === "messenger") {
      const ig = skin === "instagram";
      const shape = ig ? "rounded-md px-3.5 py-2 text-[15px] leading-[1.38]" : "rounded-md px-3 py-2 text-[15px] leading-[1.34]";
      return (
        <div className={`flex items-end gap-2 ${mine ? "justify-end" : "justify-start"}`}>
          {!mine ? <span className="w-7">{firstOfRun ? <Avatar name={name} logoUrl={logoUrl} size={28} /> : null}</span> : null}
          {mine ? (
            <p
              className={`max-w-[75%] whitespace-pre-wrap ${shape}`}
              style={ig ? { background: "linear-gradient(180deg,#a033ff,#6e3dff)", color: "#fff" } : { background: "#0a7cff", color: "#fff" }}
            >
              {message.content}
            </p>
          ) : (
            <AssistantBubble
              typing={typing}
              streaming={live}
              className={`max-w-[75%] ${shape}`}
              style={ig ? { background: "#efefef", color: "#000" } : { background: "#f0f0f0", color: "#050505" }}
            >
              {message.content}
            </AssistantBubble>
          )}
        </div>
      );
    }

    return (
      <div className={`flex items-end gap-2 ${mine ? "justify-end" : "justify-start"}`}>
        {!mine ? <Avatar name={name} logoUrl={logoUrl} size={26} /> : null}
        {mine ? (
          <p
            className="max-w-[82%] rounded-md rounded-br-sm px-3.5 py-2.5 text-[15.2px] leading-[1.45] whitespace-pre-wrap"
            style={{ background: "var(--clinic)", color: "var(--clinic-ink)" }}
          >
            {message.content}
          </p>
        ) : (
          <AssistantBubble
            typing={typing}
            streaming={live}
            className="text-ink max-w-[82%] rounded-md rounded-bl-sm bg-[#f1f1f1] px-3.5 py-2.5 text-[15.2px] leading-[1.45]"
          >
            {message.content}
          </AssistantBubble>
        )}
      </div>
    );
  }

  /** The card under an answer to a question about booking or deposits, once the answer is complete. */
  function card(message: SkinMessage, i: number) {
    if (message.role !== "assistant" || !message.content) return null;
    if (streaming && i === messages.length - 1) return null;
    const asked = messages[i - 1];
    const kind = asked?.role === "user" ? cardFor(asked.content) : null;
    if (!kind) return null;
    return (
      <div className="chat-card-in pl-9">{kind === "booking" ? <BookingCard accent={accent} /> : <DepositCard accent={accent} />}</div>
    );
  }

  const skinComposer = {
    website: (
      <form onSubmit={submit} className="flex items-center gap-2 border-t border-black/5 bg-white p-3">
        <input
          {...inputProps}
          placeholder={off ?? placeholder ?? `Message ${name}…`}
          className="border-line text-ink placeholder:text-muted min-w-0 flex-1 rounded-full border bg-white px-4 py-2.5 text-[16px] outline-none focus:border-[var(--clinic)]"
        />
        <button
          type="submit"
          disabled={disabled || streaming || !input.trim()}
          data-armed={armed || undefined}
          className="morph-btn morph-btn--once shrink-0 rounded-full px-5 py-2.5 text-[15.2px] font-bold transition-opacity disabled:opacity-45"
          style={{ background: "var(--clinic)", color: "var(--clinic-ink)" }}
        >
          <span className="morph-btn__label">Send</span>
          {/* The word folds into a paper plane as the visitor's first words
              wake the button, and it stays the plane (`armed`). */}
          <span aria-hidden className="morph-btn__icon morph-btn__icon--fly">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.5 2.5 10.6 13.4" />
              <path d="M21.5 2.5 14.6 21.4l-4-8-8-4z" />
            </svg>
          </span>
        </button>
      </form>
    ),
    whatsapp: (
      <form onSubmit={submit} className="flex items-center gap-2 px-2 py-2" style={{ background: "#f0f2f5" }}>
        <input
          {...inputProps}
          placeholder={off ?? "Message"}
          className="min-w-0 flex-1 rounded-full bg-white px-4 py-2.5 text-[15.5px] text-[#111b21] outline-none placeholder:text-[#667781]"
        />
        <button
          type="submit"
          disabled={disabled || streaming}
          aria-label="Send"
          className="grid size-11 shrink-0 place-items-center rounded-full text-white disabled:opacity-60 [&_svg]:size-[20px]"
          style={{ background: "#00a884" }}
        >
          {input.trim() ? Icon.send : Icon.mic}
        </button>
      </form>
    ),
    instagram: (
      <form onSubmit={submit} className="bg-white px-3 py-2.5">
        <div className="flex items-center gap-2 rounded-full bg-[#efefef] py-1.5 pr-3 pl-1.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-full text-white [&_svg]:size-[18px]" style={{ background: "#3797f0" }}>
            {Icon.camera}
          </span>
          <input
            {...inputProps}
            placeholder={off ?? "Message..."}
            className="min-w-0 flex-1 bg-transparent py-1 text-[15px] text-black outline-none placeholder:text-[#737373]"
          />
          {input.trim() ? (
            <button type="submit" disabled={disabled || streaming} className="text-[15px] font-semibold text-[#3797f0] disabled:opacity-50">
              Send
            </button>
          ) : (
            <span className="text-black [&_svg]:size-[22px]">{Icon.mic}</span>
          )}
        </div>
      </form>
    ),
    messenger: (
      <form onSubmit={submit} className="flex items-center gap-2.5 bg-white px-3 py-2.5" style={{ color: "#0a7cff" }}>
        <span className="[&_svg]:size-[22px]">{Icon.plus}</span>
        <span className="[&_svg]:size-[22px]">{Icon.camera}</span>
        <input
          {...inputProps}
          placeholder={off ?? "Aa"}
          className="min-w-0 flex-1 rounded-full bg-[#f0f2f5] px-4 py-2 text-[15px] text-[#050505] outline-none placeholder:text-[#65676b]"
        />
        <button type="submit" disabled={disabled || streaming || !input.trim()} aria-label="Send" className="disabled:opacity-40 [&_svg]:size-[22px]">
          {Icon.send}
        </button>
      </form>
    ),
  }[skin];

  return (
    <div className="flex h-[600px] flex-1 flex-col sm:h-[620px]" data-skin={skin}>
      {/* The boxes: where the same assistant answers. They change the look,
          never the conversation. The voice card's segmented control, with
          its white pill sliding under the box chosen (owner, 12 October
          2026). The highlight used to be carried from box to box by the view
          transition, which lifts what it carries above the page, so it slid
          over the other boxes' icons; the pill is the control's own, under
          them. */}
      <div className="border-line border-b px-2.5 pt-2.5 pb-2">
        <div
          className="voice-segments relative grid grid-cols-4 rounded-sm bg-black/[0.055] p-1"
          role="tablist"
          aria-label="Where patients can message you"
          style={{ ["--n" as string]: BOXES.length, ["--at" as string]: Math.max(0, BOXES.findIndex((box) => box.id === skin)) }}
        >
          <span aria-hidden className="voice-segments__pill" />
          {BOXES.map((box) => {
            const active = box.id === skin;
            return (
              <button
                key={box.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => switchSkin(box.id)}
                className="relative z-[1] flex flex-col items-center gap-1 rounded-sm px-1 py-1.5"
              >
                <span className="grid size-8 place-items-center rounded-sm [&_svg]:size-[18px]" style={{ background: box.badge, color: box.ink }}>
                  {box.icon}
                </span>
                <span className={`text-[12.6px] font-bold transition-colors duration-fast ${active ? "text-ink" : "text-muted hover:text-ink"}`}>{box.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col" style={{ ["--chat-head" as string]: `${headH ?? 60}px` }}>
        {/* Frosted glass over the thread, shadowed once the thread runs under it. */}
        <div
          ref={headRef}
          className="chat-head absolute inset-x-0 top-0 z-10"
          data-skin={skin}
          data-scrolled={scrolled || undefined}
          style={{ viewTransitionName: `${vt}-head`, ["viewTransitionClass" as string]: "chat-morph" }}
        >
          {header}
        </div>

        <div
          ref={scrollRef}
          onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 2)}
          className={`scroll-subtle min-h-0 flex-1 overflow-y-auto px-3 pt-[calc(var(--chat-head)+14px)] pb-4 ${skin === "whatsapp" ? "space-y-1.5" : "space-y-2"}`}
          style={{ ...surface, viewTransitionName: `${vt}-body`, ["viewTransitionClass" as string]: "chat-morph" }}
          aria-live="polite"
        >
          {opening}
          {skin === "whatsapp" ? (
            <p className="mx-auto mb-2 w-fit rounded-sm bg-[#ffeecd] px-3 py-1.5 text-center text-[12px] text-[#54656f] shadow-sm">
              {aiNotice}
            </p>
          ) : null}
          {messages.map((message, i) => (
            <Fragment key={i}>
              {bubble(message, i)}
              {i === lastUser ? receipt(message) : null}
              {card(message, i)}
            </Fragment>
          ))}
        </div>
      </div>

      {/* The suggestions: a row that swipes sideways over the composer. */}
      {onlyGreeting && !disabled && chips.length > 0 && !composer ? (
        <div className="chip-rail border-t border-black/5 bg-white py-2.5" aria-label="Suggested questions">
          <div {...rail} className="chip-rail__track flex gap-2 overflow-x-auto px-3">
            {chips.map((chip) => (
              <button
                key={chip}
                type="button"
                onClick={(event) => fly(event, chip)}
                className={`chip-rail__chip border-line hover:border-line-strong text-ink shrink-0 rounded-full border bg-white px-3.5 py-1.5 text-[13.8px] font-semibold whitespace-nowrap transition-colors ${flying === chip ? "invisible" : ""}`}
              >
                {chip}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="text-red-deep bg-white px-4 py-2 text-[14.4px] font-semibold" role="alert">
          {error}
        </p>
      ) : null}

      <div style={{ viewTransitionName: `${vt}-compose`, ["viewTransitionClass" as string]: "chat-morph" }}>{composer ?? skinComposer}</div>
      {footnote}
    </div>
  );
}
