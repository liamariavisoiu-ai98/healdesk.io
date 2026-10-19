import { existsSync } from "node:fs";
import { join } from "node:path";

import { annualTotalUsd, getPlan, SENDER_IDENTITY } from "@healdesk/catalog";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

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
  MAX_HTML_BYTES,
  REPLY_LINE,
} from "@/lib/email/templates/compose";
import {
  ACCOUNT_REASON,
  audienceFor,
  clinicReason,
  OPS_REASON,
  ORDER_REASON,
  SIGN_IN_REASON,
} from "@/lib/email/templates/context";
import { alertFixture } from "@/lib/email/templates/booking-alert-copy";
import { DEPOSIT_DECLINED_FIXTURE } from "@/lib/email/templates/deposit_to_collect";
import { renderOpsAlert } from "@/lib/email/templates/ops_alert";
import { PENDING_TEMPLATES, TEMPLATES, templateFor } from "@/lib/email/templates/registry";
import { stepsReason } from "@/lib/email/templates/steps_sent";
import { renderUrgent } from "@/lib/email/templates/urgent";
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
      kind === "ops_alert" || kind === "sign_in_link" || kind === "device_changed"
        ? null
        : "Radiance Med Spa",
    audience,
    reason:
      kind === "ops_alert"
        ? OPS_REASON
        : kind === "sign_in_link"
          ? SIGN_IN_REASON
          : kind === "order_confirmed_delayed"
            ? ORDER_REASON
            : kind === "device_changed"
              ? ACCOUNT_REASON
              : kind === "steps_sent"
                ? stepsReason("Radiance Med Spa")
                : kind === "support_escalation"
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
      WP8: ["sign_in_help_link", "address_change_confirm", "address_changing"],
      F: ["request_still_open", "request_missed", "website_message"],
      WP4: ["daily_summary", "weekly_recap"],
      WP3: ["ai_paused"],
      runtime: ["outage_started", "outage_ended", "guarantee_miss"],
      WP9: ["agreement_to_sign"],
      WP11: ["website_changes"],
      WP7: [
        "terms_notice",
        "subprocessor_notice",
        "incident_report",
        "guarantee_claim_received",
        "guarantee_finding",
        "suspended_for_cause",
        "patient_request",
        "product_update",
      ],
      WP6: ["pass_through_ending", "export_ready", "export_reminder", "data_destroyed"],
      B: ["assistant_ready", "practice_questions_failed"],
      WP5: ["ops_digest", "flag_alert"],
    });
  });

  test("the templates shipped so far: I1, B2, B3, O3 and the billing kinds (the usage alerts among them since 13 October), then B1, O7, the setup closure, O13, O4, O10 and O11, the calendar's two, the support chat's L25 and I3, and the live alerts L7, L10, L11, L12 and L34", () => {
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
      "calendar_link",
      "calendar_election_recorded",
      "support_request",
      "support_escalation",
      "booking_request",
      "deposit_to_collect",
      "handover",
      "urgent",
      "calendar_check",
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
    ]);
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
          expect(body).toContain(REPLY_LINE);
          expect(body).toContain(SENDER_IDENTITY.entityLine);
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
    for (const body of [text, preheader]) {
      expect(body).toContain("Deliver this practice's export");
      expect(body).toContain("whether or not it asks");
      expect(body).toContain("Terms §7");
      expect(body).not.toMatch(/asked for/);
    }
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

