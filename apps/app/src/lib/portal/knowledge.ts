import { createHash } from "node:crypto";

import { findClinicalContent } from "@healdesk/catalog";
import { eq, sql } from "drizzle-orm";

import { agentConfigs, clinics } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { describeError, log } from "@/lib/log";
import { enqueuePlanNotice } from "@/lib/notices/plan-notices";
import { publicOriginProblem, publicUrl } from "@/lib/public-url";
import { requestPracticeQuestions } from "@/lib/engine/practice/store";
import type { PracticeSection } from "@/lib/engine/practice/types";
import { clinicDefaultDepositUsd } from "@/lib/billing/deposits";
import {
  KnowledgeError,
  neverSayWithDefaults,
  type KnowledgeWriteOptions,
  readKnowledge,
  saveNeverSay,
  savePolicies,
  savePromotions,
  saveQuickAnswers,
  saveServices,
  validateNeverSay,
  validatePolicies,
  validatePromotions,
  validateQuickAnswers,
  validateServices,
} from "@/lib/setup/knowledge";
import { PracticeError, readUpcomingClosures, saveBasics, saveHours } from "@/lib/setup/practice";
import { readSetupState } from "@/lib/setup/state";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { appliesWhen } from "./applies";
import { clinicActorOf, readChangeStatusLine, type ChangeOrigin } from "@/lib/clinic/change-events";

/**
 * Knowledge (plan Part F3; spec, "Knowledge: quick edits, no re-scrape
 * needed"): the practice, its prices, promotions, quick answers, never-say
 * and hours. Each section saves on its own, through the writers the setup
 * wizard uses (lib/setup/knowledge.ts and practice.ts), which screen every
 * text with findClinicalContent and name the phrase they refuse. Knowledge
 * adds the offer of a rewrite: the same text without the sentence that was
 * refused, when what is left passes, so the clinic can take it in one tap.
 *
 * Edits apply at once. The practice questions that check AYA against this
 * knowledge are the engine's (lib/engine/practice): `practiceQuestionsSeam`
 * below is where a save asks for them to run again, in the background,
 * never taking AYA offline (Part F3).
 */

export const KNOWLEDGE_SECTIONS = [
  "practice",
  "policies",
  "prices",
  "promotions",
  "quick_answers",
  "never_say",
  "never_say_defaults",
  "hours",
] as const;
export type KnowledgeSection = (typeof KNOWLEDGE_SECTIONS)[number];

export function isKnowledgeSection(value: unknown): value is KnowledgeSection {
  return typeof value === "string" && (KNOWLEDGE_SECTIONS as readonly string[]).includes(value);
}

export type KnowledgeContext = { clinicId: string; userId: string; actorLabel: string };

export type KnowledgeResult =
  | {
      ok: true;
      toast: string;
      /** Where the save's next look is: Bookings, when a day just closed already has bookings. */
      link?: { href: string; label: string };
    }
  | {
      ok: false;
      field: string;
      message: string;
      /** The refused text without what was refused, when that passes: "Try this instead". */
      rewrite?: string;
    };

