import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Bookings' decide action (plan Part F5), with everything below it mocked:
 * the passkey step-up comes first and nothing is read or decided without it;
 * the request is opened in the clinic's own patient transaction, and one
 * that is not this clinic's is "not found"; Confirm, Propose and Decline go
 * to decideBookingRequest keyed by the clinic and the request's id, with the
 * sign-in and the step-up's passkey as the actor; and "Confirm anyway"
 * carries who confirmed it and their note into the audited override. The
 * same paths against a real database and a real step-up are in
 * tests/bookings-screen.test.ts.
 */

const mocks = vi.hoisted(() => {
  class NavigationSignal extends Error {
    constructor(readonly url: string) {
      super("NEXT_REDIRECT");
    }
  }
  return {
    NavigationSignal,
    decide: vi.fn(),
    open: vi.fn(),
    stepUp: vi.fn(),
    withPage: vi.fn(),
  };
});

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new mocks.NavigationSignal(url);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  RedirectType: { replace: "replace", push: "push" },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/meta/booking-requests", () => ({
  decideBookingRequest: mocks.decide,
  MAX_PROPOSED_SLOTS: 3,
}));
vi.mock("@/lib/portal/patient-page", () => ({
  requirePatientPage: mocks.stepUp,
  withPatientPage: mocks.withPage,
}));
vi.mock("@/lib/portal/bookings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/portal/bookings")>();
  return { ...actual, openRequestForDecision: mocks.open };
});

const { decideBooking } = await import("@/app/c/[slug]/bookings/actions");
const { RequestNotFoundError } = await import("@/lib/portal/bookings");

const CLINIC = "00000000-0000-4000-8000-0000000000c1";
const REQUEST = "00000000-0000-4000-8000-0000000000a1";
const PAGE = {
  portal: { userId: "usr_glow", clinicId: CLINIC, clinicSlug: "glow" },
  stepUp: {
    passkeyId: "00000000-0000-4000-8000-0000000000f1",
    stepUpId: "00000000-0000-4000-8000-0000000000e1",
    deviceLabel: "Front desk Mac",
    at: new Date(),
    expiresInMs: 900_000,
  },
  request: { ipAddress: "203.0.113.7" },
};
const ACTOR = {
  userId: "usr_glow",
  passkeyId: PAGE.stepUp.passkeyId,
  stepUpId: PAGE.stepUp.stepUpId,
  deviceLabel: "Front desk Mac",
};
const DECIDED = { outcome: "decided", followUp: null, appointmentId: null, calendarWrite: null };

function form(fields: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) data.append(key, v);
  }
  return data;
}

async function run(fields: Record<string, string | string[]>) {
  try {
    return { state: await decideBooking("glow", { status: "idle" }, form(fields)) };
  } catch (error) {
    if (error instanceof mocks.NavigationSignal) return { redirect: error.url };
    throw error;
  }
}

