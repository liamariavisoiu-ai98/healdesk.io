import {
  CARRIERS,
  forwardingInstructions,
  getPlan,
  plans,
  type Channel,
  type Plan,
} from "@healdesk/catalog";

import type { UsageMeter } from "@/db/schema";
import type { ForwardingFacts } from "@/lib/billing/notices";
import { publicUrl } from "@/lib/public-url";

import { EmailCompositionError, type Block } from "./compose";
import type { TemplateContext } from "./types";

/**
 * The words the billing emails share (Annex X5's L2–L4, L19, L27, E1, E2 and
 * O14), so twenty-one templates say a price, a date, a channel and "how to
 * cancel" the same way, and none of them grows its own copy of a rule.
 *
 * Everything here renders from the stored payload and the context. Dates come
 * from the payload or from `ctx.raisedAt`, never from a clock, so a retry
 * inside Resend's 24-hour idempotency window sends the same bytes (X1.4). The
 * one value read from outside them is the public origin, through publicUrl(),
 * which is fixed for a deployment: it is the only way to link the portal,
 * because the context carries no clinic slug.
 */

// -----------------------------------------------------------------------------
// Money and counts
// -----------------------------------------------------------------------------

/** "$897", "$24.50", "$11,484": whole dollars print without cents. */
export function money(cents: number): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(cents / 100);
}

