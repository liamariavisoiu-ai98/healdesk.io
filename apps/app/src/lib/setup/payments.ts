import type { Channel } from "@healdesk/catalog";

/**
 * Setup 2.4's payment account (plan Part E): a package with a chat channel
 * may connect its Stripe account from the deposits screen, and "Do it later
 * in Settings → Payments" is the default, because the deposit itself never
 * waits on it: until an account is connected AYA books and flags each
 * deposit for the team. Voice alone cannot take a card, so it is not offered
 * there (spec, "Card numbers are never taken": voice books and flags).
 *
 * The button is the Settings card's own route, /api/connect/stripe/start,
 * with `from=setup`: it asks for a passkey step-up (connecting a payment
 * account is a sensitive change, Part D4), sends the browser to Stripe, and
 * Stripe's return lands on /c/<slug>/setup?connect=ok|declined|failed, which
 * opens this screen again with the outcome (lib/billing/connect.ts,
 * connectReturnPath).
 *
 * Pure: the page reads the facts.
 */

export type ConnectOutcome = "ok" | "declined" | "failed";

/** The `?connect=` Stripe's return writes, or null for anything else. */
export function readConnectOutcome(value: unknown): ConnectOutcome | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "ok" || raw === "declined" || raw === "failed" ? raw : null;
}

/** What each return says, as Settings → Payments says it. */
export const CONNECT_OUTCOME_WORDS: Readonly<
  Record<ConnectOutcome, { text: string; ok: boolean }>
> = {
  ok: { text: "Your Stripe account is connected.", ok: true },
  declined: {
    text: "Stripe wasn't connected: it was declined on Stripe's page. Connect it here or later in Settings → Payments.",
    ok: false,
  },
  failed: {
    text: "We couldn't connect your Stripe account. Try again, do it later in Settings → Payments, or email hello@healdesk.io.",
    ok: false,
  },
};

export type SetupStripeView = {
  /** A chat channel was bought: the only channels that can send a payment link. */
  offered: boolean;
  isConnected: boolean;
  /** Connect is configured on this host, so the button can work. */
  available: boolean;
  /** The Settings card's start route, returning to setup. */
  href: string;
  outcome: { text: string; ok: boolean } | null;
};

export function setupStripeView(input: {
  slug: string;
  channels: readonly Channel[];
  isConnected: boolean;
  connectConfigured: boolean;
  outcome: ConnectOutcome | null;
}): SetupStripeView {
  return {
    offered: input.channels.includes("web") || input.channels.includes("meta"),
    isConnected: input.isConnected,
    available: input.connectConfigured,
    href: `/api/connect/stripe/start?clinic=${encodeURIComponent(input.slug)}&from=setup`,
    outcome: input.outcome ? CONNECT_OUTCOME_WORDS[input.outcome] : null,
  };
}

/** The deposits screen's first line: how a deposit is collected on what the clinic bought. */
export function depositCollectionLine(input: {
  channels: readonly Channel[];
  isConnected: boolean;
}): string {
  const chat = input.channels.includes("web") || input.channels.includes("meta");
  const voice = input.channels.includes("voice");
  if (!chat) {
    return "On a call AYA can't take a card, so she books the appointment and flags the deposit for your team to collect.";
  }
  if (input.isConnected) {
    return voice
      ? "In chat AYA sends a secure link to pay the deposit into your Stripe account. On a call she can't take a card, so she books and flags it for your team."
      : "In chat AYA sends a secure link to pay the deposit into your Stripe account.";
  }
  return "Until a payment account is connected, AYA books the appointment and flags the deposit for your team to collect.";
}
