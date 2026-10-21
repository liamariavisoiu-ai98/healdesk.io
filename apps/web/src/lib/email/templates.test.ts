import { renderAgreementCopy, TREATMENT_NAMES } from "@healdesk/catalog";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { Lead } from "@/lib/leads";
import { issueSetupToken, setupLinkUrl } from "@/lib/setup-link";
import { site } from "@/lib/site";
import type { SetupRequest } from "@/lib/sheets/schema";

import type { DemoSession } from "@/lib/demo/sessions";

import { demoEmail } from "./demo-ready";
import { setupUnsubscribeUrl, unsubscribeUrl } from "./index";
import { stillOpenEmail, TOUCHES } from "./nurture";
import {
  contactAck,
  setupLinkEmail,
  setupLinkReminder,
  setupRequestAck,
  setupRequestInternal,
  SUBJECT_MAX,
} from "./setup-emails";
import { voiceFollowUpInternal, voiceSetupLinkEmail } from "./voice-follow-up";

/**
 * Every email apps/web sends before a purchase, rendered and read the way
 * Annex X4 says apps/web's templates are tested: P1 (the four nurture
 * touches), P2, P3, P4, P5, P6 (the signer's copy of the agreement, which the
 * catalog words for both apps), P7 and P8; and, since 19 October 2026, the
 * demo-ready email and the two a demo call sends (the owner's setup link,
 * worded for each checkout mode, and the request to hello@), which postdate
 * the plan's list but follow its rules (X0).
 *
 * - A copy lint: no newness words, no "revenue", no "HIPAA compliant", no
 *   "live in two minutes", no "with every clinic", no "within one business
 *   day", "collected" only in "deposits collected", and no treatment name from
 *   the catalog (TREATMENT_NAMES).
 * - A link scanner over every body: https only, this site's public origin
 *   only, never HEALDESK_APP_URL (the internal address, which must never
 *   reach a browser), and a setup token only in the three emails that carry
 *   the setup link (P4, P5, P7).
 * - Subjects of at most 70 characters, with no link, however long the
 *   clinic's name (160 characters is the form's limit).
 * - The footer: every email to someone outside says who replies and to leave
 *   out patient details and names the sender as the site does; every
 *   commercial one (P1, P4, P5, P7, the demo-ready email and the demo call's
 *   setup link) also carries the opt-out and the postal address (X1.9, X1.10).
 */

const INTERNAL_APP_URL = "https://app-internal.healdesk.io";
const LONG_CLINIC = `Radiance ${"Aesthetic and Wellness ".repeat(8)}Med Spa`.slice(0, 160);
const ID = "6f1f7c1e-2f0e-4d2b-9a0a-3f5e2c1d4b7a";
const EXPIRES = new Date("2026-10-28T15:00:00Z");