describe("the live alerts: L7, L10, L11, L12 and L34", () => {
  const ALERTS = ["booking_request", "deposit_to_collect", "handover", "urgent", "calendar_check"] as const;

  test("every channel's wording keeps to the subject rules and the copy lint, and names nobody", () => {
    for (const kind of ALERTS) {
      const entry = templateFor(kind)!;
      for (const [channel, platform] of [
        ["voice", null],
        ["web", null],
        ["meta", null],
        ["meta", "instagram"],
        ["meta", "messenger"],
        ["meta", "whatsapp"],
        [null, null],
      ] as const) {
        for (const [conversationId, isBurst] of [
          ["5b0c8a1e-2f3d-4c5b-9a6e-7d8f9a0b1c2d", false],
          [null, false],
          [null, true],
        ] as const) {
          const payload = alertFixture({ channel, platform, conversationId, isBurst });
          expect(() => assertPayloadAllowed(payload, kind), kind).not.toThrow();
          const r = entry.render(payload, contextFor(kind));
          expect(subjectProblems(r.subject), `${kind} ${channel}`).toEqual([]);
          expect(copyProblems([r.subject, r.preheader, r.text, visibleText(r.html)].join("\n")), kind).toEqual([]);
          expect(linkProblems(r, kind), kind).toEqual([]);
          expect(r.text).toContain(payload.portalUrl);
          expect(r.text).not.toContain("/booking/");
          expect(r.text).toMatch(/carries no patient details on purpose/);
        }
      }
    }
  });

  test("where to find who it is follows what the alert points at, and only a call or a request says healdesk shows it", () => {
    const ctx = contextFor("urgent");
    const portal = /Who it is and how to reach them open in healdesk/;
    // A call: the caller's number came with it.
    expect(renderUrgent(alertFixture({ channel: "voice" }), ctx).text).toMatch(portal);
    // Instagram or Messenger with no request: no name or number to show, so the clinic's own inbox there.
    const instagram = renderUrgent(alertFixture({ channel: "meta", platform: "instagram" }), ctx);
    expect(instagram.text).not.toMatch(portal);
    expect(instagram.subject).toBe("Urgent: someone sent AYA an urgent message");
    expect(instagram.preheader).toBe("Please check on them now. Reply to them in your Instagram inbox.");
    expect(instagram.text).toContain("in an Instagram message to");
    expect(instagram.text).toContain("Reply to them in your Instagram inbox.");
    expect(instagram.text).toContain("this link stops opening");
    const messenger = renderUrgent(alertFixture({ channel: "meta", platform: "messenger" }), ctx);
    expect(messenger.preheader).toBe("Please check on them now. Reply to them in your Facebook Page's inbox.");
    expect(messenger.text).toContain("in a Messenger message to");
    // WhatsApp: the number is on the Cloud API alone, so there is no inbox,
    // and staff are never asked to do what they cannot.
    const whatsapp = renderUrgent(alertFixture({ channel: "meta", platform: "whatsapp" }), ctx);
    expect(whatsapp.text).not.toMatch(portal);
    expect(whatsapp.text).toContain("in a WhatsApp message to");
    expect(whatsapp.preheader).toBe("They may call you. There is no WhatsApp inbox to reply to them from.");
    expect(whatsapp.text).toContain("There is no WhatsApp inbox to reply to them from: AYA alone answers your WhatsApp number.");
    for (const r of [whatsapp]) {
      expect(r.text).not.toMatch(/reply to them in|check on them|inbox\.|get back to them/i);
    }
    // A payload that names no platform says only what holds on all three.
    const unnamed = renderUrgent(alertFixture({ channel: "meta" }), ctx);
    expect(unnamed.text).toContain("If they wrote on Instagram or Messenger, reply to them in that inbox; a WhatsApp message has no inbox to reply from.");
    // No Meta alert anywhere tells staff to reply in a WhatsApp inbox.
    for (const kind of ALERTS) {
      for (const platform of [null, "instagram", "messenger", "whatsapp"] as const) {
        const r = templateFor(kind)!.render(alertFixture({ channel: "meta", platform }), contextFor(kind));
        expect(r.text, `${kind} ${platform}`).not.toMatch(/WhatsApp inbox(?! to reply)/);
      }
    }
    // A website chat with no request: only what the visitor left, and the transcript.
    const web = renderUrgent(alertFixture({ channel: "web" }), ctx);
    expect(web.text).not.toMatch(portal);
    expect(web.text).toContain("If they left a name and number, they open in healdesk");
    expect(web.text).toContain("The chat's transcript, emailed to you when the chat ends, has everything they wrote.");
    // A request from any of them: its name and number are in healdesk.
    const request = { bookingRequestId: "8c2d4e6f-1a3b-4c5d-8e9f-0a1b2c3d4e5f" };
    for (const [channel, platform] of [["web", null], ["meta", "messenger"], ["meta", "whatsapp"]] as const) {
      const r = templateFor("booking_request")!.render(alertFixture({ channel, platform, ...request }), contextFor("booking_request"));
      expect(r.text, channel).toMatch(portal);
      expect(r.preheader).toBe("Someone asked to book. Open healdesk to see who, and when suits them.");
    }
    // A handover on Instagram or Messenger: answer them in that inbox.
    const handover = templateFor("handover")!.render(alertFixture({ channel: "meta", platform: "instagram" }), contextFor("handover"));
    expect(handover.preheader).toBe("Reply to them in your Instagram inbox.");
  });

  test("a handover says only what is always true: never what AYA told them, except on WhatsApp, where the reply is fixed", () => {
    const render = templateFor("handover")!.render;
    for (const [channel, platform] of [["voice", null], ["web", null], ["meta", "instagram"], ["meta", "messenger"], ["meta", null]] as const) {
      const r = render(alertFixture({ channel, platform }), contextFor("handover"));
      // The model's words when the guard passes them, a fixed line when it
      // does not: the email cannot know which, so it says neither.
      expect(r.text, `${channel} ${platform}`).not.toMatch(/AYA (told|tells|answers|asked)|get back to them\./);
      expect(r.text).toMatch(/^Someone asked to speak to a person /m);
    }
    // WhatsApp: answerFrontDoor always sends the fixed line asking them to call.
    const whatsapp = render(alertFixture({ channel: "meta", platform: "whatsapp" }), contextFor("handover"));
    expect(whatsapp.text).toContain("Someone asked to speak to a person in a WhatsApp message to");
    expect(whatsapp.text).toContain("AYA answers a request for a person on WhatsApp by asking them to call your practice.");
    expect(whatsapp.text).toContain("There is no WhatsApp inbox to reply to them from");
    expect(whatsapp.preheader).toBe("There is no WhatsApp inbox to reply to them from.");
    expect(whatsapp.text).not.toMatch(/reply to them in|get back to them/i);
  });

  test("past the hour's cap on handovers, one email says more asked and opens Conversations; an urgent alert has no such email", () => {
    const burst = alertFixture({ channel: "web", conversationId: null, isBurst: true });
    const handover = templateFor("handover")!.render(burst, contextFor("handover"));
    expect(handover.subject).toBe("More people asked to speak to a person this hour");
    expect(handover.text).toContain("in the last hour than healdesk emails one by one");
    expect(handover.text).toContain("Each one opens in Conversations once you sign in and confirm it's you, marked as a request for a person.");
    expect(handover.preheader).toBe("Open Conversations in healdesk to see each one.");
    expect(handover.text).not.toMatch(/AYA told/);
    expect(() => assertPayloadAllowed(burst, "handover")).not.toThrow();
    // Each urgent conversation is its own email: no subject or body speaks of more.
    for (const channel of ["voice", "web", "meta", null] as const) {
      const urgent = renderUrgent(alertFixture({ channel }), contextFor("urgent"));
      expect(urgent.subject, `${channel}`).not.toMatch(/more|this hour/i);
      expect(urgent.text).not.toContain("one by one");
    }
  });

  test("a call still going on says it shows in Conversations once it ends", () => {
    const going = renderUrgent(alertFixture({ channel: "voice", conversationId: null }), contextFor("urgent"));
    expect(going.text).toContain("The call shows in Conversations once it ends.");
    const ended = renderUrgent(alertFixture({ channel: "voice" }), contextFor("urgent"));
    expect(ended.text).not.toContain("once it ends");
  });

  test("a deposit: booked and left to the team, possibly paid already, or not booked for want of one", () => {
    const render = templateFor("deposit_to_collect")!.render;
    const booked = render(alertFixture({ appointmentId: CLINIC_ID }), contextFor("deposit_to_collect"));
    expect(booked.text).toContain("left the deposit for your team to collect");
    expect(booked.text).not.toContain("Stripe");
    const maybePaid = render(alertFixture({ appointmentId: CLINIC_ID, isPossiblyPaid: true }), contextFor("deposit_to_collect"));
    expect(maybePaid.text).toContain("Check the payment in your Stripe account before you ask for it again.");
    const declined = render(DEPOSIT_DECLINED_FIXTURE(), contextFor("deposit_to_collect", "clients"));
    expect(declined.text).toContain("AYA did not book an appointment on a call to");
    expect(declined.text).toContain("carries no client details");
    for (const r of [booked, maybePaid, declined]) {
      expect(copyProblems([r.subject, r.preheader, r.text].join("\n"))).toEqual([]);
    }
  });

  const refused: [string, Record<string, unknown>][] = [
    ["Package D's own name for the flag", { mayBePaid: true }],
    ["the website chat's database name", { channel: "web_chat" }],
    ["a caller's number", { phone: "+15551234567" }],
    ["a caller's name", { firstName: "Dana" }],
    ["the time they asked for", { preferredWindow: "Thursday afternoon" }],
    ["a treatment", { service: "lip filler" }],
    ["what they said", { text: "my lips are swelling" }],
    ["a sentence where the platform goes", { platform: "my lips are swelling" }],
  ];
  for (const [what, extra] of refused) {
    test(`the payload allowlist refuses ${what}, for good, at send time`, () => {
      expect(() => assertPayloadAllowed({ ...alertFixture(), ...extra }, "urgent")).toThrow(PayloadNotAllowedError);
    });
  }

  test("the link opens the portal on the public origin: never a desk token, never HEALDESK_APP_URL", () => {
    expect(linkProblem(alertFixture().portalUrl, "booking_request")).toBeNull();
    expect(linkProblem(`${ORIGIN}/booking/${TOKEN}`, "booking_request")).toMatch(/not a link email/);
    process.env.HEALDESK_APP_URL = "https://internal.healdesk.test";
    expect(() =>
      assertPayloadAllowed(
        { ...alertFixture(), portalUrl: "https://internal.healdesk.test/c/radiance-med-spa/conversations" },
        "urgent",
      ),
    ).toThrow(PayloadNotAllowedError);
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
