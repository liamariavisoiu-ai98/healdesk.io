import {
  BOOKING_SYSTEMS,
  CALENDAR_ACCOUNT_OPTIONS,
  renderGoogleCalendarDisclosure,
  type BookingSystemId,
  type CalendarAccount,
  type GoogleCalendarDisclosure,
} from "@healdesk/catalog";
import { eq } from "drizzle-orm";

import { clinics } from "@/db/schema";
import type { ActorContext, RequestContext } from "@/lib/audit";
import {
  CalendarElectionError,
  electionPossibleUnder,
  previewPendingElection,
  recordCalendarElection,
  type ElectionChoice,
  type RecordElectionOutcome,
} from "@/lib/booking/elections";
import { calendarTermsFor, type CalendarTerms } from "@/lib/booking/terms";
import {
  mailCalendarElectionCopy,
  mailCalendarLink,
  type CalendarMailDelivery,
} from "@/lib/email/calendar-link";
import type { CalendarLinkPurpose } from "@/lib/email/templates/calendar_link";
import { describeError, log } from "@/lib/log";
import { publicUrl } from "@/lib/public-url";
import { withTenant, type TenantTx } from "@/lib/tenant";

import {
  calendarConnectProblem,
  googleCalendarConnection,
  listCalendars,
  revokeGoogleGrantIfUnused,
  type CalendarOption,
} from "./google-calendar";
import {
  calendarLinkClinicForReissue,
  issueConnectionLinkWithin,
  resolveConnectionLink,
  type ResolvedLink,
} from "./links";
import { calendarRecipients, ownerRecipients } from "./recipients";

/**
 * The calendar links (plan §4.1): single-use links to one location's
 * Google Calendar page, app/calendar/[token], mailed only to the practice's
 * own address (lib/connections/recipients.ts), never to an address a caller
 * passes and never returned to the console except for healdesk's demo
 * clinic (Google's verification video).
 *
 * | Link          | Audience     | TTL                 | Minted by                                   |
 * | ------------- | ------------ | ------------------- | ------------------------------------------- |
 * | recipients    | `recipients` | 7 days; 3 for a re-issue or a watch alert | provisioning, ops, the expired page, the watch (C10) |
 * | owner change  | `owner`      | 3 days              | "Use a different Google account"            |
 * | owner confirm | `owner`      | 3 days              | a widening election through a recipients link |
 * | continuation  | as its parent| 1 day               | every election and connect made on the page; never mailed |
 *
 * Each records, when minted, where it was mailed (`sent_to`), and every
 * flag is frozen with it (drizzle/0057). Opening a link never spends it;
 * connecting, recording an election and confirming one do, and the page then
 * goes on under a continuation link, so a URL that was used is dead.
 */

/** Why a recipients link is being minted, which decides how long it lives. */
export type CalendarLinkReason = "provisioning" | "location_added" | "ops" | "watch" | "reissue";

const RECIPIENTS_LINK_DAYS: Record<CalendarLinkReason, number> = {
  provisioning: 7,
  location_added: 7,
  ops: 7,
  watch: 3,
  reissue: 3,
};
export const OWNER_LINK_DAYS = 3;
export const CONTINUATION_LINK_DAYS = 1;

const LINK_ACTOR: ActorContext = { type: "service", serviceName: "calendar-link" };

type MailFacts = {
  clinicId: string;
  clinicName: string;
  specialty: string | null;
  timeZone: string;
};

async function mailFacts(tx: TenantTx): Promise<MailFacts & { leaving: boolean }> {
  const [row] = await tx.db
    .select({
      name: clinics.name,
      specialty: clinics.specialty,
      timezone: clinics.timezone,
      offboardingStartedAt: clinics.offboardingStartedAt,
      destroyedAt: clinics.destroyedAt,
    })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!row) throw new Error("No such location.");
  return {
    clinicId: tx.clinicId,
    clinicName: row.name,
    specialty: row.specialty,
    timeZone: row.timezone,
    leaving: row.offboardingStartedAt !== null || row.destroyedAt !== null,
  };
}

