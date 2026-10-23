import { agreementStatesThePurge } from "@/lib/agreements/what-it-says";
import { and, eq, gt, inArray, lt, lte, or, sql } from "drizzle-orm";

import {
  appointments,
  bookingRequests,
  chatThreads,
  clinicSettings,
  clinics,
  contacts,
  conversations,
  handovers,
  metaBookingDrafts,
  metaInboundMessages,
  patientRequests,
  reconciliationExceptions,
  recordAmendments,
  retellRecordingAlerts,
  slotHolds,
  syncRuns,
  transactions,
  webhookEvents,
} from "@/db/schema";
import {
  CHAT_THREAD_IDLE_RETENTION_DAYS,
  META_MESSAGE_REF_RETENTION_DAYS,
} from "@/lib/billing/housekeeping";
import { DRAFT_TTL_HOURS } from "@/lib/meta/booking-requests";
import { linkCallHandovers } from "@/lib/handovers/record";
import type { TenantTx } from "@/lib/tenant";

/**
 * Retention: the delete the agreements already promise.
 *
 * Until this existed nothing in the product deleted anything. Every
 * conversation, transcript reference and appointment accumulated for as long
 * as the database did, which meant a breach in year five disclosed five years
 * of calls instead of the last ninety days, and the BAA's "return or destroy"
 * clause had no code behind it.
 *
 * ## Two clocks, per clinic
 *
 * `clinics.retention_media_days` (default 90) removes the transcript
 * REFERENCE from a conversation, sooner when the practice has shortened its
 * transcripts in the portal (`clinic_settings.transcript_retention_days`,
 * 30 or 7 days; it can only shorten, and reaches no other record). healdesk keeps no audio (decision of
 * 21 September 2026); the voice vendor holds a call's recording with its
 * transcript until healdesk has the transcript, and the backstop deletes the
 * call there within a day (22 October 2026, docs/hipaa-risk-analysis.md T5). The transcript text itself lives with the
 * voice vendor under its own retention setting, which must be at most this
 * window. Nulling the reference here is what stops the product from ever
 * pointing at it again; it is not, and does not claim to be, the deletion of
 * the bytes.
 *
 * `clinics.retention_record_days` (default 90) deletes the conversation,
 * appointment, booking request and transaction rows themselves, and then any
 * contact that no longer has a row of any kind. 90 days because the BAA says
 * "healdesk keeps transcripts and conversation records for 90 days, which
 * Practice may shorten in its portal" (TRANSCRIPT_RETENTION_DAYS in
 * @healdesk/catalog). Until 0048 the default was 730, for a year-over-year
 * revenue report that is phase two, so every clinic left at the default kept
 * its records eight times as long as its agreement said.
 *
 * A booking request goes once every date it carries is past the clock: when
 * it was made, the slot it was confirmed for, and its appointment's time.
 * Requests lead the deletes because a confirmed one must keep its appointment
 * (CHECK, 0039) and cannot be rewritten (trigger, 0041), and the runtime role
 * has no DELETE on them, so app_purge_booking_requests() deletes them. It
 * judges a request by its first two dates, which are frozen once it is
 * decided, as well as the third, which the runtime role and a sync can move,
 * so no booking still ahead loses its request. It refuses a cutoff later than
 * the record clock in force by the database's clock (app_record_cutoff(): for
 * a day after the clock is shortened, the longer clock it replaced), so the
 * clock cannot be shortened, used and put back in one go. An appointment a
 * remaining request still holds waits for the night the request goes. A Meta
 * draft abandoned for a day goes here too, as a backstop to the sweep the
 * clinic's next Meta message runs, and a messaging thread (chat_threads)
 * once its last message is past the record clock. An amendment Practice
 * directed (record_amendments, lib/patient-rights/amendments.ts) goes the
 * night the booking request, appointment or conversation it amends goes, in
 * the same call, and never before.
 *
 * ## The periods, as BAA 1.3.0's, 1.4.0's, 1.5.0's and 1.5.1's clause 11 state them
 *
 * The record clock is the clinic's `retention_record_days`
 * (TRANSCRIPT_RETENTION_DAYS, 90, unless the practice shortens it):
 *
 *   - a conversation, with its transcript reference: the record clock after
 *     it took place (the media clock clears the reference sooner). 1.4.0
 *     calls it "the record of each conversation, without what was said or
 *     written in it": since 13 October 2026 no row carries a reference, and
 *     the transcript itself waits only in the outbox, until the clinic's mail
 *     server confirms delivery and never past 30 days (since 14 October 2026;
 *     lib/conversations/transcript-outbox.ts), its receipt going with its
 *     conversation;
 *   - an appointment: the record clock after its time;
 *   - a booking request: the record clock after the latest of when it was
 *     made, the time it was confirmed for and its appointment's time;
 *   - a contact: while any of those of theirs is kept, and in any case the
 *     record clock after it was last written;
 *   - a messaging thread: thirty days after its last message, or the record
 *     clock or the transcript clock if either is shorter;
 *   - an amendment Practice directed: with the request, appointment or
 *     conversation it amends, and never before;
 *   - a vendor payload (webhook_events), the raw copy of a call or a
 *     booking: once processed, thirty days after it arrived
 *     (WEBHOOK_PAYLOAD_RETENTION_DAYS) or the record clock if that is
 *     shorter; never processed (its signature failed, it named no call, or
 *     every attempt to read it failed), the record clock, the period of the
 *     conversation it would have become; either way never past the
 *     transcript clock, since a call's payload carries its transcript.
 *     Until BAA 1.3.0's release gate 9 (PT-28) a payload never processed was
 *     never deleted;
 *   - a half-collected Meta draft: a day (DRAFT_TTL_HOURS);
 *   - a handled Meta message's keyed reference (meta_inbound_messages), kept
 *     only to recognise Meta's redelivery: seven days
 *     (META_MESSAGE_REF_RETENTION_DAYS), or the record clock if shorter.
 *     Until 19 October 2026 only billing-housekeeping deleted these, and it
 *     ships switched off (drizzle/0043), so the "purged after 7 days" in
 *     lib/meta/inbound.ts held only once someone switched it on;
 *   - a deposit: with its appointment, or, once its appointment is gone, the
 *     record clock after it was made (app_purge_deposit_payments, 0067);
 *   - a patient's request passed to the practice (L32, drizzle/0094): the
 *     record clock after it reached healdesk, marked received or not. The
 *     agreements state no period of their own for it; the record clock is
 *     the longest of the periods they do state, and outlasts the practice's
 *     own windows for answering the person (30 days for access, 60 for an
 *     amendment, under HIPAA), while it may still want to see what was asked.
 *     Its contact is not kept for it: when the contact's own clock takes it,
 *     the request keeps no one (its foreign key sets contact_id to NULL).
 *
 * A handover (someone asked for a person, drizzle/0092) is part of the
 * record of the conversation it was asked in, and holds nothing of its own:
 * it goes with that conversation, or with its messaging thread, and in any
 * case the record clock after it was asked.
 *
 * Each cutoff taken by one of these periods is a day early (periodCutoff):
 * the job runs at 03 and 09 UTC, so a cutoff of exactly the period kept a
 * row up to eighteen hours past it, or a day more after a missed tick, and
 * clause 4 keeps it "no longer than the periods this agreement states".
 *
 * A backup copy of anything deleted here expires with the host's backups,
 * within BACKUP_RETENTION_DAYS.
 *
 * ## Which clinics, and the switch
 *
 * The `retention-purge` job ships switched off (0032), and its switch is
 * one for every clinic. A clinic bound to BAA 1.3.0 or later,
 * or to the DPA, which state these periods as the purge runs them, is purged
 * every night whether the switch is on or not (`purgeIsPromised`; release
 * gate 9): the agreement it signed does not wait for an operator. The switch
 * adds every other clinic, and the owner turns it on at the release of 1.3.0
 * (docs/handover.md, "Retention and offboarding").
 *
 * ## What the record clock never purges, and why
 *
 * `consent_records`, `suppressions` and `contact_attempts` are not on the
 * record clock. A suppression is a person's "stop", and has to outlast the
 * rows it stopped; all three are append-only by grant (0010). None of them
 * stays for good, though: a person's go when that person is erased
 * (app_erase_contact_evidence, through the erase path in
 * lib/patient-rights/erasure.ts), and the rest with the clinic's data when it
 * is destroyed at offboarding (destroyClinicData in lib/offboarding, through
 * app_destroy_contact_evidence, drizzle/0058). They were kept past that as
 * the TCPA evidence that an outbound contact was lawful, but v1 contacts no
 * one first, so there is nothing for them to evidence, and every agreement's
 * return-or-destroy clause reaches them (BAA 1.3.0 release gate 7). An
 * erasure is recorded in `erasure_requests`, without the number, and that
 * record has its own clock: BACKUP_RETENTION_DAYS, run hourly by
 * expireErasureRecords. `audit_log` is append-only by grant.
 * `baa_acceptances` has its own six-year floor (0025) and is never swept by
 * anything.
 *
 * ## Tenant isolation is the API, not a check
 *
 * Every function here takes a `TenantTx`: it cannot be called without a
 * tenant transaction, and inside one RLS scopes every statement to that
 * clinic. tests/retention.test.ts asserts both that a purge leaves the other
 * clinic untouched and that the same statements with no tenant set delete
 * nothing at all.
 */

