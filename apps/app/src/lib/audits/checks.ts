import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import {
  agentConfigs,
  clinicChangeEvents,
  clinicChannels,
  clinicProviders,
  clinicProviderServices,
  clinics,
  clinicSettings,
  voiceAgents,
  type AuditCheckOutcome,
  type AuditPack,
  type AuditResult,
} from "@/db/schema";
import { assistantFacts } from "@/lib/assistant/facts";
import { closureLines } from "@/lib/assistant/prompt";
import { readCoverageMode, voiceCoverageFacts, voiceOutsideCoverage } from "@/lib/billing/answering";
import {
  candidateWindow,
  computeCandidates,
  DEFAULT_SERVICE_MINUTES,
  OFFER_HORIZON_DAYS,
} from "@/lib/booking/availability";
import { bookingModeFor } from "@/lib/booking/mode";
import { readGoLiveCheck } from "@/lib/channels/events";
import { readChannelStates } from "@/lib/channels/state";
import { clinicLocalDate, closedOn, closuresFrom } from "@/lib/clinic/closures";
import {
  DAY_KEYS,
  isOpenAt,
  parseOpeningHours,
  type OpeningHours,
} from "@/lib/clinic/opening-hours";
import { googleCalendarConnection, serviceKeyOf } from "@/lib/connections/google-calendar";
import { listTranscriptDeliveries } from "@/lib/conversations/transcript-outbox";
import { GO_LIVE_CODES } from "@/lib/onboarding/go-live";
import { bookingsOnNewlyClosedDays } from "@/lib/portal/knowledge";
import type { TenantTx } from "@/lib/tenant";
import type { VoiceAgentReport } from "@/lib/voice/provision";

/**
 * The ops audits' checks (design E3 §2.1, 23 October 2026): what "this
 * clinic's availability is implemented and running without problems" means,
 * one comparison at a time, and the same for its roster, its go-live and its
 * transcripts. Each check is read-only. It reads the clinic's own rows in
 * its tenant, runs the same code the channels run (the booking engine's
 * core, the answer gate's coverage rule, the assistant's facts) and answers
 * pass, warn or fail with a fixed hint, closed codes and counts. Never a
 * name, a date, a time, an address or anything a clinic typed: what an
 * operator needs to find the problem, and nothing to leak.
 *
 * No check calls a vendor on its own. An operator's manual run may add the
 * voice agent's read-back from Retell (GET only), through `deps`.
 */

export type AuditDeps = {
  /**
   * Retell's read-back of the clinic's agent and number, GET only
   * (verifyVoiceAgent). `signal` aborts its requests when the check's time
   * budget runs out.
   */
  verifyVoice?: (clinicId: string, signal: AbortSignal) => Promise<VoiceAgentReport>;
};

export type AuditContext = {
  clinicId: string;
  now: Date;
  /** An operator asked for this run: the vendor read-backs in `deps` may run. */
  manual: boolean;
  deps: AuditDeps;
  /** Aborted when the check's time budget runs out. */
  signal: AbortSignal;
  /** Run `fn` in the clinic's tenant, under the check's time budget. */
  read: <T>(fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
};

export type CheckOutcome = Omit<AuditCheckOutcome, "id">;

export type AuditCheck = {
  id: string;
  pack: AuditPack;
  /** What it compares, for the console. */
  label: string;
  run: (ctx: AuditContext) => Promise<CheckOutcome>;
};

const pass = (counts: Record<string, number> = {}, code: string | null = null): CheckOutcome => ({
  result: "pass",
  hint: null,
  counts,
  code,
});
const finding = (
  result: Exclude<AuditResult, "pass" | "error">,
  hint: string,
  counts: Record<string, number> = {},
  code: string | null = null,
): CheckOutcome => ({ result, hint, counts, code });

type ClinicFacts = {
  timeZone: string;
  timezoneConfirmed: boolean;
  hours: OpeningHours | null;
  production: boolean;
  callRouting: string | null;
};

async function clinicFacts(tx: TenantTx): Promise<ClinicFacts | null> {
  const [row] = await tx.db
    .select({
      timezone: clinics.timezone,
      timezoneConfirmedAt: clinics.timezoneConfirmedAt,
      openingHours: clinics.openingHours,
      dataClassification: clinics.dataClassification,
      callRouting: clinics.callRouting,
    })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!row) return null;
  let hours: OpeningHours | null;
  try {
    hours = parseOpeningHours(row.openingHours);
  } catch {
    hours = null;
  }
  return {
    timeZone: row.timezone,
    timezoneConfirmed: row.timezoneConfirmedAt !== null,
    hours,
    production: row.dataClassification === "production",
    callRouting: row.callRouting,
  };
}