export async function saveKnowledge(
  ctx: KnowledgeContext,
  section: unknown,
  input: unknown,
  now: Date = new Date(),
): Promise<KnowledgeResult> {
  if (!isKnowledgeSection(section)) {
    return { ok: false, field: "section", message: "That isn't part of Your practice." };
  }
  const body = (input ?? {}) as Record<string, unknown>;
  const actor: ActorContext = { type: "user", userId: ctx.userId, label: ctx.actorLabel };
  let saved: { toast: string; hours: HoursNoteInput | null };
  try {
    saved = await withTenant({ clinicId: ctx.clinicId, actor }, async (tx) => {
      // Read before the write, so its closed days are the ones the hours
      // note compares the saved ones with.
      const state = await readSetupState(tx, { userId: ctx.userId, now });
      if (!state) throw new KnowledgeError("section", "This clinic could not be found.");
      if (state.clinic.offboardingStartedAt) {
        throw new KnowledgeError(
          "section",
          "This account has closed, so its knowledge can't change.",
        );
      }
      const said = await write(
        tx,
        section,
        body,
        state.clinic.specialty,
        state.clinic.timezone,
        now,
        await knowledgeWriteOptions(tx),
        { source: "portal", actor: clinicActorOf(ctx.actorLabel) },
      );
      await practiceQuestionsSeam(tx, section, now);
      const applies = appliesWhen(state.channels);
      return {
        toast: applies ? `${said} ${applies}` : `${said} AYA uses it from now on.`,
        hours:
          section === "hours"
            ? {
                closedBefore: state.closures.map((c) => c.closedOn),
                timeZone: state.clinic.timezone,
                slug: state.clinic.slug,
              }
            : null,
      };
    });
  } catch (error) {
    if (error instanceof KnowledgeError || error instanceof PracticeError) {
      const rewrite = rewriteFor(section, body, error.field);
      return rewrite
        ? { ok: false, field: error.field, message: error.message, rewrite }
        : { ok: false, field: error.field, message: error.message };
    }
    throw error;
  }
  if (!saved.hours) return { ok: true, toast: saved.toast };
  const note = await hoursNote(ctx.clinicId, actor, saved.hours, now);
  return note
    ? {
        ok: true,
        toast: `${saved.toast} ${note.text}`,
        link: { href: `/c/${saved.hours.slug}/bookings#booked`, label: note.label },
      }
    : { ok: true, toast: saved.toast };
}

export type HoursNoteInput = { closedBefore: string[]; timeZone: string; slug: string };

/** What a save newly closed: the count for the note, and each closing for the email's key. */
type NewlyClosed = { count: number; closings: string[] };

/**
 * The count behind the hours note, and the email that backs it, as seams:
 * tests make either fail to show the save stands without it.
 */
export const closedDayNoteSeam = {
  count: (tx: TenantTx, input: HoursNoteInput, now: Date) =>
    bookingsOnNewlyClosedDays(tx, input.closedBefore, input.timeZone, now),
  email: (tx: TenantTx, input: HoursNoteInput, closings: readonly string[]) =>
    queueClosedDayBookingsEmail(tx, input.slug, closings),
};

/**
 * The note about bookings on days the save just closed, read after the
 * save has committed and in its own transaction: it is a courtesy, so a
 * failure here (a timeout, a zone the database refuses) costs the note,
 * never the clinic's hours. When there are any, the clinic is also emailed
 * (O17, owner decision D10), in a transaction of its own again, so a
 * failure to queue the email costs the email, never the note or the save.
 * Each failure is logged with the clinic id and the error's kind only.
 */
export async function hoursNote(
  clinicId: string,
  actor: ActorContext,
  input: HoursNoteInput,
  now: Date,
): Promise<{ text: string; label: string } | null> {
  let found: NewlyClosed;
  try {
    found = await withTenant({ clinicId, actor }, (tx) => closedDayNoteSeam.count(tx, input, now));
  } catch (error) {
    log.warn("closed-day bookings note skipped", { clinicId, error: describeError(error) });
    return null;
  }
  if (found.count > 0) {
    try {
      await withTenant({ clinicId, actor }, (tx) =>
        closedDayNoteSeam.email(tx, input, found.closings),
      );
    } catch (error) {
      log.warn("closed-day bookings email not queued", { clinicId, error: describeError(error) });
    }
  }
  return bookedOnClosedDaysNote(found.count);
}

/**
 * O17 to the clinic's one address: a pointer into Bookings, carrying no
 * name, time, service, date or count (lib/email/templates/closed_day_bookings.ts).
 * Returns whether this call queued it.
 *
 * Its dedupe key is one closing of a set of days, not the days alone: a
 * hash of each newly closed day with the created_at of its clinic_closures
 * row, the moment that day was closed (saveHours keeps a row for as long as
 * the day stays closed). So:
 *   - the same closing seen twice (a retried note, two saves racing to close
 *     the same day, which meet on the one row) is one key and one email;
 *   - a day closed, opened again and closed again is a new row, a new
 *     created_at and a new key, so the clinic hears again;
 *   - nothing about the moment of the call (`now`) is in the key.
 * A hash, so the dates never sit in the outbox.
 */