/**
 * Whether this location can record an election now: the election form of
 * the agreement it is under is released, or it is the demo clinic. The form
 * is the agreement's own (electionPossibleUnder), as recordCalendarElection
 * takes it, so a practice under a DPA is never mailed or shown a form whose
 * submission could only answer `draft_terms` because the BAA's is released.
 */
function electionPossible(terms: CalendarTerms): boolean {
  if (terms.kind === "none") return false;
  return electionPossibleUnder(terms.agreementVersion, terms.demo);
}

// -----------------------------------------------------------------------------
// The recipients link
// -----------------------------------------------------------------------------

export type IssueCalendarLinkOutcome =
  | {
      status: "issued";
      linkId: string;
      expiresAt: Date;
      /** The link itself: for the console only when `demo`, and otherwise for nobody but the mail. */
      url: string;
      demo: boolean;
      delivery: CalendarMailDelivery;
    }
  | {
      status: "refused";
      reason: "unavailable" | "offboarding" | "nothing_to_do" | "no_recipients";
      message: string;
    };

/**
 * Mint a recipients link for one location and mail it to the practice.
 *
 * `rule` says when a link is worth sending:
 *   - `offer`, for the automatic sends (provisioning, a new location): the
 *     terms allow writing and nothing is connected yet, or the terms still
 *     need an election and one can be recorded (a released election
 *     document, or the demo clinic);
 *   - `useful`, for ops and the expired page's re-issue: any state of the
 *     page that lets the practice do something (connect or reconnect, or
 *     record an election), which leaves out a location with no agreement in
 *     effect and one whose election cannot be recorded yet.
 *
 * Refused, minting nothing, while Google may not be asked
 * (calendarConnectProblem) and for a location that is leaving.
 */
export async function issueCalendarLink(
  clinicId: string,
  input: {
    reason: CalendarLinkReason;
    rule: "offer" | "useful";
    expiresInDays?: number;
    actor?: ActorContext;
    request?: RequestContext;
  },
): Promise<IssueCalendarLinkOutcome> {
  const problem = await calendarConnectProblem();
  if (problem) return { status: "refused", reason: "unavailable", message: problem };

  const actor = input.actor ?? LINK_ACTOR;
  const minted = await withTenant({ clinicId, actor, request: input.request }, async (tx) => {
    const facts = await mailFacts(tx);
    if (facts.leaving) {
      return {
        kind: "refused" as const,
        reason: "offboarding" as const,
        message: "This location is leaving healdesk.",
      };
    }
    const terms = await calendarTermsFor(tx);
    const connection = await googleCalendarConnection(tx);
    const live = connection !== null && connection.status !== "revoked";
    const worth =
      input.rule === "offer"
        ? (terms.allowsWrite && !live) ||
          (terms.kind === "needs_election" && electionPossible(terms))
        : terms.kind === "covered" ||
          terms.kind === "uncovered" ||
          ((terms.kind === "needs_election" || terms.kind === "not_used") &&
            electionPossible(terms));
    if (!worth) {
      return {
        kind: "refused" as const,
        reason: "nothing_to_do" as const,
        message:
          terms.kind === "none"
            ? "This location has no agreement in effect."
            : "This location's calendar terms can't be recorded yet, so a link would show nothing to do.",
      };
    }
    const recipients = await calendarRecipients(tx);
    if (recipients.length === 0) {
      return {
        kind: "refused" as const,
        reason: "no_recipients" as const,
        message: "This location has no address to send to.",
      };
    }
    const link = await issueConnectionLinkWithin(
      tx,
      {
        purpose: "calendar",
        expiresInDays: input.expiresInDays ?? RECIPIENTS_LINK_DAYS[input.reason],
        audience: "recipients",
        sentTo: recipients,
      },
      actor,
    );
    return { kind: "minted" as const, link, facts, recipients, demo: terms.demo };
  });
  if (minted.kind === "refused") {
    return { status: "refused", reason: minted.reason, message: minted.message };
  }

  const url = publicUrl(`/calendar/${minted.link.token}`);
  const delivery = await mailCalendarLink({
    ...minted.facts,
    recipients: minted.recipients,
    url,
    expiresAt: minted.link.expiresAt,
    purpose: "connect",
    linkId: minted.link.linkId,
  });
  return {
    status: "issued",
    linkId: minted.link.linkId,
    expiresAt: minted.link.expiresAt,
    url,
    demo: minted.demo,
    delivery,
  };
}