const NO_CLINIC: CheckOutcome = { result: "error", hint: "The clinic could not be read.", counts: {} };

function openDayCount(hours: OpeningHours): number {
  return DAY_KEYS.filter((day) => (hours[day] ?? []).length > 0).length;
}

/** Each local date the window touches, in the clinic's zone, earliest first. */
function localDatesIn(from: Date, to: Date, timeZone: string): string[] {
  const out = new Set<string>();
  for (let t = from.getTime() - 86_400_000; t <= to.getTime() + 86_400_000; t += 3_600_000) {
    out.add(clinicLocalDate(new Date(t), timeZone));
  }
  return [...out].sort();
}

/** Noon on a local date in the clinic's zone, as an instant. */
export function localNoon(date: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, 12, 0);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(guess));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  const shown = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour") % 24, part("minute"));
  return new Date(guess - (shown - guess));
}

// -----------------------------------------------------------------------------
// The availability pack (item 5)
// -----------------------------------------------------------------------------

const hoursValid: AuditCheck = {
  id: "hours_valid",
  pack: "availability",
  label: "Weekly hours read, at least one open day, time zone confirmed",
  run: (ctx) =>
    ctx.read(async (tx) => {
      const clinic = await clinicFacts(tx);
      if (!clinic) return NO_CLINIC;
      if (!clinic.hours) {
        return finding(
          "fail",
          "No weekly hours are saved, or they cannot be read: no times are offered on any channel. Ask the clinic to set them in Knowledge, Hours.",
        );
      }
      const openDays = openDayCount(clinic.hours);
      if (openDays === 0) {
        return finding("fail", "Every day is closed in the weekly hours: no times are offered.", { openDays });
      }
      if (!clinic.timezoneConfirmed) {
        return finding(
          "fail",
          "Time zone unconfirmed: no times are offered on any channel. Ask the clinic to confirm it in Settings.",
          { openDays },
        );
      }
      return pass({ openDays });
    }),
};

const closuresStored: AuditCheck = {
  id: "closures_stored",
  pack: "availability",
  label: "The closed days saved match the clinic's last save; at most 60 ahead",
  run: (ctx) =>
    ctx.read(async (tx) => {
      const clinic = await clinicFacts(tx);
      if (!clinic) return NO_CLINIC;
      const upcoming = (await closuresFrom(tx.db, tx.clinicId, clinicLocalDate(ctx.now, clinic.timeZone))).length;
      const [last] = await tx.db
        .select({ source: clinicChangeEvents.source, summary: clinicChangeEvents.summary, changedAt: clinicChangeEvents.changedAt })
        .from(clinicChangeEvents)
        .where(and(eq(clinicChangeEvents.clinicId, tx.clinicId), eq(clinicChangeEvents.kind, "closures")))
        .orderBy(desc(clinicChangeEvents.changedAt))
        .limit(1);
      if (upcoming > 60) {
        return finding("warn", "More than 60 closed days are saved from today, more than one save may add.", { upcoming });
      }
      const sent = last?.summary.closuresUpcoming;
      if (
        last &&
        last.source !== "direct" &&
        typeof sent === "number" &&
        clinicLocalDate(last.changedAt, clinic.timeZone) === clinicLocalDate(ctx.now, clinic.timeZone) &&
        sent !== upcoming
      ) {
        return finding(
          "warn",
          "The closed days saved differ from what the clinic's last save sent: something else changed them since. Open Knowledge with the clinic.",
          { upcoming, lastSaved: sent },
        );
      }
      return pass({ upcoming });
    }),
};

