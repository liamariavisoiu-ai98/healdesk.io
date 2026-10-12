"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import {
  HERO_LOGOS,
  LABEL,
  ORBIT_CENTRE,
  ORBITS,
  PHOTO,
  onOrbit,
  pointOnOrbit,
  showcaseText,
  storyOrder,
  type HeroLogo,
  type LogoGroup,
  type Orbit,
} from "@/lib/integrations";
import { HeroScene } from "@/components/HeroScenes";
import { REDUCED_MOTION, useMediaQuery } from "@/lib/use-media-query";

/**
 * The hero's picture: AYA, smiling, in the healdesk headset, and the logos of
 * the tools she works through on three orbits round her. The logos, their
 * orbits, what each shows and their trademark line are in
 * lib/integrations.ts; the sizes and the motion are in globals.css under
 * "The hero portrait", and the white veil that rises over the photo is
 * HeroStage's.
 *
 * ## The photo
 *
 * The owner's of 9 October 2026: 1672×941, shown as composed, her face a
 * little right of centre. Every place is a share of that box, so the
 * composition is the same at every size.
 *
 * ## Three orbits, and the chips that fan out (the owner's pick, 9 October)
 *
 * Three concentric circles ring her head (the owner asked on 12 October 2026
 * for true circles; they were ovals): Messages & Calls (website chat,
 * Instagram, Messenger, WhatsApp and her phone line) down the wall on her
 * left; on the right the inner circle carries Bookings (Google Calendar) and,
 * after it, the calendars synced with Google; Payments is low on the right. Each
 * circle is drawn whole and faint, so three rings read as three rings, with
 * its group's stretch lit from a chip with its title, and as the page opens
 * the logos fan out of their chip along the circle to their places,
 * then drift gently along it. Resting on a chip, or focusing it, lights its
 * orbit, dims the other two, spreads its logos a little and plays their
 * cards in turn; resting on a logo, focusing it or tapping it plays its own.
 * Below 1280px there is no room for orbits beside the copy, so the logos keep
 * their places on the photo and the chips are a row under it.
 *
 * Cal.com, Calendly and HighLevel are there as calendars that read Google's,
 * never as ones she writes into: v1 writes bookings to the clinic's Google
 * Calendar and nothing else. Since 12 October 2026 (owner) they are their own
 * group under a "Synced with Google" chip rather than part of Bookings, and
 * their cards say the slot came from Google and was blocked, while Google
 * Calendar's says a consultation was booked (docs/v1-product-spec.md,
 * "Where bookings are written"). Stripe is the gateway a clinic connects to
 * take deposits in chat.
 *
 * ## Motion
 *
 * Away from the hero the logos rest (see useResting), and the operating
 * system's reduce-motion setting stills them in their places.
 */

/**
 * Whether the logos may rest: more than a screen from the viewport and not
 * being headed back to.
 *
 * The hero is the top of the page, so heading back is going up. Any scroll
 * upwards wakes them at once, however far down, and so do the keys that jump
 * up a page or to the top, on the key press, before the first frame of the
 * scroll they start. A screen of margin means a reader on the way back finds
 * them already moving. An upward nudge that stops for two seconds while
 * still out of reach was not a way back, and they rest again.
 */
const OUT_OF_REACH = "100% 0px";
const INTENT_LAPSES_MS = 2000;

function useResting(target: RefObject<HTMLElement | null>) {
  const [resting, setResting] = useState(false);

  useEffect(() => {
    const el = target.current;
    if (!el || typeof IntersectionObserver === "undefined") return;

    let inReach = true;
    let headingBack = false;
    let lastY = window.scrollY;
    let lapse: ReturnType<typeof setTimeout> | undefined;

    const sync = () => setResting(!inReach && !headingBack);
    const headBack = () => {
      headingBack = true;
      clearTimeout(lapse);
      lapse = setTimeout(() => {
        headingBack = false;
        sync();
      }, INTENT_LAPSES_MS);
      sync();
    };

    const observer = new IntersectionObserver(
      (entries) => {
        // A batch can hold more than one change; the last is where it is now.
        const latest = entries[entries.length - 1];
        if (!latest) return;
        inReach = latest.isIntersecting;
        sync();
      },
      { rootMargin: OUT_OF_REACH },
    );
    const onScroll = () => {
      const y = window.scrollY;
      if (y < lastY) headBack();
      else if (y > lastY && headingBack) {
        headingBack = false;
        clearTimeout(lapse);
        sync();
      }
      lastY = y;
    };
    const onKey = (event: KeyboardEvent) => {
      const toTop = event.key === "ArrowUp" && (event.metaKey || event.ctrlKey);
      if (event.key === "Home" || event.key === "PageUp" || toTop) headBack();
    };

    observer.observe(el);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("keydown", onKey);
      clearTimeout(lapse);
    };
  }, [target]);

  return resting;
}

