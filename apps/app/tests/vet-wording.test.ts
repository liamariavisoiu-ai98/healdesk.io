import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { SetupScreenId } from "@/lib/setup/screen-ids";
import type { SetupState } from "@/lib/setup/state";

/**
 * A veterinary practice's people are its clients: its patients are animals,
 * and the person who calls, signs in or replies is the animal's owner. Once
 * the Data Protection Agreement is released (20 October 2026) a vet can buy,
 * and every surface it reads must say "client" where it would say "patient"
 * about a person (audienceFor in @healdesk/catalog). Bookings has its own
 * test (vet-booking-pages.test.ts); these are the rest a vet's staff read
 * before and around it: Home's Needs attention, Protect, the step-up prompt,
 * Settings → Sign-in, Knowledge, setup's Basics, the WhatsApp page, the
 * footer every email carries, the device emails and the transcript email.
 * Each is rendered for a vet and for a practice whose patients are people,
 * which still reads "patient" where it did.
 */

const mocks = vi.hoisted(() => ({
  audience: "clients" as "clients" | "patients",
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { url });
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  RedirectType: { replace: "replace", push: "push" },
  useParams: () => null,
  useRouter: () => ({ refresh() {}, push() {}, replace() {} }),
}));
// The passkey actions and the Protect page read the clinic's audience
// (lib/portal/audience.ts) and nothing else of it; the factor functions are
// stood in for, answering the refusal and the removal these tests word.
vi.mock("@/lib/portal/audience", () => ({
  portalAudience: async () => mocks.audience,
  clinicAudience: async () => mocks.audience,
  signInAudience: async () => mocks.audience,
}));
vi.mock("@/lib/factors/passkeys", () => ({
  startPasskeyRegistration: async () => ({ ok: false, reason: "needs_step_up" }),
  finishPasskeyRegistration: async () => ({ ok: false, reason: "challenge" }),
  removePasskey: async () => ({ ok: true, endedThisSession: false }),
}));
vi.mock("@/lib/portal/step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/portal/step-up")>()),
  sessionBinding: async () => ({ userId: "usr-1", sessionTokenHash: "hash" }),
}));
vi.mock("@/app/c/[slug]/request-meta", () => ({ requestMeta: async () => ({}) }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));
vi.mock("@/lib/portal/access", () => ({
  requirePortal: async () => ({ userId: "usr-1", clinicId: "clinic-1", clinicSlug: "paws" }),
  portalOrNull: async () => ({ userId: "usr-1", clinicId: "clinic-1", clinicSlug: "paws" }),
  portalGrants: async () => [],
}));
vi.mock("@/lib/portal/page", () => ({
  loadPortalPage: async () => ({
    state: { clinic: { offboardingStartedAt: null }, channels: [{ channel: "meta" }] },
  }),
  shellProps: () => ({
    slug: "paws",
    clinicName: "Paws & Claws",
    section: "settings",
    audience: mocks.audience,
    status: { kind: "answering" },
    timeZone: "America/Los_Angeles",
    locations: [],
    opened: [],
  }),
}));

import { generateMetadata as protectMetadata } from "@/app/c/[slug]/protect/page";
import { beginAddDevice } from "@/app/c/[slug]/protect/actions";
import { removeDeviceAction } from "@/app/c/[slug]/settings/sign-in-actions";
import { BasicsScreen } from "@/app/c/[slug]/setup/screens/PracticeScreens";
import { PracticeForm } from "@/app/c/[slug]/knowledge/KnowledgeForms";
import { ProtectDevice } from "@/app/c/[slug]/protect/ProtectDevice";
import { SignInCard } from "@/app/c/[slug]/settings/SignInCard";
import { StepUpPrompt } from "@/app/c/[slug]/step-up/StepUpPrompt";
import PortalWhatsAppPage from "@/app/c/[slug]/whatsapp/page";
import { renderTranscriptEmail } from "@/lib/conversations/transcript-email";
import { compose } from "@/lib/email/templates/compose";
import { DEVICE_CHANGED_ENTRY, type DeviceChangedPayload } from "@/lib/email/templates/device_changed";
import { DEVICE_RECOVERY_LINK_ENTRY } from "@/lib/email/templates/device_recovery_link";
import { TEMPLATES } from "@/lib/email/templates/registry";
import { SIGN_IN_HELP_LINK_ENTRY } from "@/lib/email/templates/sign_in_help_link";
import type { EmailAudience, TemplateContext } from "@/lib/email/templates/types";
import { needsAttention, type AttentionFacts } from "@/lib/portal/attention";

