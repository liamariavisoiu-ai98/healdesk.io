import {
  BAA_TEMPLATES,
  DPA_TEMPLATES,
  DPA_VERSION_PREFIX,
  GUARANTEE_FAILURES,
  INCIDENT_INFORMATION_TYPES,
  INCIDENT_MITIGATIONS,
  INCIDENT_REPORT_EVENTS,
  PHI_SUBCONTRACTORS,
  PRODUCT_UPDATES,
  SUSPENSION_CAUSES,
  TERMS_CHANGE_TOPICS,
} from "@healdesk/catalog";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { carriesUnsubscribe, isCriticalNotice, optionalSwitchOf } from "@/lib/email/kind-rules";
import {
  assertPayloadAllowed,
  copyProblems,
  findLinks,
  linkProblems,
  PayloadNotAllowedError,
  visibleText,
} from "@/lib/email/lint";
import { EmailCompositionError } from "@/lib/email/templates/compose";
import { clinicReason } from "@/lib/email/templates/context";
import {
  GUARANTEE_CLAIM_RECEIVED_ENTRY,
  GUARANTEE_FINDING_ENTRY,
  renderGuaranteeFinding,
} from "@/lib/email/templates/guarantee_claim";
import { INCIDENT_REPORT_ENTRY, renderIncidentReport } from "@/lib/email/templates/incident_report";
import { PRODUCT_UPDATE_ENTRY } from "@/lib/email/templates/product_update";
import {
  renderSubprocessorNotice,
  SUBPROCESSOR_NOTICE_ENTRY,
} from "@/lib/email/templates/subprocessor_notice";
import { SUSPENDED_FOR_CAUSE_ENTRY } from "@/lib/email/templates/suspended_for_cause";
import { renderTermsNotice, TERMS_NOTICE_ENTRY } from "@/lib/email/templates/terms_notice";
import type { RenderedEmail, TemplateContext } from "@/lib/email/templates/types";
import {
  agreementReportDeadline,
  REPORTING_RULES,
  reportingRuleFor,
  SUBCONTRACTOR_NOTICE_RULES,
  subcontractorNoticeRuleFor,
} from "@/lib/incidents/reporting-rules";

/**
 * The operator's notices (WP7; Annex X5, L28 to L31 and L33), as pure
 * functions: what each email says, and what it must never say. The owner's
 * decisions of 12 October 2026 are held here: no email states a reporting
 * deadline of "24 hours" or "five days" (the agreements promise "without
 * unreasonable delay and in no case later than 60 calendar days", and 24
 * hours is an internal target); the subcontractor notice never links to a
 * vendor list, which is given on written request; and nothing makes an
 * absolute promise about Meta. The snapshots, the link scanner, the copy lint
 * and the footer are email-templates.test.ts's, over every template.
 */

const ORIGIN = "https://app.healdesk.test";
const SAVED: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ["BETTER_AUTH_URL", "HEALDESK_APP_URL"]) SAVED[key] = process.env[key];
  process.env.BETTER_AUTH_URL = ORIGIN;
  delete process.env.HEALDESK_APP_URL;
});

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const CTX: TemplateContext = {
  clinicName: "Radiance Med Spa",
  audience: "patients",
  reason: clinicReason("Radiance Med Spa"),
  raisedAt: new Date("2026-10-14T15:00:00Z"),
  timeZone: "America/New_York",
};

function all(r: RenderedEmail): string {
  return [r.subject, r.preheader, r.text, visibleText(r.html)].join("\n");
}

/** A reporting promise the owner ruled out (12 October 2026). */
const DEADLINE_PROMISE =
  /\b(24|twenty-four)[ -]hours?\b|\bfive (calendar |business )?days\b|\b60 (calendar )?days\b|\bwithin (a|one) day\b/i;

/** An absolute promise about Meta the BAA's softened clause 16 no longer makes. */
const ABSOLUTE_META =
  /never names a treatment|is not stored|isn't stored|are not stored|never stores|never kept/i;