/**
 * The automatic send (plan §4.1): after provisioning commits, and for a new
 * location (C's seam), mail the practice a calendar link when there is
 * something for it to do. Never throws, and never logs the link.
 */
export async function offerCalendarLink(
  clinicId: string,
  reason: "provisioning" | "location_added",
): Promise<{ status: "sent" | "skipped"; reason?: string }> {
  try {
    const outcome = await issueCalendarLink(clinicId, { reason, rule: "offer" });
    if (outcome.status === "refused") {
      log.info("calendar link not offered", { clinicId, reason: outcome.reason });
      return { status: "skipped", reason: outcome.reason };
    }
    if (outcome.delivery.sent === 0) {
      log.warn("calendar link not mailed; issue one from the console", {
        clinicId,
        deliveryId: outcome.linkId,
        failures: outcome.delivery.failed,
      });
      return { status: "skipped", reason: "not_mailed" };
    }
    return { status: "sent" };
  } catch (error) {
    log.error("calendar link could not be offered; issue one from the console", {
      clinicId,
      error: describeError(error),
    });
    return { status: "skipped", reason: "error" };
  }
}

// -----------------------------------------------------------------------------
// What the page's forms do
// -----------------------------------------------------------------------------

/** What the page says after one of its forms, as `?done=`; a closed set, never text from a query. */
export const CALENDAR_PAGE_NOTICES = [
  "election_recorded",
  "owner_asked",
  "change_link_sent",
  "calendar_chosen",
] as const;
export type CalendarPageNotice = (typeof CALENDAR_PAGE_NOTICES)[number];

/**
 * "Use a different Google account": mail the practice owner a change link
 * (3 days, owner audience, any Google account may connect through it). The
 * holder of any of the location's calendar links may ask; only the owner
 * receives it.
 */
export async function requestAccountChangeLink(
  token: string,
  request?: RequestContext,
): Promise<"sent" | "expired" | "unavailable"> {
  const link = await resolveConnectionLink(token, request, "calendar");
  if (!link) return "expired";
  const sent = await mintOwnerLink(link, { purpose: "change" }, request);
  return sent ? "sent" : "unavailable";
}

async function mintOwnerLink(
  link: ResolvedLink,
  input: {
    purpose: Exclude<CalendarLinkPurpose, "connect">;
    pending?: ElectionChoice & { documentVersion: string; documentHash: string };
  },
  request?: RequestContext,
): Promise<boolean> {
  if (await calendarConnectProblem()) return false;
  const minted = await withTenant(
    { clinicId: link.clinicId, actor: LINK_ACTOR, request },
    async (tx) => {
      const facts = await mailFacts(tx);
      if (facts.leaving) return null;
      const owners = await ownerRecipients(tx);
      if (owners.length === 0) return null;
      const next = await issueConnectionLinkWithin(
        tx,
        {
          purpose: "calendar",
          expiresInDays: OWNER_LINK_DAYS,
          audience: "owner",
          sentTo: owners,
          allowsAccountChange: input.purpose === "change",
          pendingElection: input.purpose === "confirm" ? (input.pending ?? null) : null,
        },
        LINK_ACTOR,
      );
      return { next, facts, owners };
    },
  );
  if (!minted) return false;
  const delivery = await mailCalendarLink({
    ...minted.facts,
    recipients: minted.owners,
    url: publicUrl(`/calendar/${minted.next.token}`),
    expiresAt: minted.next.expiresAt,
    purpose: input.purpose,
    linkId: minted.next.linkId,
  });
  return delivery.sent > 0;
}

