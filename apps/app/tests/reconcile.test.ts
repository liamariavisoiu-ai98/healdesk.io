import { describe, expect, test } from "vitest";

import {
  exceptionTotal,
  matchedTotal,
  reconcile,
  type AppointmentRecord,
  type SaleRecord,
} from "@/lib/sync/reconcile";

/**
 * The matcher's rules, as tests.
 *
 * These are the cases that decide whether the monthly figure is honest, so they
 * are written as scenarios a clinic owner would recognise rather than as unit
 * tests of internal functions. If one of these ever has to change, the number
 * we bill against changes with it — which is exactly the level of ceremony
 * this deserves.
 */

const ASOF = new Date("2026-08-01T00:00:00Z");
const WINDOW = {
  from: new Date("2026-07-01T00:00:00Z"),
  to: new Date("2026-08-01T00:00:00Z"),
};

const appointment = (over: Partial<AppointmentRecord> = {}): AppointmentRecord => ({
  id: "appt-1",
  contactId: "contact-1",
  scheduledFor: new Date("2026-07-15T14:00:00Z"),
  checkedInAt: null,
  status: "scheduled",
  conversationId: "conv-1",
  ...over,
});

const sale = (over: Partial<SaleRecord> = {}): SaleRecord => ({
  id: "sale-1",
  contactId: "contact-1",
  appointmentId: null,
  amountUsd: "550.00",
  collectedAt: new Date("2026-07-15T14:40:00Z"),
  ...over,
});

const run = (a: AppointmentRecord[], s: SaleRecord[]) =>
  reconcile(a, s, { asOf: ASOF, exceptionWindow: WINDOW });

describe("rule 1 — a deposit is not attendance", () => {
  test("money taken weeks before the visit counts as revenue but not as arrival", () => {
    const appt = appointment({ scheduledFor: new Date("2026-07-20T14:00:00Z") });
    const deposit = sale({
      amountUsd: "200.00",
      collectedAt: new Date("2026-07-02T09:00:00Z"),
    });

    const { matches } = run([appt], [deposit]);

    expect(matches).toHaveLength(1);
    expect(matches[0]!.impliesAttendance).toBe(false);
    // Still revenue. The clinic took the money.
    expect(matchedTotal(matches, [deposit])).toBe("200.00");
  });

  test("a forfeited deposit on a no-show never implies attendance", () => {
    const appt = appointment({ status: "no_show" });
    const deposit = sale({ collectedAt: new Date("2026-07-01T09:00:00Z") });

    const { matches } = run([appt], [deposit]);

    expect(matches[0]!.impliesAttendance).toBe(false);
  });

  test("payment at the desk does imply attendance", () => {
    const { matches } = run([appointment()], [sale()]);

    expect(matches[0]!.confidence).toBe("high");
    expect(matches[0]!.impliesAttendance).toBe(true);
  });

  test("a recorded check-in settles it outright, whenever the money moved", () => {
    const appt = appointment({
      checkedInAt: new Date("2026-07-15T13:55:00Z"),
      status: "showed",
    });
    const deposit = sale({ collectedAt: new Date("2026-06-20T09:00:00Z") });

    const { matches } = run([appt], [deposit]);

    expect(matches[0]!.impliesAttendance).toBe(true);
  });
});

describe("rule 2 — ambiguity is not a guess", () => {
  test("two loose candidates for one payment produce an exception, not a coin flip", () => {
    const first = appointment({
      id: "appt-1",
      scheduledFor: new Date("2026-07-10T14:00:00Z"),
    });
    const second = appointment({
      id: "appt-2",
      scheduledFor: new Date("2026-07-24T14:00:00Z"),
    });
    // Paid a week before both — a deposit for either.
    const payment = sale({ collectedAt: new Date("2026-07-03T10:00:00Z") });

    const { matches, exceptions } = run([first, second], [payment]);

    expect(matches).toHaveLength(0);
    expect(exceptions.some((e) => e.kind === "ambiguous_match")).toBe(true);
  });

  test("but a payment during one of them is not ambiguous at all", () => {
    const first = appointment({
      id: "appt-1",
      scheduledFor: new Date("2026-07-10T14:00:00Z"),
    });
    const second = appointment({
      id: "appt-2",
      scheduledFor: new Date("2026-07-24T14:00:00Z"),
    });
    const payment = sale({ collectedAt: new Date("2026-07-10T14:30:00Z") });

    const { matches } = run([first, second], [payment]);

    expect(matches).toHaveLength(1);
    expect(matches[0]!.appointmentId).toBe("appt-1");
    expect(matches[0]!.confidence).toBe("high");
  });

  test("a link the platform supplied is trusted over any inference", () => {
    const first = appointment({ id: "appt-1" });
    const second = appointment({
      id: "appt-2",
      scheduledFor: new Date("2026-07-16T14:00:00Z"),
    });
    const payment = sale({ appointmentId: "appt-2" });

    const { matches } = run([first, second], [payment]);

    expect(matches).toHaveLength(1);
    expect(matches[0]!.appointmentId).toBe("appt-2");
    expect(matches[0]!.confidence).toBe("exact");
  });
});