describe("the incident report (L29)", () => {
  const base = INCIDENT_REPORT_ENTRY.fixture;

  test("is built from the fixed fields: what happened, both dates, each type with its count, what was done, and a contact", () => {
    const text = all(renderIncidentReport(base, CTX));
    expect(text).toContain(INCIDENT_REPORT_EVENTS.misdirected_email.sentence);
    expect(text).toContain("When it happened: Sunday 4 October");
    expect(text).toContain("When we discovered it: Monday 5 October");
    expect(text).toContain("3 first names");
    expect(text).toContain("3 phone numbers");
    expect(text).toContain("1 conversation transcript");
    expect(text).toContain(INCIDENT_MITIGATIONS.recipient_confirmed_deletion);
    expect(text).toContain(
      "Your contact at healdesk: reply to this email, or write to hello@healdesk.io.",
    );
  });

  test("never names anyone: for a breach it says the list of people comes separately, by secure transfer", () => {
    const breach = all(renderIncidentReport(base, CTX));
    expect(breach).toContain("This email names no one.");
    expect(breach).toContain("separately, by secure transfer");
    const incident = all(renderIncidentReport({ ...base, kind: "security_incident" }, CTX));
    expect(incident).not.toContain("secure transfer");
  });

  test("a breach's report since the incident's page points there for the list, behind the passkey, and names no one", () => {
    const listUrl = `${ORIGIN}/c/radiance/incidents/5c0ffee0-1111-4c2a-9a8b-1f2e3d4c5b6a`;
    const email = renderIncidentReport({ ...base, listUrl }, CTX);
    const text = all(email);
    expect(text).toContain("This email names no one.");
    expect(text).toContain(
      "The identification of each patient affected is on this incident's page in healdesk, behind your passkey",
    );
    expect(text).toContain("it's never emailed");
    expect(text).toContain(`See who was affected: ${listUrl}`);
    expect(text).not.toContain("secure transfer");
    expect(linkProblems(email, "incident_report")).toEqual([]);
    expect(() => assertPayloadAllowed({ ...base, listUrl }, "incident_report")).not.toThrow();
    // A vet's clients, in its own word; and no other class carries the link.
    expect(all(renderIncidentReport({ ...base, listUrl }, { ...CTX, audience: "clients" }))).toContain(
      "each client affected",
    );
    expect(all(renderIncidentReport({ ...base, kind: "security_incident", listUrl }, CTX))).not.toContain(
      "See who was affected",
    );
    expect(email).toMatchSnapshot();
  });

  test("states no deadline, so no reporting promise of 24 hours or five days can reach a practice", () => {
    for (const kind of ["breach", "security_incident", "improper_use_or_disclosure"] as const) {
      for (const isUpdate of [false, true]) {
        expect(all(renderIncidentReport({ ...base, kind, isUpdate }, CTX))).not.toMatch(
          DEADLINE_PROMISE,
        );
      }
    }
  });

  test("an update says so in its subject; an unknown date and empty lists say what follows", () => {
    const update = renderIncidentReport(
      { ...base, isUpdate: true, occurredOn: null, infoRows: [], mitigationRows: [] },
      CTX,
    );
    expect(update.subject).toBe("Update: healdesk incident report: a breach");
    const text = all(update);
    expect(text).toContain("When it happened: Not yet known. We'll tell you in an update.");
    expect(text).toContain("We're still establishing what information was involved");
    expect(text).toContain("We'll tell you what we've done about it in an update.");
  });

  test("a code the catalog doesn't list is refused, not printed", () => {
    expect(() =>
      renderIncidentReport({ ...base, event: "a caller's name went out" as never }, CTX),
    ).toThrow(EmailCompositionError);
    expect(() =>
      renderIncidentReport({ ...base, infoRows: [{ type: "diagnosis" as never, count: 1 }] }, CTX),
    ).toThrow(EmailCompositionError);
  });

  test("the payload allowlist refuses any prose an operator might add", () => {
    const withProse = { ...base, summary: "Sent the transcript for +1 555 010 0123" } as unknown;
    expect(() => assertPayloadAllowed(withProse, "incident_report")).toThrow(
      PayloadNotAllowedError,
    );
    const withNames = {
      ...base,
      infoRows: [{ type: "first_name", count: 1, value: "Jane" }],
    } as unknown;
    expect(() => assertPayloadAllowed(withNames, "incident_report")).toThrow(
      PayloadNotAllowedError,
    );
    expect(() => assertPayloadAllowed(base, "incident_report")).not.toThrow();
  });

  test("is critical, and has no switch and no stop link", () => {
    expect(isCriticalNotice("incident_report")).toBe(true);
    expect(optionalSwitchOf("incident_report")).toBeNull();
    expect(carriesUnsubscribe("incident_report")).toBe(false);
  });
});