export async function queueClosedDayBookingsEmail(
  tx: TenantTx,
  slug: string,
  closings: readonly string[],
): Promise<boolean> {
  if (closings.length === 0) return false;
  const problem = publicOriginProblem();
  if (problem) throw new Error(`closed-day bookings email needs a public origin: ${problem}`);
  const set = createHash("sha256")
    .update([...new Set(closings)].sort().join(","))
    .digest("hex")
    .slice(0, 32);
  return enqueuePlanNotice(tx.db, tx.clinicId, "closed_day_bookings", `closed_day_bookings:${set}`, {
    bookingsUrl: publicUrl(`/c/${slug}/bookings#booked`),
  });
}

/**
 * Once the clinic has gone live, Knowledge's edits keep the approval of the
 * agent's words: they apply at once, and AYA stays on while the practice
 * questions check them again (Part F3). Before go-live they clear it, as the
 * wizard's own writes do (lib/setup/knowledge.ts): go-live requires the
 * approval (lib/onboarding/go-live.ts), and one given before an edit must
 * not carry words nobody has checked into the first patient conversation.
 */
export async function knowledgeWriteOptions(tx: TenantTx): Promise<KnowledgeWriteOptions> {
  const [clinic] = await tx.db
    .select({ wentLiveAt: clinics.wentLiveAt })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  return { keepApproval: clinic?.wentLiveAt != null };
}

/**
 * How many of AYA's bookings and requests still to come fall on a day this
 * save closed that was open before it (owner decision D10), each counted
 * once:
 *
 *   - an appointment Bookings lists (from a request, as
 *     lib/portal/bookings.ts reads them), scheduled or confirmed;
 *   - a request still waiting for staff (requested, accepted or
 *     rescheduling) that holds a time: a live slot hold (a deposit
 *     reservation, a write in flight) or, while rescheduling, a proposed slot.
 *
 * A request that names its time only in words ("Thursday afternoon", as a
 * request taken in manual booking mode does) has no date to compare and is
 * not counted. Each row counts under its appointment when it has one, else
 * its request, so two rows about one booking count once.
 *
 * A count and nothing else: no name, time or service leaves here, and
 * nobody is contacted. The closure itself cancels nothing; the clinic
 * decides what to do with each from Bookings.
 */
export async function bookingsOnNewlyClosedDays(
  tx: TenantTx,
  closedBefore: readonly string[],
  timeZone: string,
  now: Date,
): Promise<NewlyClosed> {
  const before = new Set(closedBefore);
  const added = (await readUpcomingClosures(tx.db, tx.clinicId, timeZone, now))
    .map((c) => c.closedOn)
    .filter((day) => !before.has(day));
  if (added.length === 0) return { count: 0, closings: [] };
  const days = sql`array[${sql.join(
    added.map((d) => sql`${d}`),
    sql`, `,
  )}]::text[]`;
  const localDay = (at: ReturnType<typeof sql>) =>
    sql`((${at} at time zone ${timeZone})::date)::text = any(${days})`;
  const result = await tx.db.execute<{ n: number }>(sql`
    select count(distinct k)::int as n from (
      select a.id::text as k
        from appointments a
        join booking_requests br on br.appointment_id = a.id and br.clinic_id = a.clinic_id
       where a.clinic_id = ${tx.clinicId}
         and a.status in ('scheduled', 'confirmed')
         and a.scheduled_for > ${now}
         and ${localDay(sql`a.scheduled_for`)}
      union all
      select coalesce(br.appointment_id::text, br.id::text)
        from booking_requests br
        join slot_holds h on h.booking_request_id = br.id and h.clinic_id = br.clinic_id
       where br.clinic_id = ${tx.clinicId}
         and br.status in ('requested', 'accepted', 'rescheduling')
         and h.status in ('held', 'reserved', 'writing', 'unknown')
         and h.starts_at > ${now}
         and ${localDay(sql`h.starts_at`)}
      union all
      select coalesce(br.appointment_id::text, br.id::text)
        from booking_requests br
        cross join lateral jsonb_array_elements(br.proposed_slots) s
       where br.clinic_id = ${tx.clinicId}
         and br.status = 'rescheduling'
         and (s->>'at')::timestamptz > ${now}
         and ${localDay(sql`(s->>'at')::timestamptz`)}
    ) counted`);
  // Each newly closed day with the moment its row was written: the closing
  // the email's dedupe key names (queueClosedDayBookingsEmail).
  const rows = await tx.db.execute<{ closing: string }>(sql`
    select closed_on::text || '@' || created_at::text as closing
      from clinic_closures
     where clinic_id = ${tx.clinicId} and closed_on::text = any(${days})`);
  return { count: result.rows[0]?.n ?? 0, closings: rows.rows.map((r) => r.closing) };
}

