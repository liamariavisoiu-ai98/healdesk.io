import { audienceSingular, type Channel } from "@healdesk/catalog";

import { publicUrl } from "@/lib/public-url";
import { claimLines, escalatedLine, type ClaimsPayload } from "@/lib/reporting/claim-words";

import { counted, dayLong } from "./billing-copy";
import { compose, EmailCompositionError, type Block } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate, TemplateContext } from "./types";

/**
 * L13, the daily summary (Annex X5; spec, "Daily summary email": "Sent at the
 * start of each working day: what the assistant handled, booked and
 * escalated, every booking and booking request with its link, and every
 * request still open. The week's first summary carries the weekly recap").
 * Queued at the clinic's opening time on its working days, while its Daily
 * summary switch is on (lib/scheduler/daily-summary.ts); an optional kind,
 * so it carries the one-click stop link, and the sender closes it unsent if
 * the switch is off by then.
 *
 * A pointer (X1.1): the counts come from the claims function
 * (lib/reporting/claims.ts), worded by lib/reporting/claim-words.ts as Home
 * words them, and each booking and request is a row with its channel, where
 * it stands and a link into healdesk, with no name, number, time or service:
 * those open behind sign-in and the passkey. The calendar layer keeps no link
 * to a booking's Google Calendar event (it stores the event's id only), so a
 * booking's row opens it on Bookings, beside the requests.
 *
 * The week's first summary (the clinic's first working day of the week)
 * carries last week's recap, L14's figures, so no separate weekly email goes
 * while the summary is on (X3, "Designed merges").
 */

/** Where one booking or request stands, as its row says it. */
export const SUMMARY_ROW_STATUSES = [
  "booked",
  "confirmed",
  "waiting",
  "declined",
  "missed",
] as const;
export type SummaryRowStatus = (typeof SUMMARY_ROW_STATUSES)[number];

/** One booking or booking request: its channel, where it stands, and its link. Nothing of the person. */
export type SummaryRow = {
  channel: Channel;
  status: SummaryRowStatus;
  /** publicUrl("/c/<slug>/bookings?request=<id>"): the request on Bookings, behind sign-in and step-up. */
  linkUrl: string;
};

export type DailySummaryPayload = {
  /** The period the counts and the first list cover: since the last summary sent. */
  periodStartAt: string;
  periodEndAt: string;
  /** No summary has gone before: the period runs from when AYA started answering. */
  isFirstSummary: boolean;
  /** The last summary went more than a week ago, so the period is the last seven days. */
  isPeriodCapped: boolean;
  dayClaims: ClaimsPayload;
  /** Nothing handled when a week like the last would have led us to expect some (quietDayIsUnusual). */
  isQuietUnusual: boolean;
  /** Every booking and booking request since the last summary, oldest first, up to the row cap. */
  newRows: SummaryRow[];
  moreNewCount: number;
  /** Every request still open that was taken before the period, oldest first, up to the row cap. */
  openRows: SummaryRow[];
  moreOpenCount: number;
  /**
   * Messages left on the website's contact form while AYA was not answering
   * (package F's L20): since the last summary, or from before and still
   * waiting. Not requests AYA took, so counted on their own line, never in
   * the rows or the claims.
   */
  websiteMessageCount: number;
  /** publicUrl("/c/<slug>/bookings"). */
  bookingsUrl: string;
  /** The week's first summary: last week's recap. Null on every other day. */
  weekClaims: ClaimsPayload | null;
  /** Last week's Monday and Sunday, clinic-local dates, with `weekClaims`. */
  weekStartOn: string | null;
  weekEndOn: string | null;
};

const CHANNEL_WORDS: Record<Channel, string> = {
  voice: "Phone call",
  web: "Website chat",
  meta: "Instagram, Messenger or WhatsApp",
};

const STATUS_WORDS: Record<SummaryRowStatus, string> = {
  booked: "Booked by AYA",
  confirmed: "Confirmed by your team",
  waiting: "Waiting for you",
  declined: "Declined by your team",
  missed: "Missed: closed before a time was confirmed",
};

function rowItems(rows: readonly SummaryRow[]): { text: string; label: string; url: string }[] {
  return rows.map((row) => {
    if (!(row.channel in CHANNEL_WORDS) || !(row.status in STATUS_WORDS)) {
      throw new EmailCompositionError("A summary row has a channel or status with no words.");
    }
    return {
      text: `${CHANNEL_WORDS[row.channel]} · ${STATUS_WORDS[row.status]}`,
      label: "Open in healdesk",
      url: row.linkUrl,
    };
  });
}

function more(n: number): Block[] {
  if (n <= 0) return [];
  return [
    {
      type: "paragraph",
      text:
        n === 1
          ? "And 1 more, in Bookings."
          : `And ${n.toLocaleString("en-US")} more, in Bookings.`,
    },
  ];
}

/** "since your last summary", or what the period is when it is not that. */
function sincePhrase(payload: DailySummaryPayload): string {
  if (payload.isFirstSummary) return "since AYA started answering";
  if (payload.isPeriodCapped) return "in the last 7 days";
  return "since your last summary";
}

/** Last week's recap, for the week's first summary and for L14 alone. */
export function weekBlocks(
  claims: ClaimsPayload,
  startOn: string,
  endOn: string,
  ctx: TemplateContext,
): Block[] {
  return [
    {
      type: "paragraph",
      text: `Your week with AYA, ${dayLong(startOn, ctx)} to ${dayLong(endOn, ctx)}:`,
    },
    { type: "facts", rows: claimLines(claims).map((line) => [line.label, line.value] as const) },
  ];
}