export type ElectionSubmission = {
  bookingSystem: unknown;
  calendarAccount: unknown;
  name: unknown;
  title: unknown;
  /** The tick: "I accept this calendar election for {location}". */
  accepted: boolean;
};

export type ElectionSubmissionOutcome =
  /** Recorded; the page goes on at `next`, a continuation link's path. */
  | { status: "recorded"; next: string }
  /** It widens what reaches Google: the owner was mailed a confirm link and nothing was recorded. */
  | { status: "owner_asked" }
  | { status: "changed" }
  | { status: "unavailable" }
  | { status: "expired" }
  | { status: "invalid"; field: string; message: string };

/**
 * An election submitted on the page (plan §2.6, §4.1). Through a recipients
 * link, a narrowing election is recorded at once; a widening one records
 * nothing and mails the owner a confirm link carrying it. Through the
 * owner's confirm link, the election it carries is recorded, if it still
 * renders the same. What is recorded spends the link and continues on a
 * rotated one, minted in the same transaction; after commit, a connection
 * the new terms took away is revoked at Google when unused, and the
 * practice is mailed its copy.
 */
export async function submitCalendarElection(
  token: string,
  submission: ElectionSubmission,
  request?: RequestContext,
): Promise<ElectionSubmissionOutcome> {
  const link = await resolveConnectionLink(token, request, "calendar");
  if (!link) return { status: "expired" };
  if (!submission.accepted) {
    return {
      status: "invalid",
      field: "accepted",
      message: "Tick the box to accept the calendar election.",
    };
  }
  const choice = {
    bookingSystem: submission.bookingSystem,
    calendarAccount: submission.calendarAccount,
  } as ElectionChoice;

  let result: {
    outcome: RecordElectionOutcome;
    continuation: { token: string } | null;
    facts: MailFacts;
    recipients: string[];
  };
  try {
    result = await withTenant(
      { clinicId: link.clinicId, actor: LINK_ACTOR, request },
      async (tx) => {
        const outcome = await recordCalendarElection(tx, {
          choice,
          signatory: {
            name: typeof submission.name === "string" ? submission.name : "",
            title: typeof submission.title === "string" ? submission.title : null,
          },
          via: { source: "calendar_link", linkId: link.linkId },
          request,
        });
        const facts = await mailFacts(tx);
        let continuation: { token: string } | null = null;
        let recipients: string[] = [];
        if (outcome.status === "recorded") {
          const spent = outcome.election.consumedLink;
          const next = await issueConnectionLinkWithin(
            tx,
            {
              purpose: "calendar",
              expiresInDays: CONTINUATION_LINK_DAYS,
              audience: spent?.audience ?? link.audience,
              sentTo: spent?.sentTo ?? link.sentTo,
              allowsAccountChange: spent?.allowsAccountChange ?? false,
            },
            LINK_ACTOR,
          );
          continuation = { token: next.token };
          recipients = [
            ...new Set([...(await ownerRecipients(tx)), ...(await calendarRecipients(tx))]),
          ];
        }
        return { outcome, continuation, facts, recipients };
      },
    );
  } catch (error) {
    if (error instanceof CalendarElectionError) {
      return { status: "invalid", field: error.field ?? "election", message: error.message };
    }
    throw error;
  }

  const { outcome } = result;
  switch (outcome.status) {
    case "recorded": {
      const election = outcome.election;
      if (election.erased?.grant) {
        await revokeGoogleGrantIfUnused(election.erased.grant, {
          clinicId: link.clinicId,
          reason: "election_changed",
        });
      }
      await mailCalendarElectionCopy({
        ...result.facts,
        recipients: result.recipients,
        electionId: election.electionId,
        kind: election.kind,
        calendarAccount: choice.calendarAccount,
        bookingSystem: choice.bookingSystem,
        electedAt: new Date(),
      });
      return {
        status: "recorded",
        next: `/calendar/${result.continuation!.token}?done=election_recorded`,
      };
    }
    case "owner_confirmation_required": {
      const asked = await mintOwnerLink(
        link,
        { purpose: "confirm", pending: outcome.pending },
        request,
      );
      return asked ? { status: "owner_asked" } : { status: "unavailable" };
    }
    case "changed":
      return { status: "changed" };
    case "link_not_usable":
      return { status: "expired" };
    case "unavailable":
    case "not_member":
    case "owner_only":
      return { status: "unavailable" };
  }
}

