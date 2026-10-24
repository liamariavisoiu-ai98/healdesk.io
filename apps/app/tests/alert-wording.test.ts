import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { subjectProblems } from "@/lib/email/lint";
import { OPS_REASON } from "@/lib/email/templates/context";
import { renderOpsAlert } from "@/lib/email/templates/ops_alert";
import { ALERT_WORDING, alertWording, LEGACY_WORDING, SECTIONS } from "@/lib/ops/alert-wording";
import { isPlaceholderAllowed, printableBusinessName, wordingValues } from "@/lib/ops/alert-wording/allow-list";
import { EVENT_FIELDS } from "@/lib/ops/alert-wording/fields";
import {
  FALLBACKS,
  fill,
  fillWording,
  formatDay,
  placeholdersOf,
  plural,
  requiredPlaceholdersOf,
} from "@/lib/ops/alert-wording/render";
import { ACCOUNT, BILLING, DELIVERIES, issueTabFor, NO_CLINIC_PAGE, SETUP } from "@/lib/ops/alert-wording/tabs";
import { OPS_EVENTS, opsConsoleLink, opsConsolePath, type OpsEvent } from "@/lib/ops/notify";
import { packSections, SLACK_SECTION_MAX, slackPayload, slackText } from "@/lib/ops/slack";

/**
 * Plain-English ops alerts (lane N1; owner, 23 October 2026): every alert
 * says what happened, to whom, why it matters and numbered steps naming the
 * console page or button to use, in short sentences with no code words; the
 * email and Slack print the same sentences from one substitution; and the
 * console link is the one issue shape apps/web reads.
 *
 * The wording rules apply to every event not in LEGACY_WORDING, the ones
 * still in their old one-paragraph wording until lane N2 rewrites them.
 * Places a step may name are checked against apps/web's source, so a step
 * cannot send an operator to a button that does not exist.
 */

const WEB = join(__dirname, "..", "..", "web", "src");
const web = (path: string) => readFileSync(join(WEB, path), "utf8");

const CLINIC = "0c1d2e3f-0000-4000-8000-000000000000";
const ALERT = "9a8b7c6d-1111-4222-8333-444455556666";
const CTX = {
  clinicName: null,
  audience: "patients",
  reason: OPS_REASON,
  raisedAt: new Date("2026-10-23T12:00:00Z"),
  timeZone: "UTC",
} as const;