/** Manual booking for a reason that is a setting, not a fault. */
const EXPECTED_MANUAL: ReadonlySet<string> = new Set([
  "auto_confirm_off",
  "not_production",
  "agent_not_approved",
  "kill_switch_off",
  "manual_booking_system",
]);

const BOOKING_MODE_HINTS: Readonly<Record<string, string>> = {
  calendar_broken: "Manual booking because the calendar connection is broken: send the clinic a calendar link.",
  calendar_not_connected: "Manual booking because no Google Calendar is connected: send the clinic a calendar link.",
  calendar_degraded: "Manual booking because Google has not answered the last probes; the calendar watch keeps trying.",
  timezone_unconfirmed: "Manual booking because the time zone is unconfirmed: ask the clinic to confirm it in Settings.",
  opening_hours_unknown: "Manual booking because the weekly hours are not set: ask the clinic to set them in Knowledge.",
};

const bookingMode: AuditCheck = {
  id: "booking_mode",
  pack: "availability",
  label: "AYA books, or takes requests, and why",
  run: (ctx) =>
    ctx.read(async (tx) => {
      const clinic = await clinicFacts(tx);
      if (!clinic) return NO_CLINIC;
      const mode = await bookingModeFor(tx);
      const codes = mode.reasons.map((r) => r.code);
      if (mode.mode === "live") return pass({ reasons: 0 }, "live");
      const unexpected = codes.find((code) => !EXPECTED_MANUAL.has(code));
      if (!clinic.production || unexpected === undefined) return pass({ reasons: codes.length }, codes[0] ?? "manual");
      return finding(
        "warn",
        BOOKING_MODE_HINTS[unexpected] ?? "Manual booking: AYA takes requests instead of booking. The code says why.",
        { reasons: codes.length },
        unexpected,
      );
    }),
};

const calendarReachable: AuditCheck = {
  id: "calendar_reachable",
  pack: "availability",
  label: "The Google Calendar connection is active and not broken",
  run: (ctx) =>
    ctx.read(async (tx) => {
      const clinic = await clinicFacts(tx);
      if (!clinic) return NO_CLINIC;
      const connection = await googleCalendarConnection(tx);
      if (!connection || connection.status === "pending" || connection.status === "revoked") {
        return clinic.production
          ? finding("warn", "No Google Calendar is connected: AYA takes booking requests. Send the clinic a calendar link.", {}, "not_connected")
          : pass({}, "not_connected");
      }
      if (connection.status === "error" || connection.brokenAt !== null) {
        return finding("fail", "Google refused the calendar connection: the clinic must reconnect. Send a calendar link.", {}, "broken");
      }
      if (connection.status === "degraded") {
        return finding("warn", "Google did not answer the last calendar probes; the calendar watch keeps trying.", {}, "degraded");
      }
      return pass({}, connection.status);
    }),
};