/**
 * The expired page's "Email a new link to the practice's calendar
 * contacts": a 3-day recipients link, mailed to the practice, when the old
 * token was a calendar link issued within 30 days and a link would be
 * useful. The caller answers every case with the same sentence and has
 * already counted the attempt against the token and the address.
 */
export async function reissueCalendarLink(token: string, request?: RequestContext): Promise<void> {
  try {
    const clinicId = await calendarLinkClinicForReissue(token, request);
    if (!clinicId) return;
    const outcome = await issueCalendarLink(clinicId, {
      reason: "reissue",
      rule: "useful",
      request,
    });
    log.info("calendar link re-issue", {
      clinicId,
      outcome: outcome.status,
      reason: outcome.status === "refused" ? outcome.reason : null,
    });
  } catch (error) {
    log.error("calendar link re-issue failed", { error: describeError(error) });
  }
}

// -----------------------------------------------------------------------------
// What the page shows
// -----------------------------------------------------------------------------

export type ElectionFormModel = {
  bookingSystems: { id: BookingSystemId; label: string }[];
  accounts: { id: CalendarAccount; title: string; description: string }[];
};

export type CalendarPageModel =
  | { state: "expired"; token: string | null }
  | { state: "unavailable" }
  | { state: "terms_unavailable"; clinicName: string }
  | {
      state: "election";
      clinicName: string;
      token: string;
      /** The location runs manual booking under `not_used` terms: the page explains it first. */
      manual: boolean;
      /** Null when no election can be recorded yet (`not_used` before the document is released). */
      form: ElectionFormModel | null;
    }
  | {
      state: "confirm";
      clinicName: string;
      token: string;
      /** The election as it renders now; null when it has changed since the link was minted. */
      document: string | null;
      choice: ElectionChoice;
    }
  | {
      state: "connect";
      clinicName: string;
      token: string;
      disclosure: GoogleCalendarDisclosure;
      /** The terms name a Workspace account: the Trusted-app guidance comes first. */
      workspace: boolean;
      /** Google told us the practice removed healdesk's access. */
      accessRemoved: boolean;
      /** An owner change link: any Google account may connect. */
      accountChange: boolean;
      /** For the mismatch page's election form: what an election would offer. */
      form: ElectionFormModel | null;
    }
  | {
      state: "connected";
      clinicName: string;
      token: string;
      disclosure: GoogleCalendarDisclosure;
      workspace: boolean;
      account: {
        email: string | null;
        kind: "workspace" | "personal" | null;
        domain: string | null;
      };
      connectedOn: string | null;
      /** The connection stopped working (status `error`): reconnect, or change the account. */
      broken: boolean;
      /** The calendars it may book into, when the account has more than one. */
      calendars: CalendarOption[] | null;
    };

function electionForm(): ElectionFormModel {
  return {
    bookingSystems: BOOKING_SYSTEMS.map((system) => ({ id: system.id, label: system.label })),
    accounts: CALENDAR_ACCOUNT_OPTIONS.map((option) => ({
      id: option.id,
      title: option.title,
      description: option.description,
    })),
  };
}

/**
 * Everything the calendar page needs, from its token. Resolving the link
 * never spends it; a dead, unknown or malformed token is `expired`, with the
 * token kept only when it has a token's shape, so the re-issue form can
 * post it back.
 */