export const renderDailySummary: EmailTemplate<DailySummaryPayload> = (payload, ctx) => {
  const clinic = ctx.clinicName ?? "your practice";
  const since = sincePhrase(payload);
  const day = payload.dayClaims;
  const waiting = [...payload.newRows, ...payload.openRows].filter(
    (r) => r.status === "waiting",
  ).length;
  const waitingAll = waiting + payload.moreOpenCount;

  const blocks: Block[] = [
    { type: "paragraph", text: `Here's what AYA did at ${clinic} ${since}.` },
    { type: "facts", rows: claimLines(day).map((line) => [line.label, line.value] as const) },
  ];
  const escalated = escalatedLine(day);
  if (escalated) blocks.push({ type: "paragraph", text: escalated });
  if (payload.isQuietUnusual) {
    blocks.push({
      type: "paragraph",
      text: `That's unusually quiet for ${clinic}. If you expected people to reach AYA, Home shows each channel and what to check.`,
    });
  }
  // Last week's recap, on the week's first summary, beside today's counts.
  if (payload.weekClaims && payload.weekStartOn && payload.weekEndOn) {
    blocks.push(...weekBlocks(payload.weekClaims, payload.weekStartOn, payload.weekEndOn, ctx));
  }

  const sinceCapital = since.charAt(0).toUpperCase() + since.slice(1);
  if (payload.newRows.length > 0) {
    blocks.push(
      { type: "paragraph", text: `${sinceCapital}, every booking and booking request:` },
      { type: "links", items: rowItems(payload.newRows) },
      ...more(payload.moreNewCount),
    );
  } else {
    blocks.push({ type: "paragraph", text: `No bookings or booking requests ${since}.` });
  }

  if (payload.websiteMessageCount > 0) {
    const n = payload.websiteMessageCount;
    blocks.push({
      type: "links",
      items: [
        {
          text: `${n === 1 ? "1 person" : `${n.toLocaleString("en-US")} people`} left a message on your website`,
          label: "Open in healdesk",
          url: payload.bookingsUrl,
        },
      ],
    });
  }

  if (payload.openRows.length > 0) {
    blocks.push(
      {
        type: "paragraph",
        text: "Booking requests from before that are still waiting for your team:",
      },
      { type: "links", items: rowItems(payload.openRows) },
      ...more(payload.moreOpenCount),
    );
  }

  blocks.push(
    { type: "action", label: "Open Bookings", url: payload.bookingsUrl },
    {
      type: "paragraph",
      text: `This email carries no ${audienceSingular(ctx.audience)} details on purpose: who, when and what for open in healdesk once you sign in.`,
    },
  );

  return compose(
    {
      subject: payload.weekClaims
        ? "Your daily summary, and your week with AYA"
        : "Your daily summary from AYA",
      preheader:
        waitingAll > 0
          ? `${counted(day.handledCount, "conversation", "conversations")} handled · ${waitingAll.toLocaleString("en-US")} waiting for you.`
          : `${counted(day.handledCount, "conversation", "conversations")} handled ${since}.`,
      blocks,
    },
    ctx,
  );
};

// -----------------------------------------------------------------------------
// The registry's entry
// -----------------------------------------------------------------------------

const REQUEST_IDS = [
  "5d0c1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b",
  "6e1d2b3c-4d5e-4f60-9b7c-8d9e0f1a2b3c",
  "7f2e3c4d-5e6f-4071-8c8d-9e0f1a2b3c4d",
  "8a3f4d5e-6f70-4182-9d9e-0f1a2b3c4d5e",
] as const;

/** A request's link on Bookings, as the job builds it. */
function requestUrl(id: string): string {
  return publicUrl(`/c/radiance-med-spa/bookings?request=${id}`);
}

/** The claims a busy fixture day carries: a clinic on phone and website chat, taking requests. */
export function claimsFixture(overrides: Partial<ClaimsPayload> = {}): ClaimsPayload {
  return {
    handledCount: 14,
    voiceCount: 9,
    webCount: 5,
    metaCount: null,
    rangOutCount: 6,
    isRequestMode: true,
    requestsTakenCount: 4,
    requestsConfirmedCount: 2,
    bookedByAyaCount: 0,
    bookedValueCents: 45_000,
    pricedBookingsCount: 2,
    perUnitBookingsCount: 0,
    unpricedBookingsCount: 0,
    depositsCollectedCount: 1,
    depositsCollectedCents: 5_000,
    urgentCount: 1,
    handoverCount: 2,
    ...overrides,
  };
}

// A getter, so the links are built from BETTER_AUTH_URL when a test or the
// seed script reads them, not when this module loads.
export const DAILY_SUMMARY_ENTRY: TemplateEntry<DailySummaryPayload> = {
  render: renderDailySummary,
  get fixture(): DailySummaryPayload {
    return {
      periodStartAt: "2026-10-15T13:00:00Z",
      periodEndAt: "2026-10-16T13:00:00Z",
      isFirstSummary: false,
      isPeriodCapped: false,
      dayClaims: claimsFixture(),
      isQuietUnusual: false,
      newRows: [
        { channel: "voice", status: "confirmed", linkUrl: requestUrl(REQUEST_IDS[0]) },
        { channel: "web", status: "waiting", linkUrl: requestUrl(REQUEST_IDS[1]) },
        { channel: "voice", status: "waiting", linkUrl: requestUrl(REQUEST_IDS[2]) },
      ],
      moreNewCount: 0,
      openRows: [{ channel: "web", status: "waiting", linkUrl: requestUrl(REQUEST_IDS[3]) }],
      moreOpenCount: 0,
      websiteMessageCount: 1,
      bookingsUrl: publicUrl("/c/radiance-med-spa/bookings"),
      weekClaims: null,
      weekStartOn: null,
      weekEndOn: null,
    };
  },
};