const slotsHonourClosures: AuditCheck = {
  id: "slots_honour_closures",
  pack: "availability",
  // The slot engine's rule, not the whole engine: computeCandidates with the
  // closed days read through closedOn, as availableSlotsFor reads them, and a
  // calendar free all day. availableSlotsFor itself asks Google, which an
  // audit must not, and its closed-day reading is not exported.
  label:
    "The slot engine's rule (computeCandidates, with closedOn's closed days and an empty calendar) offers no time on a closed day or outside the weekly hours, and some time on an open day",
  run: (ctx) =>
    ctx.read(async (tx) => {
      const clinic = await clinicFacts(tx);
      if (!clinic) return NO_CLINIC;
      if (!clinic.hours || !clinic.timezoneConfirmed) return pass({ days: 0 }, "hours_unknown");
      const window = candidateWindow({ now: ctx.now, horizonDays: OFFER_HORIZON_DAYS });
      if (!window) return pass({ days: 0 }, "no_window");
      // The days closed in the window, read as the engine reads them (closedOn per date).
      const dates = localDatesIn(window.startsAt, window.endsAt, clinic.timeZone);
      const closedDates = new Set<string>();
      for (const date of dates) if (await closedOn(tx.db, tx.clinicId, date)) closedDates.add(date);
      // The engine's own core, with a calendar free all day: what it would
      // offer if Google showed no event, so only the hours and the closed
      // days decide.
      const slots = computeCandidates({
        now: ctx.now,
        horizonDays: OFFER_HORIZON_DAYS,
        durationMinutes: DEFAULT_SERVICE_MINUTES,
        timeZone: clinic.timeZone,
        hours: clinic.hours,
        closedDates,
        free: [
          {
            startsAt: new Date(window.startsAt.getTime() - 86_400_000),
            endsAt: new Date(window.endsAt.getTime() + 86_400_000),
          },
        ],
        blocked: [],
      });
      const onClosed = slots.filter((at) => closedDates.has(clinicLocalDate(at, clinic.timeZone))).length;
      const outsideHours = slots.filter((at) => isOpenAt(clinic.hours, at, clinic.timeZone) === false).length;
      const offeredDays = new Set(slots.map((at) => clinicLocalDate(at, clinic.timeZone))).size;
      const counts = { slots: slots.length, closedDays: closedDates.size, offeredDays, onClosed, outsideHours };
      if (onClosed > 0 || outsideHours > 0) {
        return finding(
          "fail",
          "The slot engine's rule offers times on a closed day or outside the weekly hours: it disagrees with the hours. Escalate to engineering.",
          counts,
        );
      }
      if (slots.length === 0) {
        return finding(
          "warn",
          "No time is offered in the next 14 days even with an empty calendar: every day is closed or the openings are too short. Confirm with the clinic.",
          counts,
        );
      }
      return pass(counts);
    }),
};

const bookingsOnClosedDays: AuditCheck = {
  id: "bookings_on_closed_days",
  pack: "availability",
  label: "Bookings, open requests and held times on a closed day still to come",
  run: (ctx) =>
    ctx.read(async (tx) => {
      const clinic = await clinicFacts(tx);
      if (!clinic) return NO_CLINIC;
      const today = clinicLocalDate(ctx.now, clinic.timeZone);
      const upcoming = (await closuresFrom(tx.db, tx.clinicId, today)).map((c) => c.closedOn);
      if (upcoming.length === 0) return pass({ bookings: 0, liveHolds: 0, closedDays: 0 });
      // Every closed day from today counts as newly closed: the portal's own count.
      const found = await bookingsOnNewlyClosedDays(tx, [], clinic.timeZone, ctx.now);
      const days = sql`array[${sql.join(
        upcoming.map((d) => sql`${d}`),
        sql`, `,
      )}]::text[]`;
      const holds = await tx.db.execute<{ n: number }>(sql`
        select count(*)::int as n from slot_holds h
         where h.clinic_id = ${tx.clinicId}
           and h.status in ('held', 'reserved', 'writing', 'unknown')
           and h.starts_at > ${ctx.now}
           and ((h.starts_at at time zone ${clinic.timeZone})::date)::text = any(${days})`);
      const liveHolds = Number(holds.rows[0]?.n ?? 0);
      const counts = { bookings: found.count, liveHolds, closedDays: upcoming.length };
      if (found.count > 0 || liveHolds > 0) {
        return finding(
          "warn",
          "Bookings or requests fall on a day the clinic has closed: they stay as they are, and the clinic decides each one in Bookings.",
          counts,
        );
      }
      return pass(counts);
    }),
};

