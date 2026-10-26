import { existsSync } from "node:fs";
import { join } from "node:path";

import { annualTotalUsd, CURRENT_BAA_VERSION, getPlan, SENDER_IDENTITY } from "@healdesk/catalog";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { DIRECT_KIND_REGISTRY, DIRECT_KINDS, LEDGER_DIRECT_KINDS } from "@/lib/email/direct-kinds";
import {
  carriesUnsubscribe,
  classOf,
  CRITICAL_NOTICE_KINDS,
  isLinkEmail,
  locksOutClinic,
  type EmailKind,
} from "@/lib/email/kind-rules";
import { NOTICE_KIND_REGISTRY, NOTICE_KINDS } from "@/lib/email/kinds";
import {
  assertPayloadAllowed,
  copyProblems,
  findLinks,
  linkProblem,
  linkProblems,
  MAX_SUBJECT_CHARS,
  PayloadNotAllowedError,
  subjectProblems,
  visibleText,
} from "@/lib/email/lint";
import {
  compose,
  EmailCompositionError,
  escapeHtml,
  MAX_HTML_BYTES,
  REPLY_LINE,
  WRITE_NEW_LINE,
} from "@/lib/email/templates/compose";
import {
  ACCOUNT_REASON,
  audienceFor,
  clinicReason,
  OPS_REASON,
  ORDER_REASON,
  SIGN_IN_REASON,
} from "@/lib/email/templates/context";
import { addressConfirmReason } from "@/lib/email/templates/address_change_confirm";
import { ASSISTANT_READY_ENTRY } from "@/lib/email/templates/assistant_ready";
import { AGREEMENT_TO_SIGN_ENTRY } from "@/lib/email/templates/agreement_to_sign";
import {
  ADDRESS_CHANGING_ENTRY,
  addressMovingReason,
} from "@/lib/email/templates/address_changing";
import { renderOpsAlert } from "@/lib/email/templates/ops_alert";
import { SIGN_IN_HELP_REASON } from "@/lib/email/templates/sign_in_help_link";
import { PENDING_TEMPLATES, TEMPLATES, templateFor } from "@/lib/email/templates/registry";
import {
  CHANNEL_READY_ENTRY,
  channelReadyWebFixture,
} from "@/lib/email/templates/channel_ready";
import {
  STEPS_SENT_ENTRY,
  stepsReason,
  stepsSentWebFixture,
  type StepsSentPayload,
} from "@/lib/email/templates/steps_sent";
import { WEB_CHAT_COUNTS_LINE } from "@/lib/setup/channels";
import { widgetSnippet } from "@/lib/setup/snippet";
import { SUPPORT_REASON } from "@/lib/email/templates/support_escalation";
import type { EmailAudience, TemplateContext } from "@/lib/email/templates/types";
import { WELCOME_ENTRY } from "@/lib/email/templates/welcome";
import {
  readUnsubscribeToken,
  stepsStopUrl,
  unsubscribeHeaders,
  unsubscribeToken,
  unsubscribeUrl,
} from "@/lib/email/unsubscribe";

/**
 * Every template, and the rules every email follows (Annex X4 of
 * docs/design/funnel-onboarding-portal-2026-10-06.md): a registry that leaves
 * no kind unowned, a snapshot per kind and audience, the payload allowlist,
 * the link scanner, the copy lint, the subject rules, the HTML's shape and
 * CAN-SPAM. No database: a template is a pure function.
 */

const ORIGIN = "https://app.healdesk.test";
const CLINIC_ID = "0c1d2e3f-0000-4000-8000-000000000000";
/** 32 random bytes as base64url, the shape of every single-use token here. */
const TOKEN = "kP3vXq9TzR7wYb2NcL5mHs8JdF4gA6eU1oIiQ0yBtVx";

const SAVED: Record<string, string | undefined> = {};
const ENV = ["BETTER_AUTH_URL", "BETTER_AUTH_SECRET", "HEALDESK_APP_URL", "NODE_ENV"] as const;

beforeEach(() => {
  for (const key of ENV) SAVED[key] = process.env[key];
  process.env.BETTER_AUTH_URL = ORIGIN;
  // A stop link is signed with a key derived from this secret, and the
  // snapshots carry the link: pinned, so CI's own secret cannot change them.
  process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-tests";
  delete process.env.HEALDESK_APP_URL;
});

afterEach(() => {
  for (const key of ENV) {
    const value = SAVED[key];
    if (value === undefined) delete (process.env as Record<string, string | undefined>)[key];
    else (process.env as Record<string, string>)[key] = value;
  }
});

const STEPS_DELIVERY_ID = "0b1c2d3e-4f50-4617-8899-aabbccddeeff";

function contextFor(kind: EmailKind, audience: EmailAudience = "patients"): TemplateContext {
  const scope = carriesUnsubscribe(kind) ? "commercial" : null;
  return {
    clinicName:
      kind === "ops_alert" ||
      kind === "ops_digest" ||
      kind === "flag_alert" ||
      kind === "sign_in_link" ||
      kind === "sign_in_help_link" ||
      kind === "device_changed" ||
      kind === "access_request"
        ? null
        : "Radiance Med Spa",
    audience,
    reason:
      kind === "ops_alert" || kind === "ops_digest" || kind === "flag_alert"
        ? OPS_REASON
        : kind === "sign_in_link"
          ? SIGN_IN_REASON
          : kind === "sign_in_help_link"
            ? SIGN_IN_HELP_REASON
            : kind === "address_change_confirm"
              ? addressConfirmReason("Radiance Med Spa")
              : kind === "order_confirmed_delayed"
            ? ORDER_REASON
            : kind === "device_changed"
              ? ACCOUNT_REASON
              : kind === "steps_sent"
                ? stepsReason("Radiance Med Spa")
                : kind === "support_escalation" || kind === "access_request"
                  ? SUPPORT_REASON
                  : clinicReason("Radiance Med Spa"),
    ...(scope ? { unsubscribeUrl: unsubscribeUrl(CLINIC_ID, scope) } : {}),
    // O11 goes to someone the clinic named, with the link that stops any more
    // reaching that address, as lib/notices/steps-sent.ts sends it.
    ...(kind === "steps_sent"
      ? { unsubscribeUrl: stepsStopUrl(CLINIC_ID, STEPS_DELIVERY_ID) }
      : {}),
    raisedAt: new Date("2026-10-06T14:32:00Z"),
    timeZone: "America/New_York",
  };
}

const TEMPLATED = Object.entries(TEMPLATES) as [
  EmailKind,
  NonNullable<(typeof TEMPLATES)[EmailKind]>,
][];

