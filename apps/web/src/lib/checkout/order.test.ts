import { META_SOLD_ALONE } from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import { LEGAL_VERSION } from "@/lib/legal";

import { validateOrder } from "./order";

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
