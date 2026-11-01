import { createHmac, timingSafeEqual } from "node:crypto";

import { isSpecialtyId, type SpecialtyId } from "./specialties";

/**
 * A personalised demo call, run on AYA's own engine (owner, 24 October 2026:
 * "the demo AYAs and the client AYA should be THE SAME, only difference should
 * be the start").
 *
 * apps/web starts the call at Retell with the demo engine agent, whose
 * custom-LLM socket is apps/app's voice endpoint at `/llm-websocket/<secret>/
 * demo`, and hands this context over as one Retell dynamic variable
 * (DEMO_CALL_VARIABLE), sealed with HEALDESK_PROVISION_SECRET, which both apps
 * hold. apps/app reads it from Retell's call details, opens it, and answers
 * with the same turn pipeline a clinic's patients get (prompt, guard, urgent
 * screen, fillers), from this context instead of the database, keeping
 * nothing. The only differences are the start (greet the person who asked
 * for the demo by name, say what AYA can do for their clinic, offer a
 * role-play) and that nothing is written anywhere.
 *
 * What it carries is business data: the clinic's own published website as
 * the demo read it, the requester's first name, the demo's slug, and, when
 * one is genuinely live, the time-limited setup-fee discount the demo
 * carries (packages/catalog/src/plans.ts; apps/web computes it from the
 * demo's own row, never invented downstream), and whether an operator signed
 * in to /admin started it (`test`). Never a patient's.
 */

export const DEMO_CALL_VARIABLE = "demo_context";
/** The last path segment of the demo engine agent's socket, where a clinic's id would be. */
export const DEMO_CALL_PATH = "demo";
/** How long a sealed context opens: a call starts within seconds of it, and a phone call-back rings within a minute. */
export const DEMO_CALL_MAX_AGE_MS = 2 * 60 * 60_000;

export type DemoCallMode = "browser" | "phone" | "inbound";

export type DemoCallService = { name: string; description: string | null; price: string | null; duration: string | null };

/**
 * Which of the clinic's values the demo made up because its public pages did
 * not show them (apps/web lib/demo/samples.ts, owner, 1 November 2026): the
 * services whose price is a typical US price, and whether the menu, the
 * opening hours and the deposit rule are samples. The demo page lists the
 * same items in its "Made up for this demo" note.
 */
export type DemoCallSampled = { prices: string[]; menu: boolean; hours: boolean; deposit: boolean };

export type DemoCallClinic = {
  clinicName: string;
  summary: string | null;
  specialty: SpecialtyId | null;
  phone: string | null;
  address: string | null;
  hours: { days: string; hours: string }[];
  services: DemoCallService[];
  providers: { name: string; title: string | null }[];
  faqs: { question: string; answer: string }[];
  policies: string[];
  booking: string | null;
  highlights: string[];
  /** What the demo made up; absent on a context sealed before it existed. */
  sampled?: DemoCallSampled;
};

/**
 * A live setup-fee discount, real and server-computed: the percentage off
 * (DEMO_SETUP_CREDIT 50%, SELF_SERVE_DEMO_SETUP_CREDIT 30%, plans.ts) and
 * when it ends, epoch milliseconds. apps/web seals it only while it is still
 * live by its own clock; apps/app checks the clock again at call time
 * (demo-facts.ts), since a call can start minutes after the context was
 * sealed. Never a specific dollar figure: healdesk's own prices are not on
 * the menu the guard checks, so a call never states one.
 */
export type DemoCallOffer = { percentOfSetupFee: number; endsAt: number };

