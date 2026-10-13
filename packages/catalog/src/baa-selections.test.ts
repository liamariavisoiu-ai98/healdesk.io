import { describe, expect, test } from "vitest";

import {
  BaaRenderError,
  currentBaaTemplate,
  getBaaTemplate,
  prepareBaa,
  templateReadsCalendarAccount,
  type BaaSelections,
  type BaaVariables,
} from "./baa";
import { buildBaaSelections, type BaaSelectionInput } from "./baa-selections";
import { BOOKING_SYSTEMS, bookingSystemName, type BookingSystemId } from "./booking-systems";
import { CALENDAR_ACCOUNTS, type CalendarAccount } from "./calendar-terms";
import { getPlatform, NO_PLATFORM_ID, platforms } from "./platforms";
import { specialties } from "./specialties";

const SIGNER = {
  clinicLegalName: "Golden Clinic LLC",
  signatoryName: "Alex Chen",
  signatoryTitle: "Owner",
  signatoryEmail: "alex@golden.test",
  effectiveDate: "2026-10-06",
};

const input = (over: Partial<BaaSelectionInput> = {}): BaaSelectionInput => ({
  specialtyId: "med-spa",
  attributionMode: "estimated",
  bookingSystem: "none",
  isCoveredEntity: true,
  calendarAccount: "workspace_baa",
  template: getBaaTemplate("1.3.0")!,
  ...over,
});

const render = (selections: BaaSelections, version: string) =>
  prepareBaa(getBaaTemplate(version)!, { ...selections, ...SIGNER } as BaaVariables);

describe("which templates ask the calendar questions", () => {
  test("1.3.0 and 1.4.0 do; every earlier version does not", () => {
    expect(templateReadsCalendarAccount(getBaaTemplate("1.3.0")!)).toBe(true);
    expect(templateReadsCalendarAccount(getBaaTemplate("1.4.0")!)).toBe(true);
    for (const version of ["1.2.2", "1.2.1", "1.2.0", "1.0.0", "1.1.0-draft", "0.1.0-draft"]) {
      expect(templateReadsCalendarAccount(getBaaTemplate(version)!), version).toBe(false);
    }
    // Since 1.3.0's release the offered template asks both questions; 1.4.0,
    // offered since 13 October 2026, carries 1.3.0's calendar clauses.
    expect(currentBaaTemplate().version).toBe("1.4.0");
    expect(templateReadsCalendarAccount(currentBaaTemplate())).toBe(true);
  });
});

describe("selections for a template before 1.3.0", () => {
  const old = (bookingSystem: BookingSystemId | null, over: Partial<BaaSelectionInput> = {}) =>
    buildBaaSelections(input({ bookingSystem, template: getBaaTemplate("1.2.1")!, ...over }));

  /** What signAgreement and AgreementStep build today from a platform id. */
  const legacy = (platformId: string): BaaSelections => ({
    specialty: specialties.find((s) => s.id === "med-spa")!.name,
    attributionMode: "estimated",
    connectedPlatform:
      platformId === NO_PLATFORM_ID ? null : (getPlatform(platformId)?.name ?? null),
    isCoveredEntity: true,
    outboundMessaging: false,
    bookingMode: "desk_confirms",
    calendarWrite: null,
  });

  test("carry exactly the fields both signing paths have always passed", () => {
    expect(old("mindbody")).toEqual({
      specialty: "Med Spas, Dermatology & Aesthetics",
      attributionMode: "estimated",
      connectedPlatform: "Mindbody",
      isCoveredEntity: true,
      outboundMessaging: false,
      bookingMode: "desk_confirms",
      calendarWrite: null,
    });
    // The calendar answers are not asked for, and an absent one is no error.
    expect(old("none", { calendarAccount: null })).not.toHaveProperty("calendarAccount");
    expect(old("none")).not.toHaveProperty("bookingSystem");
    expect(old(null, { platformId: "zenoti" })).not.toHaveProperty("bookingSystem");
  });

  test("name every platform today's checkout offers, in the bytes its signers saw", () => {
    // The live picker offers every `platforms` entry, and signs 1.2.2 naming
    // it. Zenoti, PatientNow, Acuity and Vagaro have no v1 booking system, so
    // only the platform id the picker sent can name them.
    for (const platform of platforms) {
      for (const version of ["1.2.2", "1.2.1", "1.2.0"]) {
        const built = buildBaaSelections(
          input({
            bookingSystem: null,
            platformId: platform.id,
            calendarAccount: null,
            template: getBaaTemplate(version)!,
          }),
        );
        expect(render(built, version).hash, `${version}/${platform.id}`).toBe(
          render(legacy(platform.id), version).hash,
        );
      }
    }
    expect(old(null, { platformId: "zenoti" }).connectedPlatform).toBe("Zenoti");
    expect(old(null, { platformId: "acuity" }).connectedPlatform).toBe("Acuity Scheduling");
    expect(old(null, { platformId: NO_PLATFORM_ID }).connectedPlatform).toBeNull();
  });

  test("name a booking system's phase-two platform when no platform id is given", () => {
    for (const system of BOOKING_SYSTEMS) {
      const platformId = system.phaseTwoPlatformId ?? NO_PLATFORM_ID;
      for (const version of ["1.2.2", "1.2.1", "1.2.0"]) {
        expect(render(old(system.id), version).hash, `${version}/${system.id}`).toBe(
          render(legacy(platformId), version).hash,
        );
      }
    }
    // HighLevel keeps its phase-two name in an old document.
    expect(old("gohighlevel").connectedPlatform).toBe("GoHighLevel");
    expect(old("calendly").connectedPlatform).toBeNull();
  });

  test("prefer the platform the picker sent to the booking system", () => {
    // A Zenoti clinic answers the v1 question "Something else".
    expect(old("other", { platformId: "zenoti" }).connectedPlatform).toBe("Zenoti");
    expect(old("mindbody", { platformId: NO_PLATFORM_ID }).connectedPlatform).toBeNull();
  });

  test("refuse a document with nothing, or nothing known, to name the system by", () => {
    expect(() => old(null)).toThrow(BaaRenderError);
    expect(() => old(null, { platformId: "not-a-platform" })).toThrow(BaaRenderError);
    expect(() => old("mindbody", { platformId: "not-a-platform" })).toThrow(BaaRenderError);
    expect(() => old("zenoti" as BookingSystemId, { platformId: "zenoti" })).toThrow(
      BaaRenderError,
    );
  });
});