type Audience = "patients" | "clients";
const AUDIENCES: readonly Audience[] = ["clients", "patients"];

/** "patient" or "patients" about a person; the link path /patient-requests/ is not one. */
const PATIENT = /\bpatients?\b(?!-requests)/i;

function words(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&rsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function render(element: ReactElement): string {
  return words(renderToStaticMarkup(element));
}

/** What a vet must never read, and what everyone else still reads. */
function holds(audience: Audience, said: string, patientWording: string, clientWording: string) {
  if (audience === "clients") {
    expect(said).toContain(clientWording);
    expect(said).not.toMatch(PATIENT);
  } else {
    expect(said).toContain(patientWording);
  }
}

// -----------------------------------------------------------------------------
// The portal
// -----------------------------------------------------------------------------

describe("Home's Needs attention", () => {
  const screens: SetupScreenId[] = ["basics", "hours", "services", "question"];
  const at = new Date("2026-10-20T12:00:00Z");
  const facts = (specialty: string): AttentionFacts => ({
    slug: "paws",
    addressUndeliverable: false,
    state: {
      screens,
      progress: new Map(screens.map((id) => [id, { outcome: "done" as const, at }])),
      clinic: { isCoveredEntity: false, specialty } as SetupState["clinic"],
      hasPasskey: false,
      hasBackup: false,
      billing: null,
      address: "info@paws.test",
    },
  });

  test.each([
    ["veterinary", "clients"],
    ["med-spa", "patients"],
  ] as const)("no device yet, for %s", (specialty, audience) => {
    const item = needsAttention(facts(specialty)).find((i) => i.id === "passkey")!;
    holds(
      audience,
      item.text,
      "No device can open patient details yet.",
      "No device can open client details yet. Conversations and Bookings need one.",
    );
  });
});

describe("Protect", () => {
  const base = {
    slug: "paws",
    next: "/c/paws",
    initialDevice: "mac" as const,
    stepUpHref: "/c/paws/step-up?next=%2Fc%2Fpaws",
  };

  test.each(AUDIENCES)("every mode, for %s", (audience) => {
    const first = render(
      createElement(ProtectDevice, { ...base, audience, mode: "open", firstDevice: true, codeRoute: false }),
    );
    holds(audience, first, "Protect patient details: use", "Protect client details: use");
    holds(
      audience,
      first,
      "when this device opens patient details",
      "Staff see this name when this device opens client details",
    );
    const proof = render(
      createElement(ProtectDevice, { ...base, audience, mode: "needs_proof", firstDevice: false, codeRoute: true }),
    );
    holds(
      audience,
      proof,
      "already has a device that opens patient details",
      "This sign-in already has a device that opens client details.",
    );
    for (const codeRoute of [true, false]) {
      const none = render(
        createElement(ProtectDevice, { ...base, audience, mode: "no_device", firstDevice: false, codeRoute }),
      );
      holds(
        audience,
        none,
        "has no device that opens patient details",
        "This sign-in has no device that opens client details",
      );
      holds(audience, none, "patient details may already exist", "client details may already exist");
    }
  });
});

describe("Protect's title, and what its action and Settings' removal say", () => {
  test.each(AUDIENCES)("for %s", async (audience) => {
    mocks.audience = audience;
    const one = audience === "clients" ? "client" : "patient";
    expect((await protectMetadata({ params: Promise.resolve({ slug: "paws" }) })).title).toBe(
      `Protect ${one} details`,
    );
    const refused = await beginAddDevice("paws", {});
    expect(refused).toEqual({
      ok: false,
      message: `This sign-in already has a device that opens ${one} details. Confirm with that device first, or enter a code from your authenticator app.`,
    });
    expect(await removeDeviceAction("paws", "f-1")).toMatchObject({
      ok: true,
      toast: `Device removed. It can no longer open ${one} details, and its sessions have ended.`,
    });
  });
});

describe("the step-up prompt", () => {
  test.each(AUDIENCES)("with a device and without, for %s", (audience) => {
    const props = {
      slug: "paws",
      next: "/c/paws/bookings",
      protectHref: "/c/paws/protect",
      initialDevice: "mac" as const,
      audience,
    };
    holds(
      audience,
      render(createElement(StepUpPrompt, { ...props, hasPasskey: true })),
      "Patient details need",
      "Client details need",
    );
    holds(
      audience,
      render(createElement(StepUpPrompt, { ...props, hasPasskey: false })),
      "Patient details open only after",
      "Client details open only after",
    );
  });
});

describe("Settings → Sign-in", () => {
  test.each(AUDIENCES)("the devices and the address, for %s", (audience) => {
    const said = render(
      createElement(SignInCard, {
        slug: "paws",
        address: "info@paws.test",
        devices: [
          { id: "f-1", label: "Front desk Mac", added: "Added Tuesday 6 October", lastUsed: null, isThisSession: true },
        ],
        hasBackup: true,
        backupCodesLeft: 8,
        addDeviceHref: "/c/paws/protect",
        addBackupHref: "/c/paws/setup?s=backup",
        audience,
      }),
    );
    holds(
      audience,
      said,
      "Each phone or computer that can open patient details",
      "Each phone or computer that can open client details",
    );
  });
});

describe("Knowledge and setup's Basics", () => {
  const initial = {
    name: "Paws & Claws",
    address: "1 Main St, Austin, TX",
    phone: "(512) 555-0100",
    website: "pawsandclaws.test",
    timezone: "America/Chicago",
  };
  const zones = [{ id: "America/Chicago", label: "Central" }];

  test.each(AUDIENCES)("the main number's hint, for %s", (audience) => {
    holds(
      audience,
      render(createElement(PracticeForm, { slug: "paws", initial, zones, audience })),
      "The number your patients call.",
      "The number your clients call. It can't be your direct line.",
    );
    holds(
      audience,
      render(
        createElement(BasicsScreen, {
          slug: "paws",
          backHref: null,
          skipCost: "",
          initial: { ...initial, timezoneConfirmed: true },
          addressZone: null,
          zones,
          locations: [],
          audience,
        }),
      ),
      "The number patients call today.",
      "The number clients call today. You keep it",
    );
  });
});

describe("the WhatsApp page", () => {
  beforeEach(() => {
    mocks.audience = "clients";
  });

  test.each(AUDIENCES)("what to have to hand, for %s", async (audience) => {
    mocks.audience = audience;
    const page = await PortalWhatsAppPage({
      params: Promise.resolve({ slug: "paws" }),
      searchParams: Promise.resolve({}),
    });
    const said = render(page);
    expect(said).toContain("Have these to hand:");
    holds(
      audience,
      said,
      "The phone number you want patients to message",
      "The phone number you want clients to message",
    );
  });
});

// -----------------------------------------------------------------------------
// Email
// -----------------------------------------------------------------------------

function ctx(audience: EmailAudience): TemplateContext {
  return {
    clinicName: null,
    audience,
    reason: "You're receiving this because this address is the sign-in for a healdesk account.",
    raisedAt: new Date("2026-10-20T14:32:00Z"),
    timeZone: "America/Chicago",
  };
}

describe("the footer every email carries", () => {
  test.each(AUDIENCES)("asks a reply to leave out the right people's details, for %s", (audience) => {
    const email = compose({ subject: "S", preheader: "P", blocks: [{ type: "paragraph", text: "Hello." }] }, ctx(audience));
    for (const part of [email.text, words(email.html)]) {
      holds(
        audience,
        part,
        "Replies reach the healdesk team. Please leave out patient details.",
        "Replies reach the healdesk team. Please leave out your clients' details.",
      );
    }
  });

  test("every template a vet can be sent ends with the vet's footer, never a patient's", () => {
    for (const [kind, entry] of Object.entries(TEMPLATES)) {
      // P6's footer follows the agreement it carries (agreementCopyFooter in
      // @healdesk/catalog), and a vet's is the data protection agreement's.
      const fixture =
        kind === "agreement_copy"
          ? { ...(entry!.fixture as Record<string, unknown>), documentVersion: "dpa/1.0.0" }
          : entry!.fixture;
      const email = entry!.render(fixture, { ...ctx("clients"), clinicName: "Paws & Claws" });
      expect(email.text, kind).not.toContain("Please leave out patient details.");
      expect(email.text, kind).toMatch(/Please leave out your clients' details\./);
    }
  });
});

describe("the device emails", () => {
  const changes: DeviceChangedPayload[] = [
    { change: "added", deviceName: "Front desk Mac", changedAt: "2026-10-20T14:32:00Z" },
    { change: "added", deviceName: "Front desk Mac", changedAt: "2026-10-20T14:32:00Z", source: "recovery" },
    { change: "removed", deviceName: "Front desk Mac", changedAt: "2026-10-20T14:32:00Z" },
    { change: "locked", changedAt: "2026-10-20T14:32:00Z", lockedMinutes: 15 },
    { change: "signed_out", changedAt: "2026-10-20T14:32:00Z", removedCount: 1 },
    { change: "signed_out", changedAt: "2026-10-20T14:32:00Z", removedCount: 1, source: "operator" },
  ];

  test.each(AUDIENCES)("O3, O16 and O6, for %s", (audience) => {
    const all = [
      ...changes.map((payload) => DEVICE_CHANGED_ENTRY.render(payload, ctx(audience))),
      DEVICE_RECOVERY_LINK_ENTRY.render(DEVICE_RECOVERY_LINK_ENTRY.fixture, ctx(audience)),
      SIGN_IN_HELP_LINK_ENTRY.render(SIGN_IN_HELP_LINK_ENTRY.fixture, ctx(audience)),
    ];
    for (const email of all) {
      const said = [email.subject, email.preheader, email.text, words(email.html)].join("\n");
      if (audience === "clients") expect(said).not.toMatch(PATIENT);
      else expect(said).toMatch(/\bpatient details\b/);
    }
    const added = all[0]!;
    holds(
      audience,
      added.text,
      "It can now open patient details",
      "It can now open client details, with its own Face ID",
    );
    holds(
      audience,
      all[all.length - 2]!.text,
      "can open patient details any more",
      "no device on its healdesk sign-in can open client details any more",
    );
    holds(
      audience,
      all[all.length - 1]!.text,
      "Patient details still open only with Face ID",
      "Client details still open only with Face ID",
    );
  });
});

describe("the transcript email", () => {
  test.each(AUDIENCES)("what it holds and where it belongs, for %s", (audience) => {
    const email = renderTranscriptEmail({
      conversationId: "6b0f8a52-3f7e-4d2a-9a51-2a0c1f0e9d11",
      clinic: { id: "clinic-1", name: "Paws & Claws", timeZone: "America/Chicago", audience },
      channel: "voice",
      startedAt: new Date("2026-10-20T15:00:00Z"),
      turns: [
        { speaker: "assistant", text: "Hi, I'm Paws & Claws's AI assistant, and this call is transcribed." },
        { speaker: "person", text: "I'd like a wellness exam for Biscuit on Thursday." },
      ],
    });
    for (const part of [email.text, words(email.html)]) {
      holds(audience, part, "This email holds patient information.", "This email holds your clients' information.");
      holds(
        audience,
        part,
        "file it where your practice keeps patient records",
        "file it where your practice keeps client records",
      );
      holds(
        audience,
        part,
        "which isn't meant to hold patient information",
        "which isn't meant to hold your clients' information",
      );
    }
  });
});