/** The clinic's one line about bookings on days it just closed, and its link's words; null for none. */
export function bookedOnClosedDaysNote(count: number): { text: string; label: string } | null {
  if (count <= 0) return null;
  return count === 1
    ? {
        text: "One booking or request falls on a day you just closed. It stays as it is.",
        label: "See it in Bookings",
      }
    : {
        text: `${count} bookings or requests fall on the days you just closed. They stay as they are.`,
        label: "See them in Bookings",
      };
}

async function write(
  tx: TenantTx,
  section: KnowledgeSection,
  body: Record<string, unknown>,
  specialty: string,
  timeZone: string,
  now: Date,
  options: KnowledgeWriteOptions,
  origin: ChangeOrigin,
): Promise<string> {
  switch (section) {
    case "practice":
      await saveBasics(
        tx,
        {
          name: body.name,
          address: body.address,
          phone: body.phone,
          website: body.website,
          timezone: body.timezone,
        },
        now,
      );
      return "Your practice's details are saved.";

    case "policies": {
      const policies = validatePolicies(body.policies);
      await savePolicies(tx, policies, now, options);
      return policies.length === 1 ? "One policy saved." : `${policies.length} policies saved.`;
    }

    case "prices": {
      // Every row here shows its deposit, and a blank one reads "None": no
      // deposit, stored as 0, which BD27 reads as none even when the clinic
      // has a default (null would mean that default). The wizard's Deposits
      // screen stores "None" the same way (lib/setup/save.ts).
      const services = validateServices(body.services, specialty).map((service) =>
        service.depositUsd === null || service.depositUsd === undefined
          ? { ...service, depositUsd: 0 }
          : service,
      );
      await saveServices(tx, services, now, options);
      return services.length === 1
        ? "One service saved. AYA quotes only the prices listed here."
        : `${services.length} services saved. AYA quotes only the prices listed here.`;
    }

    case "promotions": {
      const promotions = validatePromotions(body.promotions);
      await savePromotions(tx, promotions, now, options);
      return promotions ? "Promotions saved." : "Promotions cleared: AYA has none to mention.";
    }

    case "quick_answers": {
      const answers = validateQuickAnswers(body.quickAnswers);
      await saveQuickAnswers(tx, answers, now, options);
      return answers.length === 1
        ? "One quick answer saved."
        : `${answers.length} quick answers saved.`;
    }

    case "never_say": {
      const phrases = validateNeverSay(body.neverSay);
      await saveNeverSay(tx, phrases, now, options);
      return phrases.length === 1
        ? "One phrase AYA never says."
        : `${phrases.length} phrases AYA never says.`;
    }

    case "never_say_defaults": {
      // The clinical defaults back at the top, with the clinic's own after them.
      const { neverSay } = await readKnowledge(tx.db, tx.clinicId);
      const restored = neverSayWithDefaults(neverSay);
      await saveNeverSay(tx, restored, now, options);
      return "The defaults are back on the never-say list, with your own phrases after them.";
    }

    case "hours":
      await saveHours(tx, { hours: body.hours, closures: body.closures }, timeZone, now, origin);
      return "Hours saved. AYA offers nothing on a closed day and tells people when you're open.";
  }
}

/**
 * The deposit Knowledge shows on a price row, in dollars, or "" for none: the
 * service's own amount, or, for a row that follows the clinic default
 * (`depositUsd` null, BD27), that default, so the screen shows what AYA asks
 * for and saving the row as it stands keeps it. A 0 is none.
 */