/**
 * A processed vendor payload's period: thirty days after it arrived, or the
 * clinic's record clock if that is shorter. Processed, it has done its work
 * (the conversation, appointment or request it became is the record), and
 * the copy is kept only to re-read a payload found to be misparsed.
 */
export const WEBHOOK_PAYLOAD_RETENTION_DAYS = 30;
/** A slot hold that has stopped blocking is kept a week at most (plan §11.8), less on a shorter record clock. */
export const SLOT_HOLD_RETENTION_DAYS = 7;
/**
 * A Retell call alert (drizzle/0105) once resolved, that is once Retell no
 * longer holds the call, is kept thirty days after it was resolved, so the
 * operator can still see on /admin/recordings what was fixed, and then goes.
 * It never held a patient's words or number, only Retell's call id, times and
 * our own reason. An open alert is never purged: it is the only sign that
 * Retell still holds a call, and it goes only when resolved, or with the
 * clinic's destruction (drizzle/0106).
 */
export const RECORDING_ALERT_RESOLVED_RETENTION_DAYS = 30;

/**
 * A sync run started longer ago than this is a crashed one, not one in
 * flight: sync_runs is append-only by grant (0015), so a run that died
 * leaves its row "running" for good, and without a bound it would hold the
 * purge off that clinic forever. The nightly sync starts at 02 and the purge
 * at 03, so a held clinic would be skipped every night; the purge runs again
 * at 09 (lib/scheduler/tick.ts), when a hold from 02 has run out.
 */
export const SYNC_HOLDS_PURGE_HOURS = 6;

/**
 * What the nightly purge does with each table that has a clinic_id: the
 * tables it deletes from, each with its clock, and every other, with the
 * reason the purge leaves it (a separate clock, a separate job, or a record
 * the purge has no period for). tests/retention.test.ts holds this map to
 * the catalog, so a new tenant table fails it until someone decides which
 * side it is on, and holds the purged side to what purgeClinic deletes.
 */
