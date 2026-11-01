import type { DemoCallContext } from "@healdesk/catalog";

import { bookingTools, zonedDayStart, type BookingEngine, type BookingTools } from "@/lib/assistant/booking-tools";
import type { ActorContext } from "@/lib/audit";
import type { assistantMayAnswer } from "@/lib/billing/answering";

import { amountsInRules, demoClinicId, demoTimeZone, listedIn, openSpans } from "./demo-facts";

/**
 * A demo call books through the same tool layer as a clinic's own calls
 * (owner, 1 November 2026, after demo call be078f77: "go ahead with the
 * restructure"; and 24 October 2026: "the demo AYAs and the client AYA
 * should be THE SAME, only difference should be the start").
 *
 * Until now the demo answered from a prompt written for a clinic without a
 * calendar ("you do not book appointments yourself... the team will confirm
 * within a day") while its own note and code said the call books, and the
 * two disagreed on every booking (docs/design/demo-aya-anatomy-2026-11-01.md).
 * Now the demo runs the prompt a clinic with a connected calendar gets, and
 * the booking-tools.ts layer that clinic's calls use: the model asks for
 * times (find_times) and picks one (choose_time), and the tool layer says the
 * fixed lines of lib/booking/lines.ts, holds the time, takes the name and
 * number, and books.
 *
 * Only the engine underneath is the demo's own: the calendar is made of the
 * practice's published (or made-up) hours, held in memory for the call, and
 * nothing is written anywhere. The time the caller picks is held (owner,
 * 1 November 2026, approving docs/design/demo-aya-simpler-2026-11-01.md row
 * 2: the "just taken" first pick, once a call, was the one line a caller
 * could tell was staged, and it is gone).
 */

/**
 * The number a demo caller is taken to be calling from. A browser call has
 * none, and a clinic's call always does (Retell's from_number): with it, "the
 * one I'm calling from" works as on a clinic's call, and another number is
 * taken when they give one. 555-01xx numbers are reserved for fiction.
 */
export const DEMO_CALLER_PHONE = "+12025550143";

/** An hour of an open day, as the calendar offers it. */
type DemoTime = { at: Date; providerId: null };

/** The practice's day as a date string, YYYY-MM-DD, in its own zone. */
function dayString(at: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** The weekday of an instant in a zone, 0 Sunday to 6. */
function weekday(at: Date, zone: string): number {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short" }).format(at));
}

/**
 * The demo's free times on one day: an hour after opening, the middle of the
 * day, and two hours before closing, so three offered times spread over the
 * day as a receptionist would offer them.
 */
function timesOn(day: Date, span: { open: number; close: number }, zone: string): DemoTime[] {
  const start = zonedDayStart(dayString(day, zone), zone);
  if (!start) return [];
  const hour = (m: number) => Math.round(m / 60) * 60;
  const picks = [hour(span.open + 60), hour((span.open + span.close) / 2), hour(span.close - 120), hour(span.close - 60)].filter((m, i, all) => m >= span.open && m <= span.close - 60 && all.indexOf(m) === i);
  return picks.map((m) => ({ at: new Date(start.getTime() + m * 60_000), providerId: null }));
}

/** The engine a demo books on: the published hours, in memory, nothing written. */
export function demoBookingEngine(context: Pick<DemoCallContext, "clinic" | "issuedAt">): BookingEngine {
  const zone = demoTimeZone(context.clinic.address);
  const spans = openSpans(context);
  const menu = context.clinic.services.map((s) => s.name);
  const canonical = (service: string | null | undefined) => (service ? (listedIn(service, menu)[0] ?? service) : null);
  const deposit = amountsInRules(context.clinic.policies.filter((p) => /\bdeposit\b/i.test(p)))[0] ?? null;
  const inHours = (at: Date) => {
    const span = spans.get(weekday(at, zone));
    if (!span) return false;
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(at);
    const minutes = Number(parts.find((p) => p.type === "hour")?.value) * 60 + Number(parts.find((p) => p.type === "minute")?.value);
    return minutes >= span.open && minutes <= span.close - 60;
  };

  const engine: BookingEngine = {
    async offerTimes(_clinicId, input) {
      if (spans.size === 0) return { status: "request_only", reasons: ["no_hours"] };
      const now = input.now ?? new Date(context.issuedAt);
      // The day they named, or the next three open days; from an hour they asked for ("after four"), when given.
      const days: Date[] = [];
      if (input.day) days.push(input.day);
      else for (let k = 1; k <= 14 && days.length < 3; k += 1) {
        const day = new Date(now.getTime() + k * 86_400_000);
        if (spans.has(weekday(day, zone))) days.push(day);
      }
      const slots = days.flatMap((day) => {
        const span = spans.get(weekday(new Date(day.getTime() + 12 * 3_600_000), zone));
        return span ? timesOn(new Date(day.getTime() + 12 * 3_600_000), span, zone) : [];
      });
      const from = input.from ? input.from.getTime() : now.getTime();
      const open = slots.filter((s) => s.at.getTime() > now.getTime() && s.at.getTime() >= from);
      return { status: "ok", timeZone: zone, serviceMinutes: 60, canonicalService: canonical(input.service), slots: open };
    },
    async placeHold(_clinicId, input) {
      const at = input.startsAt;
      if (!inHours(at)) return { kind: "slot_taken", alternatives: [] };
      return { kind: "held", holdId: "demo-hold", expiresAt: new Date(at.getTime()), startsAt: at, minutes: 60, providerId: null };
    },
    async bookConversation(_clinicId, input) {
      return {
        kind: "booked",
        startsAt: input.startsAt,
        minutes: 60,
        canonicalService: canonical(input.service),
        providerId: null,
        replayed: false,
        appointmentId: null,
        requestId: null,
        // The demo's deposit rule, said as a clinic's call says one: flagged for the front desk, never taken on the call.
        deposit: deposit !== null ? { action: "book_and_flag", amountUsd: deposit } : null,
      };
    },
    async chatDepositFor() {
      return { kind: "none" } as Awaited<ReturnType<BookingEngine["chatDepositFor"]>>;
    },
    async logRequest() {
      return { kind: "invalid" } as unknown as Awaited<ReturnType<BookingEngine["logRequest"]>>;
    },
  };
  return engine;
}

/** The gate a demo answers through: always open, since a demo bills nobody and keeps nothing. */
const DEMO_GATE = (async () => ({ decision: "answer" })) as unknown as typeof assistantMayAnswer;

/** A demo call's tools: the real tool layer on the demo's engine, always on. */
export function demoBookingTools(context: Pick<DemoCallContext, "clinic" | "issuedAt" | "slug">, callId: string, actor: ActorContext): BookingTools {
  const tools = bookingTools(
    {
      clinicId: demoClinicId(context.slug),
      channel: "voice",
      holderKey: `retell:${callId}`,
      bookingKey: `retell:${callId}:1`,
      conversationId: null,
      timeZone: demoTimeZone(context.clinic.address),
      actor,
      budgetMs: 5_000,
    },
    demoBookingEngine(context),
    DEMO_GATE,
  );
  return { channel: "voice", available: async () => true, run: tools.run };
}