export function depositShown(own: number | null | undefined, clinicDefault: number | null): string {
  if (own !== null && own !== undefined) return own > 0 ? String(own) : "";
  return clinicDefault !== null && clinicDefault > 0 ? String(clinicDefault) : "";
}

/** The clinic default deposit (agent_configs.deposit_policy), or null when it has none. */
export async function readClinicDefaultDeposit(
  clinicId: string,
  actor: ActorContext,
): Promise<number | null> {
  return withTenant({ clinicId, actor }, async (tx) => {
    const [row] = await tx.db
      .select({ policy: agentConfigs.depositPolicy })
      .from(agentConfigs)
      .where(eq(agentConfigs.clinicId, tx.clinicId))
      .limit(1);
    return clinicDefaultDepositUsd(row?.policy);
  });
}

/** Each Knowledge section as the practice questions name it (O9, Home). */
const PRACTICE_SECTION: Readonly<Record<KnowledgeSection, PracticeSection>> = {
  practice: "practice",
  policies: "policies",
  prices: "prices",
  promotions: "promotions",
  quick_answers: "quick_answers",
  never_say: "never_say",
  never_say_defaults: "never_say",
  hours: "hours",
};

/**
 * A knowledge change asks for the practice questions to run again (plan Part
 * G), two minutes after the last change, in the background
 * (lib/engine/practice). Asked in the save's own transaction, so a save that
 * rolls back asks for nothing. A failure there shows "We're double-checking
 * your change" on Home and tells ops (practice_question_failed), and never
 * takes AYA offline: the run approves, or it does not, and that is all.
 */
export async function practiceQuestionsSeam(
  tx: TenantTx,
  section: KnowledgeSection,
  now: Date = new Date(),
): Promise<void> {
  await requestPracticeQuestions(tx, { reason: "knowledge", section: PRACTICE_SECTION[section], now });
}

// -----------------------------------------------------------------------------
// "Try this instead"
// -----------------------------------------------------------------------------

/**
 * The refused text with the sentences the clinical screen refuses taken out,
 * when what is left is not empty and passes. Null when there is nothing to
 * offer: the clinic rewrites it itself, with the phrase named.
 */
export function rewriteWithout(text: string): string | null {
  const sentences = text.match(/[^.!?\n]+[.!?]*\s*/g) ?? [text];
  const kept = sentences.filter((s) => findClinicalContent({ s }).length === 0);
  const rewrite = kept.join("").replace(/\s+/g, " ").trim();
  if (!rewrite || rewrite === text.trim()) return null;
  return findClinicalContent({ rewrite }).length === 0 ? rewrite : null;
}

/** The text a refusal was about, by the field the writer named, and its rewrite. */
function rewriteFor(
  section: KnowledgeSection,
  body: Record<string, unknown>,
  field: string,
): string | null {
  const indexed = /^(\w+)\[(\d+)\](?:\.(question|answer))?$/.exec(field);
  if (section === "promotions" && typeof body.promotions === "string") {
    return rewriteWithout(body.promotions);
  }
  if (section === "policies" && indexed?.[1] === "policies" && Array.isArray(body.policies)) {
    const text = body.policies[Number(indexed[2])];
    return typeof text === "string" ? rewriteWithout(text) : null;
  }
  if (
    section === "quick_answers" &&
    indexed?.[1] === "quickAnswers" &&
    Array.isArray(body.quickAnswers)
  ) {
    const row = (body.quickAnswers[Number(indexed[2])] ?? {}) as Record<string, unknown>;
    const text = row[indexed[3] ?? "answer"];
    return typeof text === "string" ? rewriteWithout(text) : null;
  }
  return null;
}

/**
 * The Hours card's status line (design E4 §3.D): "In use since 2:14 pm." for
 * the newest change to the hours or closed days. Null when the clinic has
 * changed neither since the record began.
 */
export function hoursStatusLine(
  clinicId: string,
  actor: ActorContext,
  timeZone: string,
  now: Date = new Date(),
): Promise<string | null> {
  return readChangeStatusLine(clinicId, actor, ["hours", "closures"], timeZone, now);
}