describe("the template registry", () => {
  test("every kind has a template or a pending line naming its owner, never both and never neither", () => {
    const every: EmailKind[] = [...NOTICE_KINDS, ...DIRECT_KINDS];
    for (const kind of every) {
      const templated = templateFor(kind) !== undefined;
      const pending = Object.prototype.hasOwnProperty.call(PENDING_TEMPLATES, kind);
      expect(templated !== pending, `${kind}: templated ${templated}, pending ${pending}`).toBe(
        true,
      );
    }
    // No stray lines for kinds that do not exist.
    for (const kind of [...Object.keys(TEMPLATES), ...Object.keys(PENDING_TEMPLATES)]) {
      expect(every, kind).toContain(kind);
    }
  });

  test("a pending kind's owner is the owner its registry names", () => {
    for (const [kind, pending] of Object.entries(PENDING_TEMPLATES)) {
      const owner =
        kind in NOTICE_KIND_REGISTRY
          ? NOTICE_KIND_REGISTRY[kind as keyof typeof NOTICE_KIND_REGISTRY].owner
          : DIRECT_KIND_REGISTRY[kind as keyof typeof DIRECT_KIND_REGISTRY].owner;
      expect(pending.owner, kind).toBe(owner);
      expect(pending.ships.length, kind).toBeGreaterThan(0);
    }
  });

  test("every pending kind names the package that owes it", () => {
    const byPackage: Record<string, string[]> = {};
    for (const [kind, pending] of Object.entries(PENDING_TEMPLATES)) {
      (byPackage[pending.package] ??= []).push(kind);
    }
    expect(byPackage).toEqual({
      runtime: ["outage_started", "outage_ended", "guarantee_miss"],
    });
  });

  test("the templates shipped so far: I1, B2, B3, O3 and the billing kinds (the usage alerts among them since 13 October), then B1, O7, the setup closure, O13, O4, O10 and O11, the calendar's two, the live alerts, the operator's notices, O6 and O5's two, the support chat's L25 and I3, the practice questions' O8 and O9, I2, after cancellation E3 to E6, the claims function's L13 and L14, the DPA re-sign's L22, the drift list's L23, Flag this answer's I4, a patient's request, L32, the human route's O16, P6's resend and I3's access request", () => {
    expect(Object.keys(TEMPLATES)).toEqual([
      "ops_alert",
      "sign_in_link",
      "order_confirmed_delayed",
      "device_changed",
      "payment_failed",
      "payment_action_required",
      "grace_ending",
      "suspended",
      "restored",
      "cancel_scheduled",
      "cancel_reversed",
      "canceled",
      "renewal_upcoming",
      "usage_80",
      "usage_100",
      "overage_invoiced",
      "plan_changed",
      "location_added",
      "connect_disconnected",
      "plan_started",
      "price_stepped_up",
      "step_up_reminder",
      "allowance_fallback",
      "receipt",
      "refund_issued",
      "card_expiring",
      "connect_connected",
      "welcome",
      "setup_reminder",
      "setup_closed",
      "calendar_stopped",
      "calendar_reconnected",
      "setting_changed",
      "channel_ready",
      "steps_sent",
      "channel_live",
      "ai_paused",
      "calendar_link",
      "calendar_election_recorded",
      "booking_request",
      "request_still_open",
      "request_missed",
      "deposit_to_collect",
      "handover",
      "urgent",
      "website_message",
      "calendar_check",
      "ended_early",
      "terms_notice",
      "subprocessor_notice",
      "incident_report",
      "guarantee_claim_received",
      "guarantee_finding",
      "suspended_for_cause",
      "product_update",
      "sign_in_help_link",
      "address_change_confirm",
      "address_changing",
      "support_request",
      "support_escalation",
      "assistant_ready",
      "practice_questions_failed",
      "ops_digest",
      "pass_through_ending",
      "export_ready",
      "export_reminder",
      "data_destroyed",
      "daily_summary",
      "weekly_recap",
      "agreement_to_sign",
      "website_changes",
      "closed_day_bookings",
      "flag_alert",
      "patient_request",
      "device_recovery_link",
      "agreement_copy",
      "access_request",
      // Lane P6f: the emails the owner sends through the approval inbox.
      "setup_extended",
      "setup_waiting_on_us",
      "setup_help_offer",
      "agreement_question",
      "baa_resign_chase",
      // Lane P7c: L37, the support reply the owner approves.
      "support_reply",
      // Lane P7g: L38, the acknowledgement of a practice's email to support.
      "support_received",
    ]);
  });

  test("the ledger records exactly the direct kinds flagged for it: B1, O11's sent-on steps, O5, L22 and E6", () => {
    const flagged = DIRECT_KINDS.filter((kind) => DIRECT_KIND_REGISTRY[kind].ledger);
    expect([...LEDGER_DIRECT_KINDS]).toEqual(flagged);
    expect(flagged).toEqual([
      "welcome",
      "steps_sent",
      "address_change_confirm",
      "address_changing",
      "agreement_to_sign",
      "data_destroyed",
      "baa_resign_chase",
      "support_reply",
    ]);
    // Lane P7c: a support reply carries no token and locks no one out.
    expect(isLinkEmail("support_reply")).toBe(false);
    expect(locksOutClinic("support_reply")).toBe(false);
    // Lane P6f: the owner's re-sign chase carries a fresh signing link.
    expect(isLinkEmail("baa_resign_chase")).toBe(true);
    // X1.5 names O5's confirmation and L22 link emails; O5's notice and E6 carry no token.
    expect(isLinkEmail("address_change_confirm")).toBe(true);
    expect(isLinkEmail("agreement_to_sign")).toBe(true);
    expect(isLinkEmail("address_changing")).toBe(false);
    expect(isLinkEmail("data_destroyed")).toBe(false);
    expect(isLinkEmail("welcome")).toBe(true);
    expect(locksOutClinic("welcome")).toBe(true);
    // O11 goes to someone the clinic names, never to the clinic's address,
    // so it carries no link into the portal and locks no one out.
    expect(isLinkEmail("steps_sent")).toBe(false);
    expect(locksOutClinic("steps_sent")).toBe(false);
    // Its reader can stop any more reaching that address (Annex X5, O11).
    expect(carriesUnsubscribe("steps_sent")).toBe(true);
  });

  test("every template's fixture passes the payload allowlist", () => {
    for (const [kind, entry] of TEMPLATED) {
      expect(() => assertPayloadAllowed(entry.fixture, kind), kind).not.toThrow();
    }
  });

  test("an optional or commercial kind gets a template only together with its stop-link page", () => {
    // The footer and List-Unsubscribe point at /email/stop/<token>. That page
    // lands with the switches (M3); until it exists, a template for such a kind
    // would mail a stop link that 404s, which CAN-SPAM does not forgive.
    const page = ["route.ts", "page.tsx"].some((file) =>
      existsSync(join(process.cwd(), "src", "app", "email", "stop", "[token]", file)),
    );
    for (const [kind] of TEMPLATED) {
      if (carriesUnsubscribe(kind)) expect(page, `${kind} needs the stop-link page`).toBe(true);
    }
  });
});

/**
 * Since 17ab8ea1 a direct sender leaves out a clinic name the email may not
 * print (printableClinicName), so every direct kind can render with none.
 * The check of 19 October 2026 found the fallbacks lower case where they open
 * a sentence ("your practice's AYA is ready", "a practice asked us").
 */
describe("every direct kind, rendered with no clinic name it may print", () => {
  const STARTS_LOWER = /(?:^|[.!?:]\s+|\n)(?:your|a) practice\b/;
  for (const [kind, entry] of TEMPLATED.filter(([k]) => (DIRECT_KINDS as readonly string[]).includes(k))) {
    test(`${kind}: no gap, and no sentence opening in lower case`, () => {
      const ctx = { ...contextFor(kind), clinicName: null };
      const r = entry.render(entry.fixture, ctx);
      for (const part of [r.subject, r.preheader, r.text, visibleText(r.html)]) {
        expect(part).not.toMatch(/\bnull\b|\bundefined\b/);
        expect(part, kind).not.toMatch(STARTS_LOWER);
      }
    });
  }
});

