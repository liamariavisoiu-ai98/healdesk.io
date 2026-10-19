import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { FakeGoogleCalendar } from "@healdesk/connectors";
import { setGoogleFetch } from "@healdesk/connectors";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { auth } from "@/lib/auth";
import { hashSessionToken } from "@/lib/factors/step-ups";
import { createBookingRequest } from "@/lib/meta/booking-requests";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { deskDecideById } from "./setup/desk";
import {
  deskLocation,
  freshGoogle,
  installGoogleEnv,
  phoneRequest,
  restoreGoogleEnv,
} from "./setup/desk-calendar";
import { inTenant } from "./setup/factories";
import { provisionPortalClinic, type PortalClinic } from "./setup/portal-clinic";
import { brokenLinks } from "./setup/portal-links";

/**
 * Bookings (plan Part F5) against the database, behind a real passkey
 * step-up: every session here is one a sign-in link started, presented by
 * its cookie, and its step-up a row on that session as the store keeps it.
 *
 * - The page and both actions refuse without a step-up, and another clinic's
 *   sign-in, request or appointment is "not found".
 * - The page shows Needs you, Missed and Booked by AYA, and writes one access
 *   row per list naming the passkey and the device.
 * - Confirm, Propose and Decline go through the decision core keyed by the
 *   clinic and the request, as the sign-in and its passkey.
 * - Showed, No-show and Cancelled update the appointment, and log.
 * - The emailed link (/booking/<token>) shows nothing of the person: it
 *   points through sign-in and the step-up to the request.
 * - The calendar's free times are asked for after the page's transaction
 *   has committed.
 */

const mocks = vi.hoisted(() => {
  class NavigationSignal extends Error {
    constructor(readonly url: string) {
      super("NEXT_REDIRECT");
    }
  }
  return { NavigationSignal, headers: new Headers() };
});

vi.mock("next/headers", () => ({
  headers: async () => mocks.headers,
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new mocks.NavigationSignal(url);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  RedirectType: { replace: "replace", push: "push" },
  // The shell's Help carries the support chat (WP10), which reads the slug
  // from the route; static markup has no router.
  useParams: () => null,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
// The guard shows nothing until the browser has asked the server
// (PatientPageGuard); static markup has no browser, so it stands in as a
// wrapper that says which step-up and render it was given.
vi.mock("@/app/c/[slug]/PatientPageGuard", async () => {
  const { createElement } = await import("react");
  return {
    PatientPageGuard: (props: {
      slug: string;
      stepUpId: string;
      renderId: string;
      children: unknown;
    }) =>
      createElement(
        "div",
        { "data-guard": props.slug, "data-step-up": props.stepUpId, "data-render": props.renderId },
        props.children as never,
      ),
  };
});

const { default: BookingsPage } = await import("@/app/c/[slug]/bookings/page");
const { decideBooking, markOutcome } = await import("@/app/c/[slug]/bookings/actions");
const { default: BookingPointerPage } = await import("@/app/booking/[token]/page");
const { requirePatientPage, withPatientPage } = await import("@/lib/portal/patient-page");
const { readBookingsScreen, withFreeTimes } = await import("@/lib/portal/bookings");

const describeDb = hasTestDatabase ? describe : describe.skip;
const DAY = 86_400_000;
const SERVICE = { type: "service", serviceName: "test" } as const;
const APP_DIR = join(process.cwd(), "src", "app");

type Signed = { cookie: string; token: string; userId: string };

async function signIn(userId: string): Promise<Signed> {
  const started = await auth.api.startLinkSession({
    body: { userId },
    headers: new Headers(),
    asResponse: true,
  });
  const cookie = started.headers
    .getSetCookie()
    .find((c) => c.startsWith("hd.session_token="))!
    .split(";")[0]!;
  const token = decodeURIComponent(cookie.slice("hd.session_token=".length)).split(".")[0]!;
  return { cookie, token, userId };
}

function browse(who: Signed | null, path: string): void {
  mocks.headers = new Headers({
    ...(who ? { cookie: who.cookie } : {}),
    "x-healdesk-path": path,
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    "x-forwarded-for": "203.0.113.7",
  });
}

async function outcome<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; redirect: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    if (error instanceof mocks.NavigationSignal) return { ok: false, redirect: error.url };
    throw error;
  }
}

/** A passkey on the sign-in, and a live step-up with it on this session, as the store keeps one. */
async function stepUpWithPasskey(
  who: Signed,
  label = "Front desk Mac",
): Promise<{ factorId: string; stepUpId: string }> {
  const pool = getMigratorPool();
  const factor = await pool.query<{ id: string }>(
    `insert into user_factors (user_id, kind, device_label, credential_id, public_key, counter, backed_up)
     values ($1, 'passkey', $2, $3, '\\x01', 0, true) returning id`,
    [who.userId, label, randomBytes(16).toString("base64url")],
  );
  const factorId = factor.rows[0]!.id;
  const step = await pool.query<{ id: string }>(
    `insert into step_ups (session_token_hash, user_id, factor_id, device_label, created_at, last_activity_at)
     values ($1, $2, $3, $4, now() - interval '1 minute', now()) returning id`,
    [hashSessionToken(who.token), who.userId, factorId, label],
  );
  return { factorId, stepUpId: step.rows[0]!.id };
}

type AuditRow = {
  actor_type: string;
  actor_user_id: string | null;
  actor_label: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  resource_ids: string[] | null;
  metadata: Record<string, unknown> | null;
};

async function auditRows(clinicId: string): Promise<AuditRow[]> {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<AuditRow>(
      `select actor_type, actor_user_id, actor_label, action, resource_type, resource_id,
              resource_ids, metadata
         from audit_log where clinic_id = $1 order by occurred_at, id`,
      [clinicId],
    );
    return rows;
  });
}

