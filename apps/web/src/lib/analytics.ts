/**
 * Funnel analytics, with a closed vocabulary.
 *
 * ## The rule, written into code rather than a doc
 *
 * No advertising pixel, tag manager or conversion tag may ever be added to
 * apps/web, and no event may carry chat text, an email address, a phone
 * number or a clinic's patient-facing content. Sending person-level
 * conversion data to Meta or Google from a health site is the GoodRx /
 * BetterHelp fact pattern ($1.5M and $7.8M). See docs/architecture.md → "No
 * conversion attribution to ad platforms". Ad-channel measurement, when it is
 * wanted, uses Stripe's own reporting keyed on the client_reference_id the
 * checkout already sets — the money event is server-side and never needs to
 * leave for a third party.
 *
 * Two mechanisms enforce it here:
 *
 *   1. `EVENTS` is the only set of names `track()` accepts, and each carries
 *      an allowlist of property keys. Anything else is dropped before it
 *      reaches the vendor. A lead id is the join key for everything else —
 *      join server-side in the marketing database, never in the browser.
 *   2. The vendor client is created only by PostHogProvider, only after the
 *      visitor accepted the cookie notice, and only when a project key is
 *      present. `track()` before any of that is a no-op, never an error.
 *
 * The vendor is PostHog, chosen because it has no advertising integration to
 * switch on by accident, signs a DPA, and can run without cookies until
 * consent. It runs on PostHog's US cloud because the client base is US (the
 * EU cloud until 23 September 2026; nothing about what is sent changed).
 */

type Primitive = string | number | boolean;

export const EVENTS = {
  demo_gate_viewed: [],
  demo_unlocked: ["consent"],
  demo_message_sent: ["turn"],
  claim_started: ["campaign", "has_website"],
  claim_completed: ["branch"],
  pricing_viewed: ["interval"],
  why_wait_viewed: [],
  client_error: ["digest"],
  checkout_started: ["plan", "interval"],
  checkout_step: ["step", "plan", "interval"],
  contact_submitted: [],
  setup_requested: ["has_website"],
  call_requested: [],
  // The homepage's "See it in your own branding": a demo of their own asked
  // for. Never the website or the address typed, only that it happened.
  own_demo_requested: [],
  // "Get in touch": the Calendly modal opened, and a call booked in it. The
  // booking's own payload names the invitee and never leaves GetInTouch.tsx.
  meeting_opened: [],
  meeting_booked: [],
} as const satisfies Record<string, readonly string[]>;

export type EventName = keyof typeof EVENTS;

/** Minimal shape of the client we need; keeps posthog-js out of this module's types. */
export type AnalyticsClient = {
  capture: (event: string, properties?: Record<string, Primitive>) => unknown;
};

let client: AnalyticsClient | null = null;

/** Called once by PostHogProvider after consent. Idempotent. */
export function attachAnalyticsClient(next: AnalyticsClient | null): void {
  client = next;
}

export function isAnalyticsActive(): boolean {
  return client !== null;
}

/** Keep only allowlisted keys with primitive values. Never strings that look like contact details. */
export function sanitize(
  event: EventName,
  props: Record<string, unknown> | undefined,
): Record<string, Primitive> {
  const out: Record<string, Primitive> = {};
  if (!props) return out;
  const allowed = EVENTS[event] as readonly string[];
  for (const key of allowed) {
    const value = props[key];
    if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (typeof value === "string" && value.length <= 64 && !looksLikeContact(value)) {
      out[key] = value;
    }
  }
  return out;
}

function looksLikeContact(value: string): boolean {
  return /@/.test(value) || /\+?\d[\d\s().-]{7,}\d/.test(value);
}

export function track(event: EventName, props?: Record<string, unknown>): void {
  if (!(event in EVENTS)) return;
  const clean = sanitize(event, props);
  // First-party mirror (app/api/track): recorded against the lead only when
  // the demo gate has identified one, and independent of the cookie notice —
  // it is our own record of our own funnel, not a third party's. The server
  // answers 204 and records nothing for anonymous visitors.
  if (typeof window !== "undefined" && typeof fetch === "function") {
    try {
      void fetch("/api/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, props: clean }),
        keepalive: true,
        credentials: "same-origin",
      }).catch(() => {});
    } catch {
      // Never break a page over instrumentation.
    }
  }
  if (!client) return;
  try {
    client.capture(event, clean);
  } catch {
    // Analytics must never break a page.
  }
}

/** Paths where no third-party script may run, consent or not. */
export function isAnalyticsExcludedPath(pathname: string): boolean {
  // /admin is the operator's console. /demo/ carries a personalised demo's
  // slug in its URL, and the slug is the only key to that demo: a recorded
  // pageview would hand a vendor a working link. The purchase-complete page
  // is /welcome, a route handler that renders outside the layout, so no
  // vendor script ever loads there.
  return pathname.startsWith("/admin") || pathname.startsWith("/demo/");
}

/**
 * Pages whose query string never reaches the vendor (plan Part A2: "PostHog
 * strips query strings on /get-started"). Their links carry `?lead=` (a lead
 * id, the join key to a person's row), `?link=`, `?plan=`, `?cancelled=` and
 * `?c=` (a campaign), and /start and /welcome carry a setup token and a
 * purchase ref, should either ever appear as a referrer.
 */
const QUERY_FREE_PATHS = ["/get-started", "/start", "/welcome"] as const;

function queryFreePath(pathname: string): boolean {
  return QUERY_FREE_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/** An absolute URL on one of those pages, without its query string and fragment; anything else as it was. */
export function scrubUrl(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    if (!queryFreePath(url.pathname) || (!url.search && !url.hash)) return value;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

type Props = Record<string, unknown>;

function scrubProps(props: Props | undefined): Props | undefined {
  if (!props) return props;
  const out: Props = {};
  for (const [key, value] of Object.entries(props)) out[key] = typeof value === "string" ? scrubUrl(value) : value;
  return out;
}

/**
 * PostHog's `before_send`: every URL-valued property of the event and of the
 * person properties it sets (`$current_url`, `$referrer`,
 * `$initial_current_url`, `$session_entry_url` and the rest) loses the query
 * string on the pages above. Pure, so it is tested without the vendor.
 */
export function scrubEvent<T extends { properties: Props; $set?: Props; $set_once?: Props }>(event: T | null): T | null {
  if (!event) return event;
  return {
    ...event,
    properties: scrubProps(event.properties) ?? {},
    ...(event.$set ? { $set: scrubProps(event.$set) } : {}),
    ...(event.$set_once ? { $set_once: scrubProps(event.$set_once) } : {}),
  };
}