export const PURGE_COVERAGE: Readonly<{
  purged: Readonly<Record<string, string>>;
  notPurged: Readonly<Record<string, string>>;
}> = {
  purged: {
    conversations: "the record clock after it took place (its transcript reference sooner, by the media clock)",
    appointments: "the record clock after its time, once no remaining request holds it",
    booking_requests: "the record clock after its latest date (app_purge_booking_requests)",
    transactions: "the record clock after it was collected (phase two)",
    reconciliation_exceptions: "with the transaction or appointment it was about (phase two)",
    contacts: "once nothing of theirs is kept, and the record clock after last written",
    record_amendments: "with the request, appointment or conversation it amends",
    deposit_payments: "with its appointment, or the record clock after it was made (app_purge_deposit_payments)",
    webhook_events: "thirty days after it arrived once processed, the record clock if never, the transcript clock at most",
    meta_booking_drafts: "a day (DRAFT_TTL_HOURS)",
    chat_threads: "thirty days after its last message, or the record or transcript clock if shorter",
    meta_inbound_messages: "seven days (META_MESSAGE_REF_RETENTION_DAYS), or the record clock if shorter",
    slot_holds: "a week once it no longer blocks, or the record clock if shorter",
    handovers: "with its conversation or thread (cascade), and in any case the record clock after it was asked",
    patient_requests: "the record clock after it reached healdesk, marked received or not",
    retell_recording_alerts:
      "thirty days after it was resolved (RECORDING_ALERT_RESOLVED_RETENTION_DAYS); an open one never, since it is the only sign Retell still holds a call",
  },
  notPurged: {
    conversation_flags:
      "no clock of its own: goes with the conversation or thread it flags, by cascade, when the purge deletes that",
    incident_affected_contacts:
      "no clock of its own: goes with the contact it names, by cascade, when the purge deletes that, never holding the contact back; the incident keeps the count recorded (incidents.affected_recorded)",
    voice_redial_contexts:
      "its own clock: two hours on the database's clock, deleted on first use and by the minute sweep (app_sweep_redial_contexts), and with its conversation by cascade (lib/voice/redial.ts)",
    transcript_emails:
      "its own clock: the outbox job deletes each sealed copy on delivery and never keeps one past 30 days, and the receipt goes with its conversation by cascade (lib/conversations/transcript-outbox.ts)",
    erasure_requests: "its own clock: expireErasureRecords, hourly, BACKUP_RETENTION_DAYS after the deletion",
    suppressions: "a person's \"stop\", which must outlast what it stopped: goes with the person's erasure, or the clinic's destruction",
    consent_records: "append-only evidence: goes with the person's erasure, or the clinic's destruction",
    contact_attempts: "append-only evidence: goes with the person's erasure, or the clinic's destruction",
    voice_agents:
      "no patient and no clock: the clinic's Retell agent and AYA number (0107), one row it needs while it answers calls and, after it leaves, the record that the number was released; kept for good (KEPT_FOR_GOOD)",
    clinic_closures: "the clinic's closed days, no patient: go with its destruction",
    clinic_providers: "the clinic's providers, no patient: go with its destruction",
    clinic_provider_services: "which services each provider offers, no patient: go with its destruction",
    clinic_setup_screens: "setup progress, no patient: goes with the destruction",
    provider_connections: "the clinic's credentials, no patient: erased on disconnect, deleted at destruction",
    audit_log: "append-only by grant: the record of how the data was handled, the purge's own runs included",
    sync_runs: "append-only by grant (phase two): what each sync ran, no patient; goes when the account closes",
    connection_links: "single-use links, no patient: go when the account closes",
    clinic_memberships: "the access history, no patient: revoked when the account closes, and kept",
    agent_configs: "the clinic's setup, no patient: goes when the account closes",
    clinic_settings: "the clinic's switches, no patient: go when the account closes",
    clinic_settings_history: "append-only by grant, no patient: goes when the account closes",
    report_recipients: "the clinic's own addresses: go when the account closes",
    clinic_touches: "our notes on the account, never a patient: go when the account closes",
    clinic_change_events: "the clinic's changes to hours, closed days and providers, counts and dates, no patient: go when the account closes",
    clinic_audit_claims: "an operator's audit in progress, deleted after the run, no patient: goes when the account closes",
    clinic_audits: "ops audit results, codes and counts, no patient: the last 20 per pack kept (lib/audits/run.ts), the rest go when the account closes",
    practice_question_runs: "synthetic cases, no patient: go when the account closes",
    practice_question_results: "synthetic cases and answers, no patient: go when the account closes",
    audit_review_queue: "ops decisions on synthetic runs, no patient: go when the account closes",
    site_rereads: "reads of the clinic's public website, no patient: go when the account closes",
    clinic_locations: "the account's locations (addresses, lines, hours), no patient: go when the account closes",
    website_changes: "what those reads found, no patient: go when the account closes",
    entitlements: "a billing record, kept (lib/offboarding/account-closure.ts, KEPT_FOR_GOOD)",
    billing_transitions: "a billing record, kept",
    billing_requests: "a billing record, kept",
    billing_notices: "the notices given, no patient: kept",
    report_deliveries: "the ledger of the notices, no patient: kept",
    lifecycle_waves: "the reminder ledger (drizzle/0115), no patient: kept",
    clinic_lifecycle: "the account's setup stage and our decision (drizzle/0115), no patient: kept",
    overage_invoices: "a billing record, kept",
    usage_events: "a billing record, kept",
    channel_events: "a billing record, kept",
    clinic_channels: "a billing record, kept",
    calendar_elections: "part of the signed agreement, kept",
    location_acknowledgements: "part of the agreement: each added location's acceptance of one central assistant, kept",
    agreement_resigns: "contract metadata, kept",
    sign_in_address_changes: "the record of the notice addresses, kept",
    incidents: "the record of each incident and its notice, kept",
  },
};

export type PurgeResult = {
  clinicId: string;
  skipped: "sync_running" | null;
  mediaCleared: number;
  bookingRequestsDeleted: number;
  transactionsDeleted: number;
  appointmentsDeleted: number;
  conversationsDeleted: number;
  contactsDeleted: number;
  draftsDeleted: number;
  webhookEventsDeleted: number;
  chatThreadsDeleted: number;
  slotHoldsDeleted: number;
  /** Deposits whose appointment the record clock took (drizzle/0067). */
  depositsDeleted: number;
  /** Handled Meta messages' keyed references past their seven days. */
  metaMessageRefsDeleted: number;
  /** Handovers past the record clock that their conversation or thread did not take with it (drizzle/0092). */
  handoversDeleted: number;
  /** Patients' requests passed to the practice, past the record clock (drizzle/0094). */
  patientRequestsDeleted: number;
  /** Retell call alerts resolved more than RECORDING_ALERT_RESOLVED_RETENTION_DAYS ago (drizzle/0105). */
  recordingAlertsDeleted: number;
};

