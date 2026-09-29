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
  call_requested: [],
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
  // /get-started/done is the one page where a completed purchase, a clinic
  // name and a specialty coexist; /admin is the operator's console.
  return pathname.startsWith("/get-started/done") || pathname.startsWith("/admin");
}