beforeEach(() => {
  vi.stubEnv("BETTER_AUTH_URL", "https://app.healdesk.test");
  vi.stubEnv("HEALDESK_APP_URL", "");
  vi.stubEnv("HEALDESK_CONSOLE_ORIGIN", "https://healdesk.test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const REWRITTEN = OPS_EVENTS.filter((event) => !LEGACY_WORDING.has(event));

// -----------------------------------------------------------------------------
// Every event has one wording
// -----------------------------------------------------------------------------

describe("every event has exactly one wording", () => {
  test("LEGACY_WORDING plus the rewritten set is OPS_EVENTS, with none in both", () => {
    for (const event of OPS_EVENTS) expect(ALERT_WORDING[event], event).toBeDefined();
    expect(Object.keys(ALERT_WORDING).sort()).toEqual([...OPS_EVENTS].sort());
    for (const event of LEGACY_WORDING) expect(OPS_EVENTS as readonly string[], event).toContain(event);
    expect(new Set([...LEGACY_WORDING, ...REWRITTEN]).size).toBe(OPS_EVENTS.length);
    expect(LEGACY_WORDING.size + REWRITTEN.length).toBe(OPS_EVENTS.length);
  });

  test("a legacy event still reads exactly as it did: one paragraph, no steps", () => {
    for (const event of LEGACY_WORDING) {
      const wording = ALERT_WORDING[event]!;
      // Rewritten but not taken off LEGACY: it would skip the rules below.
      expect(wording.steps, event).toEqual([]);
      expect(wording.whyItMatters, event).toBe("");
      expect(placeholdersOf(wording.whatHappened), event).toEqual([]);
      expect(fill(wording.whatHappened, {}), event).toBe(wording.whatHappened);
    }
  });

  test("each event is in the file of its runbook section (apps/web RUNBOOK_ANCHOR)", () => {
    const source = web("lib/admin/fix-with-claude.ts");
    const block = source.slice(source.indexOf("export const RUNBOOK_ANCHOR"));
    const anchors = Object.fromEntries(
      [...block.slice(0, block.indexOf("};")).matchAll(/^ {2}([a-z0-9_]+): "([a-z-]+)",$/gm)].map((m) => [m[1], m[2]]),
    );
    expect(Object.keys(anchors).sort()).toEqual([...OPS_EVENTS].sort());
    for (const [section, module] of Object.entries(SECTIONS)) {
      for (const event of Object.keys(module.WORDING)) expect(anchors[event], event).toBe(section);
      for (const event of module.LEGACY) expect(Object.keys(module.WORDING), event).toContain(event);
    }
  });
});

// -----------------------------------------------------------------------------
// The wording rules, for every rewritten event
// -----------------------------------------------------------------------------

/** Imperative first words a step may open with. */
const VERBS = new Set(
  "Open Press Check Phone Call Record Read Look Find Write Ask Use Leave Stop Do Wait Reply Email Confirm Send Mark Tell Turn Switch Release Delete Fix Decide Extend Cancel Refund Deliver Review Move Note Give Start Close Correct Update Follow Contact Raise Find Keep".split(" "),
);

/**
 * The places a step may send an operator, each with the apps/web file and
 * text that prove it exists today. A new place goes here with its proof.
 */
const PLACES: Readonly<Record<string, readonly [file: string, proof: string]>> = {
  "Setup tab": ["app/admin/clinics/[clinicId]/ClinicTabs.tsx", 'setup: "Setup"'],
  "Billing tab": ["app/admin/clinics/[clinicId]/ClinicTabs.tsx", 'billing: "Billing"'],
  "Deliveries tab": ["app/admin/clinics/[clinicId]/ClinicTabs.tsx", 'deliveries: "Deliveries"'],
  "Care tab": ["app/admin/clinics/[clinicId]/ClinicTabs.tsx", 'care: "Care"'],
  "Account tab": ["app/admin/clinics/[clinicId]/ClinicTabs.tsx", 'account: "Account"'],
  "Queues page": ["app/admin/queues/page.tsx", 'title: "Queues"'],
  "Setup requests": ["app/admin/queues/SetupRequestsSection.tsx", 'title="Setup requests"'],
  "Send setup link": ["app/admin/queues/SetupRequestsSection.tsx", '"Send setup link"'],
  Decline: ["app/admin/queues/SetupRequestsSection.tsx", "Decline"],
  "Link sent": ["app/admin/queues/SetupRequestsSection.tsx", "`Link sent "],
  "Calendar writes needing attention": [
    "app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx",
    "Calendar writes needing attention",
  ],
  Retry: ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", "Retry\n"],
  "Send calendar link": ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", "Send calendar link"],
  "Phone line": ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", 'title="Phone line"'],
  "Extend the setup window": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", "Extend the setup window"],
  "Usage and the allowance": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", 'title="Usage and the allowance"'],
  "At the allowance": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", "At the allowance"],
  "Touch log": ["app/admin/clinics/[clinicId]/care/TouchLog.tsx", 'title="Touch log"'],
  Record: ["app/admin/clinics/[clinicId]/care/TouchLog.tsx", '"Record"'],
};

/** Words an operator should never have to know (the brief's list). */
const JARGON = [
  "payload",
  "webhook",
  "idempotent",
  "dead-letter",
  "tenant",
  "RLS",
  "outbox",
  "pg-boss",
  "SSM",
  "cron",
  "migration",
  "queue",
  "ledger",
  "endpoint",
  "API",
  "token",
];
const SQL = /\b(select|insert into|update \w+ set|delete from|where \w+ =|psql|drizzle)\b/i;

/** The text with placeholders and named places taken out: what the reader reads around them. */
function prose(text: string): string {
  let out = text.replace(/\{[^}]*\}/g, "X").replace(/[[\]]/g, "");
  for (const place of Object.keys(PLACES)) out = out.split(place).join("Place");
  return out;
}

function codeProblems(text: string): string[] {
  const t = prose(text);
  const problems: string[] = [];
  if (/`/.test(t)) problems.push("a backtick");
  if (/\b[a-z0-9]+_[a-z0-9_]+\b/i.test(t)) problems.push(`snake_case: ${/\b[a-z0-9]+_[a-z0-9_]+\b/i.exec(t)![0]}`);
  if (/\b[a-z]+[A-Z][A-Za-z]*\b/.test(t)) problems.push(`camelCase: ${/\b[a-z]+[A-Z][A-Za-z]*\b/.exec(t)![0]}`);
  if (/\b[\w-]+\/[\w./-]+\.(ts|tsx|md|sql|json|sh|ya?ml)\b|\b(lib|src|apps|docs)\//.test(t)) problems.push("a file path");
  if (SQL.test(t)) problems.push("a SQL word");
  for (const word of JARGON) {
    if (new RegExp(`\\b${word}s?\\b`, word === word.toUpperCase() ? "" : "i").test(t)) problems.push(`jargon: ${word}`);
  }
  return problems;
}

function sentences(text: string): string[] {
  return prose(text)
    .split(/(?<=[.!?:])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe("the plain-English rules", () => {
  test("every place a step may name exists in apps/web today", () => {
    for (const [place, [file, proof]] of Object.entries(PLACES)) {
      expect(web(file), place).toContain(proof);
    }
  });

  test.each(REWRITTEN.map((event) => [event]))("%s follows them", (event) => {
    const wording = ALERT_WORDING[event as OpsEvent]!;
    const fields = EVENT_FIELDS[event as OpsEvent];
    expect(fields, "list its fields in alert-wording/fields.ts").toBeDefined();

    // The title: the subject line, in the subject rules, with no placeholder.
    expect(subjectProblems(`healdesk ops: ${wording.title}`)).toEqual([]);
    expect(`healdesk ops: ${wording.title}`.length).toBeLessThanOrEqual(70);
    expect(placeholdersOf(wording.title)).toEqual([]);

    expect(wording.whatHappened.trim()).not.toBe("");
    expect(wording.whyItMatters.trim()).not.toBe("");
    expect(wording.steps.length).toBeGreaterThanOrEqual(2);

    for (const step of wording.steps) {
      const first = step.split(/\s+/)[0]!;
      expect(VERBS.has(first), `"${step}" starts with a verb`).toBe(true);
      expect(
        Object.keys(PLACES).some((place) => step.includes(place)),
        `"${step}" names a console page or button`,
      ).toBe(true);
    }

    const texts = [wording.title, wording.whatHappened, wording.whyItMatters, ...wording.steps];
    for (const text of texts) expect(codeProblems(text), text).toEqual([]);

    const all = texts.slice(1).flatMap(sentences);
    const average = all.reduce((n, s) => n + s.split(/\s+/).length, 0) / all.length;
    expect(average, "average words per sentence").toBeLessThanOrEqual(22);

    // Placeholders: allow-listed, raised with this event, and safe when missing.
    const known = new Set([
      ...fields!,
      ...(fields!.includes("clinicId") ? ["clinicName"] : []),
      ...(fields!.includes("used") && fields!.includes("included") ? ["percent"] : []),
    ]);
    for (const text of texts) {
      for (const key of placeholdersOf(text)) {
        expect(isPlaceholderAllowed(key), `${key} is allow-listed`).toBe(true);
        expect(known.has(key), `${key} is raised with ${event}`).toBe(true);
      }
      for (const match of text.replace(/\[[^\]]*\]/g, "").matchAll(/\{([A-Za-z0-9]+)(:[a-z ]+)?\}/g)) {
        expect(Boolean(match[2]) || Object.hasOwn(FALLBACKS, match[1]!), `${match[1]} needs a fallback or a clause`).toBe(
          true,
        );
      }
    }
    expect(requiredPlaceholdersOf(wording.title)).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// The one substitution
// -----------------------------------------------------------------------------

describe("the substitution", () => {
  test("formats values for reading", () => {
    expect(fill("{clinicName} used {percent} of {meter}", { clinicName: "Glow", percent: 91, meter: "voice_minutes" })).toBe(
      "Glow used 91% of voice minutes",
    );
    expect(fill("by {promisedOn}", { promisedOn: "2026-10-22" })).toBe("by 22 Oct");
    expect(formatDay("2026-10-01T04:00:00.000Z")).toBe("1 Oct");
    expect(fill("{count:change}", { count: 1 })).toBe("1 change");
    expect(fill("{written:closed day}", { written: 3 })).toBe("3 closed days");
    expect(fill("{attemptCount:try}", { attemptCount: 5 })).toBe("5 tries");
    expect(plural("match")).toBe("matches");
    expect(fill("{used}", { used: 12500 })).toBe("12,500");
  });

  test("drops an optional clause whose value is missing, and tidies what it leaves", () => {
    expect(fill("A clinic asked us[: {business}]. We replied[ by {promisedOn}].", {})).toBe(
      "A clinic asked us. We replied.",
    );
    expect(fill("Hello [ {business} ], there", {})).toBe("Hello, there");
  });

  test("never prints undefined, null or a raw placeholder, for any event, with nothing or junk to fill it", () => {
    const junk = { clinicName: "", business: null, used: Number.NaN, meter: "patients", section: "<script>" } as Record<
      string,
      unknown
    >;
    for (const event of OPS_EVENTS) {
      for (const fields of [{}, junk]) {
        const filled = fillWording(alertWording(event, fields), wordingValues(fields, null));
        const text = [filled.title, filled.whatHappened, filled.whyItMatters, ...filled.steps].join("\n");
        expect(text, event).not.toMatch(/undefined|null|NaN|\{|\}|\[|\]/);
        expect(text, event).not.toContain("<script>");
      }
    }
  });
});

// -----------------------------------------------------------------------------
// The business name a setup requester typed
// -----------------------------------------------------------------------------

describe("a setup requester's business name", () => {
  test("is kept when it is a name, cut at 80 characters, and refused when it could reach someone", () => {
    expect(printableBusinessName("  Glow   Med Spa ")).toBe("Glow Med Spa");
    const long = "The Very Long Name Aesthetic and Wellness Clinic of the Greater Riverside Valley Area North";
    const cut = printableBusinessName(long)!;
    expect(cut.length).toBeLessThanOrEqual(80);
    expect(long.startsWith(cut)).toBe(true);
    for (const bad of [
      "owner@glow.test",
      "https://glow.test",
      "www.glowspa",
      "glowspa.com",
      "Call 5551234567",
      "",
      "   ",
      42,
      null,
    ]) {
      expect(printableBusinessName(bad), String(bad)).toBeNull();
    }
  });
});

// -----------------------------------------------------------------------------
// The link
// -----------------------------------------------------------------------------

describe("the console link", () => {
  test("is the issue shape: the clinic's tab and the alert's anchor", () => {
    expect(opsConsoleLink("calendar_write_stuck", { clinicId: CLINIC }, ALERT)).toBe(
      `https://healdesk.test/admin/clinics/${CLINIC}/setup#calendar_write_stuck-${ALERT}`,
    );
    expect(opsConsoleLink("usage_near_cap", { clinicId: CLINIC.toUpperCase() }, ALERT.toUpperCase())).toBe(
      `https://healdesk.test/admin/clinics/${CLINIC}/billing#usage_near_cap-${ALERT}`,
    );
    // No alert id (the console's own inbox): the tab, no issue named.
    expect(opsConsolePath("transcript_undelivered", { clinicId: CLINIC })).toBe(`/admin/clinics/${CLINIC}/deliveries`);
    expect(opsConsolePath("transcript_undelivered", { clinicId: CLINIC }, "not-a-uuid")).toBe(
      `/admin/clinics/${CLINIC}/deliveries`,
    );
  });

  test("with no clinic, opens the page that owns the alert, or nothing", () => {
    expect(opsConsoleLink("setup_request_reply_past_due", { requestId: ALERT }, ALERT)).toBe(
      "https://healdesk.test/admin/queues#setup-requests",
    );
    expect(opsConsoleLink("dmarc_review_due", {}, ALERT)).toBeNull();
  });

  test("every no-clinic page is a page apps/web has, and every anchor a section on it", () => {
    for (const [event, path] of Object.entries(NO_CLINIC_PAGE)) {
      const [page, anchor] = path!.split("#");
      const dir = join(WEB, "app", ...page!.split("/").filter(Boolean));
      expect(existsSync(join(dir, "page.tsx")), `${event}: ${page}`).toBe(true);
      if (anchor) {
        const sections = readFileSync(join(dir, "page.tsx"), "utf8");
        const files = [...sections.matchAll(/from "\.\/(\w+)"/g)].map((m) => readFileSync(join(dir, `${m[1]}.tsx`), "utf8"));
        expect(files.some((f) => f.includes(`id="${anchor}"`)), `${event}: #${anchor}`).toBe(true);
      }
    }
  });

  test("the tab for each event is apps/web's issueTabFor, set for set", () => {
    const source = web("lib/admin/issue-link.ts");
    const theirs = (name: string): string[] => {
      const block = new RegExp(`const ${name}: ReadonlySet<OpsEvent> = new Set<OpsEvent>\\(\\[([\\s\\S]*?)\\]\\);`).exec(source);
      if (!block) throw new Error(`apps/web's ${name} set was not found`);
      return [...block[1]!.replace(/\/\/[^\n]*/g, "").matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]!).sort();
    };
    expect([...SETUP].sort()).toEqual(theirs("SETUP"));
    expect([...BILLING].sort()).toEqual(theirs("BILLING"));
    expect([...DELIVERIES].sort()).toEqual(theirs("DELIVERIES"));
    expect([...ACCOUNT].sort()).toEqual(theirs("ACCOUNT"));
    expect(issueTabFor("incident_notice_overdue")).toBe("care");
    expect(source).toMatch(/return "care";\s*\}\s*$/);
  });
});