describe("each template's output", () => {
  for (const [kind, entry] of TEMPLATED) {
    for (const audience of ["patients", "clients"] as const) {
      test(`${kind}, for ${audience}: the snapshot`, () => {
        expect(entry.render(entry.fixture, contextFor(kind, audience))).toMatchSnapshot();
      });
    }

    describe(kind, () => {
      const rendered = () => entry.render(entry.fixture, contextFor(kind));

      test("a subject of at most 70 characters, with no link", () => {
        expect(subjectProblems(rendered().subject)).toEqual([]);
      });

      test("passes the copy lint, in the text and in the HTML a reader sees", () => {
        const r = rendered();
        expect(
          copyProblems([r.subject, r.preheader, r.text, visibleText(r.html)].join("\n")),
        ).toEqual([]);
      });

      test("passes the link scanner", () => {
        expect(linkProblems(rendered(), kind)).toEqual([]);
      });

      test("ends with the footer: why, the reply line, the entity and the postal address", () => {
        const r = rendered();
        for (const body of [r.text, visibleText(r.html)]) {
          // O16 carries a live link and asks for a new email, never a reply
          // that would quote it to us, so its footer says the same.
          expect(body).toContain(kind === "device_recovery_link" ? WRITE_NEW_LINE : REPLY_LINE);
          if (kind === "device_recovery_link") expect(body).not.toContain(REPLY_LINE);
          expect(body).not.toContain(SENDER_IDENTITY.entityLine);
          expect(body).not.toContain(SENDER_IDENTITY.postalAddressLabel);
          expect(body).toContain(SENDER_IDENTITY.postalAddress);
          expect(body).toContain("You're receiving this because");
        }
      });

      test("HTML that is one column, system fonts, no images and nothing remote, under 100 KB", () => {
        const { html } = rendered();
        expect(Buffer.byteLength(html)).toBeLessThan(MAX_HTML_BYTES);
        expect(html).not.toMatch(/<img|<link|<script|<iframe|<table|\bsrc=|url\(|@import/i);
        expect(html).toContain("-apple-system");
        expect(html).toContain("max-width:560px");
      });
    });
  }
});

describe("O5 from ops' changeClinicEmail", () => {
  const ops = (isToNewAddress: boolean) =>
    ADDRESS_CHANGING_ENTRY.render(
      { ...ADDRESS_CHANGING_ENTRY.fixture, isFromOperator: true, isToNewAddress },
      {
        ...contextFor("address_changing"),
        reason: isToNewAddress
          ? addressMovingReason("Radiance Med Spa")
          : clinicReason("Radiance Med Spa"),
      },
    );

  test("to the old address and to the new: the snapshots", () => {
    expect(ops(false)).toMatchSnapshot();
    expect(ops(true)).toMatchSnapshot();
  });

  test("both name the end of the objection window, how to object, and carry no stop link or token", () => {
    for (const isToNewAddress of [false, true]) {
      const r = ops(isToNewAddress);
      expect(r.text).toContain("takes effect on Friday, October 9 at 10:32 AM EDT");
      expect(r.text).toContain("reply to this email before Friday, October 9 at 10:32 AM EDT");
      expect(r.text).not.toContain("Stop this change");
      expect(linkProblems(r, "address_changing")).toEqual([]);
      expect(copyProblems([r.subject, r.text].join("\n"))).toEqual([]);
    }
    expect(ops(true).text).toContain(
      "You're receiving this because Radiance Med Spa is moving its healdesk address to this one.",
    );
  });
});

// Round 2 of the 19 October guardrails: O8 said "She has passed her practice
// questions … among others" while the booking and deposit cases cannot be
// asked. It names what was asked, as Home's tracker does, until they can be.
describe("O8, your AYA is ready to talk to", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/engine/practice/cases");
    vi.resetModules();
  });

  test("names the questions asked and says the booking ones wait, then goes back to the plain line once every case can be asked", async () => {
    for (const audience of ["patients", "clients"] as const) {
      const one = audience === "clients" ? "client" : "patient";
      const r = ASSISTANT_READY_ENTRY.render(ASSISTANT_READY_ENTRY.fixture, contextFor("assistant_ready", audience));
      expect(r.text).toContain(`an urgent message from a ${one}, an off-topic ${one} and a question your answers don't cover.`);
      expect(r.text).toContain("The ones about booking and deposits wait for her booking tools.");
      expect(r.text).not.toMatch(/among others/);
      expect(r.preheader).toBe(`She has passed the practice questions she can be asked. Nothing in the preview reaches ${audience}.`);
      expect(copyProblems([r.subject, r.preheader, r.text].join("\n"))).toEqual([]);
    }
    vi.resetModules();
    vi.doMock("@/lib/engine/practice/cases", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/engine/practice/cases")>()),
      casesNotAskable: () => [],
    }));
    const { ASSISTANT_READY_ENTRY: every } = await import("@/lib/email/templates/assistant_ready");
    const plain = every.render(every.fixture, contextFor("assistant_ready"));
    expect(plain.preheader).toBe("She has passed her practice questions. Nothing in the preview reaches patients.");
    expect(plain.text).toContain("AYA has passed her practice questions about Radiance Med Spa:");
    expect(plain.text).not.toMatch(/booking tools/);
  });
});

describe("L22, sign your updated agreement", () => {
  const render = (over: Partial<typeof AGREEMENT_TO_SIGN_ENTRY.fixture>, audience: EmailAudience = "patients") =>
    AGREEMENT_TO_SIGN_ENTRY.render(
      { ...AGREEMENT_TO_SIGN_ENTRY.fixture, ...over },
      contextFor("agreement_to_sign", audience),
    );

  test("the reminders and an unsure practice with nothing answering yet: the snapshots", () => {
    expect(render({ waitingDays: 3 })).toMatchSnapshot();
    expect(render({ isUnsure: true, channels: [], directLineE164: null })).toMatchSnapshot();
  });

  test("says AYA is paused until it's signed and where each channel goes, with the link", () => {
    const first = render({});
    expect(first.subject).toBe("Sign your updated agreement");
    expect(first.preheader).toBe("AYA is paused until it's signed.");
    expect(first.text).toContain("now bills health insurance electronically");
    expect(first.text).toContain("Until it's signed, AYA is paused:");
    expect(first.text).toContain("Phone: calls go to your direct line ((415) 555-0100)");
    expect(first.text).toContain("Website chat: shows a contact form");
    expect(first.text).toContain("AYA answers again the moment it's signed");
    expect(first.text).toContain("The link works for 14 days");
    expect(linkProblems(first, "agreement_to_sign")).toEqual([]);
    // A token in it is a single-use token, allowed only in a link email.
    expect(linkProblems(first, "ai_paused").join(" ")).toContain("single-use token");
  });

  test("before anything answers, it says AYA starts once it's signed, and never that she answers again", () => {
    const quiet = render({ channels: [], directLineE164: null }, "clients");
    expect(quiet.preheader).toBe("AYA starts answering once it's signed.");
    expect(quiet.text).toContain("AYA doesn't answer your clients until it's signed.");
    expect(quiet.text).not.toContain("is paused:");
    expect(quiet.text).not.toContain("answers again");
  });

  test("a reminder says how long it has waited, and an unsure practice is told why the BAA covers it", () => {
    const day7 = render({ waitingDays: 7, isUnsure: true });
    expect(day7.subject).toBe("Your updated agreement is waiting to be signed");
    expect(day7.text).toContain("still waiting to be signed, 7 days after we sent it");
    expect(day7.text).toContain("not sure whether Radiance Med Spa bills any health insurance");
    expect(copyProblems([day7.subject, day7.text].join("\n"))).toEqual([]);
  });
});