const voiceAnswersClosedDays: AuditCheck = {
  id: "voice_answers_closed_days",
  pack: "availability",
  label: "On a closed day, the answer gate lets AYA answer calls in the clinic's coverage mode",
  run: (ctx) =>
    ctx.read(async (tx) => {
      const clinic = await clinicFacts(tx);
      if (!clinic) return NO_CLINIC;
      const coverage = await readCoverageMode(tx.db, tx.clinicId, { callRouting: clinic.callRouting });
      const [next] = await closuresFrom(tx.db, tx.clinicId, clinicLocalDate(ctx.now, clinic.timeZone), 1);
      if (!next) return pass({ closedDays: 0 }, coverage);
      // The gate's own facts at noon that day: its weekly hours and its
      // reading of the closed days, so a closure the gate cannot see fails here.
      const noon = localNoon(next.closedOn, clinic.timeZone);
      const facts = await voiceCoverageFacts(tx.db, tx.clinicId, {
        coverageMode: coverage,
        openingHours: clinic.hours,
        timeZone: clinic.timeZone,
        now: noon,
      });
      if (voiceOutsideCoverage({ coverageMode: coverage, ...facts })) {
        return finding(
          "fail",
          "On its closed day, calls would be passed through to the clinic's own line instead of AYA answering; the code is the coverage mode.",
          { closedDays: 1 },
          coverage,
        );
      }
      return pass({ closedDays: 1 }, coverage);
    }),
};

const voiceAgentCurrent: AuditCheck = {
  id: "voice_agent_current",
  pack: "availability",
  label: "The clinic's Retell agent is ready, not drifted and without error",
  run: async (ctx) => {
    const state = await ctx.read(async (tx) => {
      const [voice] = await tx.db
        .select({ channel: clinicChannels.channel })
        .from(clinicChannels)
        .where(and(eq(clinicChannels.clinicId, tx.clinicId), eq(clinicChannels.channel, "voice")))
        .limit(1);
      if (!voice) return { bought: false as const };
      const [agent] = await tx.db
        .select({ status: voiceAgents.status, lastError: voiceAgents.lastError, driftFlaggedAt: voiceAgents.driftFlaggedAt })
        .from(voiceAgents)
        .where(eq(voiceAgents.clinicId, tx.clinicId))
        .limit(1);
      return { bought: true as const, agent: agent ?? null };
    });
    if (!state.bought) return pass({}, "no_phone");
    const { agent } = state;
    if (!agent) return finding("warn", "Phone is bought and no Retell agent exists yet.", {}, "none");
    if (agent.status === "failed" || agent.driftFlaggedAt !== null) {
      return finding("fail", "The Retell agent's set-up failed or it keeps drifting: see the clinic's voice panel.", {}, agent.status);
    }
    if (agent.status !== "ready") return finding("warn", "The Retell agent is not ready yet.", {}, agent.status);
    if (agent.lastError) return finding("warn", "The Retell agent is ready but its last sync failed: see the voice panel.", {}, agent.status);
    if (ctx.manual && ctx.deps.verifyVoice) {
      const report = await ctx.deps.verifyVoice(ctx.clinicId, ctx.signal);
      if (report.checked && !report.ok) {
        return finding(
          "fail",
          "Retell's agent or number is not as healdesk wrote it: see the voice panel's read-back.",
          { problems: report.problems.length },
          "read_back",
        );
      }
    }
    return pass({}, agent.status);
  },
};

const webChatLive: AuditCheck = {
  id: "web_chat_live",
  pack: "availability",
  label: "Website chat is live, when it is bought",
  run: (ctx) =>
    ctx.read(async (tx) => {
      const states = await readChannelStates(tx.db, tx.clinicId, ctx.now);
      const web = states.find((s) => s.channel === "web");
      if (!web) return pass({}, "not_bought");
      if (web.status === "live" || web.status === "paused") return pass({}, web.status);
      return finding("warn", "Website chat is bought and not live yet; the code is what it waits on.", {}, web.waitingOn ?? web.status);
    }),
};