// -----------------------------------------------------------------------------
// The email and Slack say the same thing
// -----------------------------------------------------------------------------

const FIVE: { event: OpsEvent; fields: Record<string, string | number> }[] = [
  {
    event: "setup_request_reply_past_due",
    fields: { requestId: ALERT, source: "setup_request", business: "Glow Med Spa", promisedOn: "2026-10-22" },
  },
  {
    event: "usage_near_cap",
    fields: { clinicId: CLINIC, meter: "voice_minutes", windowStart: "2026-10-01T00:00:00.000Z", used: 455, included: 500 },
  },
  {
    event: "calendar_write_stuck",
    fields: { clinicId: CLINIC, appointmentId: ALERT, status: "unknown", code: "timeout", attemptCount: 5 },
  },
  {
    event: "lifecycle_decision_due",
    fields: {
      clinicId: CLINIC,
      stepsLeftCount: 3,
      noProgressDays: 9,
      setupDays: 22,
      remainingDays: 8,
      decision: "none",
      recommendation: "extend",
      extendDays: 7,
    },
  },
  {
    event: "clinic_availability_changed",
    fields: { clinicId: CLINIC, section: "closures", count: 2, written: 3, deleted: 1 },
  },
];

describe("one wording, two renderings", () => {
  test.each(FIVE.map((f) => [f.event, f]))("%s: the email and Slack print the same sentences and every step", (_e, alert) => {
    const { event, fields } = alert as (typeof FIVE)[number];
    const clinicName = fields.clinicId ? "Glow Med Spa" : null;
    const consoleUrl = opsConsoleLink(event, fields, ALERT)!;
    const email = renderOpsAlert({ event, ...fields, ...(clinicName ? { clinicName } : {}), consoleUrl }, CTX);
    const slack = slackText({ event, fields, clinicName, alertId: ALERT });
    const filled = fillWording(alertWording(event, fields), wordingValues(fields, clinicName));
    for (const sentence of [filled.whatHappened, filled.whyItMatters]) {
      expect(email.text).toContain(sentence);
      expect(slack).toContain(sentence.replace(/&/g, "&amp;"));
    }
    filled.steps.forEach((step, i) => {
      expect(email.text).toContain(`${i + 1}. ${step}`);
      expect(slack).toContain(`${i + 1}. ${step}`);
    });
    expect(email.text).toContain(consoleUrl);
    expect(slack).toContain(`<${consoleUrl}|Open in the console>`);
    // The event code once, as a reference at the bottom, not in the body.
    expect(email.text.split(consoleUrl).join("").split(event).length - 1).toBe(1);
    expect(email.text).toContain(`Alert code: ${event}`);
    expect(email.text).not.toMatch(/undefined|\{|\}/);
    expect(filled.steps.length).toBeGreaterThanOrEqual(2);
  });

  test("the setup request alert names the business and the promised day, and nothing about the person", () => {
    const { fields } = FIVE[0]!;
    const slack = slackText({ event: "setup_request_reply_past_due", fields, clinicName: null, alertId: ALERT });
    expect(slack).toContain("A clinic asked us to set up AYA: Glow Med Spa.");
    expect(slack).toContain("We promised to reply by 22 Oct");
    expect(slack).toContain("Business: Glow Med Spa");
    expect(slack).not.toContain(ALERT.slice(0, 8) + "-1111-4222-8333-444455556666#");
    // Without a name or a day, the same alert still reads.
    const bare = slackText({ event: "setup_request_reply_past_due", fields: { requestId: ALERT }, clinicName: null });
    expect(bare).toContain("A clinic asked us to set up AYA. We promised to reply, and that day has passed.");
  });

  test("Slack's blocks hold the whole text in sections Slack accepts, and never cut a step", () => {
    for (const { event, fields } of FIVE) {
      const payload = slackPayload({ event, fields, clinicName: "Glow", alertId: ALERT });
      for (const block of payload.blocks) expect(block.text.text.length).toBeLessThanOrEqual(SLACK_SECTION_MAX);
      expect(payload.blocks.map((b) => b.text.text).join("\n")).toBe(payload.text);
    }
    const steps = Array.from({ length: 12 }, (_, i) => `${i + 1}. ${"Press the button on the tab. ".repeat(12)}`);
    const sections = packSections(steps);
    expect(sections.length).toBeGreaterThan(1);
    for (const s of sections) expect(s.length).toBeLessThanOrEqual(SLACK_SECTION_MAX);
    expect(sections.join("\n")).toBe(steps.join("\n"));
    // A single line longer than a section is split at spaces, word for word.
    const huge = "word ".repeat(1000).trim();
    const split = packSections([huge]);
    expect(split.length).toBeGreaterThan(1);
    expect(split.join(" ")).toBe(huge);
  });
});
