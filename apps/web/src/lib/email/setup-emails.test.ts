import { describe, expect, test } from "vitest";

import { LINK_NOTICES } from "@/components/checkout/SetupRequestForm";
import { refuseWithoutLink, type SetupLinkState } from "@/lib/setup-gate";
import type { SetupRequest } from "@/lib/sheets/schema";

import {
  channelList,
  contactAck,
  setupLinkEmail,
  setupLinkReminder,
  setupRequestAck,
  setupRequestInternal,
} from "./setup-emails";

/**
 * The copy a prospect reads around a setup request (Annex X: P2, P4, P5, P8,
 * plus the refusals and the form's notices), held to the owner's rules of
 * 5 and 6 October 2026:
 * - nothing that says we are new;
 * - a date, never "within one business day" or "we'll be in touch";
 * - no opening date or other timing before purchase;
 * - the two acknowledgements, which go to an unverified address, echo
 *   nothing the person typed but that address;
 * - every email says replies reach a person and asks for no patient details,
 *   and the commercial ones (P4, P5) carry the opt-out and the postal address.
 */

const NEWNESS = /\b(?:pilot|beta|early access|first clinics|founding|cohort|launching)\b/i;
const VAGUE = /within one business day|we'll be in touch|we will be in touch/i;

const REQUEST: SetupRequest = {
  id: "6f1f7c1e-2f0e-4d2b-9a0a-3f5e2c1d4b7a",
  name: "Alex Chen",
  clinicName: "Radiance Med Spa",
  website: "radiancemedspa.com",
  email: "info@radiancemedspa.com",
  emailNormalized: "info@radiancemedspa.com",
  channels: "phone,web,whatsapp",
  leadId: null,
  status: "invited",
  invitedAt: new Date("2026-10-06T14:00:00Z"),
  linkExpiresAt: new Date("2026-10-20T14:00:00Z"),
  openedAt: null,
  remindedAt: null,
  signedAt: null,
  paidAt: null,
  unsubscribedAt: null,
  ipAddress: null,
  createdAt: new Date("2026-10-06T13:00:00Z"),
  updatedAt: new Date("2026-10-06T14:00:00Z"),
};

const LINK = "https://healdesk.io/start?t=abc";
const OPT_OUT = "https://healdesk.io/api/email/unsubscribe?t=s.x";

const emails = {
  p2: setupRequestAck(REQUEST, "Wednesday 7 October"),
  p4: setupLinkEmail(REQUEST, {
    link: LINK,
    expiresAt: REQUEST.linkExpiresAt!,
    creditUntil: new Date("2026-10-15T14:00:00Z"),
    unsubscribeUrl: OPT_OUT,
  }),
  p5: setupLinkReminder(REQUEST, { link: LINK, expiresAt: REQUEST.linkExpiresAt!, unsubscribeUrl: OPT_OUT }),
  p8: contactAck("info@radiancemedspa.com", "Wednesday 7 October"),
};

describe("setup and contact emails", () => {
  test.each(Object.entries(emails))("%s says nothing new-sounding, vague or timed", (_kind, email) => {
    const all = `${email.subject}\n${email.text}`;
    expect(all).not.toMatch(NEWNESS);
    expect(all).not.toMatch(VAGUE);
    expect(all).not.toMatch(/\bopens? (?:on|by)\b|same day/i);
    expect(email.subject.length).toBeLessThanOrEqual(70);
    expect(email.subject).not.toMatch(/https?:/);
    // Nobody has said yet what kind of practice it is, so both words (a vet's
    // people are clients).
    expect(email.text).toContain(
      "Replies reach the healdesk team. Please leave out patient or client details.",
    );
  });

  test("the acknowledgements echo nothing but the address they go to", () => {
    for (const email of [emails.p2, emails.p8]) {
      expect(email.text).toContain("info@radiancemedspa.com");
      expect(email.text).not.toContain("Radiance Med Spa");
      expect(email.text).not.toContain("Alex");
      expect(email.text).toContain("Wednesday 7 October");
    }
  });

  test("the commercial ones carry the opt-out and the postal address", () => {
    for (const email of [emails.p4, emails.p5]) {
      expect(email.text).toContain(OPT_OUT);
      expect(email.text).toMatch(/Wilmington, DE/);
      expect(email.text).toContain(LINK);
    }
    expect(emails.p4.text).toContain("Your setup fee is waived");
  });

  test("the request to us names everything an operator needs, in plain words", () => {
    const internal = setupRequestInternal(REQUEST, { creditLive: false, replyBy: "Tuesday 7 October" });
    expect(internal.text).toContain("phone, website chat and WhatsApp");
    expect(internal.text).toContain("/admin/setup");
    // The day P2 promised them, never "the next business day" (X1.3).
    expect(internal.text).toContain("We promised them a reply by Tuesday 7 October.");
    expect(internal.text).not.toMatch(/next business day|within one business day/i);
    expect(channelList(null)).toBe("not said");
  });
});

describe("refusals and notices", () => {
  const states: SetupLinkState[] = ["none", "invalid", "expired", "replaced", "used"];

  test.each(states)("the %s refusal says nothing new-sounding", async (link) => {
    const response = refuseWithoutLink({ mode: "pilot", link });
    const body = (await response!.json()) as { error: string };
    expect(body.error).not.toMatch(NEWNESS);
  });

  test("the form's notices say nothing new-sounding", () => {
    for (const text of Object.values(LINK_NOTICES)) expect(text).not.toMatch(NEWNESS);
  });
});