const assistantKnowsClosures: AuditCheck = {
  id: "assistant_knows_closures",
  pack: "availability",
  label: "Every closed day still to come is in what AYA is told",
  run: (ctx) =>
    ctx.read(async (tx) => {
      const clinic = await clinicFacts(tx);
      if (!clinic) return NO_CLINIC;
      const saved = (await closuresFrom(tx.db, tx.clinicId, clinicLocalDate(ctx.now, clinic.timeZone), 60)).map(
        (c) => c.closedOn,
      );
      const facts = await assistantFacts(tx, { now: ctx.now });
      if (!facts) return NO_CLINIC;
      const told = new Set((facts.closures ?? []).map((c) => c.closedOn));
      const lines = closureLines(facts.closures).length;
      const missing = saved.filter((d) => !told.has(d)).length;
      const counts = { saved: saved.length, told: told.size, lines, missing };
      if (missing > 0 || lines !== saved.length) {
        return finding("fail", "A closed day is saved but missing from what AYA is told: she may say the clinic is open.", counts);
      }
      return pass(counts);
    }),
};

// -----------------------------------------------------------------------------
// The roster pack (item 6)
// -----------------------------------------------------------------------------

type Roster = {
  named: boolean;
  providers: { id: string; services: string[] }[];
  services: string[];
};

async function readRoster(tx: TenantTx): Promise<Roster> {
  const [settings] = await tx.db
    .select({ bookingDetail: clinicSettings.bookingDetail })
    .from(clinicSettings)
    .where(eq(clinicSettings.clinicId, tx.clinicId))
    .limit(1);
  const active = await tx.db
    .select({ id: clinicProviders.id })
    .from(clinicProviders)
    .where(and(eq(clinicProviders.clinicId, tx.clinicId), eq(clinicProviders.active, true)))
    .orderBy(asc(clinicProviders.createdAt));
  const mapped = active.length
    ? await tx.db
        .select({ providerId: clinicProviderServices.providerId, serviceKey: clinicProviderServices.serviceKey })
        .from(clinicProviderServices)
        .where(
          and(
            eq(clinicProviderServices.clinicId, tx.clinicId),
            inArray(
              clinicProviderServices.providerId,
              active.map((p) => p.id),
            ),
          ),
        )
    : [];
  const [agent] = await tx.db
    .select({ services: agentConfigs.services })
    .from(agentConfigs)
    .where(eq(agentConfigs.clinicId, tx.clinicId))
    .limit(1);
  return {
    named: settings?.bookingDetail === "named_provider",
    providers: active.map((p) => ({
      id: p.id,
      services: mapped.filter((m) => m.providerId === p.id).map((m) => m.serviceKey),
    })),
    services: [...new Set((agent?.services ?? []).map((s) => serviceKeyOf(s.name)))],
  };
}

const rosterServicesCovered: AuditCheck = {
  id: "roster_services_covered",
  pack: "roster",
  label: "Under named providers, every service has a provider who offers it",
  run: (ctx) =>
    ctx.read(async (tx) => {
      const roster = await readRoster(tx);
      if (!roster.named) return pass({ providers: roster.providers.length }, "generic");
      const offered = new Set(roster.providers.flatMap((p) => p.services));
      const uncovered = roster.services.filter((s) => !offered.has(s)).length;
      const counts = { services: roster.services.length, uncovered, providers: roster.providers.length };
      if (uncovered > 0) {
        return finding(
          "warn",
          "A service no active provider offers is booked on the location's shared calendar. Ask the clinic to map it in Settings, Booking detail.",
          counts,
        );
      }
      return pass(counts, "named_provider");
    }),
};

const rosterProvidersHaveServices: AuditCheck = {
  id: "roster_providers_have_services",
  pack: "roster",
  label: "Under named providers, no active provider is left with no service",
  run: (ctx) =>
    ctx.read(async (tx) => {
      const roster = await readRoster(tx);
      if (!roster.named) return pass({ providers: roster.providers.length }, "generic");
      const idle = roster.providers.filter((p) => p.services.length === 0).length;
      const counts = { providers: roster.providers.length, idle };
      if (roster.providers.length === 0) {
        return finding(
          "warn",
          "Named providers is chosen and no provider is active: every service books on the shared calendar.",
          counts,
        );
      }
      if (idle > 0) {
        return finding("warn", "An active provider offers no service, so AYA never books with them.", counts);
      }
      return pass(counts, "named_provider");
    }),
};

