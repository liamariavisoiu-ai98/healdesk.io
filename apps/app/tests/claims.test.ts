import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { readChannelStates } from "@/lib/channels/state";
import { copyProblems } from "@/lib/email/lint";
import { needsAttention, type AttentionFacts } from "@/lib/portal/attention";
import { readWaitingCounts } from "@/lib/portal/bookings";
import { waitedFor, waitingSentence } from "@/lib/portal/waiting-words";
import { claimLines, escalatedLine, type ClaimsPayload } from "@/lib/reporting/claim-words";
import {
  QUIET_CHANNEL_DAYS,
  quietDayIsUnusual,
  readClaims,
  readQuietChannels,
} from "@/lib/reporting/claims";
import { listedPrice } from "@/lib/setup/prices";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getAppPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { deskDecideById } from "./setup/desk";
import { inTenant } from "./setup/factories";
import { provisionPortalClinic } from "./setup/portal-clinic";
import {
  backdate,
  conversation,
  DAY,
  HOUR,
  liveClinic,
  MINUTE,
  request,
  setServices,
} from "./setup/summary-fixtures";

/**
 * Package WP4: the claims function (lib/reporting/claims.ts) and its words
 * (claim-words.ts), which Home's week, the daily summary and the weekly
 * recap share; Home's "Waiting for you" counts and a quiet channel in Needs
 * attention; and the listed-price snapshot booked value multiplies by
 * (drizzle/0081). The summaries themselves: tests/daily-summary.test.ts.
 *
 * The claims rules are the spec's ("What v1 can prove, and what it cannot")
 * and CLAUDE.md's: never revenue, "collected" only in "deposits collected",
 * and Home, which is not a patient page, shows counts and never a name, a
 * time or a service.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "claims-test" } as const;

/** A busy day's claims at a clinic on phone and website chat, taking requests. */
function payload(overrides: Partial<ClaimsPayload> = {}): ClaimsPayload {
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

// -----------------------------------------------------------------------------
// The claims in words
// -----------------------------------------------------------------------------

describe("the claims in words", () => {
  test("while bookings are requests: handled, each channel with the rang-out count on phone, requests taken and confirmed, booked value and deposits", () => {
    expect(claimLines(payload())).toEqual([
      { label: "Conversations handled", value: "14" },
      { label: "Phone", value: "9 calls · 6 would otherwise have rung out" },
      { label: "Website chat", value: "5 chats" },
      { label: "Booking requests taken", value: "4 · 2 confirmed by your team" },
      { label: "Booked value at your listed prices", value: "$450 across 2 bookings" },
      { label: "Deposits collected", value: "1 · $50" },
    ]);
  });

  test("once AYA books: appointments booked by AYA lead, and requests still show when there were any", () => {
    const direct = claimLines(
      payload({
        isRequestMode: false,
        bookedByAyaCount: 3,
        requestsTakenCount: 1,
        requestsConfirmedCount: 0,
      }),
    );
    expect(direct.map((l) => l.label).slice(3, 5)).toEqual([
      "Appointments booked by AYA",
      "Booking requests taken",
    ]);
    expect(direct[3]!.value).toBe("3");
    const none = claimLines(
      payload({ isRequestMode: false, bookedByAyaCount: 2, requestsTakenCount: 0 }),
    );
    expect(none.map((l) => l.label)).not.toContain("Booking requests taken");
  });

  test("booked value never multiplies a per-unit price in, and names bookings with no listed price", () => {
    const value = (p: Partial<ClaimsPayload>) =>
      claimLines(payload(p)).find((l) => l.label === "Booked value at your listed prices")?.value;
    expect(value({ perUnitBookingsCount: 2, unpricedBookingsCount: 1 })).toBe(
      "$450 across 2 bookings · 2 bookings priced per unit, not added in · 1 booking with no listed price",
    );
    expect(value({ pricedBookingsCount: 0, bookedValueCents: 0, perUnitBookingsCount: 1 })).toBe(
      "1 booking priced per unit, not added in",
    );
    // Nothing booked had a listed price: no value line at all, never "$0".
    expect(
      value({ pricedBookingsCount: 0, bookedValueCents: 0, unpricedBookingsCount: 3 }),
    ).toBeUndefined();
  });

  test("an unavailable rang-out count is left out, never shown as zero; a channel not bought has no row; no deposit, no line", () => {
    const lines = claimLines(
      payload({
        rangOutCount: null,
        webCount: null,
        metaCount: 7,
        depositsCollectedCount: 0,
        depositsCollectedCents: 0,
      }),
    );
    expect(lines.find((l) => l.label === "Phone")!.value).toBe("9 calls");
    expect(lines.map((l) => l.label)).toEqual([
      "Conversations handled",
      "Phone",
      "Instagram, Messenger & WhatsApp",
      "Booking requests taken",
      "Booked value at your listed prices",
    ]);
  });

  test("every wording passes the email copy lint: no revenue, collected only as deposits collected", () => {
    const variants: Partial<ClaimsPayload>[] = [
      {},
      { isRequestMode: false, bookedByAyaCount: 5 },
      { perUnitBookingsCount: 3, unpricedBookingsCount: 2 },
      { rangOutCount: null, metaCount: 2 },
      { handledCount: 1, voiceCount: 1, webCount: 0, depositsCollectedCount: 1 },
    ];
    for (const v of variants) {
      const words = claimLines(payload(v))
        .map((l) => `${l.label}: ${l.value}`)
        .join("\n");
      expect(copyProblems(words), JSON.stringify(v)).toEqual([]);
      expect(words).not.toMatch(/revenue|recovered|attribut/i);
    }
  });

  test("escalated: counts of what went to the clinic as it happened, or nothing", () => {
    expect(escalatedLine({ urgentCount: 1, handoverCount: 2 })).toBe(
      "Sent to you as they happened: 1 urgent report and 2 requests to speak with a person.",
    );
    expect(escalatedLine({ urgentCount: 0, handoverCount: 1 })).toBe(
      "Sent to you as they happened: 1 request to speak with a person.",
    );
    expect(escalatedLine({ urgentCount: 0, handoverCount: 0 })).toBeNull();
  });
});

describe("a quiet day, and Waiting for you", () => {
  test("a quiet day is unusual only when the week before would have led us to expect three or more", () => {
    // A day after a week of 21: three expected, none came.
    expect(quietDayIsUnusual({ handled: 0, handledPriorWeek: 21, periodMs: DAY })).toBe(true);
    // A day after a week of 14: two expected, an ordinary quiet day.
    expect(quietDayIsUnusual({ handled: 0, handledPriorWeek: 14, periodMs: DAY })).toBe(false);
    // Monday's summary covers the weekend: three days' worth expected.
    expect(quietDayIsUnusual({ handled: 0, handledPriorWeek: 7, periodMs: 3 * DAY })).toBe(true);
    expect(quietDayIsUnusual({ handled: 1, handledPriorWeek: 70, periodMs: DAY })).toBe(false);
  });

  test("the card counts and ages, never names", () => {
    const now = new Date("2026-10-15T15:00:00Z");
    expect(
      waitingSentence(
        {
          toCallBack: 3,
          oldestSince: new Date(now.getTime() - 2 * HOUR - 5 * MINUTE),
          depositsToCollect: 1,
        },
        now,
      ),
    ).toBe("3 people to call back (oldest 2 h) · 1 deposit to collect");
    expect(
      waitingSentence(
        { toCallBack: 1, oldestSince: new Date(now.getTime() - 25 * MINUTE), depositsToCollect: 0 },
        now,
      ),
    ).toBe("1 person to call back (oldest 25 min)");
    expect(waitingSentence({ toCallBack: 0, oldestSince: null, depositsToCollect: 2 }, now)).toBe(
      "2 deposits to collect",
    );
    expect(waitingSentence({ toCallBack: 0, oldestSince: null, depositsToCollect: 0 }, now)).toBe(
      "Nothing right now.",
    );
    expect(waitedFor(new Date(now.getTime() - 3 * DAY), now)).toBe("3 days");
    expect(waitedFor(new Date(now.getTime() - 30_000), now)).toBe("1 min");
  });
});

describe("Needs attention: a quiet channel", () => {
  const facts = (overrides: Partial<AttentionFacts> = {}): AttentionFacts => ({
    slug: "glow",
    state: {
      screens: [],
      progress: new Map(),
      clinic: { isCoveredEntity: false } as AttentionFacts["state"]["clinic"],
      hasPasskey: true,
      hasBackup: true,
      billing: null,
      address: "desk@glow.test",
    } as unknown as AttentionFacts["state"],
    addressUndeliverable: false,
    ...overrides,
  });

  test("after go-live each quiet channel gets its line and the one thing to check, linking to Settings", () => {
    const items = needsAttention(facts({ live: true, quietChannels: ["voice", "web"] })).filter(
      (i) => i.id === "quiet_channel",
    );
    expect(items).toEqual([
      {
        key: "quiet_channel:voice",
        id: "quiet_channel",
        text: "No calls have reached AYA for a week. Check that call forwarding is still set on your line.",
        action: { label: "Check it in Settings", href: "/c/glow/settings#channels" },
      },
      {
        key: "quiet_channel:web",
        id: "quiet_channel",
        text: "No one has used your website chat for a week. Check that the chat is still on your website.",
        action: { label: "Check it in Settings", href: "/c/glow/settings#channels" },
      },
    ]);
    // Before go-live there is nothing to be quiet.
    expect(
      needsAttention(facts({ live: false, quietChannels: ["voice"] })).some(
        (i) => i.id === "quiet_channel",
      ),
    ).toBe(false);
    expect(QUIET_CHANNEL_DAYS).toBe(7);
  });
});

describe("the listed price", () => {
  test("the listed price a booking keeps: the low end, the unit price apart, nothing for no price", () => {
    expect(listedPrice({ priceKind: "exact", priceFromUsd: 150, priceToUsd: 150 })).toEqual({
      cents: 15_000,
      kind: "exact",
    });
    expect(listedPrice({ priceKind: "from", priceFromUsd: 199.5, priceToUsd: null })).toEqual({
      cents: 19_950,
      kind: "from",
    });
    expect(listedPrice({ priceKind: "range", priceFromUsd: 500, priceToUsd: 800 })).toEqual({
      cents: 50_000,
      kind: "range",
    });
    expect(
      listedPrice({ priceKind: "per_unit", priceFromUsd: 14, priceToUsd: null, unit: "unit" }),
    ).toEqual({ cents: 1_400, kind: "per_unit" });
    // A service written before kinds: both ends say what it is.
    expect(listedPrice({ priceFromUsd: 300, priceToUsd: 450 })).toEqual({
      cents: 30_000,
      kind: "range",
    });
    expect(listedPrice({ priceKind: null, priceFromUsd: null, priceToUsd: null })).toBeNull();
    expect(listedPrice(null)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Against the database
// -----------------------------------------------------------------------------

describeDb("the claims, against the database", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 60_000);

  beforeEach(async () => {
    await truncateAll();
  }, 120_000);

  afterAll(async () => {
    await closePools();
  });

  test("a booking keeps the listed price it was made at, which nothing changes afterwards", async () => {
    const c = await provisionPortalClinic("price-snap");
    await setServices(c.clinicId);
    const priced = await request(
      c.clinicId,
      { name: "Maria Lopez", phone: "+14155550134" },
      "consultation",
    );
    const unpriced = await request(
      c.clinicId,
      { name: "Ben Ortiz", phone: "+14155550177" },
      "Assessment",
    );
    const first = await deskDecideById(c.clinicId, priced, "confirmed", {
      decidedByLabel: "Jo",
      deskNote: null,
      confirmedFor: new Date(Date.now() + 3 * DAY),
    });
    const second = await deskDecideById(c.clinicId, unpriced, "confirmed", {
      decidedByLabel: "Jo",
      deskNote: null,
      confirmedFor: new Date(Date.now() + 4 * DAY),
    });
    const rows = await inTenant(c.clinicId, async (client) => {
      const { rows } = await client.query<{
        id: string;
        listed_price_cents: number | null;
        listed_price_kind: string | null;
      }>(
        `select id, listed_price_cents, listed_price_kind from appointments where id = any($1::uuid[]) order by scheduled_for`,
        [[first.appointmentId, second.appointmentId]],
      );
      return rows;
    });
    expect(rows.map((r) => [r.listed_price_cents, r.listed_price_kind])).toEqual([
      [15_000, "exact"],
      [null, null],
    ]);
    // A later price edit in Knowledge never rewrites it, for the app or the owner.
    await setServices(c.clinicId);
    const app = await getAppPool().connect();
    try {
      await app.query("begin");
      await app.query(`select set_config('app.clinic_id', $1, true)`, [c.clinicId]);
      await expect(
        app.query(`update appointments set listed_price_cents = 99 where id = $1`, [
          first.appointmentId,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      await app.query("rollback");
    } finally {
      app.release();
    }
    await expect(
      inTenant(c.clinicId, (client) =>
        client.query(`update appointments set listed_price_kind = 'from' where id = $1`, [
          first.appointmentId,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  test("the claims over a period: each channel, rang out, requests and confirmations, AYA's bookings, booked value and deposits", async () => {
    const now = new Date(Date.now() + MINUTE);
    const c = await liveClinic(
      "claims",
      new Date(now.getTime() - 20 * DAY),
      "voice-metachat-1000-1000",
    );
    await setServices(c.clinicId);
    const inWeek = new Date(now.getTime() - 2 * DAY);
    await conversation(c.clinicId, { channel: "voice", at: inWeek, reason: "after_hours" });
    await conversation(c.clinicId, {
      channel: "voice",
      at: inWeek,
      reason: "rang_unanswered",
      urgent: true,
      outcome: "escalated_to_human",
    });
    // A legacy call-back reason is never a call answered that would have rung out.
    await conversation(c.clinicId, {
      channel: "voice",
      at: inWeek,
      reason: "missed_call_callback",
    });
    await conversation(c.clinicId, {
      channel: "voice",
      at: inWeek,
      reason: null,
      outcome: "escalated_to_human",
    });
    await conversation(c.clinicId, { channel: "web_chat", at: inWeek });
    // Outside the week.
    await conversation(c.clinicId, {
      channel: "voice",
      at: new Date(now.getTime() - 9 * DAY),
      reason: "after_hours",
    });
    // Two Meta conversations AYA was allowed to answer, one last month.
    for (const [ref, at] of [
      ["ref-a", inWeek],
      ["ref-b", inWeek],
      ["ref-c", new Date(now.getTime() - 30 * DAY)],
    ] as const) {
      await inTenant(c.clinicId, (client) =>
        client.query(
          `insert into usage_events (clinic_id, location_clinic_id, meter, source, source_ref, quantity, occurred_at, included, used_before)
           values ($1, $1, 'chat_conversations', 'meta', $2, 1, $3, 1000, 0)`,
          [c.clinicId, ref, at],
        ),
      );
    }
    // Requests: one waiting, one confirmed at an exact price, one at a
    // per-unit price, one with no listed price, and one AYA booked herself.
    await request(c.clinicId, { name: "Ana Diaz", phone: "+14155550101" });
    for (const [treatment, days] of [
      ["Consultation", 3],
      ["Toxin", 4],
      ["Assessment", 5],
    ] as const) {
      const id = await request(
        c.clinicId,
        { name: `Pat ${treatment}`, phone: `+1415555020${days}` },
        treatment,
      );
      await deskDecideById(c.clinicId, id, "confirmed", {
        decidedByLabel: "Jo",
        deskNote: null,
        confirmedFor: new Date(Date.now() + days * DAY),
      });
    }
    const ayaRequest = await request(
      c.clinicId,
      { name: "Lee Park", phone: "+14155550301" },
      "Peel",
    );
    const ayaContact = await inTenant(
      c.clinicId,
      async (client) =>
        (
          await client.query<{ contact_id: string }>(
            `select contact_id from booking_requests where id = $1`,
            [ayaRequest],
          )
        ).rows[0]!.contact_id,
    );
    await inTenant(c.clinicId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into appointments (clinic_id, contact_id, scheduled_for, treatment, booking_origin, calendar_event_key, listed_price_cents, listed_price_kind)
         values ($1, $2, now() + interval '6 days', 'Peel', 'assistant', $3, 20000, 'range') returning id`,
        [c.clinicId, ayaContact, ayaRequest],
      );
      await client.query(
        `update booking_requests set status = 'confirmed', appointment_id = $2, confirmed_for = now() + interval '6 days', decided_at = now() where id = $1`,
        [ayaRequest, rows[0]!.id],
      );
    });
    // Deposits: one paid this week through the clinic's own link, one still open.
    for (const [status, paid] of [
      ["paid", inWeek],
      ["open", null],
    ] as const) {
      await inTenant(c.clinicId, (client) =>
        client.query(
          `insert into deposit_payments (clinic_id, channel, amount_cents, stripe_account_id, status, paid_at)
           values ($1, 'web', 5000, 'acct_test', $2, $3)`,
          [c.clinicId, status, paid],
        ),
      );
    }

    const claims = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      readClaims(tx, { from: new Date(now.getTime() - 7 * DAY), to: now }, "home"),
    );
    // In the catalog's order: website chat, Meta, phone.
    expect(claims.channels).toEqual([
      { channel: "web", handled: 1 },
      { channel: "meta", handled: 2 },
      { channel: "voice", handled: 4 },
    ]);
    expect(claims.handled).toBe(7);
    expect(claims.rangOut).toBe(2);
    expect(claims.urgent).toBe(1);
    expect(claims.handovers).toBe(1);
    expect(claims.requestsTaken).toBe(4);
    expect(claims.requestsConfirmed).toBe(3);
    expect(claims.bookedByAya).toBe(1);
    // $150 exact and $200, the low end of AYA's range-priced booking.
    expect(claims.bookedValue).toEqual({ cents: 35_000, priced: 2, perUnit: 1, unpriced: 1 });
    expect(claims.depositsCollected).toEqual({ count: 1, cents: 5_000 });
    // The calendar is not connected, so bookings are requests.
    expect(claims.bookingMode).toBe("requests");

    // A clinic without phone has no rang-out count: unavailable, not zero.
    const web = await liveClinic("claims-web", new Date(now.getTime() - 20 * DAY), "webchat-1000");
    const webClaims = await withTenant({ clinicId: web.clinicId, actor: ACTOR }, (tx) =>
      readClaims(tx, { from: new Date(now.getTime() - 7 * DAY), to: now }, "home"),
    );
    expect(webClaims.rangOut).toBeNull();
    expect(webClaims.channels.map((ch) => ch.channel)).toEqual(["web"]);
  });

  test("Waiting for you counts what Needs you lists, and nothing lapsed or past", async () => {
    const c = await provisionPortalClinic("waiting");
    const older = await request(c.clinicId, { name: "Ana Diaz", phone: "+14155550101" });
    await backdate(c.clinicId, older, `created_at = now() - interval '2 hours'`);
    await request(c.clinicId, { name: "Ben Ortiz", phone: "+14155550102" });
    const lapsed = await request(c.clinicId, { name: "Cleo Park", phone: "+14155550103" });
    await backdate(c.clinicId, lapsed, `expires_at = now() - interval '1 hour'`);
    const booked = await request(c.clinicId, { name: "Dee Fox", phone: "+14155550104" });
    const decided = await deskDecideById(c.clinicId, booked, "confirmed", {
      decidedByLabel: "Jo",
      deskNote: null,
      confirmedFor: new Date(Date.now() + 2 * DAY),
    });
    await inTenant(c.clinicId, (client) =>
      client.query(
        `update appointments set deposit_status = 'pending_front_desk', deposit_usd = 50 where id = $1`,
        [decided.appointmentId],
      ),
    );
    const counts = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      readWaitingCounts(tx),
    );
    expect(counts.toCallBack).toBe(2);
    expect(counts.depositsToCollect).toBe(1);
    expect(Math.round((Date.now() - counts.oldestSince!.getTime()) / HOUR)).toBe(2);
    // After the appointment, its deposit is no longer waiting.
    const later = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      readWaitingCounts(tx, new Date(Date.now() + 3 * DAY)),
    );
    expect(later.depositsToCollect).toBe(0);
  });

  test("a channel is quiet after a week live and answering with nothing reaching it, and not after a pause or a recent call", async () => {
    const now = new Date(Date.now() + MINUTE);
    const c = await liveClinic("quiet", new Date(now.getTime() - 10 * DAY));
    const quiet = async (at: Date) =>
      withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) =>
        readQuietChannels(tx, await readChannelStates(tx.db, tx.clinicId, at), at),
      );
    expect(await quiet(now)).toEqual(["web", "voice"]);
    await conversation(c.clinicId, { channel: "voice", at: new Date(now.getTime() - 2 * DAY) });
    expect(await quiet(now)).toEqual(["web"]);
    // Turned back on three days ago: not a week of answering yet.
    await inTenant(c.clinicId, (client) =>
      client.query(
        `insert into channel_events (clinic_id, channel, kind, actor, occurred_at) values ($1, null, 'resumed', 'system', $2)`,
        [c.clinicId, new Date(now.getTime() - 3 * DAY)],
      ),
    );
    expect(await quiet(now)).toEqual([]);
    // A week on from that, and from the call, both are quiet again.
    expect(await quiet(new Date(now.getTime() + 5 * DAY))).toEqual(["web"]);
    expect(await quiet(new Date(now.getTime() + 6 * DAY))).toEqual(["web", "voice"]);
    // Live for less than a week: never quiet.
    const fresh = await liveClinic("quiet-new", new Date(now.getTime() - 3 * DAY));
    expect(
      await withTenant({ clinicId: fresh.clinicId, actor: ACTOR }, async (tx) =>
        readQuietChannels(tx, await readChannelStates(tx.db, tx.clinicId, now), now),
      ),
    ).toEqual([]);
  });
});