const promised = new Map<string, boolean>();

/**
 * Whether the agreement a clinic is on (the version in effect,
 * app_agreement_in_effect) promises the purge's periods, so that the nightly
 * run purges it whatever the job's switch says: read from that version's own
 * text (agreementStatesThePurge), so each version decides by what it says.
 * BAA 1.3.0 and the DPA do; 1.2.2 and earlier do not; a version the catalog
 * does not hold has no text, and promises nothing. Until 12 October 2026
 * every version not on a list of earlier ones counted as promising, and
 * 1.2.2, released after the list was written, would have been purged with
 * the switch off had it not been added by hand (third review).
 */
export function purgeIsPromised(version: string | null): boolean {
  if (version === null) return false;
  let answer = promised.get(version);
  if (answer === undefined) {
    answer = agreementStatesThePurge(version);
    promised.set(version, answer);
  }
  return answer;
}

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * The cutoff for a period the agreement states, a day early. The purge runs
 * at 03 and 09 UTC, so a cutoff of exactly the period kept a row up to
 * eighteen hours past it, and a day more after a missed tick, where BAA
 * 1.3.0's clause 4 keeps it "no longer than the periods this agreement
 * states" (the calendar session's re-audit, C19, 12 October 2026). A day
 * early, every row is gone before its period ends, whichever run takes it.
 * app_record_cutoff() takes the same day (drizzle/0067).
 */
function periodCutoff(now: Date, days: number): Date {
  return daysAgo(now, Math.max(days - 1, 0));
}

/**
 * One clinic, one transaction, on its own two clocks.
 *
 * Refuses to touch a clinic with a sync run in flight (phase two): the
 * reconciler joins appointments to transactions, and deleting one side of a
 * pair it is about to match creates the very exception the report then has
 * to explain. Only a run started in the last SYNC_HOLDS_PURGE_HOURS holds it,
 * so a crashed one cannot keep a clinic's records past its periods.
 */