export async function calendarLinkPage(
  token: string,
  request?: RequestContext,
): Promise<CalendarPageModel> {
  const link = await resolveConnectionLink(token, request, "calendar");
  if (!link) return { state: "expired", token: /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null };
  if (await calendarConnectProblem()) return { state: "unavailable" };

  const model = await withTenant(
    { clinicId: link.clinicId, actor: LINK_ACTOR, request },
    async (tx): Promise<CalendarPageModel | "list_calendars"> => {
      const terms = await calendarTermsFor(tx);
      const clinicName = link.clinicName;

      if (link.pendingElection) {
        const preview = await previewPendingElection(tx, link.pendingElection);
        if (preview.status !== "ready") return { state: "terms_unavailable", clinicName };
        return {
          state: "confirm",
          clinicName,
          token,
          document: preview.current ? preview.text : null,
          choice: {
            bookingSystem: link.pendingElection.bookingSystem,
            calendarAccount: link.pendingElection.calendarAccount,
          },
        };
      }
      if (terms.kind === "none") return { state: "terms_unavailable", clinicName };
      if (terms.kind === "needs_election" && !electionPossible(terms)) {
        return { state: "terms_unavailable", clinicName };
      }
      if (terms.kind === "needs_election" || terms.kind === "not_used") {
        return {
          state: "election",
          clinicName,
          token,
          manual: terms.kind === "not_used",
          form: electionPossible(terms) ? electionForm() : null,
        };
      }

      const disclosure = renderGoogleCalendarDisclosure({ clinicName });
      const workspace = terms.account !== "personal";
      const connection = await googleCalendarConnection(tx);
      const live = connection !== null && connection.status !== "revoked";
      if (!live || link.allowsAccountChange) {
        return {
          state: "connect",
          clinicName,
          token,
          disclosure,
          workspace,
          accessRemoved:
            !live &&
            connection !== null &&
            connection.brokenAt !== null &&
            !link.allowsAccountChange,
          accountChange: link.allowsAccountChange,
          form: electionPossible(terms) ? electionForm() : null,
        };
      }
      return "list_calendars";
    },
  );
  if (model !== "list_calendars") return model;

  // Connected: who, and, when it has more than one, which calendar.
  const view = await withTenant(
    { clinicId: link.clinicId, actor: LINK_ACTOR, request },
    async (tx) => {
      const terms = await calendarTermsFor(tx);
      const connection = (await googleCalendarConnection(tx))!;
      const [clinic] = await tx.db
        .select({ timezone: clinics.timezone })
        .from(clinics)
        .where(eq(clinics.id, tx.clinicId))
        .limit(1);
      return { terms, connection, timeZone: clinic?.timezone ?? null };
    },
  );
  const listed =
    view.connection.status === "error"
      ? null
      : await listCalendars(link.clinicId, { actor: LINK_ACTOR, request });
  const m = view.connection.metadata;
  return {
    state: "connected",
    clinicName: link.clinicName,
    token,
    disclosure: renderGoogleCalendarDisclosure({ clinicName: link.clinicName }),
    workspace:
      view.terms.kind === "covered" || view.terms.kind === "uncovered"
        ? view.terms.account !== "personal"
        : true,
    account: {
      email: typeof m.accountEmail === "string" ? m.accountEmail : null,
      kind:
        view.connection.managed === null
          ? null
          : view.connection.managed
            ? "workspace"
            : "personal",
      domain: view.connection.hostedDomain,
    },
    connectedOn: connectedOn(m.connectedAt, view.timeZone),
    broken: view.connection.status === "error",
    calendars: listed?.status === "ok" && listed.calendars.length > 1 ? listed.calendars : null,
  };
}

/**
 * The day the connection was made, as the clinic's own calendar has it
 * ("October 8, 2026"), the way its calendar emails write dates: an evening
 * connect in the Americas is already the next day in UTC. Null when either
 * is unreadable.
 */
export function connectedOn(connectedAt: unknown, timeZone: string | null): string | null {
  if (typeof connectedAt !== "string" || !timeZone) return null;
  const at = new Date(connectedAt);
  if (Number.isNaN(at.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(at);
  } catch {
    return null;
  }
}