/** A logo's size on the photo, in its pixels, from 1280px: 5% of its width. */
const LOGO_PX = 0.05 * PHOTO.width;

/** Seconds for one drift along the orbit and back, by orbit: the outer ones slower. */
const ORBIT_TIME: Record<LogoGroup, number> = { messages: 12, bookings: 16, synced: 16, payments: 20 };
/** How far each way along its orbit a logo drifts, in degrees. */
const DRIFT_DEGREES = 3;
/**
 * How long each card shows while a chip plays its group's in turn: long
 * enough for its scene (HeroScenes.tsx) to play through, about two seconds,
 * and be read. They were 1.6s and 2.6s while a card was two lines of text.
 */
const CARD_MS = 3200;
/** Between the cards the hero plays on its own, once the logos have fanned out. */
const AUTOPLAY_MS = 3600;
const FIRST_CARD_MS = 2400;
/** How long after a visitor lets go of a logo or a chip the cards stay theirs. */
const RESUME_MS = 4000;
const STORY = storyOrder();

function toPx(at: { x: number; y: number }) {
  return { x: (at.x / 100) * PHOTO.width, y: (at.y / 100) * PHOTO.height };
}

/** The custom properties that place a logo and drive its motion, in shares of its own size. */
function motion(logo: HeroLogo, orbit: Orbit, i: number) {
  const here = toPx(logo.at);
  const chip = toPx(onOrbit(orbit.group, orbit.chip));
  const ahead = toPx(onOrbit(orbit.group, logo.angle + DRIFT_DEGREES));
  const out = { x: here.x - ORBIT_CENTRE.x, y: here.y - ORBIT_CENTRE.y };
  const length = Math.hypot(out.x, out.y);
  const fixed = (n: number) => n.toFixed(3);
  return {
    ["--x" as string]: `${logo.at.x}%`,
    ["--y" as string]: `${logo.at.y}%`,
    // From the chip, for the fan as the page opens.
    ["--fx" as string]: fixed((chip.x - here.x) / LOGO_PX),
    ["--fy" as string]: fixed((chip.y - here.y) / LOGO_PX),
    // Along the orbit, for the drift.
    ["--tx" as string]: fixed((ahead.x - here.x) / LOGO_PX),
    ["--ty" as string]: fixed((ahead.y - here.y) / LOGO_PX),
    // Out from the centre, for the spread when its chip is active.
    ["--ux" as string]: fixed(out.x / length),
    ["--uy" as string]: fixed(out.y / length),
    ["--i" as string]: i,
    ["--orbit-time" as string]: `${ORBIT_TIME[orbit.group]}s`,
  };
}

/** An orbit's drawn stretch, from its chip to its tail, in the photo's pixels. */
function arcPath(orbit: Orbit) {
  const from = pointOnOrbit(orbit.group, orbit.chip);
  const to = pointOnOrbit(orbit.group, orbit.tail);
  const sweep = orbit.tail > orbit.chip ? 1 : 0;
  const large = Math.abs(orbit.tail - orbit.chip) > 180 ? 1 : 0;
  return { from, to, d: `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} A ${orbit.r} ${orbit.r} 0 ${large} ${sweep} ${to.x.toFixed(1)} ${to.y.toFixed(1)}` };
}

const capital = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