export async function purgeClinic(tx: TenantTx, now: Date = new Date()): Promise<PurgeResult> {
  const result: PurgeResult = {
    clinicId: tx.clinicId,
    skipped: null,
    mediaCleared: 0,
    bookingRequestsDeleted: 0,
    transactionsDeleted: 0,
    appointmentsDeleted: 0,
    conversationsDeleted: 0,
    contactsDeleted: 0,
    draftsDeleted: 0,
    webhookEventsDeleted: 0,
    chatThreadsDeleted: 0,
    slotHoldsDeleted: 0,
    depositsDeleted: 0,
    metaMessageRefsDeleted: 0,
    handoversDeleted: 0,
    patientRequestsDeleted: 0,
    recordingAlertsDeleted: 0,
  };

  const [running] = await tx.db
    .select({ id: syncRuns.id })
    .from(syncRuns)
    .where(
      and(
        eq(syncRuns.clinicId, tx.clinicId),
        eq(syncRuns.status, "running"),
        gt(syncRuns.startedAt, new Date(now.getTime() - SYNC_HOLDS_PURGE_HOURS * 60 * 60 * 1000)),
      ),
    )
    .limit(1);
  if (running) {
    result.skipped = "sync_running";
    return result;
  }

  const [clinic] = await tx.db
    .select({
      mediaDays: clinics.retentionMediaDays,
      recordDays: clinics.retentionRecordDays,
    })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!clinic) return result;

  // The transcript clock: clinic_settings.transcript_retention_days (90, 30
  // or 7 days) may shorten the media clock, never lengthen it, and reaches
  // transcripts only, no other record (BAA 1.3.0 clause 11, "Practice may
  // shorten the period for transcripts in its portal"). Since 13 October 2026
  // nothing sets it: healdesk keeps no transcript (each is emailed to the
  // clinic; BAA 1.4.0 clause 11), the portal's setting is gone, and new rows
  // carry no transcript_uri. It is still read, because a value saved before
  // only ever makes this delete sooner. A clinic with no settings row keeps
  // the media clock.
  const [settings] = await tx.db
    .select({ transcriptDays: clinicSettings.transcriptRetentionDays })
    .from(clinicSettings)
    .where(eq(clinicSettings.clinicId, tx.clinicId))
    .limit(1);
  const transcriptDays = Math.min(clinic.mediaDays, settings?.transcriptDays ?? clinic.mediaDays);
  const mediaBefore = periodCutoff(now, transcriptDays);
  const recordBefore = periodCutoff(now, clinic.recordDays);
  // A call's handover the database missed linking goes with its
  // conversation from here (drizzle/0092).
  await linkCallHandovers(tx);

  // 1. Media references.
  const cleared = await tx.db
    .update(conversations)
    .set({ transcriptUri: null })
    .where(
      and(
        eq(conversations.clinicId, tx.clinicId),
        lt(conversations.startedAt, mediaBefore),
        sql`${conversations.transcriptUri} is not null`,
      ),
    )
    .returning({ id: conversations.id });
  result.mediaCleared = cleared.length;

  // 2. Slot holds first (plan §11.8). A hold names its contact, request and
  //    appointment, each ON DELETE SET NULL, so the deletes below would
  //    otherwise rewrite holds through the transition trigger. Every hold
  //    that has stopped blocking goes once it is a week old, or older than
  //    the record clock when that is shorter: a hold is made when its
  //    request is, so no hold younger than the clock names a request this
  //    run deletes. One that still blocks is never deleted (the delete
  //    guard, drizzle/0057), and the same predicate keeps it out of reach
  //    here, by the database's clock.
  const holdsBefore = new Date(
    Math.max(daysAgo(now, SLOT_HOLD_RETENTION_DAYS).getTime(), recordBefore.getTime()),
  );
  const holds = await tx.db
    .delete(slotHolds)
    .where(
      and(
        eq(slotHolds.clinicId, tx.clinicId),
        lt(slotHolds.createdAt, holdsBefore),
        sql`not ((${slotHolds.status} = 'held' and ${slotHolds.expiresAt} > clock_timestamp())
                 or (${slotHolds.status} in ('writing', 'unknown', 'reserved')
                     and ${slotHolds.blocksUntil} > clock_timestamp()))`,
      ),
    )
    .returning({ id: slotHolds.id });
  result.slotHoldsDeleted = holds.length;

  // 3. Records, children first. Booking requests lead: one that produced an
  //    appointment holds it, so it goes before it, once its own dates and
  //    its appointment's are all past the clock. Through
  //    app_purge_booking_requests(), as the app role has no DELETE on them,
  //    at the earlier of this job's cutoff and the database's own
  //    (app_record_cutoff(), the record clock in force), in one statement:
  //    the function refuses anything later, so a job clock running ahead of
  //    the database's must not reach it.
  const requests = await tx.db.execute<{ n: number }>(
    sql`select app_purge_booking_requests(least(${recordBefore}::timestamptz, app_record_cutoff())) as n`,
  );
  result.bookingRequestsDeleted = requests.rows[0]?.n ?? 0;

  // Deposits go with their appointments, before them, while the
  // appointment still leads to them (its foreign key on a deposit is SET
  // NULL), and one whose appointment is already gone once it is older than
  // the clock: deposit_payments had no clock but destruction (the calendar
  // session's re-audit, C19). Through app_purge_deposit_payments(), as the
  // runtime role has no DELETE on them, with the Connect event that last
  // touched each, at the same cutoff as the requests.
  const deposits = await tx.db.execute<{ deposits_deleted: number; connect_events_deleted: number }>(
    sql`select * from app_purge_deposit_payments(least(${recordBefore}::timestamptz, app_record_cutoff()))`,
  );
  result.depositsDeleted = deposits.rows[0]?.deposits_deleted ?? 0;

  // Exceptions reference transactions and appointments; they go with the
  // rows they were about.
  const oldTransactions = await tx.db
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.clinicId, tx.clinicId), lt(transactions.collectedAt, recordBefore)));
  // An appointment a remaining request still holds stays until the request
  // goes. Its time can sit before the request's own dates (a sync from the
  // clinic's system writes scheduled_for, lib/sync/upsert.ts), and deleting
  // it would fail the request's foreign key and the whole night's purge.
  const oldAppointments = await tx.db
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        eq(appointments.clinicId, tx.clinicId),
        lt(appointments.scheduledFor, recordBefore),
        sql`not exists (select 1 from ${bookingRequests} r where r.appointment_id = ${appointments.id})`,
      ),
    );
  const transactionIds = oldTransactions.map((r) => r.id);
  const appointmentIds = oldAppointments.map((r) => r.id);

  if (transactionIds.length || appointmentIds.length) {
    await tx.db.delete(reconciliationExceptions).where(
      and(
        eq(reconciliationExceptions.clinicId, tx.clinicId),
        or(
          transactionIds.length
            ? inArray(reconciliationExceptions.transactionId, transactionIds)
            : sql`false`,
          appointmentIds.length
            ? inArray(reconciliationExceptions.appointmentId, appointmentIds)
            : sql`false`,
        ),
      ),
    );
  }
  if (transactionIds.length) {
    const gone = await tx.db
      .delete(transactions)
      .where(and(eq(transactions.clinicId, tx.clinicId), inArray(transactions.id, transactionIds)))
      .returning({ id: transactions.id });
    result.transactionsDeleted = gone.length;
  }
  if (appointmentIds.length) {
    // A newer transaction may still point at an old appointment; detach it
    // rather than lose the money event.
    await tx.db
      .update(transactions)
      .set({ appointmentId: null })
      .where(and(eq(transactions.clinicId, tx.clinicId), inArray(transactions.appointmentId, appointmentIds)));
    // An amended appointment is left to the definer below, which takes it
    // with its amendments: the runtime role cannot delete an amendment, and
    // the foreign key keeps it from deleting what one amends.
    const gone = await tx.db
      .delete(appointments)
      .where(
        and(
          eq(appointments.clinicId, tx.clinicId),
          inArray(appointments.id, appointmentIds),
          sql`not exists (select 1 from ${recordAmendments} ra where ra.appointment_id = ${appointments.id})`,
        ),
      )
      .returning({ id: appointments.id });
    result.appointmentsDeleted = gone.length;
  }
  // An amended appointment goes with its amendments, in one call, at the
  // earlier of this job's cutoff and the database's own, as the booking
  // requests above (app_purge_amended_appointments, drizzle/0064). Its time
  // is one the runtime role and a sync can move, so an amendment never goes
  // on its own: only with the appointment it amends.
  const amendedAppointments = await tx.db.execute<{ n: number }>(
    sql`select app_purge_amended_appointments(least(${recordBefore}::timestamptz, app_record_cutoff())) as n`,
  );
  result.appointmentsDeleted += amendedAppointments.rows[0]?.n ?? 0;

  // An amended conversation goes with its amendments, in one call: the
  // runtime role may delete a conversation but not an amendment, and no
  // conversation goes while one of its amendments remains (record_amendments,
  // a foreign key with no delete action, drizzle/0064), so
  // app_purge_amended_conversations() takes the two together, at the earlier
  // of this job's cutoff and the database's own, as the booking requests
  // above, whose amendments go inside app_purge_booking_requests(). An
  // amendment never goes while what it amends stays. An amended conversation
  // past this job's cutoff but not the database's (a job clock ahead of it,
  // or a clock shortened in the last day) waits for the night it goes.
  const amendedGone = await tx.db.execute<{ n: number }>(
    sql`select app_purge_amended_conversations(least(${recordBefore}::timestamptz, app_record_cutoff())) as n`,
  );
  result.conversationsDeleted = amendedGone.rows[0]?.n ?? 0;
  const oldConversations = await tx.db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.clinicId, tx.clinicId),
        lt(conversations.startedAt, recordBefore),
        sql`not exists (select 1 from ${recordAmendments} ra where ra.conversation_id = ${conversations.id})`,
      ),
    );
  const conversationIds = oldConversations.map((r) => r.id);
  if (conversationIds.length) {
    await tx.db
      .update(appointments)
      .set({ conversationId: null })
      .where(and(eq(appointments.clinicId, tx.clinicId), inArray(appointments.conversationId, conversationIds)));
    const gone = await tx.db
      .delete(conversations)
      .where(and(eq(conversations.clinicId, tx.clinicId), inArray(conversations.id, conversationIds)))
      .returning({ id: conversations.id });
    result.conversationsDeleted += gone.length;
  }
  // A handover goes with its conversation or thread (the foreign keys'
  // cascades), and in any case at the record clock after it was asked: a
  // call whose conversation was never written leaves one pointing at
  // nothing (drizzle/0092). One the database missed linking to its call's
  // conversation is linked first (linkCallHandovers), so it went with it.
  const oldHandovers = await tx.db
    .delete(handovers)
    .where(and(eq(handovers.clinicId, tx.clinicId), lt(handovers.createdAt, recordBefore)))
    .returning({ id: handovers.id });
  result.handoversDeleted = oldHandovers.length;

  // 3b. Patients' requests passed to the practice (L32), the record clock
  //     after each reached healdesk, before the contacts, whose delete would
  //     otherwise clear each one's contact_id first for nothing.
  const requestsPassed = await tx.db
    .delete(patientRequests)
    .where(
      and(eq(patientRequests.clinicId, tx.clinicId), lt(patientRequests.receivedAt, recordBefore)),
    )
    .returning({ id: patientRequests.id });
  result.patientRequestsDeleted = requestsPassed.length;

  // 4. Contacts nothing refers to any more, and that are themselves old. A
  //    request still inside the clock keeps its person: a Meta request reuses
  //    the contact without touching updated_at, and a person a request names
  //    cannot be deleted (booking_requests.contact_id is NO ACTION), so
  //    without this the delete of someone first seen a year ago who asked
  //    again yesterday would fail the whole purge.
  const orphaned = await tx.db
    .delete(contacts)
    .where(
      and(
        eq(contacts.clinicId, tx.clinicId),
        lt(contacts.updatedAt, recordBefore),
        sql`not exists (select 1 from ${conversations} c where c.contact_id = ${contacts.id})`,
        sql`not exists (select 1 from ${appointments} a where a.contact_id = ${contacts.id})`,
        sql`not exists (select 1 from ${transactions} t where t.contact_id = ${contacts.id})`,
        sql`not exists (select 1 from ${bookingRequests} b where b.contact_id = ${contacts.id})`,
      ),
    )
    .returning({ id: contacts.id });
  result.contactsDeleted = orphaned.length;

  // 5. Vendor payloads: raw bodies, PHI by the migration's own admission. A
  //    processed one at thirty days, or the record clock when the clinic
  //    has shortened it below that, so no raw copy outlives the record it
  //    became. One never processed at the record clock: the period of the
  //    conversation it would have been (BAA 1.3.0 release gate 9). And
  //    neither past the transcript clock: a voice payload carries the whole
  //    transcript, so a practice that keeps transcripts seven days must not
  //    keep their raw copy thirty (second review, 12 October 2026).
  const processedBefore = periodCutoff(
    now,
    Math.min(WEBHOOK_PAYLOAD_RETENTION_DAYS, clinic.recordDays, transcriptDays),
  );
  const unprocessedBefore = periodCutoff(now, Math.min(clinic.recordDays, transcriptDays));
  const payloads = await tx.db
    .delete(webhookEvents)
    .where(
      and(
        eq(webhookEvents.clinicId, tx.clinicId),
        or(
          and(sql`${webhookEvents.processedAt} is not null`, lt(webhookEvents.receivedAt, processedBefore)),
          and(sql`${webhookEvents.processedAt} is null`, lt(webhookEvents.receivedAt, unprocessedBefore)),
        ),
      ),
    )
    .returning({ id: webhookEvents.id });
  result.webhookEventsDeleted = payloads.length;

  // 6. Abandoned Meta drafts: a first name and a number, "swept after a day"
  //    when the clinic's next Meta message arrives (readMetaDraft in
  //    lib/meta/booking-requests.ts). A clinic whose threads go quiet would
  //    keep them for good without this.
  const drafts = await tx.db
    .delete(metaBookingDrafts)
    .where(
      and(
        eq(metaBookingDrafts.clinicId, tx.clinicId),
        lt(metaBookingDrafts.updatedAt, new Date(now.getTime() - DRAFT_TTL_HOURS * 60 * 60 * 1000)),
      ),
    )
    .returning({ senderId: metaBookingDrafts.senderId });
  result.draftsDeleted = drafts.length;

  // 7. Messaging threads gone quiet. A thread is a keyed reference to the
  //    sender's platform id (for WhatsApp, their number) and when they last
  //    wrote, kept to count conversations and to know whose first reply has
  //    carried the opening line. It goes after thirty days of silence
  //    (CHAT_THREAD_IDLE_RETENTION_DAYS, which billing-housekeeping also
  //    sweeps, but that job ships switched off), or at the record clock or
  //    the transcript clock when either is shorter: a thread is the trace of
  //    a conversation, and outlives neither its record nor its transcript
  //    (second review, 12 October 2026). BAA 1.3.0's clause 11 keeps a
  //    person's contact details "until 90 days after the last time those
  //    details were recorded"; a thread's last message is that time, so this
  //    is never later. Nothing is lost by it: a message after a day's
  //    silence starts a new conversation, and its first reply the opening
  //    line, whether or not the thread is still there.
  const threadsBefore = periodCutoff(
    now,
    Math.min(CHAT_THREAD_IDLE_RETENTION_DAYS, clinic.recordDays, transcriptDays),
  );
  const quietThreads = await tx.db
    .delete(chatThreads)
    .where(and(eq(chatThreads.clinicId, tx.clinicId), lt(chatThreads.lastInboundAt, threadsBefore)))
    .returning({ ref: chatThreads.partyRef });
  result.chatThreadsDeleted = quietThreads.length;

  // 8. Handled Meta messages' references: an HMAC of each message's id
  //    (lib/meta/inbound.ts), kept only so that Meta's redelivery of a batch
  //    is not answered twice, which happens within hours. Seven days, or the
  //    record clock when shorter, so no trace of a message outlives the
  //    record of its conversation.
  const refsBefore = new Date(
    Math.max(daysAgo(now, META_MESSAGE_REF_RETENTION_DAYS).getTime(), recordBefore.getTime()),
  );
  const refs = await tx.db
    .delete(metaInboundMessages)
    .where(and(eq(metaInboundMessages.clinicId, tx.clinicId), lt(metaInboundMessages.receivedAt, refsBefore)))
    .returning({ ref: metaInboundMessages.messageRef });
  result.metaMessageRefsDeleted = refs.length;

  // 9. Retell call alerts resolved more than thirty days ago
  //    (RECORDING_ALERT_RESOLVED_RETENTION_DAYS): Retell no longer holds the
  //    call, and the row is only the operator's record that it was fixed. An
  //    open alert is never purged, however old: it is the only sign that
  //    Retell still holds a call, and it goes when resolved or at the
  //    clinic's destruction (drizzle/0106).
  const resolvedAlerts = await tx.db
    .delete(retellRecordingAlerts)
    .where(
      and(
        eq(retellRecordingAlerts.clinicId, tx.clinicId),
        sql`${retellRecordingAlerts.resolvedAt} is not null`,
        lt(retellRecordingAlerts.resolvedAt, daysAgo(now, RECORDING_ALERT_RESOLVED_RETENTION_DAYS)),
      ),
    )
    .returning({ id: retellRecordingAlerts.id });
  result.recordingAlertsDeleted = resolvedAlerts.length;

  // The audit row says what kind and how many — never which person.
  const total =
    result.mediaCleared +
    result.bookingRequestsDeleted +
    result.transactionsDeleted +
    result.appointmentsDeleted +
    result.conversationsDeleted +
    result.contactsDeleted +
    result.draftsDeleted +
    result.webhookEventsDeleted +
    result.chatThreadsDeleted +
    result.slotHoldsDeleted +
    result.depositsDeleted +
    result.metaMessageRefsDeleted +
    result.handoversDeleted +
    result.patientRequestsDeleted +
    result.recordingAlertsDeleted;
  if (total > 0) {
    tx.audit.record({
      action: "delete",
      resourceType: "retention_purge",
      resultCount: total,
      metadata: {
        mediaCleared: result.mediaCleared,
        bookingRequests: result.bookingRequestsDeleted,
        transactions: result.transactionsDeleted,
        appointments: result.appointmentsDeleted,
        conversations: result.conversationsDeleted,
        contacts: result.contactsDeleted,
        drafts: result.draftsDeleted,
        webhookEvents: result.webhookEventsDeleted,
        chatThreads: result.chatThreadsDeleted,
        slotHolds: result.slotHoldsDeleted,
        deposits: result.depositsDeleted,
        metaMessageRefs: result.metaMessageRefsDeleted,
        handovers: result.handoversDeleted,
        patientRequests: result.patientRequestsDeleted,
        recordingAlerts: result.recordingAlertsDeleted,
        mediaDays: clinic.mediaDays,
        transcriptDays,
        recordDays: clinic.recordDays,
      },
    });
  }

  return result;
}