beforeEach(() => {
  vi.stubEnv("HEALDESK_APP_URL", INTERNAL_APP_URL);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function request(clinicName: string): SetupRequest {
  return {
    id: ID,
    name: "Alex Chen",
    clinicName,
    website: "radiancemedspa.com",
    email: "info@radiancemedspa.com",
    emailNormalized: "info@radiancemedspa.com",
    channels: "phone,web",
    leadId: null,
    status: "invited",
    invitedAt: new Date("2026-10-14T15:00:00Z"),
    linkExpiresAt: EXPIRES,
    remindedAt: null,
    openedAt: null,
    signedAt: null,
    paidAt: null,
    unsubscribedAt: null,
    ipAddress: null,
    createdAt: new Date("2026-10-13T15:00:00Z"),
    updatedAt: new Date("2026-10-14T15:00:00Z"),
  } as SetupRequest;
}

function lead(): Lead {
  const at = new Date("2026-10-01T12:00:00Z");
  return {
    id: ID,
    email: "alex.chen@radiancemedspa.com",
    emailNormalized: "alex.chen@radiancemedspa.com",
    phone: null,
    clinicName: "Radiance Med Spa",
    website: null,
    specialty: "med-spa",
    segment: null,
    sourceCampaign: null,
    leadScore: "business",
    isBusinessEmail: true,
    marketingConsent: true,
    consentNoticeVersion: "v",
    consentText: "Email me",
    consentAt: at,
    claimToken: null,
    unsubscribedAt: null,
    bouncedAt: null,
    nurtureStep: 0,
    lastTouchAt: null,
    cohortCreditOfferedAt: null,
    checkoutStartedAt: at,
    checkoutAbandonedAt: at,
    abandonmentSentAt: null,
    convertedAt: null,
    convertedPlan: null,
    convertedMrrUsd: null,
    referrerHost: null,
    unlockCount: 1,
    firstSeenAt: at,
    lastSeenAt: at,
    createdAt: at,
    updatedAt: at,
    abandonedRef: ID,
  };
}

type Rendered = {
  name: string;
  subject: string;
  text: string;
  commercial: boolean;
  external: boolean;
  setupLink: boolean;
};

function everyEmail(clinicName: string): Rendered[] {
  const req = request(clinicName);
  const link = setupLinkUrl(issueSetupToken(ID, req.email, EXPIRES));
  const optOut = setupUnsubscribeUrl(ID);
  const out: Rendered[] = [];
  for (const touch of TOUCHES) {
    out.push({
      name: `P1 touch ${touch.step}`,
      subject: touch.subject,
      text: touch.text(lead()),
      commercial: true,
      external: true,
      setupLink: false,
    });
  }
  const p2 = setupRequestAck(req, "Thursday 15 October");
  out.push({ name: "P2", ...p2, commercial: false, external: true, setupLink: false });
  const p3 = setupRequestInternal(req, { creditLive: true, replyBy: "Thursday 15 October" });
  out.push({ name: "P3", ...p3, commercial: false, external: false, setupLink: false });
  for (const creditUntil of [null, new Date("2026-10-20T15:00:00Z")]) {
    const p4 = setupLinkEmail(req, {
      link,
      expiresAt: EXPIRES,
      creditUntil,
      unsubscribeUrl: optOut,
    });
    out.push({
      name: `P4${creditUntil ? " with credit" : ""}`,
      ...p4,
      commercial: true,
      external: true,
      setupLink: true,
    });
  }
  const p5 = setupLinkReminder(req, { link, expiresAt: EXPIRES, unsubscribeUrl: optOut });
  out.push({ name: "P5", ...p5, commercial: true, external: true, setupLink: true });
  for (const agreementKind of ["baa", "dpa", null] as const) {
    for (const setupLink of [{ url: link, expiresAt: EXPIRES }, null]) {
      const p7 = stillOpenEmail(lead(), { clinicName, agreementKind, setupLink });
      out.push({
        name: `P7 ${agreementKind ?? "unknown kind"}${setupLink ? " with link" : ""}`,
        ...p7,
        commercial: true,
        external: true,
        setupLink: setupLink !== null,
      });
    }
  }
  const p8 = contactAck("info@radiancemedspa.com", "Thursday 15 October");
  out.push({ name: "P8", ...p8, commercial: false, external: true, setupLink: false });
  for (const version of ["1.6.0", "dpa/1.0.0"]) {
    const p6 = renderAgreementCopy({
      signatoryName: "Alex Chen",
      clinicName,
      version,
      documentHash: "a".repeat(64),
      acceptedAt: new Date("2026-10-14T15:00:00Z"),
    });
    out.push({ name: `P6 ${version}`, subject: p6.subject, text: p6.text, commercial: false, external: true, setupLink: false });
  }
  const readyAt = new Date("2026-10-14T15:00:00Z");
  const demo = {
    id: ID,
    slug: "radiance-med-spa-k7q2mz9xwa",
    status: "ready",
    clinicName,
    brandName: null,
    profile: null,
    createdBy: "operator",
    createdAt: readyAt,
    readyAt,
    expiresAt: new Date("2026-10-21T15:00:00Z"),
  } as unknown as DemoSession;
  for (const [when, now] of [
    ["with the offer", readyAt.getTime()],
    ["after the offer", readyAt.getTime() + 72 * 3_600_000],
  ] as const) {
    const ready = demoEmail(demo, now, { unsubscribeUrl: unsubscribeUrl(ID) });
    out.push({ name: `Demo-ready ${when}`, ...ready, commercial: true, external: true, setupLink: false });
  }
  const voiceLink = { url: `${site.url}/get-started?plan=voice-webchat`, plan: "AYA Voice + Web Chat" };
  for (const mode of ["pilot", "public"] as const) {
    const voice = voiceSetupLinkEmail({ name: "Alex Chen", clinic: clinicName, link: voiceLink, mode, unsubscribeUrl: unsubscribeUrl(ID) });
    out.push({ name: `Voice-setup-link ${mode}`, ...voice, commercial: true, external: true, setupLink: false });
    const team = voiceFollowUpInternal(
      {
        topic: "start",
        name: "Alex Chen",
        clinic: clinicName,
        practice: "Med Spas",
        email: "alex.chen@radiancemedspa.com",
        preferredTime: "",
        recommended: "AYA Voice + Web Chat",
        notes: "",
        summary: "",
        callId: "call_1",
      },
      { link: voiceLink, mode },
    );
    out.push({ name: `Voice-follow-up ${mode}`, ...team, commercial: false, external: false, setupLink: false });
  }
  return out;
}

const EMAILS = [
  ...everyEmail("Radiance Med Spa"),
  ...everyEmail(LONG_CLINIC).map((e) => ({ ...e, name: `${e.name}, long name` })),
];

const BANNED: readonly { pattern: RegExp; label: string }[] = [
  {
    pattern: /\b(?:pilot|beta|early access|first clinics|founding|cohort)\b/i,
    label: "a newness word",
  },
  { pattern: /\brevenue\b/i, label: "revenue" },
  { pattern: /\bHIPAA[\s-]*compliant\b/i, label: "HIPAA compliant" },
  { pattern: /\blive in (?:two|2) minutes\b/i, label: "live in two minutes" },
  { pattern: /\bwith every clinic\b/i, label: "with every clinic" },
  {
    pattern: /\bwithin one business day\b|\bnext business day\b/i,
    label: "a reply without its date",
  },
  { pattern: /(?<!deposits )\bcollected\b/i, label: "collected, outside deposits collected" },
];

const treatment = new RegExp(
  `\\b(?:${TREATMENT_NAMES.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "i",
);

describe("every apps/web email before a purchase", () => {
  test("the set is the one Annex X5 lists, P1 to P8, and the three that postdate it", () => {
    const kinds = new Set(EMAILS.map((e) => e.name.split(/[ ,]/)[0]));
    expect([...kinds].sort()).toEqual(
      ["Demo-ready", "P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "Voice-follow-up", "Voice-setup-link"].sort(),
    );
  });

  test.each(EMAILS.map((e) => [e.name, e] as const))("%s: the copy lint", (_name, email) => {
    for (const { pattern, label } of BANNED) {
      expect(`${email.subject}\n${email.text}`, label).not.toMatch(pattern);
    }
    expect(
      `${email.subject}\n${email.text}`.match(treatment)?.[0] ?? null,
      "a treatment name",
    ).toBeNull();
  });

  test.each(EMAILS.map((e) => [e.name, e] as const))(
    "%s: every link is this site's, over https",
    (_name, email) => {
      const links = email.text.match(/\bhttps?:\/\/[^\s)>"]+/g) ?? [];
      const origin = new URL(site.url).origin;
      for (const href of links) {
        const url = new URL(href);
        expect(url.protocol, href).toBe("https:");
        expect(url.origin, href).toBe(origin);
      }
      expect(email.text).not.toContain(new URL(INTERNAL_APP_URL).host);
      expect(email.text).not.toContain("localhost");
      // A setup token only where the setup link belongs.
      expect(email.text.includes("/start?t="), "a setup token").toBe(email.setupLink);
    },
  );

  test.each(EMAILS.map((e) => [e.name, e] as const))(
    "%s: a subject of at most 70 characters, with no link",
    (_name, email) => {
      expect(email.subject.length, email.subject).toBeLessThanOrEqual(SUBJECT_MAX);
      expect(email.subject).not.toMatch(/https?:\/\/|www\.|\.com\b/i);
      expect(email.subject).not.toMatch(/\n/);
    },
  );

  test.each(EMAILS.filter((e) => e.external).map((e) => [e.name, e] as const))(
    "%s: the footer every email to someone outside carries",
    (_name, email) => {
      // A DPA's copy (P6) names the practice's clients, never patients; an
      // email to a practice whose kind nobody has said yet names both.
      expect(email.text).toMatch(
        /Replies reach the healdesk team\. Please leave out (?:patient details|your clients' details|patient or client details)\./,
      );
      expect(email.text).toContain("healdesk is a service of Viixi FZC");
      // apps/web's words, or apps/app's in the agreement copy both apps send (P6).
      expect(email.text).toMatch(/You're (?:getting|receiving) this because /);
    },
  );

  test.each(EMAILS.filter((e) => e.commercial).map((e) => [e.name, e] as const))(
    "%s: commercial, so the one-click opt-out and the postal address (CAN-SPAM)",
    (_name, email) => {
      expect(email.text).toMatch(
        /Stop these emails: https:\/\/\S+\/api\/email\/unsubscribe\?t=\S+/,
      );
      expect(email.text).toContain("Wilmington, DE 19801");
    },
  );

  test("the transactional ones offer no opt-out, and P2 and P8 echo nothing but the address", () => {
    for (const email of EMAILS.filter((e) => !e.commercial)) {
      expect(email.text, email.name).not.toContain("/api/email/unsubscribe");
    }
    for (const email of EMAILS.filter((e) => e.name.startsWith("P2") || e.name.startsWith("P8"))) {
      expect(email.text).not.toContain("Radiance Med Spa");
      expect(email.text).not.toContain("Alex");
    }
  });

  test("the lint and the scanner catch what they are for", () => {
    expect("Join our founding cohort").toMatch(BANNED[0]!.pattern);
    expect("We collected $400").toMatch(BANNED[6]!.pattern);
    expect("deposits collected").not.toMatch(BANNED[6]!.pattern);
    expect("2 Botox bookings").toMatch(treatment);
    expect(unsubscribeUrl(ID).startsWith(site.url)).toBe(true);
  });
});