export function HeroPortrait({ autoplay = false }: { autoplay?: boolean }) {
  const stage = useRef<HTMLDivElement>(null);
  const resting = useResting(stage);
  const wide = useMediaQuery("(min-width: 1280px)");
  const reduce = useMediaQuery(REDUCED_MOTION);
  /** The logo whose card shows, from a hover, a focus or a tap. */
  const [picked, setPicked] = useState<string | null>(null);
  /** The chip being rested on or focused, whose group's cards play in turn. */
  const [group, setGroup] = useState<LogoGroup | null>(null);
  const [turn, setTurn] = useState(0);
  /** The card the hero is playing on its own. */
  const [auto, setAuto] = useState<string | null>(null);
  const busy = useRef(false);
  const holdUntil = useRef(0);

  useEffect(() => {
    if (!group) return;
    const id = window.setInterval(() => setTurn((n) => n + 1), CARD_MS);
    return () => window.clearInterval(id);
  }, [group]);

  // Whether a visitor has hold of a card, for the timer below to read.
  useEffect(() => {
    busy.current = picked !== null || group !== null;
  });

  /**
   * The cards play themselves while the hero is the first thing on screen:
   * from 1280px, with motion allowed, in reach, and while the copy is still
   * down (`autoplay`; a card over the headline would be in its way). A
   * visitor's hover, focus, tap or chip takes over at once, and the hero
   * waits RESUME_MS after they let go. A hidden tab plays nothing.
   */
  const playing = autoplay && wide && !reduce && !resting;
  useEffect(() => {
    if (!playing) return;
    let step = 0;
    let timer: number;
    const tick = () => {
      if (busy.current || Date.now() < holdUntil.current || document.hidden) {
        setAuto(null);
      } else {
        setAuto(STORY[step % STORY.length] ?? null);
        step += 1;
      }
      timer = window.setTimeout(tick, AUTOPLAY_MS);
    };
    timer = window.setTimeout(tick, FIRST_CARD_MS);
    return () => {
      window.clearTimeout(timer);
      setAuto(null);
    };
  }, [playing]);

  const members = group ? HERO_LOGOS.filter((logo) => logo.group === group) : [];
  const shown = group ? (members[turn % members.length]?.name ?? null) : (picked ?? (playing ? auto : null));
  const lit = group ?? HERO_LOGOS.find((logo) => logo.name === shown)?.group;

  /** A visitor took hold of a card, or let go: the hero's own turn is over for now. */
  const took = useCallback(() => {
    holdUntil.current = Date.now() + RESUME_MS;
    setAuto(null);
  }, []);

  /** Start a chip's group from its first card, or stop it. */
  const play = useCallback(
    (next: LogoGroup | null) => {
      took();
      setTurn(0);
      setGroup(next);
    },
    [took],
  );
  const setShown = useCallback(
    (next: string | null | ((current: string | null) => string | null)) => {
      took();
      setGroup(null);
      setPicked(next);
    },
    [took],
  );

  const hover = useCallback(
    (event: React.PointerEvent, name: string | null) => {
      // A touch is a tap, handled by the click; only a mouse or a pen hovers.
      if (event.pointerType === "touch") return;
      setShown(name);
    },
    [setShown],
  );

  return (
    <>
      <div ref={stage} role="group" aria-label={LABEL} className="portrait" data-paused={resting || undefined} data-group={group ?? undefined} data-lit={lit}>
        <img
          src="/brand/aya-hero.webp"
          alt=""
          width={PHOTO.width}
          height={PHOTO.height}
          fetchPriority="high"
          draggable={false}
          className="portrait__photo"
        />

        {/* The orbits' drawn stretches: a dark line under a white one, so
            each reads on the white wall and on her hair alike, fading out
            toward its tail. */}
        <svg className="portrait__orbits" viewBox={`0 0 ${PHOTO.width} ${PHOTO.height}`} preserveAspectRatio="none" aria-hidden>
          <defs>
            {ORBITS.map((orbit) => {
              const { from, to } = arcPath(orbit);
              return (
                <linearGradient key={orbit.group} id={`orbit-fade-${orbit.group}`} gradientUnits="userSpaceOnUse" x1={from.x} y1={from.y} x2={to.x} y2={to.y}>
                  <stop offset="0" stopColor="#fff" stopOpacity="0.95" />
                  <stop offset="0.75" stopColor="#fff" stopOpacity="0.7" />
                  <stop offset="1" stopColor="#fff" stopOpacity="0" />
                </linearGradient>
              );
            })}
          </defs>
          {ORBITS.map((orbit, i) => {
            const { d } = arcPath(orbit);
            // A circle two groups share is drawn once, with the first.
            const ring = ORBITS.findIndex((o) => o.r === orbit.r) === i;
            return (
              <g key={orbit.group} className="portrait__orbit" data-group={orbit.group}>
                {ring ? (
                  <circle cx={ORBIT_CENTRE.x} cy={ORBIT_CENTRE.y} r={orbit.r} pathLength={1} className="portrait__ring" vectorEffect="non-scaling-stroke" />
                ) : null}
                <path d={d} pathLength={1} className="portrait__orbit-shade" vectorEffect="non-scaling-stroke" />
                <path d={d} pathLength={1} className="portrait__orbit-line" stroke={`url(#orbit-fade-${orbit.group})`} vectorEffect="non-scaling-stroke" />
              </g>
            );
          })}
        </svg>

        <ul className="portrait__logos">
          {HERO_LOGOS.map((logo, i) => {
            const orbit = ORBITS.find((o) => o.group === logo.group)!;
            const isShown = shown === logo.name;
            return (
              <li
                key={logo.name}
                className="portrait__node"
                data-group={logo.group}
                data-shown={isShown || undefined}
                // Where its card opens: above, for the logo nearest the
                // photo's right edge; and below 1280px, inwards for every
                // logo on her right, where a card opening outwards would
                // leave the screen.
                data-card={logo.card}
                data-side={logo.at.x > 50 ? "right" : "left"}
                style={motion(logo, orbit, i)}
              >
                <span className="portrait__fan">
                  <span className="portrait__spread">
                    <span className="portrait__drift">
                      <button
                        type="button"
                        className="portrait__tile"
                        aria-label={showcaseText(logo)}
                        onPointerEnter={(event) => hover(event, logo.name)}
                        onPointerLeave={(event) => hover(event, null)}
                        onFocus={() => setShown(logo.name)}
                        onBlur={() => setShown((current) => (current === logo.name ? null : current))}
                        onClick={() => setShown((current) => (current === logo.name ? null : logo.name))}
                      >
                        <img src={logo.src} alt="" width={192} height={192} decoding="async" draggable={false} className="portrait__logo" />
                      </button>
                    </span>
                    {/* Said by the button's own name; drawn here for the eye. */}
                    <span className="portrait__card" data-scene={logo.scene} aria-hidden>
                      <span className="portrait__card-name">{capital(logo.name)}</span>
                      <HeroScene logo={logo} />
                    </span>
                  </span>
                </span>
              </li>
            );
          })}
        </ul>

        {/* The chips, at the head of each orbit. */}
        <div className="portrait__chips">
          {ORBITS.map((orbit) => {
            const at = onOrbit(orbit.group, orbit.chip);
            const own = HERO_LOGOS.filter((logo) => logo.group === orbit.group);
            return (
              <button
                key={orbit.group}
                type="button"
                className="portrait__chip"
                data-group={orbit.group}
                aria-pressed={group === orbit.group}
                aria-label={`${orbit.title}: ${own.map((logo) => logo.name).join(", ")}. Show what each does.`}
                style={{ ["--x" as string]: `${at.x}%`, ["--y" as string]: `${at.y}%` }}
                onPointerEnter={(event) => event.pointerType !== "touch" && play(orbit.group)}
                onPointerLeave={(event) => event.pointerType !== "touch" && play(null)}
                onFocus={() => play(orbit.group)}
                onBlur={() => play(null)}
                onClick={() => play(group === orbit.group ? null : orbit.group)}
              >
                <Minis logos={own} />
                <span>{orbit.title}</span>
                <span className="portrait__chip-count">{own.length}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Below 1280px: the groups as a row under the photo. */}
      <ul className="portrait__legend" aria-hidden>
        {ORBITS.map((orbit) => (
          <li key={orbit.group} className="portrait__chip portrait__chip--static">
            <Minis logos={HERO_LOGOS.filter((logo) => logo.group === orbit.group)} />
            <span>{orbit.title}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Minis({ logos }: { logos: readonly HeroLogo[] }) {
  return (
    <span className="portrait__minis" aria-hidden>
      {logos.slice(0, 3).map((logo) => (
        <img key={logo.name} src={logo.src} alt="" width={40} height={40} />
      ))}
    </span>
  );
}