export type DemoCallContext = {
  v: 1;
  slug: string;
  mode: DemoCallMode;
  /** The requester's first name as they typed it on the demo page; null when not given. */
  firstName: string | null;
  issuedAt: number;
  clinic: DemoCallClinic;
  /** The demo's live setup-fee discount, or null when none applies or it has ended. */
  offer: DemoCallOffer | null;
  /**
   * Started by a healdesk operator signed in to /admin, testing (owner,
   * 25 October 2026: "for our test demos right now, the client is always
   * hello@healdesk.io"): only then does the call's transcript go to hello@
   * when it ends, as a clinic's goes to the clinic. A prospect's demo call
   * keeps no transcript (the Privacy page). Sealed, so no caller can set it.
   */
  test: boolean;
  /**
   * The buy button the demo page shows the requester, as labelled there
   * ("Book Onboarding" on a demo an operator built, "Get AYA" on one asked
   * for on the homepage), each opening checkout with the demo's discount
   * applied; null where the page shows none (a demo already bought). What
   * Aya closes on (owner, 25 October 2026: "the absolute best closer"),
   * since she can send nothing herself.
   */
  buyButton: string | null;
};

/**
 * The call back Aya offers a hesitant clinic owner on a demo call, word for
 * word (owner, 26 October 2026), and the version apps/web records beside the
 * number in its consent row (apps/web lib/demo/callbacks.ts). One string for
 * both, so the record shows the words the owner actually heard: apps/app's
 * demo note tells her to say exactly this (lib/voice/demo-facts.ts). Bump the
 * version whenever the words change, in the same commit.
 *
 * The call it offers is a person on the team ringing a business number its
 * owner gave and asked to be called on, not an automated or AI call.
 */
export const DEMO_CALLBACK_OFFER = {
  version: "2026-10-26.1",
  text: "No problem at all. Want someone from our team to give you a quick call? What's the best number to reach you on?",
} as const;

export const DEMO_CALL_LIMITS = {
  services: 40,
  providers: 15,
  faqs: 20,
  policies: 12,
  highlights: 8,
  hours: 10,
  text: 600,
  name: 40,
  slug: 120,
  /** The sealed token: well inside what a Retell dynamic variable carries. */
  sealed: 60_000,
} as const;

const MODES: readonly DemoCallMode[] = ["browser", "phone", "inbound"];

function text(value: unknown, max: number = DEMO_CALL_LIMITS.text): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