async function auditCount(clinicId: string): Promise<number> {
  return (await auditRows(clinicId)).length;
}

/** A caller and their request on the phone, as the booking engine logs one. */
async function voiceRequest(
  clinicId: string,
  person: { name: string; phone: string },
  window = "Thursday afternoon",
): Promise<{ id: string; token: string }> {
  const contactId = await inTenant(clinicId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `insert into contacts (clinic_id, phone, full_name) values ($1, $2, $3) returning id`,
      [clinicId, person.phone, person.name],
    );
    return rows[0]!.id;
  });
  return withTenant({ clinicId, actor: SERVICE }, (tx) =>
    createBookingRequest(tx, {
      channel: "voice",
      contactId,
      conversationId: null,
      preferredWindow: window,
      treatment: "Consultation",
      alternativeWindows: ["Friday morning"],
    }),
  );
}

/** Move a request's link expiry into the past, as the owner with the no-rewrite trigger off. */
async function lapse(clinicId: string, requestId: string): Promise<void> {
  const pool = getMigratorPool();
  await pool.query(`alter table booking_requests disable trigger booking_requests_no_rewrite`);
  try {
    await inTenant(clinicId, (client) =>
      client.query(
        `update booking_requests set expires_at = now() - interval '1 hour' where id = $1`,
        [requestId],
      ),
    );
  } finally {
    await pool.query(`alter table booking_requests enable trigger booking_requests_no_rewrite`);
  }
}

async function requestRow(clinicId: string, id: string) {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<{
      status: string;
      decided_by_label: string | null;
      appointment_id: string | null;
    }>(`select status, decided_by_label, appointment_id from booking_requests where id = $1`, [id]);
    return rows[0]!;
  });
}

async function appointmentStatus(clinicId: string, id: string): Promise<string> {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<{ status: string }>(
      `select status from appointments where id = $1`,
      [id],
    );
    return rows[0]!.status;
  });
}

function form(fields: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) data.append(key, v);
  }
  return data;
}

async function renderBookings(slug: string, query: Record<string, string> = {}): Promise<string> {
  return renderToStaticMarkup(
    await BookingsPage({
      params: Promise.resolve({ slug }),
      searchParams: Promise.resolve(query),
    }),
  );
}