describe("L22 for a newer business associate agreement (wave 2 R11)", () => {
  const render = (
    over: Partial<typeof AGREEMENT_TO_SIGN_ENTRY.fixture>,
    audience: EmailAudience = "patients",
  ) =>
    AGREEMENT_TO_SIGN_ENTRY.render(
      {
        ...AGREEMENT_TO_SIGN_ENTRY.fixture,
        kind: "baa_version",
        version: "1.5.0",
        isRequired: false,
        ...over,
      },
      contextFor("agreement_to_sign", audience),
    );

  test("answering below the floor, a reminder, and a practice not answering yet: the snapshots", () => {
    expect(render({ isRequired: true })).toMatchSnapshot();
    expect(render({ waitingDays: 3 })).toMatchSnapshot();
    expect(render({ channels: [], directLineE164: null, isRequired: true })).toMatchSnapshot();
  });

  test("names both versions, and says AYA keeps answering while it's unsigned, below the floor or not", () => {
    // A BAA-version re-sign never pauses AYA (owner, 19 October 2026).
    for (const isRequired of [true, false]) {
      const email = render({ isRequired });
      expect(email.text).toContain(
        `version ${CURRENT_BAA_VERSION}, in place of version 1.5.0, which you signed`,
      );
      expect(email.text).toContain("An agreement only changes when you sign it");
      expect(email.text).toContain("AYA keeps answering while you read it and sign it.");
      expect(email.text).not.toContain("paused");
      expect(email.text).not.toContain("answers again");
      expect(email.text).not.toContain("direct line");
      expect(email.preheader).toBe("AYA keeps answering while you sign it.");
      // Never the DPA's words about insurance.
      expect(email.text).not.toContain("insurance");
      expect(email.text).not.toContain("data protection agreement");
      expect(copyProblems([email.subject, email.text].join("\n"))).toEqual([]);
      expect(linkProblems(email, "agreement_to_sign")).toEqual([]);
    }
  });

  test("before anything answers, it says whether go-live waits on the signature", () => {
    const waits = render({ channels: [], directLineE164: null, isRequired: true }, "clients");
    expect(waits.text).toContain("AYA starts answering your clients only once it's signed.");
    const free = render({ channels: [], directLineE164: null });
    expect(free.text).toContain("Nothing else in your setup waits on it.");
    expect(free.preheader).toBe(`Version ${CURRENT_BAA_VERSION} of your agreement, to sign.`);
  });

  test("its payload passes the allowlist, and one naming no version is refused", () => {
    const payload = {
      ...AGREEMENT_TO_SIGN_ENTRY.fixture,
      kind: "baa_version" as const,
      version: "1.5.0",
      isRequired: true,
    };
    expect(() => assertPayloadAllowed(payload, "agreement_to_sign")).not.toThrow();
    expect(() => render({ version: undefined })).toThrow(/names the version it replaces/);
  });
});

describe("website chat's line in O10 and O11", () => {
  // The registry's fixtures are phone's. Website chat's variants carry the
  // line a clinic pastes (lib/setup/snippet.ts), built from the stored script
  // address and slug, so it must be the screens' line to the byte, shown and
  // never parsed in the HTML, and on our public origin.
  const LINE = `<script src="${ORIGIN}/widget/v1.js" data-clinic="radiance-med-spa" async></script>`;
  const ready = () =>
    CHANNEL_READY_ENTRY.render(channelReadyWebFixture(), contextFor("channel_ready"));
  const steps = () => STEPS_SENT_ENTRY.render(stepsSentWebFixture(), contextFor("steps_sent"));

  test("the snapshots, for patients and for clients", () => {
    for (const audience of ["patients", "clients"] as const) {
      expect(
        CHANNEL_READY_ENTRY.render(channelReadyWebFixture(), contextFor("channel_ready", audience)),
      ).toMatchSnapshot();
      expect(
        STEPS_SENT_ENTRY.render(stepsSentWebFixture(), contextFor("steps_sent", audience)),
      ).toMatchSnapshot();
    }
  });

  test("each carries the line the screens print, on a line of its own, and its payload passes the allowlist", () => {
    expect(widgetSnippet("radiance-med-spa")).toBe(LINE);
    for (const [kind, rendered, payload] of [
      ["channel_ready", ready(), channelReadyWebFixture()],
      ["steps_sent", steps(), stepsSentWebFixture()],
    ] as const) {
      expect(rendered.text.split("\n"), kind).toContain(LINE);
      // Escaped in the HTML: shown as text, never a tag a mail client runs.
      expect(rendered.html, kind).toContain(escapeHtml(LINE));
      expect(rendered.html, kind).not.toMatch(/<script|<img|<link|<iframe|<[^>]*\bsrc=/i);
      expect(visibleText(rendered.html), kind).toContain(LINE);
      expect(linkProblems(rendered, kind), kind).toEqual([]);
      expect(subjectProblems(rendered.subject), kind).toEqual([]);
      expect(
        copyProblems([rendered.subject, rendered.preheader, rendered.text].join("\n")),
        kind,
      ).toEqual([]);
      expect(() => assertPayloadAllowed(payload, kind), kind).not.toThrow();
    }
    // A slug is an id's shape; anything that is not one is refused.
    expect(() =>
      assertPayloadAllowed({ ...stepsSentWebFixture(), clinicSlug: "<b>radiance</b>" }, "steps_sent"),
    ).toThrow(PayloadNotAllowedError);
    // The script on any origin but ours is refused, so no email can hand a
    // clinic a line that loads someone else's code.
    expect(() =>
      assertPayloadAllowed(
        { ...stepsSentWebFixture(), scriptUrl: "https://cdn.example.com/widget/v1.js" },
        "steps_sent",
      ),
    ).toThrow(PayloadNotAllowedError);
  });

  test("O10 tells the clinic its one step, that a chat on its site is real, and links to Settings for the web person", () => {
    const { subject, text } = ready();
    expect(subject).toBe("Website chat is ready: one step left");
    expect(text).toContain(
      "Website chat is ready for Radiance Med Spa's website. One step is left, and it's yours: paste this line once, just before </body>, on every page of your website. AYA is designed to start answering there once it's in.",
    );
    expect(text).toContain(WEB_CHAT_COUNTS_LINE);
    expect(text).toContain(
      `Open the line in Settings: ${ORIGIN}/c/radiance-med-spa/settings#website-line`,
    );
    expect(findLinks(text)).toEqual([
      `${ORIGIN}/widget/v1.js`,
      `${ORIGIN}/c/radiance-med-spa/settings#website-line`,
    ]);
  });

  test("O11 is the line with a two-sentence instruction, says who asked, and carries the stop link", () => {
    const { subject, text, html } = steps();
    expect(subject).toBe("Website chat line from Radiance Med Spa");
    expect(text).toContain(
      "Radiance Med Spa asked us to send you this line for its website. Paste it once, just before </body>, on every page of the site. AYA, the practice's AI assistant from healdesk, is designed to start answering chats there once it's in.",
    );
    for (const body of [text, visibleText(html)]) {
      expect(body).toContain(
        "You're receiving this because someone at Radiance Med Spa asked us to send it to this address.",
      );
      expect(body).toContain(`Stop these emails: ${stepsStopUrl(CLINIC_ID, STEPS_DELIVERY_ID)}`);
    }
  });

  test("the Meta channels have no step an email can carry: refused, never sent without it", () => {
    expect(() =>
      CHANNEL_READY_ENTRY.render(
        { channel: "meta" } as unknown as ReturnType<typeof channelReadyWebFixture>,
        contextFor("channel_ready"),
      ),
    ).toThrow(EmailCompositionError);
    expect(() =>
      STEPS_SENT_ENTRY.render(
        { channel: "meta" } as unknown as ReturnType<typeof stepsSentWebFixture>,
        contextFor("steps_sent"),
      ),
    ).toThrow(EmailCompositionError);
  });
});

