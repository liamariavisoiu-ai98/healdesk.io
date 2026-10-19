import { afterEach, describe, expect, test, vi } from "vitest";

import type { Transaction } from "@/db";
import { createLocationClinic, LOCATION_CLINICS_READY } from "@/lib/location-clinic";
import { notifyBookingAlert } from "@/lib/notices/booking-alerts";
import { notifyCalendarState } from "@/lib/notices/calendar-state";
import { notifyOps, OPS_EVENTS } from "@/lib/ops/notify";
import { requireStepUp } from "@/lib/portal/step-up";
import type { TenantTx } from "@/lib/tenant";

/**
 * The seams other sessions call before their bodies exist. What they promise
 * now is what callers rely on: the notifiers never throw inside a caller's
 * transaction, and the portal guards refuse rather than let anyone in.
 */

const CLINIC = "0c1d2e3f-0000-4000-8000-000000000000";

// The step-up's request, outside any request: no session at all.
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: async () => null } } }));

function fieldsOf(line: string): Record<string, unknown> {
  return JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>;
}

describe("notifyOps", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("writes one ops-alert line with the event and its ids and counts", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await notifyOps("duplicate_subscription", { clinicId: CLINIC, count: 2 });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0]![0]);
    expect(line.startsWith("[healdesk] ops alert {")).toBe(true);
    expect(fieldsOf(line)).toEqual({ clinicId: CLINIC, count: 2, event: "duplicate_subscription" });
  });

  test("never throws: a field the log refuses is left out and named, and the line still goes", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      notifyOps("billing_event_dead_lettered", { email: "owner@clinic.test", eventId: "evt_1" }),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0]![0]);
    expect(line).not.toContain("owner@clinic.test");
    expect(fieldsOf(line)).toEqual({
      eventId: "evt_1",
      hint: "fields left out: email",
      event: "billing_event_dead_lettered",
    });
  });

  test("names every event in snake_case", () => {
    for (const event of OPS_EVENTS) expect(event).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
    expect(new Set(OPS_EVENTS).size).toBe(OPS_EVENTS.length);
  });
});

describe("the notice seams", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("the booking alerts queue through the outbox since M5, and never throw into their caller", async () => {
    // A transaction that cannot run anything: the alert is not queued, one
    // error line says so, and the deposit it reports on goes on.
    // tests/live-alerts.test.ts proves the queueing on a real transaction.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const tenantTx = { clinicId: CLINIC } as unknown as TenantTx;
    await expect(
      notifyBookingAlert(tenantTx, "deposit_to_collect", { appointmentId: CLINIC }),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toMatch(/^\[healdesk\] booking alert not queued /);
  });

  test("the calendar email queues O13 since M3, and never throws into its caller", async () => {
    // A transaction that cannot run anything: the email is not queued, one
    // error line says so, and the calendar event it reports on goes on.
    // tests/setup-wizard.test.ts proves the queueing on a real transaction.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      notifyCalendarState({} as unknown as Transaction, CLINIC, "stopped", { dedupeKey: "conn-1" }),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain("calendar email not queued");
  });
});

describe("the portal guards", () => {
  // requirePortal is real since sign-in landed (tests/portal-access.test.ts),
  // and requireStepUp since the factors did (tests/step-up.test.ts). What
  // callers build on: without a live step-up it never returns, it sends the
  // browser to step up.
  test("the step-up sends a session it cannot vouch for to step up, and never returns", async () => {
    await expect(
      requireStepUp(
        { userId: "usr_1", clinicId: CLINIC, clinicSlug: "any-clinic" },
        "patient_pages",
      ),
    ).rejects.toThrow(/^NEXT_REDIRECT \/c\/any-clinic\/step-up\?next=%2Fc%2Fany-clinic$/);
  });
});

describe("extra locations", () => {
  // addLocation charges before it creates the clinic, and refuses while this
  // flag is false. The flag and the real body must change together: a true
  // flag over the stub would take a clinic's money for a location that then
  // fails to exist.
  test("are refused while createLocationClinic is still a stub", async () => {
    expect(LOCATION_CLINICS_READY).toBe(false);
    await expect(
      createLocationClinic({
        billingClinicId: CLINIC,
        locationNumber: 2,
        actor: { type: "service", serviceName: "test" },
      }),
    ).rejects.toThrow(/provisioning rewrite/);
  });
});