export type ErasureRequest = {
  /** E.164, as stored on contacts.phone. */
  phone?: string;
  /** Lower-cased. */
  email?: string;
  /** Who asked, for the audit row: "patient", "clinic", or a ticket id. */
  requestedBy: string;
  /**
   * Only what was recorded no later than this: a contact created by then, a
   * draft last written by then. Omitted, everything there is. The erase path
   * applied again after a restore passes the time of the original deletion
   * (reapplyErasures in lib/patient-rights/erasure.ts), so a person who came
   * back after asking to be deleted keeps what they gave afterwards.
   */
  before?: Date;
};

export type ErasureResult = {
  contactsMatched: number;
  bookingRequestsDeleted: number;
  conversationsDeleted: number;
  appointmentsDeleted: number;
  transactionsDeleted: number;
  draftsDeleted: number;
  /** Amendments of the requests and conversations deleted (drizzle/0064). */
  amendmentsDeleted: number;
  /** Deposits of their appointments (drizzle/0067). */
  depositsDeleted: number;
  /** The Connect webhook rows that last touched those deposits (drizzle/0067). */
  connectEventsDeleted: number;
};

/**
 * The single-patient path: "delete everything you hold about me".
 *
 * Deletes, not de-identifies: a conversation row with the contact detached
 * still carries a treatment interest and a time, which is a re-identification
 * waiting for a join. Their booking requests go too, whatever the desk
 * decided, as do a payment matched to one of their appointments and a
 * half-collected Meta draft carrying the number. A deleted request's id and
 * token hash are never written again (booking_request_keys).
 *
 * Nothing of the person is kept afterwards, the number included. Until 8
 * October 2026 this wrote the number into `suppressions` "so the request
 * itself is honoured", a copy kept for as long as the clinic's data was;
 * BAA 1.3.0's clause 4(c) allows only a record of the request, for no
 * longer than it is needed, and v1 contacts no one first, so there is no
 * do-not-contact list for the number to stay on. The operator's erase path
 * (erasePerson in lib/patient-rights/erasure.ts) runs this, deletes what this
 * does not reach (the person's raw call payloads, their own messaging
 * threads with their drafts, and their own suppressions, consent records and
 * contact attempts), and records the request in erasure_requests, without
 * the number.
 */