describeDb("Bookings", () => {
  let a: PortalClinic;
  let b: PortalClinic;

  beforeAll(async () => {
    await runMigrations();
  }, 60_000);

  beforeEach(async () => {
    await truncateAll();
    mocks.headers = new Headers();
    a = await provisionPortalClinic("bookings-a");
    b = await provisionPortalClinic("bookings-b");
  }, 120_000);

  afterAll(async () => {
    await closePools();
  });

  test("opens only behind the passkey step-up, and another clinic's sign-in gets not found", async () => {
    const path = `/c/${a.clinicSlug}/bookings`;
    const request = await voiceRequest(a.clinicId, { name: "Maria Lopez", phone: "+14155550134" });
    const before = await auditCount(a.clinicId);

    browse(null, path);
    expect(await outcome(() => renderBookings(a.clinicSlug))).toEqual({
      ok: false,
      redirect: `/sign-in?next=${encodeURIComponent(`/c/${a.clinicSlug}`)}`,
    });

    const link = await signIn(a.userId);
    browse(link, path);
    expect(await outcome(() => renderBookings(a.clinicSlug))).toEqual({
      ok: false,
      redirect: `/c/${a.clinicSlug}/step-up?next=${encodeURIComponent(path)}`,
    });
    // The emailed link's target comes back to the request after the step-up.
    expect(await outcome(() => renderBookings(a.clinicSlug, { request: request.id }))).toEqual({
      ok: false,
      redirect: `/c/${a.clinicSlug}/step-up?next=${encodeURIComponent(`${path}?request=${request.id}`)}`,
    });

    // Clinic B's sign-in, stepped up on its own device, cannot open A's Bookings.
    const other = await signIn(b.userId);
    await stepUpWithPasskey(other, "Other desk");
    browse(other, path);
    await expect(renderBookings(a.clinicSlug)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(await auditCount(a.clinicId)).toBe(before);
  });

  test("Needs you, Missed and Booked by AYA, each list logged once by the passkey and device", async () => {
    const open = await voiceRequest(a.clinicId, { name: "Maria Lopez", phone: "+14155550134" });
    const missed = await voiceRequest(
      a.clinicId,
      { name: "Ben Ortiz", phone: "+14155550177" },
      "Monday morning",
    );
    await lapse(a.clinicId, missed.id);
    const booked = await voiceRequest(a.clinicId, { name: "Cleo Park", phone: "+14155550199" });
    const at = new Date(Date.now() + 3 * DAY);
    const decided = await deskDecideById(a.clinicId, booked.id, "confirmed", {
      decidedByLabel: "Jo",
      deskNote: null,
      confirmedFor: at,
    });
    expect(decided.outcome).toBe("decided");
    const appointmentId = decided.appointmentId!;
    // A deposit the clinic's rule left for the front desk to take.
    await inTenant(a.clinicId, (client) =>
      client.query(
        `update appointments set deposit_status = 'pending_front_desk', deposit_usd = 50 where id = $1`,
        [appointmentId],
      ),
    );
    // Clinic B's request never shows on A's screen.
    await voiceRequest(b.clinicId, { name: "Zed Other", phone: "+14155550111" });

    const link = await signIn(a.userId);
    const { factorId, stepUpId } = await stepUpWithPasskey(link);
    browse(link, `/c/${a.clinicSlug}/bookings`);
    const before = await auditCount(a.clinicId);
    const html = await renderBookings(a.clinicSlug);
    // Everything about a patient sits inside the guard, given this step-up.
    expect(html).toContain(`data-step-up="${stepUpId}"`);
    expect(html.indexOf("data-guard=")).toBeLessThan(html.indexOf("Maria Lopez"));

    const needs = html.slice(html.indexOf("Needs you"), html.indexOf('id="missed"'));
    expect(needs).toContain("Maria Lopez would like to book");
    expect(needs).toContain('href="tel:+14155550134"');
    expect(needs).toContain("Call Maria");
    expect(needs).toContain("Thursday afternoon");
    expect(needs).toContain("Confirm a time");
    expect(needs).toContain("Propose other times");
    expect(needs).toContain(">Decline<");
    expect(needs).not.toContain("Ben");
    expect(needs).toContain("Deposits to collect");
    expect(needs).toContain("A $50 deposit from Cleo Park, before");
    expect(needs).toContain("Your team confirmed it, and the deposit is still to take.");
    expect(needs).toContain('href="tel:+14155550199"');
    const missedPart = html.slice(html.indexOf('id="missed"'), html.indexOf('id="booked"'));
    expect(missedPart).toContain("They were told you’d call.");
    expect(missedPart).toContain("Ben Ortiz");
    expect(missedPart).toContain('href="tel:+14155550177"');
    expect(missedPart).not.toContain("Decline");
    const bookedPart = html.slice(html.indexOf('id="booked"'));
    expect(bookedPart).toContain("Cleo Park");
    // Every request has its anchor, wherever it now sits. Conversations
    // links one by its ?request= focus instead (conversations-screen.test.ts).
    expect(needs).toContain(`id="request-${open.id}"`);
    expect(missedPart).toContain(`id="request-${missed.id}"`);
    expect(bookedPart).toContain(`id="request-${booked.id}"`);
    expect(bookedPart).toContain("Confirmed by Jo");
    expect(bookedPart).toContain("Deposit of $50 to collect: call them");
    expect(bookedPart).toMatch(/aria-pressed="false"[^>]*>Showed</);
    expect(bookedPart).toContain(">No-show<");
    expect(bookedPart).toContain(">Cancelled<");
    expect(html).not.toContain("Zed");
    expect(html).not.toMatch(/\brevenue\b|HIPAA compliant/i);
    expect(brokenLinks(html, a.clinicSlug)).toEqual([]);

    const rows = (await auditRows(a.clinicId)).slice(before);
    const reads = rows.filter((r) => r.action === "read");
    expect(reads).toHaveLength(2);
    for (const r of reads) {
      expect(r).toMatchObject({
        actor_type: "user",
        actor_user_id: a.userId,
        actor_label: "Front desk Mac",
        metadata: { passkeyId: factorId, stepUpId },
      });
    }
    const requests = reads.find((r) => r.resource_type === "booking_request")!;
    expect([...requests.resource_ids!].sort()).toEqual([open.id, missed.id].sort());
    const appointments = reads.find((r) => r.resource_type === "appointment")!;
    expect(appointments.resource_ids).toEqual([appointmentId]);
    // Ids only: nothing of the person in the access log.
    expect(JSON.stringify(rows)).not.toMatch(/Maria|Ben|Cleo|0134|Thursday/);
  });

  test("Confirm, Propose and Decline go through the core as the sign-in and its passkey; none without a step-up", async () => {
    const first = await voiceRequest(a.clinicId, { name: "Maria Lopez", phone: "+14155550134" });
    const second = await voiceRequest(a.clinicId, { name: "Ben Ortiz", phone: "+14155550177" });
    const theirs = await voiceRequest(b.clinicId, { name: "Zed Other", phone: "+14155550111" });
    const link = await signIn(a.userId);
    browse(link, `/c/${a.clinicSlug}/bookings`);

    // No step-up: nothing read, nothing decided.
    const before = await auditCount(a.clinicId);
    expect(
      await outcome(() =>
        decideBooking(
          a.clinicSlug,
          { status: "idle" },
          form({ requestId: second.id, decision: "declined" }),
        ),
      ),
    ).toEqual({
      ok: false,
      redirect: `/c/${a.clinicSlug}/step-up?next=${encodeURIComponent(`/c/${a.clinicSlug}/bookings`)}`,
    });
    expect((await requestRow(a.clinicId, second.id)).status).toBe("requested");
    expect(await auditCount(a.clinicId)).toBe(before);

    const { factorId, stepUpId } = await stepUpWithPasskey(link);
    const as = { actor_type: "user", actor_user_id: a.userId, actor_label: "Front desk Mac" };
    const passkey = { passkeyId: factorId, stepUpId };

    // Propose two times.
    const t1 = new Date(Date.now() + 2 * DAY);
    const t2 = new Date(Date.now() + 4 * DAY);
    let mark = await auditCount(a.clinicId);
    expect(
      await outcome(() =>
        decideBooking(
          a.clinicSlug,
          { status: "idle" },
          form({
            requestId: first.id,
            decision: "rescheduling",
            proposedSlot: [t1.toISOString(), t2.toISOString()],
          }),
        ),
      ),
    ).toEqual({
      ok: false,
      redirect: `/c/${a.clinicSlug}/bookings?request=${first.id}&followup=none&calendar=none`,
    });
    expect((await requestRow(a.clinicId, first.id)).status).toBe("rescheduling");
    let rows = (await auditRows(a.clinicId)).slice(mark);
    expect(rows[0]).toMatchObject({
      ...as,
      action: "read",
      resource_type: "booking_request",
      resource_id: first.id,
      metadata: passkey,
    });
    expect(rows).toContainEqual(
      expect.objectContaining({
        ...as,
        action: "update",
        resource_id: first.id,
        metadata: expect.objectContaining({
          outcome: "decided",
          decision: "rescheduling",
          slots: 2,
          ...passkey,
        }),
      }),
    );

    // Confirm the one they chose: the appointment, created as the passkey.
    mark = await auditCount(a.clinicId);
    await outcome(() =>
      decideBooking(
        a.clinicSlug,
        { status: "idle" },
        form({ requestId: first.id, decision: "confirmed", slotAt: t1.toISOString(), name: "Jo" }),
      ),
    );
    const confirmed = await requestRow(a.clinicId, first.id);
    expect(confirmed).toMatchObject({ status: "confirmed", decided_by_label: "Jo" });
    expect(confirmed.appointment_id).not.toBeNull();
    rows = (await auditRows(a.clinicId)).slice(mark);
    expect(rows).toContainEqual(
      expect.objectContaining({
        ...as,
        action: "create",
        resource_type: "appointment",
        resource_id: confirmed.appointment_id,
        metadata: expect.objectContaining({ confirmedByDesk: true, ...passkey }),
      }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        ...as,
        action: "update",
        resource_id: first.id,
        metadata: expect.objectContaining({
          outcome: "decided",
          decision: "confirmed",
          ...passkey,
        }),
      }),
    );

    // Decline, with no name typed: the device decided it.
    await outcome(() =>
      decideBooking(
        a.clinicSlug,
        { status: "idle" },
        form({ requestId: second.id, decision: "declined" }),
      ),
    );
    expect(await requestRow(a.clinicId, second.id)).toMatchObject({
      status: "declined",
      decided_by_label: "Front desk Mac",
    });

    // A second decision on a decided request is refused, and the refusal is
    // audited with the passkey behind it.
    mark = await auditCount(a.clinicId);
    await outcome(() =>
      decideBooking(
        a.clinicSlug,
        { status: "idle" },
        form({ requestId: second.id, decision: "declined" }),
      ),
    );
    expect((await auditRows(a.clinicId)).slice(mark)).toContainEqual(
      expect.objectContaining({
        ...as,
        action: "update",
        metadata: expect.objectContaining({
          outcome: "rejected",
          reason: "already-decided",
          ...passkey,
        }),
      }),
    );

    // Clinic B's request, posted to A's Bookings: not found, untouched, unlogged.
    mark = await auditCount(a.clinicId);
    await expect(
      decideBooking(
        a.clinicSlug,
        { status: "idle" },
        form({ requestId: theirs.id, decision: "declined" }),
      ),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect((await requestRow(b.clinicId, theirs.id)).status).toBe("requested");
    expect(await auditCount(a.clinicId)).toBe(mark);
    expect(await auditCount(b.clinicId)).toBe(
      (await auditRows(b.clinicId)).filter((r) => r.actor_user_id !== a.userId).length,
    );
  });

  test("Showed, No-show and Cancelled update the appointment and log by the passkey; another clinic's is not found", async () => {
    const past = await voiceRequest(a.clinicId, { name: "Maria Lopez", phone: "+14155550134" });
    const ahead = await voiceRequest(a.clinicId, { name: "Ben Ortiz", phone: "+14155550177" });
    const theirs = await voiceRequest(b.clinicId, { name: "Zed Other", phone: "+14155550111" });
    const started = await deskDecideById(a.clinicId, past.id, "confirmed", {
      decidedByLabel: "Jo",
      deskNote: null,
      confirmedFor: new Date(Date.now() - 30 * 60_000),
    });
    const upcoming = await deskDecideById(a.clinicId, ahead.id, "confirmed", {
      decidedByLabel: "Jo",
      deskNote: null,
      confirmedFor: new Date(Date.now() + 2 * DAY),
    });
    const other = await deskDecideById(b.clinicId, theirs.id, "confirmed", {
      decidedByLabel: "Jo",
      deskNote: null,
      confirmedFor: new Date(Date.now() - 30 * 60_000),
    });
    const startedId = started.appointmentId!;
    const upcomingId = upcoming.appointmentId!;

    const link = await signIn(a.userId);
    browse(link, `/c/${a.clinicSlug}/bookings`);
    const mark0 = await auditCount(a.clinicId);
    expect(
      await outcome(() =>
        markOutcome(
          a.clinicSlug,
          { status: "idle" },
          form({ appointmentId: startedId, outcome: "showed" }),
        ),
      ),
    ).toMatchObject({ ok: false, redirect: expect.stringContaining("/step-up?next=") });
    expect(await appointmentStatus(a.clinicId, startedId)).toBe("scheduled");
    expect(await auditCount(a.clinicId)).toBe(mark0);

    const { factorId, stepUpId } = await stepUpWithPasskey(link);
    const as = { actor_type: "user", actor_user_id: a.userId, actor_label: "Front desk Mac" };

    let mark = await auditCount(a.clinicId);
    expect(
      await markOutcome(
        a.clinicSlug,
        { status: "idle" },
        form({ appointmentId: startedId, outcome: "showed" }),
      ),
    ).toMatchObject({ status: "saved", outcome: "showed" });
    expect(await appointmentStatus(a.clinicId, startedId)).toBe("showed");
    // One transaction: both rows share its time, so their order is not asserted.
    const marked = (await auditRows(a.clinicId)).slice(mark);
    expect(marked).toHaveLength(2);
    expect(marked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ...as,
          action: "read",
          resource_type: "appointment",
          resource_id: startedId,
          metadata: { passkeyId: factorId, stepUpId },
        }),
        expect.objectContaining({
          ...as,
          action: "update",
          resource_type: "appointment",
          resource_id: startedId,
          metadata: {
            outcome: "marked",
            status: "showed",
            from: "scheduled",
            passkeyId: factorId,
            stepUpId,
          },
        }),
      ]),
    );

    // A mis-click is put right with another click.
    await markOutcome(
      a.clinicSlug,
      { status: "idle" },
      form({ appointmentId: startedId, outcome: "no_show" }),
    );
    expect(await appointmentStatus(a.clinicId, startedId)).toBe("no_show");

    // Ahead of its time: no showed or no-show yet; cancelled, once confirmed.
    expect(
      await markOutcome(
        a.clinicSlug,
        { status: "idle" },
        form({ appointmentId: upcomingId, outcome: "showed" }),
      ),
    ).toMatchObject({
      status: "failed",
      message: expect.stringMatching(/once the appointment has started/),
    });
    expect(await appointmentStatus(a.clinicId, upcomingId)).toBe("scheduled");
    // Cancelling one still ahead asks first, and says what it does.
    expect(
      await markOutcome(
        a.clinicSlug,
        { status: "idle" },
        form({ appointmentId: upcomingId, outcome: "cancelled" }),
      ),
    ).toEqual({
      status: "confirm",
      message:
        "Cancelling frees this time in healdesk, so AYA may book it for someone else. It doesn't change your calendar, and it can't be undone here.",
    });
    expect(await appointmentStatus(a.clinicId, upcomingId)).toBe("scheduled");

    // A calendar write still on its way: no cancelling until it settles, or
    // it could land in the clinic's calendar afterwards.
    await inTenant(a.clinicId, (client) =>
      client.query(`update appointments set calendar_write_status = 'unknown' where id = $1`, [
        upcomingId,
      ]),
    );
    mark = await auditCount(a.clinicId);
    expect(
      await markOutcome(
        a.clinicSlug,
        { status: "idle" },
        form({ appointmentId: upcomingId, outcome: "cancelled", confirm: "1" }),
      ),
    ).toEqual({
      status: "failed",
      message:
        "We're still checking whether this booking reached your calendar. Try again in a minute.",
    });
    expect(await appointmentStatus(a.clinicId, upcomingId)).toBe("scheduled");
    // It read the appointment (its access row) and changed nothing.
    expect((await auditRows(a.clinicId)).slice(mark).map((r) => r.action)).toEqual(["read"]);
    await inTenant(a.clinicId, (client) =>
      client.query(`update appointments set calendar_write_status = 'failed' where id = $1`, [
        upcomingId,
      ]),
    );
    expect(
      await markOutcome(
        a.clinicSlug,
        { status: "idle" },
        form({ appointmentId: upcomingId, outcome: "cancelled", confirm: "1" }),
      ),
    ).toMatchObject({ status: "saved", outcome: "cancelled" });
    expect(await appointmentStatus(a.clinicId, upcomingId)).toBe("cancelled");

    // Clinic B's appointment, through A's Bookings: not found, untouched, no row.
    mark = await auditCount(a.clinicId);
    await expect(
      markOutcome(
        a.clinicSlug,
        { status: "idle" },
        form({ appointmentId: other.appointmentId!, outcome: "cancelled" }),
      ),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(await appointmentStatus(b.clinicId, other.appointmentId!)).toBe("scheduled");
    expect(await auditCount(a.clinicId)).toBe(mark);
  });

  test("the emailed link shows nothing of the person, and points through sign-in and the step-up to the request", async () => {
    const request = await voiceRequest(a.clinicId, { name: "Maria Lopez", phone: "+14155550134" });
    const target = `/c/${a.clinicSlug}/bookings?request=${request.id}`;

    browse(null, `/booking/${request.token}`);
    expect(
      await outcome(() =>
        BookingPointerPage({ params: Promise.resolve({ token: request.token }) }),
      ),
    ).toEqual({ ok: false, redirect: `/sign-in?next=${encodeURIComponent(target)}` });
    expect(
      await outcome(() =>
        BookingPointerPage({ params: Promise.resolve({ token: "A".repeat(43) }) }),
      ),
    ).toEqual({ ok: false, redirect: "/booking/invalid" });
    expect(
      await outcome(() =>
        BookingPointerPage({ params: Promise.resolve({ token: "not-a-token" }) }),
      ),
    ).toEqual({ ok: false, redirect: "/booking/invalid" });

    const link = await signIn(a.userId);
    browse(link, `/booking/${request.token}`);
    expect(
      await outcome(() =>
        BookingPointerPage({ params: Promise.resolve({ token: request.token }) }),
      ),
    ).toEqual({ ok: false, redirect: target });
    // Still a pointer once the request has lapsed: it is under Missed.
    await lapse(a.clinicId, request.id);
    expect(
      await outcome(() =>
        BookingPointerPage({ params: Promise.resolve({ token: request.token }) }),
      ),
    ).toEqual({ ok: false, redirect: target });

    // Following it: the step-up, then the request on Bookings.
    browse(link, `/c/${a.clinicSlug}/bookings`);
    expect(
      await outcome(() => renderBookings(a.clinicSlug, { request: request.id })),
    ).toMatchObject({ ok: false, redirect: expect.stringContaining("/step-up?next=") });
    await stepUpWithPasskey(link);
    const html = await renderBookings(a.clinicSlug, { request: request.id });
    expect(html).toContain("This request lapsed");

    // What the link itself logged: that it was followed, by id, and no more.
    const followed = (await auditRows(a.clinicId)).filter(
      (r) => r.metadata?.outcome === "link_followed",
    );
    expect(followed.length).toBeGreaterThanOrEqual(3);
    for (const r of followed) {
      expect(r).toMatchObject({
        actor_type: "service",
        actor_label: "booking-link",
        action: "read",
        resource_id: request.id,
        metadata: { outcome: "link_followed" },
      });
    }

    // The page has no action and names no field of the person.
    expect(readdirSync(join(APP_DIR, "booking", "[token]"))).toEqual(["page.tsx"]);
    const source = readFileSync(join(APP_DIR, "booking", "[token]", "page.tsx"), "utf8");
    expect(source).not.toMatch(/firstName|phone|preferredWindow|treatment|collectedFields|decide/i);
  });
});

