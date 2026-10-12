import { META_SOLD_ALONE } from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import { LEGAL_VERSION } from "@/lib/legal";

import { signRequestRefusal, validateOrder } from "./order";

/**
 * The order /api/checkout validates, read directly for the branches the
 * route's own tests cannot reach while a catalog flag is open: Meta as a
 * clinic's only channel, refused while Meta has not approved the app.
 */

const ORDER = {
  plan: "chat-meta",
  clinicName: "Glow Med Spa LLC",
  specialty: "med-spa",
  website: null,
  bookingSystem: "google_calendar",
  calendarAccount: "workspace_baa",
  contactName: "Laura Owner",
  contactEmail: "info@glowmedspa.com",
  agreementId: "6f1f7c1e-2f0e-4d2b-9a0a-3f5e2c1d4b7a",
  covered: "no",
  profile: null,
  profileStatus: "none",
  termsAccepted: true,
  termsVersion: LEGAL_VERSION,
};

describe("Meta on its own", () => {
  test("is sold while the catalog says so, today", () => {
    expect(META_SOLD_ALONE).toBe(true);
    expect(validateOrder(ORDER).ok).toBe(true);
  });

  test("is refused under the package's field, before anything else, once it is not", () => {
    const refused = validateOrder({ ...ORDER, website: "not a website" }, { metaSoldAlone: false });
    expect(refused).toEqual({
      ok: false,
      refusal: {
        field: "plan",
        error:
          "Instagram, Messenger + WhatsApp is not sold on its own until Meta approves our app. Choose Website, or a package with website chat or the phone.",
      },
    });
  });

  test("beside the phone it is sold either way", () => {
    expect(validateOrder({ ...ORDER, plan: "meta-voice" }, { metaSoldAlone: false }).ok).toBe(true);
  });
});

/**
 * What /api/agreement checks before it forwards a signature to apps/app: the
 * calendar answers, the platform they imply, and a practice `agreementKindFor`
 * gives an agreement to. The Data Protection Agreement is one of them once
 * the owner releases it, stood in for here; until then the decision never
 * names it, and a veterinary practice is refused.
 */
describe("a signature request", () => {
  const REQUEST = {
    specialty: "med-spa",
    isCoveredEntity: true,
    bookingSystem: "google_calendar",
    calendarAccount: "workspace_baa",
    platform: "none",
  };

  test("a practice signing the BAA goes through, released DPA or not", () => {
    expect(signRequestRefusal(REQUEST)).toBeNull();
    expect(signRequestRefusal(REQUEST, { dpaReleased: true })).toBeNull();
  });

  test("a veterinary practice is refused until the DPA is released, and signs it from then", () => {
    const vet = { ...REQUEST, specialty: "veterinary", isCoveredEntity: false };
    expect(signRequestRefusal(vet)).toEqual({
      field: "specialty",
      error: "We can't offer an agreement for this practice here.",
    });
    expect(signRequestRefusal(vet, { dpaReleased: true })).toBeNull();
  });

  test("a med spa that answered No is forwarded either way: to the BAA today, to the DPA once released", () => {
    const no = { ...REQUEST, isCoveredEntity: false };
    expect(signRequestRefusal(no)).toBeNull();
    expect(signRequestRefusal(no, { dpaReleased: true })).toBeNull();
  });

  test("the calendar answers are still checked first, whichever agreement it is", () => {
    const vet = { ...REQUEST, specialty: "veterinary", isCoveredEntity: false };
    expect(
      signRequestRefusal({ ...vet, calendarAccount: "gmail" }, { dpaReleased: true }),
    ).toMatchObject({
      field: "calendarAccount",
    });
    expect(
      signRequestRefusal({ ...vet, platform: "mindbody" }, { dpaReleased: true }),
    ).toMatchObject({
      field: "platform",
    });
  });
});
