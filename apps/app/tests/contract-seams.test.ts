import { afterEach, describe, expect, test, vi } from "vitest";

import type { Transaction } from "@/db";
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

  test("record and send nothing yet, write one line each and never throw", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const tenantTx = { clinicId: CLINIC } as unknown as TenantTx;
    await expect(
      notifyBookingAlert(tenantTx, "deposit_to_collect", { appointmentId: CLINIC }),
    ).resolves.toBeUndefined();
    await expect(
      notifyCalendarState({} as unknown as Transaction, CLINIC, "stopped", { dedupeKey: "conn-1" }),
    ).resolves.toBeUndefined();
    expect(info).toHaveBeenCalledTimes(2);
  });
});

describe("the portal guards", () => {
  // requirePortal is real since sign-in landed; tests/portal-access.test.ts
  // holds it. The step-up still refuses until the factors land.
  test("the step-up refuses until the factors land", async () => {
    await expect(
      requireStepUp(
        { userId: "usr_1", clinicId: CLINIC, clinicSlug: "any-clinic" },
        "patient_pages",
      ),
    ).rejects.toThrow(/lands with the factors/);
  });
});