const rosterCalendarHealthy: AuditCheck = {
  id: "roster_calendar_healthy",
  pack: "roster",
  label: "Under named providers, the Google Calendar the providers book through is working",
  run: (ctx) =>
    ctx.read(async (tx) => {
      const roster = await readRoster(tx);
      if (!roster.named || roster.providers.length === 0) return pass({}, "generic");
      const connection = await googleCalendarConnection(tx);
      if (!connection || connection.status !== "active" || connection.brokenAt !== null) {
        return finding(
          "fail",
          "Named providers book through Google Calendar, and the connection is not working: send the clinic a calendar link.",
          { providers: roster.providers.length },
          connection?.status ?? "not_connected",
        );
      }
      return pass({ providers: roster.providers.length }, "active");
    }),
};

// -----------------------------------------------------------------------------
// The go-live pack (item 7)
// -----------------------------------------------------------------------------

const goLiveChecks: AuditCheck[] = GO_LIVE_CODES.map((code) => ({
  id: `golive_${code}`,
  pack: "golive" as const,
  label: `Go-live: ${code}`,
  run: (ctx: AuditContext) =>
    ctx.read(async (tx) => {
      const read = await readGoLiveCheck(tx, ctx.now);
      if (!read) return NO_CLINIC;
      if (read.production) return pass({}, "live");
      const missing = read.check.missing.find((m) => m.code === code);
      if (!missing) return pass();
      // The operator's fixed words for the code, from lib/onboarding/go-live.ts.
      return { result: "fail" as const, hint: missing.text, counts: {}, code, side: missing.side };
    }),
}));

// -----------------------------------------------------------------------------
// The transcripts pack (item 11)
// -----------------------------------------------------------------------------

const transcriptsDelivered: AuditCheck = {
  id: "transcripts_7_days",
  pack: "transcripts",
  label: "Every transcript of the last 7 days reached the clinic",
  run: (ctx) =>
    ctx.read(async (tx) => {
      const { counts } = await listTranscriptDeliveries(tx, 7, 1);
      const held = await tx.db.execute<{ n: number }>(sql`
        select count(*)::int as n from transcript_emails t
         where t.clinic_id = ${tx.clinicId}
           and t.status in ('pending', 'sent', 'bounced')
           and t.created_at < ${new Date(ctx.now.getTime() - 3_600_000)}
           and t.created_at > ${new Date(ctx.now.getTime() - 7 * 86_400_000)}`);
      const heldOverHour = Number(held.rows[0]?.n ?? 0);
      const all = { ...counts, heldOverHour };
      if (counts.expired > 0 || counts.unconfirmed > 0) {
        return finding(
          "fail",
          "A transcript was never confirmed delivered and its copy is gone: the clinic never had it. See the clinic's transcripts page.",
          all,
        );
      }
      if (counts.bounced > 0 || heldOverHour > 0) {
        return finding("warn", "A transcript bounced or has waited more than an hour: the outbox keeps retrying.", all);
      }
      return pass(all);
    }),
};

/** Every check, in the order a pack runs and shows them. */
export const CHECKS: readonly AuditCheck[] = [
  hoursValid,
  closuresStored,
  bookingMode,
  calendarReachable,
  slotsHonourClosures,
  bookingsOnClosedDays,
  voiceAnswersClosedDays,
  voiceAgentCurrent,
  webChatLive,
  assistantKnowsClosures,
  rosterServicesCovered,
  rosterProvidersHaveServices,
  rosterCalendarHealthy,
  ...goLiveChecks,
  transcriptsDelivered,
];

export function checksFor(pack: AuditPack): AuditCheck[] {
  return CHECKS.filter((check) => check.pack === pack);
}