/** "1 voice minute", "1,000 voice minutes". */
export function counted(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** "a month" or "a year", after a price. */
export function perInterval(interval: "month" | "year"): string {
  return interval === "year" ? "a year" : "a month";
}

/** The meters by the names a clinic sees on Billing. */
export const METER_WORDS: Record<UsageMeter, { one: string; many: string }> = {
  voice_minutes: { one: "voice minute", many: "voice minutes" },
  chat_conversations: { one: "chat conversation", many: "chat conversations" },
};

// -----------------------------------------------------------------------------
// People and channels
// -----------------------------------------------------------------------------

/** "patient" or "client" (audienceFor): a vet's customers own the animal that is the patient. */
export function person(ctx: TemplateContext): "patient" | "client" {
  return ctx.audience === "clients" ? "client" : "patient";
}

export function people(ctx: TemplateContext): "patients" | "clients" {
  return ctx.audience === "clients" ? "clients" : "patients";
}

type ChannelWords = {
  /** At the start of a sentence or in a subject. */
  title: string;
  /** Mid-sentence. */
  name: string;
  /** Meta is one channel sold as three apps, so it takes a plural verb. */
  plural: boolean;
  /** Where AYA answers someone on it. */
  where: string;
};

/**
 * One channel, three names: the phone, website chat, and the Meta bot, which
 * a clinic knows as Instagram, Messenger and WhatsApp (the names the site and
 * the Terms use), never as "Meta".
 */
export const CHANNEL_WORDS: Record<Channel, ChannelWords> = {
  voice: { title: "Phone", name: "phone", plural: false, where: "on the phone" },
  web: {
    title: "Website chat",
    name: "website chat",
    plural: false,
    where: "in your website chat",
  },
  meta: {
    title: "Instagram, Messenger and WhatsApp",
    name: "Instagram, Messenger and WhatsApp",
    plural: true,
    where: "on Instagram, Messenger or WhatsApp",
  },
};

/** "is" or "are", "joins" or "join": agreement with a channel's name. */
export function verbFor(channel: Channel, singular: string, plural: string): string {
  return CHANNEL_WORDS[channel].plural ? plural : singular;
}

/**
 * What happens when AYA stops answering, in the Terms' own words (§6, §8): one
 * sentence for every email that announces it or warns of it.
 */
export const WHEN_AYA_STOPS =
  "forwarded calls pass straight through to your direct line, and website chat becomes a contact form";

/**
 * The other way a bought channel's price joins the plan (BD4, R33): a channel
 * ready on our side but waiting on the clinic joins 30 days after the later
 * of its readiness and the plan start (billing reconcile's WAITING_JOIN_DAYS),
 * after a week's notice (L4, STEP_UP_NOTICE_DAYS), whether or not it ever
 * answers. Every email that says a price joins from a channel's first answer
 * says this beside it: the Terms bill by both, and a clinic told only about
 * the first answer would not expect the second.
 */
export const WAITING_CHANNEL_JOINS =
  "A channel that's ready but waiting on a step of yours joins 30 days after it became ready or after your plan started, whichever is later, and we email you a week before.";

// -----------------------------------------------------------------------------
// Plans
// -----------------------------------------------------------------------------

/** The catalog package a payload names by id. The allowlist only lets catalog ids through. */
export function planById(id: string): Plan {
  const plan = getPlan(id);
  if (!plan) {
    throw new EmailCompositionError("The payload names a package the catalog does not sell.");
  }
  return plan;
}

/**
 * The package a payload names by name, or undefined. `planName` may also be a
 * pricing card's name (the allowlist accepts both), which is no one package, so
 * a template reads only what a missing package leaves out.
 */
export function planByName(name: string): Plan | undefined {
  return plans.find((plan) => plan.name === name);
}

// -----------------------------------------------------------------------------
// Dates
// -----------------------------------------------------------------------------

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

type CalendarDay = { year: number; month: number; day: number };

function instant(iso: string): Date {
  const at = new Date(iso);
  // The value is not echoed: it came from a payload, and the error is stored.
  if (Number.isNaN(at.getTime())) throw new EmailCompositionError("A payload date is not ISO.");
  return at;
}

/**
 * The calendar day an ISO value names. A bare date (`…On`: a renewal, the end
 * of a window) is that day wherever the clinic is; a moment (`…At`: a grace
 * end, a disconnection) is the day it falls on in the clinic's own time zone,
 * so a period that ends at 00:00 UTC ends the evening before in New York, as
 * it really does there.
 */
function calendarDay(iso: string, timeZone: string): CalendarDay {
  if (DATE_ONLY.test(iso)) {
    const [year, month, day] = iso.split("-").map(Number) as [number, number, number];
    return { year, month, day };
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant(iso));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function dayWords(day: CalendarDay, options: { weekday: boolean; year: boolean }): string {
  const noon = new Date(Date.UTC(day.year, day.month - 1, day.day, 12));
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
  }).formatToParts(noon);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return [
    options.weekday ? get("weekday") : null,
    String(day.day),
    get("month"),
    options.year ? String(day.year) : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * The year is printed only when it is not the year the notice was raised in,
 * reckoned from `raisedAt` rather than the clock: "Tuesday 13 October", but
 * "Friday 5 November 2027" for a renewal a year out.
 */
function needsYear(day: CalendarDay, ctx: TemplateContext): boolean {
  return day.year !== calendarDay(ctx.raisedAt.toISOString(), ctx.timeZone).year;
}

/** "Tuesday 13 October", the way X1.3's dated promises read. */
export function dayLong(iso: string, ctx: TemplateContext): string {
  const day = calendarDay(iso, ctx.timeZone);
  return dayWords(day, { weekday: true, year: needsYear(day, ctx) });
}

/** "13 October": for subjects, which have 70 characters to spend. */
export function dayShort(iso: string, ctx: TemplateContext): string {
  const day = calendarDay(iso, ctx.timeZone);
  return dayWords(day, { weekday: false, year: needsYear(day, ctx) });
}

/** "October 2026": a card's expiry month, always with its year. */
export function monthAndYear(iso: string, ctx: TemplateContext): string {
  const day = calendarDay(iso, ctx.timeZone);
  return dayWords(day, { weekday: false, year: true }).replace(/^\d+ /, "");
}

/**
 * "10:32 am EDT on Tuesday 13 October": a deadline or a security record, where
 * the hour matters. Grace ends at a moment, and a date alone would let the
 * clinic read "until Tuesday" as the whole of Tuesday.
 */
export function momentLong(iso: string, ctx: TemplateContext): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ctx.timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).formatToParts(instant(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const minute = get("minute");
  const clock = `${get("hour")}${minute === "00" ? "" : `:${minute}`} ${get("dayPeriod").toLowerCase()}`;
  return `${clock} ${get("timeZoneName")} on ${dayLong(iso, ctx)}`.replace(/\s+/g, " ");
}

/** An ISO value `days` later: a bare date stays a bare date. */
export function plusDays(iso: string, days: number): string {
  if (DATE_ONLY.test(iso)) {
    return new Date(Date.parse(`${iso}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
  }
  return new Date(instant(iso).getTime() + days * DAY_MS).toISOString();
}

// -----------------------------------------------------------------------------
// Links
// -----------------------------------------------------------------------------

/**
 * The portal's front door, publicUrl("/"): signed in, it lands on the clinic's
 * Home, one tap from Billing and Settings; signed out, on /sign-in. It is the
 * only portal link a template can build, because the context names the clinic
 * but not its slug. Never a Customer Portal session URL, which Stripe expires
 * in minutes: the clinic opens Stripe's portal from Billing.
 */
export function portalUrl(): string {
  return publicUrl("/");
}

/**
 * How to cancel online, for every email that links a receipt (X3's merges:
 * "that email links Stripe's hosted receipt, with the cancel link", and X7's
 * "receipts that say how to cancel online"). Cancelling is the auto-renew
 * switch, which ends the plan at the end of the paid period, or, before the
 * plan has started, means it never starts (spec, Billing); immediate
 * cancellation is not in the portal (spec, "What the portal does not have").
 */
export function cancelOnline(options: { beforeStart?: boolean } = {}): Block {
  const then = options.beforeStart
    ? "Your plan then won't start, and nothing more is charged."
    : "Your plan then ends when the period you've paid for runs out.";
  return {
    type: "paragraph",
    text: `To cancel online, sign in at ${portalUrl()} and turn auto-renew off in Billing. ${then}`,
  };
}

// -----------------------------------------------------------------------------
// Undoing call forwarding (R31)
// -----------------------------------------------------------------------------

/**
 * The steps for undoing call forwarding on the clinic's own line, from the
 * catalog's forwardingInstructions(...).undo and nowhere else: the codes live
 * in one table there, and a code we are not sure of is not listed, so an
 * unknown carrier gets the catalog's "ask your carrier" step rather than a
 * guess that would do nothing or leave the line forwarded.
 *
 * After hours only forwards on the carrier's schedule, which no star code
 * undoes (the catalog says so), so that mode asks the carrier too; a cloud
 * phone system is a rule in its admin whatever the mode. The destination
 * number only fills the set-up steps, which an undo never prints, so none is
 * passed.
 *
 * `lead` is the email's own sentence saying why; the list follows it.
 */
export function undoForwarding(facts: ForwardingFacts, lead: string): Block[] {
  const instructions = forwardingInstructions({
    carrier: facts.routing === "after_hours_only" ? null : facts.carrier,
    phoneSystemType: facts.phoneSystem,
    routing: facts.routing === "all_calls" ? "always" : "conditional",
    destinationE164: "",
  });
  const carrier = CARRIERS.find((c) => c.id === facts.carrier)?.name;
  const how =
    facts.phoneSystem === "voip"
      ? "Your line forwards by a rule in your phone system's admin:"
      : facts.routing === "after_hours_only"
        ? "After-hours forwarding runs on your carrier's schedule, so:"
        : instructions.needsCarrierHelp || !carrier
          ? "We don't have your carrier's codes on file, so:"
          : `From the clinic's own line, dial these ${carrier} codes:`;
  return [
    { type: "paragraph", text: `${lead} ${how}` },
    {
      type: "list",
      items: instructions.undo.map((step) => [step.label, step.dial].filter(Boolean).join(" ")),
    },
  ];
}