export async function eraseContact(tx: TenantTx, request: ErasureRequest): Promise<ErasureResult> {
  if (!request.phone && !request.email) {
    throw new Error("An erasure request needs a phone number or an email address.");
  }

  const matches = await tx.db
    .select({ id: contacts.id, phone: contacts.phone })
    .from(contacts)
    .where(
      and(
        eq(contacts.clinicId, tx.clinicId),
        or(
          request.phone ? eq(contacts.phone, request.phone) : sql`false`,
          request.email ? sql`lower(${contacts.email}) = ${request.email.toLowerCase()}` : sql`false`,
        ),
        request.before ? lte(contacts.createdAt, request.before) : sql`true`,
      ),
    );
  const ids = matches.map((m) => m.id);
  const result: ErasureResult = {
    contactsMatched: ids.length,
    bookingRequestsDeleted: 0,
    conversationsDeleted: 0,
    appointmentsDeleted: 0,
    transactionsDeleted: 0,
    draftsDeleted: 0,
    amendmentsDeleted: 0,
    depositsDeleted: 0,
    connectEventsDeleted: 0,
  };

  if (ids.length) {
    const theirAppointments = await tx.db
      .select({ id: appointments.id })
      .from(appointments)
      .where(and(eq(appointments.clinicId, tx.clinicId), inArray(appointments.contactId, ids)));
    const aIds = theirAppointments.map((r) => r.id);
    // Their transactions: the ones tied to them, and any payment matched to
    // one of their appointments, whoever it was matched to. A payment for
    // their appointment is about them, as the call that produced it is; and
    // transactions.appointment_id has no delete action, so one left behind
    // would abort the erasure at the appointment's delete.
    const theirTransactions = await tx.db
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.clinicId, tx.clinicId),
          or(
            inArray(transactions.contactId, ids),
            aIds.length ? inArray(transactions.appointmentId, aIds) : sql`false`,
          ),
        ),
      );
    const tIds = theirTransactions.map((r) => r.id);

    if (tIds.length || aIds.length) {
      await tx.db.delete(reconciliationExceptions).where(
        and(
          eq(reconciliationExceptions.clinicId, tx.clinicId),
          or(
            tIds.length ? inArray(reconciliationExceptions.transactionId, tIds) : sql`false`,
            aIds.length ? inArray(reconciliationExceptions.appointmentId, aIds) : sql`false`,
          ),
        ),
      );
    }
    if (tIds.length) {
      const gone = await tx.db
        .delete(transactions)
        .where(and(eq(transactions.clinicId, tx.clinicId), inArray(transactions.id, tIds)))
        .returning({ id: transactions.id });
      result.transactionsDeleted = gone.length;
    }
    // The rest goes in one call, from their booking requests down to the
    // people: their own requests, whatever the desk decided; their
    // appointments; their conversations and the ones that produced their
    // appointments (a call that led to a booking is about the person who
    // booked, whether or not the caller was matched); then the contacts. The
    // requests have to lead, because a confirmed one holds its appointment
    // (CHECK, 0039; trigger, 0041) and every one names its person (a foreign
    // key with no delete action), and the app role has no DELETE on them, so
    // app_erase_contacts() does it as their owner. It takes the people in the
    // same call and fails with nothing removed if anything else still refers
    // to them, someone else's request on one of their appointments included,
    // so a request leaves only with the person it names. The amendments of
    // the requests and conversations it deletes go first, in the same call
    // (record_amendments, drizzle/0064): an amendment leaves only with what
    // it amends. So do the deposits of their appointments, with the Connect
    // events that last touched them, before the appointments go (drizzle/0067):
    // the appointment's foreign key on a deposit is SET NULL, so a deposit
    // left until afterwards could never be found again, and its Checkout
    // session leads to the payer in the clinic's own Stripe account.
    const [erased] = (
      await tx.db.execute<{
        requests_deleted: number;
        appointments_deleted: number;
        conversations_deleted: number;
        amendments_deleted: number;
        deposits_deleted: number;
        connect_events_deleted: number;
      }>(
        sql`select * from app_erase_contacts(array[${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )}]::uuid[])`,
      )
    ).rows;
    result.bookingRequestsDeleted = erased?.requests_deleted ?? 0;
    result.appointmentsDeleted = erased?.appointments_deleted ?? 0;
    result.conversationsDeleted = erased?.conversations_deleted ?? 0;
    result.amendmentsDeleted = erased?.amendments_deleted ?? 0;
    result.depositsDeleted = erased?.deposits_deleted ?? 0;
    result.connectEventsDeleted = erased?.connect_events_deleted ?? 0;
  }

  // A half-collected Meta draft has no contact, only the number typed into
  // the thread, so it is found by number whether or not a contact matched.
  const phones = [...new Set([request.phone, ...matches.map((m) => m.phone)])].filter(
    (p): p is string => Boolean(p),
  );
  if (phones.length) {
    const drafts = await tx.db
      .delete(metaBookingDrafts)
      .where(
        and(
          eq(metaBookingDrafts.clinicId, tx.clinicId),
          inArray(metaBookingDrafts.phone, phones),
          request.before ? lte(metaBookingDrafts.updatedAt, request.before) : sql`true`,
        ),
      )
      .returning({ senderId: metaBookingDrafts.senderId });
    result.draftsDeleted = drafts.length;
  }

  tx.audit.record({
    action: "delete",
    resourceType: "contact_erasure",
    resourceIds: ids,
    resultCount: ids.length,
    metadata: {
      requestedBy: request.requestedBy,
      bookingRequests: result.bookingRequestsDeleted,
      conversations: result.conversationsDeleted,
      appointments: result.appointmentsDeleted,
      transactions: result.transactionsDeleted,
      drafts: result.draftsDeleted,
      amendments: result.amendmentsDeleted,
      deposits: result.depositsDeleted,
      connectEvents: result.connectEventsDeleted,
    },
  });

  return result;
}