describe("the subcontractor notice (L29)", () => {
  test("names the subcontractor, what it will receive and why, and when it starts", () => {
    for (const [provider, sub] of Object.entries(PHI_SUBCONTRACTORS)) {
      const r = renderSubprocessorNotice(
        { provider: provider as keyof typeof PHI_SUBCONTRACTORS, startsAt: "2026-10-16T15:00:00Z" },
        CTX,
      );
      const text = all(r);
      expect(r.subject).toBe(`Notice of a new healdesk subcontractor: ${sub.name}`);
      expect(text).toContain(`What it will receive: ${sub.receives}`);
      expect(text).toContain(`Why: ${sub.why}`);
      expect(text).toContain("From: 11 am EDT on Friday 16 October");
      expect(text).toContain("You may then end your agreement without penalty");
    }
  });

  test("never links to a vendor list: the list is given on written request, and the email carries no link at all", () => {
    const r = SUBPROCESSOR_NOTICE_ENTRY.render(SUBPROCESSOR_NOTICE_ENTRY.fixture, CTX);
    expect(findLinks([r.text, r.html].join("\n"))).toEqual([]);
    expect(all(r)).not.toMatch(/subprocessors|healdesk\.io\//i);
    expect(all(r)).toContain("Our current list of subcontractors is yours on written request");
  });

  test("states the start, never a notice period", () => {
    expect(
      all(SUBPROCESSOR_NOTICE_ENTRY.render(SUBPROCESSOR_NOTICE_ENTRY.fixture, CTX)),
    ).not.toMatch(DEADLINE_PROMISE);
  });

  test("is critical once sent", () => {
    expect(isCriticalNotice("subprocessor_notice")).toBe(true);
    expect(carriesUnsubscribe("subprocessor_notice")).toBe(false);
  });
});

describe("the terms notice (L28)", () => {
  test("names the version, the day it applies from and what it changes, and links only to Billing", () => {
    const r = TERMS_NOTICE_ENTRY.render(TERMS_NOTICE_ENTRY.fixture, CTX);
    const text = all(r);
    expect(r.subject).toBe("healdesk's terms are changing on 20 November");
    expect(text).toContain(
      "The new version, 2026-11-20.1, applies to Radiance Med Spa from your first renewal on or after Friday 20 November.",
    );
    expect(text).toContain(`- ${TERMS_CHANGE_TOPICS.fees}`);
    expect(text).toContain(`- ${TERMS_CHANGE_TOPICS.refunds}`);
    expect(text).toContain("turn Auto-renew off in Billing before that renewal");
    expect(findLinks(r.text)).toEqual([`${ORIGIN}/c/radiance-med-spa/billing`]);
    expect(linkProblems(r, "terms_notice")).toEqual([]);
  });

  test("is mandatory: no switch and no stop link", () => {
    expect(optionalSwitchOf("terms_notice")).toBeNull();
    expect(carriesUnsubscribe("terms_notice")).toBe(false);
    expect(TERMS_NOTICE_ENTRY.render(TERMS_NOTICE_ENTRY.fixture, CTX).text).not.toContain(
      "Stop these emails",
    );
  });

  test("names at least one change, from the catalog's list", () => {
    expect(() => renderTermsNotice({ ...TERMS_NOTICE_ENTRY.fixture, topicRows: [] }, CTX)).toThrow(
      EmailCompositionError,
    );
    expect(() =>
      renderTermsNotice(
        { ...TERMS_NOTICE_ENTRY.fixture, topicRows: [{ code: "everything" as never }] },
        CTX,
      ),
    ).toThrow(EmailCompositionError);
  });
});

describe("the guarantee's two emails (L30)", () => {
  test("the claim received gives the day of our finding", () => {
    const r = GUARANTEE_CLAIM_RECEIVED_ENTRY.render(GUARANTEE_CLAIM_RECEIVED_ENTRY.fixture, CTX);
    expect(all(r)).toContain("We'll tell you our finding by Thursday 26 November.");
  });

  test("a miss gives the result, the refund date and what failed; no miss gives neither", () => {
    const miss = all(GUARANTEE_FINDING_ENTRY.render(GUARANTEE_FINDING_ENTRY.fixture, CTX));
    expect(miss).toContain(
      "We found a call or message that was routed to AYA and wasn't answered.",
    );
    expect(miss).toContain(`What failed: ${GUARANTEE_FAILURES.telephony_and_speech}`);
    expect(miss).toContain("Refunded by: Thursday 3 December");
    const none = all(
      renderGuaranteeFinding(
        { claimReceivedOn: "2026-11-12", outcome: "no_miss_found", refundByOn: null, code: null },
        CTX,
      ),
    );
    expect(none).toContain("so no refund is due under the guarantee");
    expect(none).not.toContain("What failed");
  });

  test("a miss without its refund date or what failed is refused", () => {
    expect(() =>
      renderGuaranteeFinding({ ...GUARANTEE_FINDING_ENTRY.fixture, refundByOn: null }, CTX),
    ).toThrow(EmailCompositionError);
    expect(() =>
      renderGuaranteeFinding({ ...GUARANTEE_FINDING_ENTRY.fixture, code: null }, CTX),
    ).toThrow(EmailCompositionError);
  });
});

describe("the suspension for a legal or security reason (L31)", () => {
  test("says why, from the catalog, and never that paying restores it", () => {
    for (const [code, cause] of Object.entries(SUSPENSION_CAUSES)) {
      const text = all(
        SUSPENDED_FOR_CAUSE_ENTRY.render(
          { code: code as keyof typeof SUSPENSION_CAUSES, suspendedAt: "2026-10-14T16:20:00Z" },
          CTX,
        ),
      );
      expect(text).toContain(`Why: ${cause.sentence}`);
      expect(text).toContain("Paying an invoice doesn't lift this suspension.");
      expect(text).not.toMatch(/pay(ing)? .* restores/i);
    }
    expect(isCriticalNotice("suspended_for_cause")).toBe(true);
  });
});

describe("product updates (L33)", () => {
  test("are optional, behind the product-updates switch, with the one-click stop link", () => {
    expect(optionalSwitchOf("product_update")).toBe("product_updates");
    expect(carriesUnsubscribe("product_update")).toBe(true);
    const r = PRODUCT_UPDATE_ENTRY.render(PRODUCT_UPDATE_ENTRY.fixture, {
      ...CTX,
      unsubscribeUrl: `${ORIGIN}/email/stop/abc`,
    });
    expect(r.text).toContain(`Stop these emails: ${ORIGIN}/email/stop/abc`);
  });

  test("are transactional, never promotional", () => {
    for (const update of Object.values(PRODUCT_UPDATES)) {
      const text = [update.label, update.subject, ...update.paragraphs].join("\n");
      expect(text).not.toMatch(/\b(upgrade|offer|discount|% off|limited time|sale|buy|deal)\b/i);
    }
  });
});

describe("every word an operator notice can carry", () => {
  const copy = [
    ...Object.values(INCIDENT_REPORT_EVENTS).flatMap((e) => [e.label, e.sentence]),
    ...Object.values(INCIDENT_INFORMATION_TYPES).flatMap((t) => [t.one, t.many]),
    ...Object.values(INCIDENT_MITIGATIONS),
    ...Object.values(PHI_SUBCONTRACTORS).flatMap((s) => [s.name, s.receives, s.why]),
    ...Object.values(TERMS_CHANGE_TOPICS),
    ...Object.values(SUSPENSION_CAUSES).flatMap((c) => [c.label, c.sentence]),
    ...Object.values(GUARANTEE_FAILURES),
    ...Object.values(PRODUCT_UPDATES).flatMap((u) => [
      u.label,
      u.subject,
      ...u.paragraphs,
      u.action.label,
    ]),
  ];

  test("passes the copy lint", () => {
    for (const line of copy) expect(copyProblems(line), line).toEqual([]);
  });

  test("makes no reporting promise and no absolute promise about Meta", () => {
    for (const line of copy) {
      expect(line, line).not.toMatch(DEADLINE_PROMISE);
      expect(line, line).not.toMatch(ABSOLUTE_META);
    }
  });

  test("is about the people who contacted the practice, never a named patient or service", () => {
    for (const line of copy)
      expect(line, line).not.toMatch(/\bpatient's name\b|\btreatment name\b/i);
  });
});

describe("what each agreement promises (lib/incidents/reporting-rules.ts)", () => {
  test("every agreement version in the catalog has both rules, and the maps name nothing else", () => {
    for (const template of [...BAA_TEMPLATES, ...DPA_TEMPLATES]) {
      expect(reportingRuleFor(template.version).basis, template.version).toBe("agreement");
      expect(subcontractorNoticeRuleFor(template.version).basis, template.version).toBe(
        "agreement",
      );
    }
    const catalog = new Set([...BAA_TEMPLATES, ...DPA_TEMPLATES].map((t) => t.version));
    for (const map of [REPORTING_RULES, SUBCONTRACTOR_NOTICE_RULES]) {
      for (const [kind, rules] of Object.entries(map)) {
        for (const bare of Object.keys(rules)) {
          expect(catalog.has(kind === "dpa" ? `${DPA_VERSION_PREFIX}${bare}` : bare), bare).toBe(
            true,
          );
        }
      }
    }
  });

  test("60 calendar days from 1.2.2 on and in the DPA; five days before; the strictest without one", () => {
    const discovered = new Date("2026-10-09T15:00:00Z"); // a Friday
    const day = (d: Date | null) => d?.toISOString().slice(0, 10);
    for (const version of ["1.5.0", "1.4.0", "1.3.0", "1.2.2", `${DPA_VERSION_PREFIX}1.0.0`]) {
      for (const cls of ["breach", "security_incident", "improper_use_or_disclosure"]) {
        expect(day(agreementReportDeadline(cls, discovered, version).notifyBy), version).toBe(
          "2026-12-08",
        );
      }
    }
    for (const version of ["1.2.1", null, "9.9.9"]) {
      expect(day(agreementReportDeadline("breach", discovered, version).notifyBy)).toBe(
        "2026-10-14",
      );
      // Five business days from a Friday: the next Friday.
      expect(day(agreementReportDeadline("security_incident", discovered, version).notifyBy)).toBe(
        "2026-10-16",
      );
    }
    expect(reportingRuleFor(null).basis).toBe("no_agreement");
    expect(reportingRuleFor("9.9.9").basis).toBe("unknown_version");
    expect(agreementReportDeadline("service_complaint", discovered, "1.5.0").notifyBy).toBeNull();
  });

  test("24 hours' subcontractor notice from 1.3.0 on and in the DPA; fifteen days before, and without one", () => {
    for (const version of ["1.5.0", "1.4.0", "1.3.0", `${DPA_VERSION_PREFIX}1.0.0`]) {
      expect(subcontractorNoticeRuleFor(version).rule, version).toBe("twenty_four_hours");
    }
    for (const version of ["1.2.2", "1.2.1", "1.0.0", null, "9.9.9"]) {
      expect(subcontractorNoticeRuleFor(version).rule, String(version)).toBe("fifteen_days");
    }
  });
});