function list<T>(value: unknown, max: number, each: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const item of value) {
    if (out.length >= max) break;
    const parsed = each(item);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A first name as a person types it: letters, spaces, apostrophes and hyphens, at most DEMO_CALL_LIMITS.name; null otherwise. */
export function demoFirstName(value: unknown): string | null {
  const name = text(value, DEMO_CALL_LIMITS.name);
  if (!name) return null;
  const first = name.split(" ")[0]!;
  return /^[\p{L}][\p{L}'’-]*$/u.test(first) ? first : null;
}

/** The made-up items, cleaned; undefined for anything that is not one. */
export function parseDemoCallSampled(input: unknown): DemoCallSampled | undefined {
  const o = obj(input);
  if (!o) return undefined;
  return {
    prices: list(o.prices, DEMO_CALL_LIMITS.services, (p) => text(p, 120)),
    menu: o.menu === true,
    hours: o.hours === true,
    deposit: o.deposit === true,
  };
}

/** The clinic part, cleaned and capped; null without a clinic name. */
export function parseDemoCallClinic(input: unknown): DemoCallClinic | null {
  const o = obj(input);
  if (!o) return null;
  const clinicName = text(o.clinicName, 120);
  if (!clinicName) return null;
  const sampled = parseDemoCallSampled(o.sampled);
  return {
    clinicName,
    summary: text(o.summary),
    specialty: isSpecialtyId(o.specialty) ? o.specialty : null,
    phone: text(o.phone, 40),
    address: text(o.address, 300),
    hours: list(o.hours, DEMO_CALL_LIMITS.hours, (h) => {
      const r = obj(h);
      const days = r && text(r.days, 80);
      const hours = r && text(r.hours, 80);
      return days && hours ? { days, hours } : null;
    }),
    services: list(o.services, DEMO_CALL_LIMITS.services, (s) => {
      const r = obj(s);
      const name = r && text(r.name, 120);
      return r && name ? { name, description: text(r.description), price: text(r.price, 80), duration: text(r.duration, 40) } : null;
    }),
    providers: list(o.providers, DEMO_CALL_LIMITS.providers, (p) => {
      const r = obj(p);
      const name = r && text(r.name, 80);
      return r && name ? { name, title: text(r.title, 80) } : null;
    }),
    faqs: list(o.faqs, DEMO_CALL_LIMITS.faqs, (f) => {
      const r = obj(f);
      const question = r && text(r.question, 300);
      const answer = r && text(r.answer);
      return question && answer ? { question, answer } : null;
    }),
    policies: list(o.policies, DEMO_CALL_LIMITS.policies, (p) => text(p)),
    booking: text(o.booking),
    highlights: list(o.highlights, DEMO_CALL_LIMITS.highlights, (h) => text(h)),
    ...(sampled ? { sampled } : {}),
  };
}

/** A live discount, cleaned; null for anything missing, out of range or malformed. A whole percent, 1 to 100. */
export function parseDemoCallOffer(input: unknown): DemoCallOffer | null {
  const o = obj(input);
  if (!o) return null;
  const percentOfSetupFee = o.percentOfSetupFee;
  const endsAt = o.endsAt;
  if (typeof percentOfSetupFee !== "number" || !Number.isFinite(percentOfSetupFee)) return null;
  if (percentOfSetupFee <= 0 || percentOfSetupFee > 100) return null;
  if (typeof endsAt !== "number" || !Number.isFinite(endsAt)) return null;
  return { percentOfSetupFee: Math.round(percentOfSetupFee), endsAt };
}

/** The whole context, cleaned; null when any required part is missing or malformed. */
export function parseDemoCallContext(input: unknown): DemoCallContext | null {
  const o = obj(input);
  if (!o || o.v !== 1) return null;
  const slug = text(o.slug, DEMO_CALL_LIMITS.slug);
  const mode = MODES.find((m) => m === o.mode);
  const clinic = parseDemoCallClinic(o.clinic);
  if (!slug || !mode || !clinic || typeof o.issuedAt !== "number" || !Number.isFinite(o.issuedAt)) return null;
  return { v: 1, slug, mode, firstName: demoFirstName(o.firstName), issuedAt: o.issuedAt, clinic, offer: parseDemoCallOffer(o.offer), test: o.test === true, buyButton: text(o.buyButton, 40) };
}

function mac(body: string, secret: string): string {
  return createHmac("sha256", secret).update(`healdesk-demo-call.v1.${body}`).digest("hex");
}

/** The context sealed for the Retell dynamic variable: base64url JSON, a dot, its HMAC. */
export function sealDemoCallContext(context: DemoCallContext, secret: string): string {
  if (!secret) throw new Error("A demo call cannot be sealed without HEALDESK_PROVISION_SECRET.");
  const body = Buffer.from(JSON.stringify(context), "utf8").toString("base64url");
  const sealed = `${body}.${mac(body, secret)}`;
  if (sealed.length > DEMO_CALL_LIMITS.sealed) throw new Error("The demo call context is too large to send.");
  return sealed;
}

/**
 * The context back, or null when the seal does not match, it is older than
 * DEMO_CALL_MAX_AGE_MS (or from the future by more than a minute), or what it
 * holds does not parse. Never throws.
 */
export function openDemoCallContext(sealed: unknown, secret: string, now: number = Date.now()): DemoCallContext | null {
  if (typeof sealed !== "string" || !secret || sealed.length > DEMO_CALL_LIMITS.sealed) return null;
  const dot = sealed.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = sealed.slice(0, dot);
  const given = Buffer.from(sealed.slice(dot + 1), "hex");
  const expected = Buffer.from(mac(body, secret), "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const context = parseDemoCallContext(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
    if (!context) return null;
    if (context.issuedAt > now + 60_000 || now - context.issuedAt > DEMO_CALL_MAX_AGE_MS) return null;
    return context;
  } catch {
    return null;
  }
}