describe("selections for 1.3.0", () => {
  test("carry both answers and name the booking system as the agreement must", () => {
    expect(
      buildBaaSelections(input({ bookingSystem: "gohighlevel", calendarAccount: "personal" })),
    ).toEqual({
      specialty: "Med Spas, Dermatology & Aesthetics",
      attributionMode: "estimated",
      connectedPlatform: "HighLevel",
      isCoveredEntity: true,
      outboundMessaging: false,
      bookingMode: "desk_confirms",
      calendarWrite: null,
      bookingSystem: "gohighlevel",
      calendarAccount: "personal",
    });
  });

  test("never carry a sync the browser could choose", () => {
    for (const system of BOOKING_SYSTEMS) {
      const built = buildBaaSelections(input({ bookingSystem: system.id }));
      expect(built, system.id).not.toHaveProperty("bookingSync");
      expect(built.connectedPlatform, system.id).toBe(bookingSystemName(system.id));
    }
  });

  test("name the booking system, whatever phase-two platform also came", () => {
    // The render guard requires it, so the old picker's platform cannot leak
    // into a 1.3.0 document.
    expect(
      buildBaaSelections(input({ bookingSystem: "mindbody", platformId: "zenoti" }))
        .connectedPlatform,
    ).toBe("Mindbody");
    expect(
      buildBaaSelections(input({ bookingSystem: "other", platformId: "zenoti" })).connectedPlatform,
    ).toBeNull();
  });

  test("render for every booking system, account and covered-entity answer", () => {
    for (const system of BOOKING_SYSTEMS) {
      for (const calendarAccount of CALENDAR_ACCOUNTS) {
        for (const isCoveredEntity of [true, false, null]) {
          const built = buildBaaSelections(
            input({ bookingSystem: system.id, calendarAccount, isCoveredEntity }),
          );
          const prepared = render(built, "1.3.0");
          expect(
            prepared.clauseIds.filter((id) => id.startsWith("google-calendar-")),
            system.id,
          ).toHaveLength(1);
        }
      }
    }
  });

  test("refuse a missing or unknown account, and an unknown specialty or booking system", () => {
    for (const calendarAccount of [null, "gmail", undefined] as unknown as CalendarAccount[]) {
      expect(() => buildBaaSelections(input({ calendarAccount })), String(calendarAccount)).toThrow(
        BaaRenderError,
      );
    }
    expect(() => buildBaaSelections(input({ specialtyId: "not-a-specialty" }))).toThrow(
      BaaRenderError,
    );
    expect(() => buildBaaSelections(input({ bookingSystem: "zenoti" as BookingSystemId }))).toThrow(
      BaaRenderError,
    );
    // A platform id names nothing in 1.3.0, so it cannot stand in for the
    // booking system, and an unknown one is refused all the same.
    expect(() => buildBaaSelections(input({ bookingSystem: null, platformId: "zenoti" }))).toThrow(
      BaaRenderError,
    );
    expect(() => buildBaaSelections(input({ platformId: "not-a-platform" }))).toThrow(
      BaaRenderError,
    );
    // The same refusals hold for an older template's specialty and system.
    expect(() =>
      buildBaaSelections(input({ specialtyId: "x", template: getBaaTemplate("1.2.1")! })),
    ).toThrow(BaaRenderError);
  });
});