describe("rule 3 — unmatched money is surfaced, never absorbed", () => {
  test("a walk-in sale with no patient attached becomes an exception with its amount", () => {
    const walkIn = sale({ contactId: null, amountUsd: "1200.00" });

    const { matches, exceptions } = run([], [walkIn]);

    expect(matches).toHaveLength(0);
    const unmatched = exceptions.filter((e) => e.kind === "unmatched_sale");
    expect(unmatched).toHaveLength(1);
    expect(exceptionTotal(unmatched)).toBe("1200.00");
  });

  test("a sale nowhere near any appointment is surfaced rather than dropped", () => {
    const appt = appointment({ scheduledFor: new Date("2026-07-01T14:00:00Z") });
    const late = sale({ collectedAt: new Date("2026-07-28T14:00:00Z") });

    const { matches, exceptions } = run([appt], [late]);

    expect(matches).toHaveLength(0);
    expect(exceptions.some((e) => e.kind === "unmatched_sale")).toBe(true);
  });

  test("an attended visit with no money found is raised too", () => {
    const attended = appointment({
      status: "showed",
      checkedInAt: new Date("2026-07-15T13:58:00Z"),
    });

    const { exceptions } = run([attended], []);

    expect(exceptions.some((e) => e.kind === "unmatched_appointment")).toBe(true);
  });

  test("a platform that never records arrival produces missing_arrival, not no_show", () => {
    const unknown = appointment({ status: "scheduled", checkedInAt: null });

    const { exceptions } = run([unknown], []);

    const raised = exceptions.find((e) => e.kind === "missing_arrival");
    expect(raised).toBeDefined();
    expect(raised!.summary).toContain("never recorded whether the patient arrived");
  });
});

describe("what must NOT raise an exception", () => {
  test("a booking in the future is not a reconciliation problem", () => {
    const future = appointment({
      scheduledFor: new Date("2026-09-10T14:00:00Z"),
    });

    const { exceptions } = reconcile([future], [], {
      asOf: ASOF,
      exceptionWindow: {
        from: new Date("2026-07-01T00:00:00Z"),
        to: new Date("2026-10-01T00:00:00Z"),
      },
    });

    expect(exceptions).toHaveLength(0);
  });

  test("appointments read only as match candidates don't get complained about", () => {
    // Loaded because a July deposit might belong to it, but it sits in August
    // and is August's problem.
    const august = appointment({
      scheduledFor: new Date("2026-08-05T14:00:00Z"),
      status: "showed",
    });

    const { exceptions } = run([august], []);

    expect(exceptions).toHaveLength(0);
  });

  test("a cancelled appointment with no money is not an exception", () => {
    const { exceptions } = run([appointment({ status: "cancelled" })], []);

    expect(exceptions).toHaveLength(0);
  });
});

describe("money arithmetic", () => {
  test("cents survive a hundred sums", () => {
    const sales = Array.from({ length: 100 }, (_, i) =>
      sale({ id: `sale-${i}`, amountUsd: "0.07" }),
    );
    const matches = sales.map((s) => ({
      saleId: s.id,
      appointmentId: "appt-1",
      confidence: "exact" as const,
      impliesAttendance: true,
    }));

    // 100 × 0.07 is 7.000000000000001 in floating point.
    expect(matchedTotal(matches, sales)).toBe("7.00");
  });

  test("a refund reduces the total rather than being ignored", () => {
    const refund = sale({ id: "refund", amountUsd: "-150.00" });
    const charge = sale({ id: "charge", amountUsd: "550.00" });
    const matches = [charge, refund].map((s) => ({
      saleId: s.id,
      appointmentId: "appt-1",
      confidence: "exact" as const,
      impliesAttendance: true,
    }));

    expect(matchedTotal(matches, [charge, refund])).toBe("400.00");
  });
});

describe("stability", () => {
  test("the same inputs produce the same fingerprints, so re-runs update rather than pile up", () => {
    const walkIn = sale({ contactId: null });

    const first = run([], [walkIn]);
    const second = run([], [walkIn]);

    expect(second.exceptions.map((e) => e.fingerprint)).toEqual(
      first.exceptions.map((e) => e.fingerprint),
    );
  });
});