describe("Bookings' decide action", () => {
  beforeEach(() => {
    mocks.decide.mockReset();
    mocks.open.mockReset();
    mocks.stepUp.mockReset();
    mocks.withPage.mockReset();
    mocks.stepUp.mockResolvedValue(PAGE);
    mocks.withPage.mockImplementation(async (_page, read: (tx: unknown) => Promise<unknown>) =>
      read({ clinicId: CLINIC }),
    );
    mocks.open.mockResolvedValue(undefined);
  });

  test("without a live passkey step-up nothing is opened or decided", async () => {
    mocks.stepUp.mockImplementation(async () => {
      throw new mocks.NavigationSignal("/c/glow/step-up?next=%2Fc%2Fglow%2Fbookings");
    });
    expect(await run({ requestId: REQUEST, decision: "declined" })).toEqual({
      redirect: "/c/glow/step-up?next=%2Fc%2Fglow%2Fbookings",
    });
    expect(mocks.stepUp).toHaveBeenCalledWith("glow", { returnTo: "/c/glow/bookings" });
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  test("another clinic's request is not found, and nothing is decided", async () => {
    mocks.open.mockRejectedValue(new RequestNotFoundError());
    await expect(run({ requestId: REQUEST, decision: "declined" })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  test("Confirm, Propose and Decline reach the core by clinic and request, as the sign-in and its passkey", async () => {
    mocks.decide.mockResolvedValue({
      ...DECIDED,
      appointmentId: REQUEST,
      calendarWrite: "written",
    });
    const at = new Date(Date.now() + 3 * 86_400_000).toISOString();
    expect(
      await run({ requestId: REQUEST, decision: "confirmed", slotAt: at, treatment: "Facial" }),
    ).toEqual({
      redirect: `/c/glow/bookings?request=${REQUEST}&followup=none&calendar=written`,
    });
    // The request was opened in the page's patient transaction first.
    expect(mocks.withPage).toHaveBeenCalledWith(PAGE, expect.any(Function));
    expect(mocks.open).toHaveBeenCalledWith({ clinicId: CLINIC }, REQUEST);
    expect(mocks.decide).toHaveBeenLastCalledWith(
      { clinicId: CLINIC, requestId: REQUEST },
      "confirmed",
      expect.objectContaining({
        actor: ACTOR,
        confirmedFor: new Date(at),
        // No name typed: the device that decided.
        decidedByLabel: "Front desk Mac",
        treatment: "Facial",
        addAnyway: false,
        request: PAGE.request,
      }),
    );

    mocks.decide.mockResolvedValue({ ...DECIDED, followUp: "sent" });
    const first = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const second = new Date(Date.now() + 4 * 86_400_000).toISOString();
    expect(
      await run({
        requestId: REQUEST,
        decision: "rescheduling",
        proposedSlot: [first, second, ""],
      }),
    ).toEqual({
      redirect: `/c/glow/bookings?request=${REQUEST}&followup=sent&calendar=none`,
    });
    expect(mocks.decide).toHaveBeenLastCalledWith(
      { clinicId: CLINIC, requestId: REQUEST },
      "rescheduling",
      expect.objectContaining({
        actor: ACTOR,
        proposedSlots: [
          { at: new Date(first), source: "calendar" },
          { at: new Date(second), source: "calendar" },
        ],
      }),
    );

    mocks.decide.mockResolvedValue(DECIDED);
    await run({ requestId: REQUEST, decision: "declined", name: "Jo", note: "No Saturdays" });
    expect(mocks.decide).toHaveBeenLastCalledWith(
      { clinicId: CLINIC, requestId: REQUEST },
      "declined",
      expect.objectContaining({ actor: ACTOR, decidedByLabel: "Jo", deskNote: "No Saturdays" }),
    );
    expect(mocks.open).toHaveBeenCalledTimes(3);
  });

  test("Accept is not offered on Bookings: Call is a tel: link", async () => {
    expect(await run({ requestId: REQUEST, decision: "accepted" })).toEqual({
      state: { status: "failed", message: expect.any(String) },
    });
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  test("a lapsed request says so, rather than deciding", async () => {
    mocks.decide.mockResolvedValue({ ...DECIDED, outcome: "invalid" });
    expect(await run({ requestId: REQUEST, decision: "declined" })).toEqual({
      state: { status: "failed", message: expect.stringMatching(/lapsed/) },
    });
  });

  test("the busy answer carries the name and note into the form that confirms anyway", async () => {
    const at = new Date(Date.now() + 3 * 86_400_000).toISOString();
    mocks.decide.mockResolvedValueOnce({ ...DECIDED, outcome: "calendar_busy" });
    const busy = await run({
      requestId: REQUEST,
      decision: "confirmed",
      slotAt: at,
      treatment: "Facial",
      name: "Jo",
      note: "Checked with Dr Lee",
    });
    expect(busy).toEqual({
      state: {
        status: "busy",
        message: expect.any(String),
        slotAt: at,
        treatment: "Facial",
        name: "Jo",
        note: "Checked with Dr Lee",
      },
    });

    // What the second form posts (DecideForm's hidden inputs): the same
    // time, name and note, and addAnyway.
    const state = (busy as { state: { slotAt: string; name: string; note: string } }).state;
    mocks.decide.mockResolvedValueOnce({ ...DECIDED, calendarWrite: "written" });
    expect(
      await run({
        requestId: REQUEST,
        decision: "confirmed",
        slotAt: state.slotAt,
        treatment: "Facial",
        name: state.name,
        note: state.note,
        addAnyway: "1",
      }),
    ).toMatchObject({ redirect: expect.stringContaining(`request=${REQUEST}`) });
    expect(mocks.decide).toHaveBeenLastCalledWith(
      { clinicId: CLINIC, requestId: REQUEST },
      "confirmed",
      expect.objectContaining({
        actor: ACTOR,
        confirmedFor: new Date(at),
        decidedByLabel: "Jo",
        deskNote: "Checked with Dr Lee",
        addAnyway: true,
      }),
    );
  });
});