describeDb("Bookings and the calendar's free times", () => {
  let google: FakeGoogleCalendar;

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    installGoogleEnv();
  }, 60_000);

  afterAll(async () => {
    restoreGoogleEnv();
    await closePools();
  });

  test("are asked for only after the page's access row has committed", async () => {
    google = freshGoogle();
    const f = await deskLocation(google, "bookings-free");
    const r = await phoneRequest(f.clinicId);
    const { rows } = await getMigratorPool().query<{ slug: string; user_id: string }>(
      `select c.slug, m.user_id from clinics c join member m on m.organization_id = c.organization_id
        where c.id = $1`,
      [f.clinicId],
    );
    const { slug, user_id: userId } = rows[0]!;
    const link = await signIn(userId);
    await stepUpWithPasskey(link);
    browse(link, `/c/${slug}/bookings`);

    const seen: boolean[] = [];
    const real = google.fetch;
    setGoogleFetch((async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input instanceof Request ? input.url : input).includes("freeBusy")) {
        // Visible from another connection only once the page's transaction committed.
        const logged = await inTenant(f.clinicId, (client) =>
          client.query(
            `select 1 from audit_log
              where resource_type = 'booking_request' and action = 'read' and resource_ids ? $1`,
            [r.requestId],
          ),
        );
        seen.push(logged.rows.length === 1);
      }
      return real(input, init);
    }) as typeof fetch);

    const page = await requirePatientPage(slug);
    const screen = await withFreeTimes(
      page,
      await withPatientPage(page, (tx) => readBookingsScreen(tx, { focus: r.requestId })),
    );
    expect(screen.writableCalendar).toBe(true);
    expect(screen.focus!.calendar!.slots.length).toBeGreaterThan(0);
    expect(seen).toEqual([true]);
  });
});