describe("phone's steps in O11", () => {
  // The set-up promise describes the step, never the time (CLAUDE.md,
  // "Claims and copy"). Until 19 October 2026 O11's phone version said "It
  // takes a few minutes, from the practice's own phone."
  const phone = STEPS_SENT_ENTRY.fixture as Extract<StepsSentPayload, { channel: "voice" }>;
  const intro = (payload: StepsSentPayload) => {
    const { text } = STEPS_SENT_ENTRY.render(payload, contextFor("steps_sent"));
    const line = text.split("\n").find((l) => l.startsWith("Radiance Med Spa asked us"));
    expect(line).toBeDefined();
    return line!;
  };
  const LEAD =
    "Radiance Med Spa asked us to send you these steps. They forward the practice's main line to AYA, its AI assistant from healdesk, so the calls the front desk can't take are answered.";

  test("it says how the steps are done on each path they take, and never how long they take", () => {
    const cases: [StepsSentPayload, string][] = [
      // The carrier's codes, dialled from the line being forwarded.
      [
        phone,
        "It's done by following the steps below for the practice's kind of line, dialling each code from the main line itself.",
      ],
      [
        { ...phone, carrier: "verizon", phoneSystem: "unknown", routing: "after_hours_only" },
        "It's done by following the steps below for the practice's kind of line, dialling each code from the main line itself.",
      ],
      // A cloud phone system: a rule in its admin, whatever the carrier.
      [
        { ...phone, phoneSystem: "voip" },
        "It's done in the admin of the practice's phone system, as below.",
      ],
      // No codes for the carrier: the steps ask it.
      [{ ...phone, carrier: null }, "It's done by asking the practice's phone company, as below."],
      [
        { ...phone, carrier: "other", routing: "all_calls" },
        "It's done by asking the practice's phone company, as below.",
      ],
    ];
    for (const [payload, how] of cases) {
      const line = intro(payload);
      expect(line).toBe(`${LEAD} ${how}`);
      // The lead's "can't take" is about calls; the step's sentence follows it.
      expect(line.slice(LEAD.length)).not.toMatch(
        /\b(takes?|few|couple|minutes?|hours?|seconds?|quick(ly)?|\d+)\b/i,
      );
      expect(copyProblems(line)).toEqual([]);
    }
  });
});

