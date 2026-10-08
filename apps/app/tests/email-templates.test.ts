import { existsSync } from "node:fs";
import { join } from "node:path";

import { SENDER_IDENTITY } from "@healdesk/catalog";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { DIRECT_KIND_REGISTRY, DIRECT_KINDS } from "@/lib/email/direct-kinds";
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
import { renderOpsAlert } from "@/lib/email/templates/ops_alert";
import { PENDING_TEMPLATES, TEMPLATES, templateFor } from "@/lib/email/templates/registry";
import type { EmailAudience, TemplateContext } from "@/lib/email/templates/types";
import {
  readUnsubscribeToken,
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
const ENV = ["BETTER_AUTH_URL", "HEALDESK_APP_URL", "NODE_ENV"] as const;

beforeEach(() => {
  for (const key of ENV) SAVED[key] = process.env[key];
  process.env.BETTER_AUTH_URL = ORIGIN;
  delete process.env.HEALDESK_APP_URL;
});

afterEach(() => {
  for (const key of ENV) {
    const value = SAVED[key];
    if (value === undefined) delete (process.env as Record<string, string | undefined>)[key];
    else (process.env as Record<string, string>)[key] = value;
  }
});

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
              : clinicReason("Radiance Med Spa"),
    ...(scope ? { unsubscribeUrl: unsubscribeUrl(CLINIC_ID, scope) } : {}),
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

  test("the templates shipped so far: I1, B2, B3, O3, the billing kinds and the calendar's two", () => {
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
      "calendar_link",
      "calendar_election_recorded",
    ]);
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
          blockRateCents: 8_000,
        },
      ],
      [
        "renewal_upcoming",
        { renewsOn: "2026-11-05", amountCents: 1_200_00, planName: "Complete FrontDesk AI" },
      ],
      ["plan_changed", { planName: "Web + Voice", interval: "month" }],
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