describe("the welcome email (B1)", () => {
  const usd = (amount: number) => `$${amount.toLocaleString("en-US")}`;

  test("the monthly price either way: an annual plan's per month, with the year's total", () => {
    const plan = getPlan(WELCOME_ENTRY.fixture.planId)!;
    const monthly = WELCOME_ENTRY.render(WELCOME_ENTRY.fixture, contextFor("welcome"));
    expect(monthly.text).toContain(`Monthly price: ${usd(plan.monthlyUsd)}`);
    expect(monthly.text).toContain(`Monthly billing (${usd(plan.monthlyUsd)}) starts the day`);

    const annual = WELCOME_ENTRY.render(
      { ...WELCOME_ENTRY.fixture, interval: "year" },
      contextFor("welcome"),
    );
    expect(annual.text).toContain(
      `Price: ${usd(plan.annualMonthlyUsd)} a month, billed annually (${usd(annualTotalUsd(plan))} a year)`,
    );
    expect(annual.text).toContain("Billing: Annual");
    expect(annual.text).not.toContain("Monthly price");
  });

  test("the order names the package, its steps and the extra-100 prices, marked provisional", () => {
    const { text } = WELCOME_ENTRY.render(
      { ...WELCOME_ENTRY.fixture, planId: "voice-metachat-700-1500", channels: ["web", "meta", "voice"] },
      contextFor("welcome"),
    );
    expect(text).toContain("Package: AYA Voice + Meta Chat");
    expect(text).toContain("Included each month: 700 voice minutes and 1,500 chat conversations");
    expect(text).toContain(
      "Past the allowance: $104 for each started block of 100 extra voice minutes, and $78 for each started block of 100 extra chat conversations",
    );
    expect(text).toMatch(/provisional/);
    expect(text).not.toMatch(/\$1\.04|\$0\.78|per minute|per conversation/);

    const voice = WELCOME_ENTRY.render(
      { ...WELCOME_ENTRY.fixture, planId: "voice-300", channels: ["voice"] },
      contextFor("welcome"),
    ).text;
    expect(voice).toContain("Included each month: 300 voice minutes\n");
    expect(voice).toContain("Past the allowance: $104 for each started block of 100 extra voice minutes\n");
  });

  test("cancelling online is Billing's Auto-renew, and the signed agreement downloads from Billing", () => {
    const { text, html } = WELCOME_ENTRY.render(WELCOME_ENTRY.fixture, contextFor("welcome"));
    // Not a reply to this email: the portal's own switch (plan Part F6).
    expect(text).not.toMatch(/reply to this email and we'll cancel/i);
    expect(text).toContain(
      "To cancel online, turn off Auto-renew in Billing. Before your plan starts, that means it won't start, and nothing more is charged.",
    );
    expect(text).toContain(`Open Billing: ${WELCOME_ENTRY.fixture.billingUrl}`);
    expect(WELCOME_ENTRY.fixture.billingUrl).toMatch(/\/c\/[a-z0-9-]+\/billing#switches$/);
    // The agreement's download, beside the Terms (plan C4).
    expect(text).toContain(
      `Download your signed agreement (PDF): ${WELCOME_ENTRY.fixture.agreementUrl}`,
    );
    expect(WELCOME_ENTRY.fixture.agreementUrl).toMatch(/\/c\/[a-z0-9-]+\/billing\/agreement$/);
    expect(html).toContain(`href="${WELCOME_ENTRY.fixture.agreementUrl}"`);
    expect(html).toContain(`href="${WELCOME_ENTRY.fixture.billingUrl}"`);
  });

  test("Help: the voicemail line in the plan's words while one is set, and nothing while not", () => {
    const set = WELCOME_ENTRY.render(WELCOME_ENTRY.fixture, contextFor("welcome", "clients"));
    expect(set.text).toContain(
      "Or leave a message on (888) 555-0100: we reply the next business day. Please don't include client details.",
    );
    const unset = WELCOME_ENTRY.render(
      { ...WELCOME_ENTRY.fixture, helpPhoneE164: null, callUrl: null },
      contextFor("welcome"),
    );
    expect(unset.text).toContain("Questions? Reply to this email, or write to hello@healdesk.io.");
    expect(unset.text).not.toMatch(/leave a message|five-minute call|\/help\/call/);
  });
});

describe("after cancellation (E3 to E6)", () => {
  // Annex X5: E4 links to the read-only portal behind the sign-in and the
  // step-up, and never attaches the export; E5 says the same; E6 links
  // nowhere, since the portal holds nothing of the clinic's patients by then.
  test("E4 and E5 point at the export on Conversations, and never carry it", () => {
    for (const kind of ["export_ready", "export_reminder"] as const) {
      const entry = templateFor(kind)!;
      const { text, html } = entry.render(entry.fixture, contextFor(kind));
      expect(findLinks(text), kind).toEqual([`${ORIGIN}/c/radiance-med-spa/conversations#export`]);
      expect(html, kind).toContain(`href="${ORIGIN}/c/radiance-med-spa/conversations#export"`);
      expect(text, kind).toContain("It isn't attached to this email");
      expect(text, kind).toContain("confirm it's you with Face ID or your screen lock");
    }
  });

  test("E4's dates are E2's: the day to download by, and the day the data is gone at the latest", () => {
    const entry = templateFor("export_ready")!;
    const { text } = entry.render(entry.fixture, contextFor("export_ready"));
    expect(text).toContain("Download it by Friday 4 December.");
    expect(text).toContain(
      "We destroy our copies of your data within 30 days of your export being delivered, and by Thursday 4 February 2027 at the latest.",
    );
  });

  test("E6 says what was destroyed and when, what remains and why, and links nowhere", () => {
    const entry = templateFor("data_destroyed")!;
    const baa = entry.render(entry.fixture, contextFor("data_destroyed"));
    expect(findLinks(baa.text)).toEqual([]);
    expect(baa.text).toContain("On Saturday 5 December we destroyed the patient information");
    expect(baa.text).toContain("until Saturday 9 January 2027");
    expect(baa.text).toContain("Anthropic");
    expect(baa.text).toContain("The signed agreement, with any calendar terms you recorded under it, and our record of disclosures");
    expect(baa.text).toContain("Your billing history, as tax law requires.");
    // Exactly what went: the patient records and the credentials. The setup
    // is not among them (until 19 October it was said to be, while it was
    // kept for good); it goes when the account closes, and E6 says when.
    expect(baa.text).toContain(
      "with their conversations, booking requests, appointments and deposits, and the credentials you connected through healdesk.",
    );
    expect(baa.text).not.toMatch(/and your setup\./);
    expect(baa.text).toContain(
      "Your healdesk account closes after Sunday 6 December, once calls still forwarded to us have stopped passing through to your direct line. Then we end your sign-in and take your address off it, and delete your setup:",
    );
    expect(baa.text).toContain(
      "Your account's email address, for six years after your service ended, as the agreement's address for notices",
    );
    // And exactly what stays beyond the agreement and the billing.
    expect(baa.text).toContain(
      "What we must be able to show we did under the agreement and HIPAA: the notices we sent you and where, any security incident and its notice, the addresses you gave us for notices, and the log of how your data was handled and who could sign in, this destruction included.",
    );
    // Destroyed after the pass-through had ended: the account closed with it.
    const late = entry.render(
      { ...entry.fixture, accountClosesAt: entry.fixture.destroyedAt },
      contextFor("data_destroyed"),
    );
    expect(late.text).toContain(
      "Your healdesk account closes next. We end your sign-in and take your address off it, and delete your setup:",
    );
    expect(late.text).not.toContain("closes after");
    const dpa = entry.render(
      { ...entry.fixture, isDataProtectionAgreement: true },
      contextFor("data_destroyed", "clients"),
    );
    expect(dpa.text).toContain("we destroyed the client information");
    expect(dpa.text).not.toContain("record of disclosures");
    expect(dpa.text).not.toContain("HIPAA");
  });

  test("E3 prints the date, never 'tomorrow', and the undo codes for the clinic's carrier", () => {
    const entry = templateFor("pass_through_ending")!;
    for (const noticeDays of [7, 1] as const) {
      const { subject, text } = entry.render(
        { ...entry.fixture, noticeDays },
        contextFor("pass_through_ending"),
      );
      expect(subject).toBe("Calls stop passing through on 6 December");
      expect(text).not.toMatch(/tomorrow/i);
      // AT&T's undo is a step per kind of line, some with nothing to dial, so
      // it is steps to follow, each code dialled from the clinic's own line.
      expect(text).toContain("Follow these AT&T steps, dialling each code from the clinic's own line:");
      expect(text).toContain("- Cancel busy forwarding on AT&T Phone: *91#");
    }
  });
});

describe("ops alerts beyond the fixture", () => {
  // The registry's fixture is one event. An alert whose wording is an
  // instruction someone acts on once, unprompted, gets a snapshot of its own,
  // so a change to what it tells ops to do shows up in review.
  test("the DMARC review reminder: the snapshot", () => {
    expect(
      renderOpsAlert(
        { event: "dmarc_review_due", windowStart: "2026-10-06" },
        contextFor("ops_alert"),
      ),
    ).toMatchSnapshot();
  });

  // The destruction clock (lib/offboarding): a practice on the thirty days
  // with no export delivered, from day 21, and a subscription's end the
  // database could start only a week back. Ids, instants and a count.
  test("a leaving practice with no export delivered: the snapshot", () => {
    expect(
      renderOpsAlert(
        {
          event: "export_undelivered_before_destruction",
          clinicId: CLINIC_ID,
          destroyAt: "2026-11-30T10:00:00.000Z",
        },
        contextFor("ops_alert"),
      ),
    ).toMatchSnapshot();
  });

  // BAA 1.2.2 and 1.2.1 give the export "on request", but Terms §7 promises every
  // leaving practice one within thirty days of the end and the canceled email
  // tells it one is coming, so it has no reason to ask. The data goes at day
  // 29 whatever the export, so an alert telling ops to deliver only "any export
  // the practice asked for" let a practice that was told to expect one lose its
  // records for good.
  test("a leaving practice with no export delivered: ops is told to deliver it, asked for or not", () => {
    const { text, preheader } = renderOpsAlert(
      {
        event: "export_undelivered_before_destruction",
        clinicId: CLINIC_ID,
        destroyAt: "2026-11-30T10:00:00.000Z",
      },
      contextFor("ops_alert"),
    );
    // Since lane N4 the preheader is the urgency and the headline; the
    // instruction is in the email's text, and it is urgent.
    expect(preheader).toBe("URGENT: This clinic's export must be delivered before its data is destroyed on 30 Nov");
    expect(text).toContain("Deliver this practice's export");
    expect(text).toContain("whether or not it asks");
    expect(text).toContain("Terms §7");
    for (const body of [text, preheader]) expect(body).not.toMatch(/asked for/);
  });

  test("a subscription's end processed over a week late: the snapshot", () => {
    expect(
      renderOpsAlert(
        {
          event: "offboarding_started_late",
          clinicId: CLINIC_ID,
          serviceEndedAt: "2026-10-27T10:00:00.000Z",
          lateDays: 3,
        },
        contextFor("ops_alert"),
      ),
    ).toMatchSnapshot();
  });
});

describe("CAN-SPAM", () => {
  // No commercial or optional kind has a template yet, so the machinery is
  // proved on a composed email: what a commercial template will produce.
  const url = () => unsubscribeUrl(CLINIC_ID, "commercial");

  test("a commercial email carries the opt-out in its footer, both headers and the postal address", () => {
    const ctx: TemplateContext = { ...contextFor("ops_alert"), unsubscribeUrl: url() };
    const email = compose(
      {
        subject: "What changed in healdesk",
        preheader: "Two changes.",
        blocks: [{ type: "paragraph", text: "Two changes." }],
      },
      ctx,
    );
    expect(email.text).toContain(`Stop these emails: ${url()}`);
    expect(email.html).toContain(`href="${url()}"`);
    expect(email.text).toContain(SENDER_IDENTITY.postalAddress);
    expect(unsubscribeHeaders(url())).toEqual({
      "List-Unsubscribe": `<${url()}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  test("every commercial or optional kind is one the sender gives a stop link", () => {
    for (const kind of [...NOTICE_KINDS, ...DIRECT_KINDS]) {
      if (
        classOf(kind) === "commercial" ||
        NOTICE_KIND_REGISTRY[kind as keyof typeof NOTICE_KIND_REGISTRY]?.optionalSwitch
      ) {
        expect(carriesUnsubscribe(kind), kind).toBe(true);
      }
    }
    expect(carriesUnsubscribe("usage_80")).toBe(true);
    expect(carriesUnsubscribe("payment_failed")).toBe(false);
  });

  test("the stop link is signed: it names one clinic and one switch, and a forged one is refused", () => {
    const token = unsubscribeToken(CLINIC_ID, "usage_alerts");
    expect(readUnsubscribeToken(token)).toEqual({ clinicId: CLINIC_ID, scope: "usage_alerts" });
    const [payload] = token.split(".");
    const forged = `${Buffer.from(`${CLINIC_ID}:daily_summary`).toString("base64url")}.${token.split(".")[1]}`;
    expect(readUnsubscribeToken(forged)).toBeNull();
    expect(readUnsubscribeToken(`${payload}.AAAA`)).toBeNull();
    expect(readUnsubscribeToken("nonsense")).toBeNull();
  });
});

describe("the payload allowlist", () => {
  test("accepts what F0's billing payloads carry", () => {
    const ok: [EmailKind, Record<string, unknown>][] = [
      [
        "payment_failed",
        {
          amountDueCents: 89_700,
          hostedInvoiceUrl: "https://invoice.stripe.com/i/acct_1/test_x",
          graceEndsAt: "2026-10-12T00:00:00.000Z",
        },
      ],
      ["payment_action_required", { hostedInvoiceUrl: null }],
      [
        "usage_80",
        {
          meter: "voice_minutes",
          used: 400,
          included: 500,
          windowEndsOn: "2026-10-31",
          overageMode: "allow",
          blockRateCents: 10_400,
        },
      ],
      [
        "renewal_upcoming",
        {
          renewsOn: "2026-11-05",
          amountCents: 556_800,
          planName: "AYA Voice + Meta Chat, 500 minutes and 300 conversations",
        },
      ],
      ["plan_changed", { planName: "AYA Voice + Web Chat", interval: "month" }],
      ["plan_started", { planName: "AYA Voice, 1,500 minutes", boughtPlanId: "voice-1500" }],
      ["location_added", { locations: 2 }],
      ["canceled", { passThroughDays: 30 }],
      ["cancel_scheduled", { endsAt: "2026-11-05T00:00:00.000Z" }],
      ["restored", {}],
    ];
    for (const [kind, payload] of ok) {
      expect(() => assertPayloadAllowed(payload, kind), kind).not.toThrow();
    }
  });

  test("accepts the clinic's name, masked addresses, its own numbers, ids, flags and rows", () => {
    expect(() =>
      assertPayloadAllowed({
        clinicName: "Radiance Med Spa",
        addressMasked: "o***@radiance.test",
        directLineE164: "+15551234567",
        noticeIds: [CLINIC_ID],
        channels: ["web", "voice"],
        isAnnual: true,
        bookingRows: [{ channel: "voice", status: "waiting", count: 2 }],
        portalUrl: `${ORIGIN}/c/radiance/bookings`,
      }),
    ).not.toThrow();
  });

  const refused: [string, Record<string, unknown>][] = [
    ["an address", { email: "owner@radiance.test" }],
    ["free text", { note: "She asked about lip filler" }],
    ["an opening date", { publishedOpeningOn: "2026-11-01" }],
    ["F0's free-text window label", { windowLabel: "October 2026" }],
    ["a clinic name holding an address", { clinicName: "owner@radiance.test" }],
    ["a phone number outside an E164 field", { phone: "+15551234567" }],
    ["a sentence in a category", { kind: "lip filler appointment" }],
    ["a plan the catalog does not sell", { planName: "Botox membership" }],
    ["a plan name with a step off the grid", { planName: "AYA Voice, 550 minutes" }],
    ["a plan id from the seven packages of 5 October", { boughtPlanId: "web-voice" }],
    ["a URL to someone else's site", { hostedInvoiceUrl: "https://evil.example/invoice" }],
    ["an unmasked address in a masked field", { addressMasked: "owner@radiance.test" }],
    ["a time", { startsAt: "next Tuesday at 3" }],
    ["a nested object outside rows", { clinic: { name: "Radiance" } }],
  ];
  for (const [what, payload] of refused) {
    test(`refuses ${what}, naming the field and never its value`, () => {
      let caught: unknown;
      try {
        assertPayloadAllowed(payload, "payment_failed");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PayloadNotAllowedError);
      const message = (caught as Error).message;
      expect(message).toContain(Object.keys(payload)[0]!);
      for (const value of Object.values(payload)) {
        if (typeof value === "string") expect(message).not.toContain(value);
      }
    });
  }
});

describe("the link scanner", () => {
  test("finds links in text, in attributes and in CSS", () => {
    expect(
      findLinks(
        `See https://a.test/x and <a href="https://b.test/y">y</a> <div style="background:url('https://c.test/z')">`,
      ),
    ).toEqual(["https://a.test/x", "https://b.test/y", "https://c.test/z"]);
  });

  test("https only, outside development's own origin", () => {
    expect(linkProblem("http://elsewhere.test/x", "payment_failed")).toMatch(/https only/);
    expect(linkProblem("mailto:hello@healdesk.io", "payment_failed")).not.toBeNull();
    (process.env as Record<string, string>).NODE_ENV = "production";
    expect(linkProblem("http://app.healdesk.test/c/radiance", "payment_failed")).toMatch(
      /https only/,
    );
  });

  test("public origins only: ours and Stripe's hosted pages", () => {
    expect(linkProblem(`${ORIGIN}/c/radiance/billing`, "payment_failed")).toBeNull();
    expect(
      linkProblem("https://invoice.stripe.com/i/acct_1/test_YWNjdF8x", "payment_failed"),
    ).toBeNull();
    expect(linkProblem("https://evil.example/c/radiance", "payment_failed")).toMatch(
      /not a public origin/,
    );
  });

  test("never HEALDESK_APP_URL", () => {
    process.env.HEALDESK_APP_URL = "https://internal.healdesk.test";
    expect(linkProblem("https://internal.healdesk.test/api/ops", "payment_failed")).toMatch(
      /HEALDESK_APP_URL/,
    );
  });

  test("a single-use token only in a link email; a slug or an id is not a token", () => {
    expect(linkProblem(`${ORIGIN}/link/${TOKEN}`, "payment_failed")).toMatch(/not a link email/);
    expect(linkProblem(`${ORIGIN}/sign-in?token=${TOKEN}`, "payment_failed")).toMatch(
      /not a link email/,
    );
    expect(linkProblem(`${ORIGIN}/link/${TOKEN}`, "sign_in_link")).toBeNull();
    expect(
      linkProblem(`${ORIGIN}/c/radiance-med-spa-a1b2c3/settings`, "payment_failed"),
    ).toBeNull();
    expect(linkProblem(`${ORIGIN}/c/radiance/bookings/${CLINIC_ID}`, "payment_failed")).toBeNull();
  });

  test("a stop link only where there is something optional to stop", () => {
    const stop = unsubscribeUrl(CLINIC_ID, "usage_alerts");
    expect(linkProblem(stop, "usage_80")).toBeNull();
    expect(linkProblem(stop, "payment_failed")).toMatch(/neither optional nor commercial/);
  });

  test("reads the headers and the subject too", () => {
    const body = { subject: "Your invoice", text: "Hello", html: "<p>Hello</p>" };
    expect(
      linkProblems(
        { ...body, headers: { "List-Unsubscribe": "<https://evil.example/stop>" } },
        "usage_80",
      ),
    ).toEqual(["a link to https://evil.example, which is not a public origin of ours"]);
    expect(
      linkProblems({ ...body, subject: "See https://app.healdesk.test/x" }, "payment_failed"),
    ).toContain("a link in the subject");
  });
});

describe("the copy lint", () => {
  const refused: [string, string][] = [
    ["a newness word", "Thanks for joining our pilot."],
    ["a newness word", "You are one of our first clinics."],
    ["a newness word", "Welcome to the founding cohort."],
    ["revenue", "AYA recovered revenue for you."],
    ["HIPAA compliant", "healdesk is HIPAA compliant."],
    ["live in two minutes", "You can be live in two minutes."],
    ["with every clinic", "We sign a BAA with every clinic."],
    ["collected", "We collected $200 for you."],
    ["within one business day", "We'll reply within one business day."],
    ["an opening date", "Phone opens on Monday 12 October."],
    ["an opening date", "See the opening date on Home."],
    ["a treatment name", "2 Botox bookings today."],
    ["a treatment name", "Someone asked about lip filler."],
  ];
  for (const [why, text] of refused) {
    test(`refuses ${why}: "${text}"`, () => {
      expect(copyProblems(text).length).toBeGreaterThan(0);
    });
  }

  test("lets honest sentences through", () => {
    expect(copyProblems("3 deposits collected this week.")).toEqual([]);
    expect(copyProblems("We'll reply by Tuesday 7 October.")).toEqual([]);
    expect(copyProblems("Your daily summary arrives each Monday at 8:00.")).toEqual([]);
    expect(copyProblems("2 bookings and 1 request are waiting in Bookings.")).toEqual([]);
  });

  test("subjects: at most 70 characters, never a link", () => {
    expect(subjectProblems("x".repeat(MAX_SUBJECT_CHARS))).toEqual([]);
    expect(subjectProblems("x".repeat(MAX_SUBJECT_CHARS + 1))).toEqual([
      `over ${MAX_SUBJECT_CHARS} characters`,
    ]);
    expect(subjectProblems("Open https://app.healdesk.test now")).toEqual(["a link"]);
    expect(subjectProblems("Open www.healdesk.io now")).toEqual(["a link"]);
  });
});

describe("compose", () => {
  test("refuses a two-line subject, a missing reason and an HTML over 100 KB", () => {
    const ctx = contextFor("ops_alert");
    expect(() => compose({ subject: "a\nb", preheader: "p", blocks: [] }, ctx)).toThrow(
      EmailCompositionError,
    );
    expect(() =>
      compose({ subject: "a", preheader: "p", blocks: [] }, { ...ctx, reason: " " }),
    ).toThrow(EmailCompositionError);
    expect(() =>
      compose(
        {
          subject: "a",
          preheader: "p",
          blocks: [{ type: "paragraph", text: "x".repeat(MAX_HTML_BYTES) }],
        },
        ctx,
      ),
    ).toThrow(EmailCompositionError);
  });

  test("escapes everything it is given", () => {
    const email = compose(
      {
        subject: "a",
        preheader: "p",
        blocks: [{ type: "paragraph", text: '<script>alert("x")</script>' }],
      },
      { ...contextFor("ops_alert"), clinicName: "Radiance" },
    );
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
  });
});

describe("the kind rules", () => {
  test("critical kinds are the registry's, and no outbox kind is a link email", () => {
    expect([...CRITICAL_NOTICE_KINDS].sort()).toEqual(
      NOTICE_KINDS.filter((k) => NOTICE_KIND_REGISTRY[k].priority === "critical").sort(),
    );
    for (const kind of NOTICE_KINDS) expect(isLinkEmail(kind), kind).toBe(false);
    expect(isLinkEmail("sign_in_link")).toBe(true);
    // The calendar link carries a token; the election's copy never does.
    expect(isLinkEmail("calendar_link")).toBe(true);
    expect(isLinkEmail("calendar_election_recorded")).toBe(false);
    expect(linkProblem(`${ORIGIN}/calendar/${TOKEN}`, "calendar_election_recorded")).toMatch(
      /not a link email/,
    );
  });

  test("a bounce on a sign-in kind locks a clinic out; one on an ops alert does not", () => {
    expect(locksOutClinic("sign_in_link")).toBe(true);
    expect(locksOutClinic("sign_in_help_link")).toBe(true);
    // O16, the human route's link: a single-use token, and a clinic that
    // cannot receive it cannot open patient details at all.
    expect(isLinkEmail("device_recovery_link")).toBe(true);
    expect(locksOutClinic("device_recovery_link")).toBe(true);
    expect(locksOutClinic("order_confirmed_delayed")).toBe(true);
    expect(locksOutClinic("ops_alert")).toBe(false);
    expect(locksOutClinic("payment_failed")).toBe(false);
  });

  test("a vet's customers are clients; everyone else's are patients", () => {
    expect(audienceFor("veterinary")).toBe("clients");
    expect(audienceFor("med-spa")).toBe("patients");
    expect(audienceFor(null)).toBe("patients");
  });
});
