import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { subjectProblems } from "@/lib/email/lint";
import { OPS_REASON } from "@/lib/email/templates/context";
import { renderOpsAlert } from "@/lib/email/templates/ops_alert";
import { ALERT_WORDING, alertWording, LEGACY_WORDING, SECTIONS } from "@/lib/ops/alert-wording";
import {
  cleanBusinessName,
  isPlaceholderAllowed,
  printableBusinessName,
  wordingValues,
} from "@/lib/ops/alert-wording/allow-list";
import { emailFacts, sharedFacts } from "@/lib/ops/alert-wording/facts";
import { EVENT_FIELDS } from "@/lib/ops/alert-wording/fields";
import {
  clauseText,
  FALLBACKS,
  fill,
  fillWording,
  formatDay,
  placeholdersOf,
  plural,
  requiredPlaceholdersOf,
} from "@/lib/ops/alert-wording/render";
import { changeAlertFields } from "@/lib/clinic/change-events";
import { dueWaves, type WaveFacts } from "@/lib/lifecycle/waves";
import { ACCOUNT, BILLING, DELIVERIES, issueTabFor, NO_CLINIC_PAGE, SETUP } from "@/lib/ops/alert-wording/tabs";
import { OPS_EVENTS, opsConsoleLink, opsConsolePath, type OpsEvent } from "@/lib/ops/notify";
import { packSections, SLACK_SECTION_MAX, slackName, slackPayload, slackText } from "@/lib/ops/slack";

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
 * text that prove it exists today, and whether it is a page or card (where
 * to go) or a button (what to press there). A new place goes here with its
 * proof.
 */
type Place = readonly [file: string, proof: string, kind: "page" | "button"];
const PLACES: Readonly<Record<string, Place>> = {
  "Setup tab": ["app/admin/clinics/[clinicId]/ClinicTabs.tsx", 'setup: "Setup"', "page"],
  "Billing tab": ["app/admin/clinics/[clinicId]/ClinicTabs.tsx", 'billing: "Billing"', "page"],
  "Deliveries tab": ["app/admin/clinics/[clinicId]/ClinicTabs.tsx", 'deliveries: "Deliveries"', "page"],
  "Care tab": ["app/admin/clinics/[clinicId]/ClinicTabs.tsx", 'care: "Care"', "page"],
  "Account tab": ["app/admin/clinics/[clinicId]/ClinicTabs.tsx", 'account: "Account"', "page"],
  "Queues page": ["app/admin/queues/page.tsx", 'title: "Queues"', "page"],
  "Setup requests": ["app/admin/queues/SetupRequestsSection.tsx", 'title="Setup requests"', "page"],
  "Calendar writes needing attention": [
    "app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx",
    "Calendar writes needing attention",
    "page",
  ],
  "Phone line": ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", 'title="Phone line"', "page"],
  "Usage and the allowance": [
    "app/admin/clinics/[clinicId]/billing/BillingPanel.tsx",
    'title="Usage and the allowance"',
    "page",
  ],
  "Touch log": ["app/admin/clinics/[clinicId]/care/TouchLog.tsx", 'title="Touch log"', "page"],
  "Send setup link": ["app/admin/queues/SetupRequestsSection.tsx", '"Send setup link"', "button"],
  Decline: ["app/admin/queues/SetupRequestsSection.tsx", "Decline", "button"],
  "Link sent": ["app/admin/queues/SetupRequestsSection.tsx", "`Link sent ", "button"],
  "the email didn't send": ["app/admin/queues/SetupRequestsSection.tsx", "the email didn't send", "button"],
  Retry: ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", "Retry\n", "button"],
  "Send calendar link": ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", "Send calendar link", "button"],
  "Extend the setup window": [
    "app/admin/clinics/[clinicId]/billing/BillingPanel.tsx",
    "Extend the setup window",
    "button",
  ],
  "At the allowance": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", "At the allowance", "button"],
  Record: ["app/admin/clinics/[clinicId]/care/TouchLog.tsx", '"Record"', "button"],
  // Lane N2a: the places the provisioning, billing, usage and email-delivery
  // steps name. Pages and cards first, then buttons.
  "Clinics page": ["app/admin/clinics/page.tsx", 'title: "Clinics"', "page"],
  "Jobs page": ["app/admin/system/jobs/page.tsx", 'title: "Jobs"', "page"],
  "Map page": ["app/admin/map/page.tsx", 'title: "System map"', "page"],
  "Agreements register": ["app/admin/compliance/page.tsx", 'label: "Agreements register"', "page"],
  "Plan card": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", "title={`Plan — ", "page"],
  "Plan started": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", 'label="Plan started', "page"],
  Locations: ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", '<Row label="Locations">', "page"],
  "Refunded under § 5": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", 'label="Refunded under § 5"', "page"],
  "Needs attention": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", "Needs attention", "page"],
  "Billing requests": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", "Billing requests —", "page"],
  "Setup closure": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", 'close_setup: "Setup closure"', "page"],
  "Cancel now": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", 'cancel_now: "Cancel now"', "page"],
  "Parked Stripe events": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", "Parked Stripe events —", "page"],
  "A location waiting to be set up": [
    "app/admin/clinics/[clinicId]/billing/BillingPanel.tsx",
    'title="A location waiting to be set up"',
    "page",
  ],
  "Annual overage invoices": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", "Annual overage invoices —", "page"],
  "Refund under Terms § 5": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", 'title="Refund under Terms § 5"', "page"],
  "Billing emails": ["app/admin/clinics/[clinicId]/deliveries/DeliveriesLedger.tsx", "Billing emails", "page"],
  "Reports and alerts": ["app/admin/clinics/[clinicId]/deliveries/DeliveriesLedger.tsx", "Reports and alerts", "page"],
  "The clinic's address": ["app/admin/clinics/[clinicId]/account/AccountPanel.tsx", `title="The clinic's address"`, "page"],
  Offboarding: ["app/admin/clinics/[clinicId]/care/CarePanel.tsx", 'title="Offboarding"', "page"],
  "Preview the amount": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", "Preview the amount", "button"],
  Replay: ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", "Replay\n", "button"],
  "Retry the location setup": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", "Retry the location setup", "button"],
  "Retry the invoice": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", "Retry the invoice", "button"],
  "Turn auto-renew on": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", '"Turn auto-renew on"', "button"],
  "Close the unfinished setup": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", "Close the unfinished setup", "button"],
  "Turn on": ["app/admin/system/jobs/JobsTable.tsx", '"Turn on"', "button"],
  "Enter the change": ["app/admin/clinics/[clinicId]/account/AccountPanel.tsx", '"Enter the change"', "button"],
  "Resend copy": ["app/admin/compliance/agreements/AgreementsRegister.tsx", '"Resend copy"', "button"],
  // Lane N2b: setup-and-support, agreements, voice, calendar, transcripts.
  "Home page": ["app/admin/page.tsx", 'title: "Home"', "page"],
  "Clinics page": ["app/admin/clinics/page.tsx", 'title: "Clinics"', "page"],
  "Voice agent column": ["app/admin/clinics/ClinicTable.tsx", 'label: "Voice agent"', "page"],
  "Calendar column": ["app/admin/clinics/ClinicTable.tsx", 'label: "Calendar"', "page"],
  Support: ["app/admin/queues/SupportSection.tsx", 'id="support" title={`Support', "page"],
  "Waiting for a reply": ["app/admin/queues/SupportSection.tsx", "Waiting for a reply", "page"],
  "Mark replied": ["app/admin/queues/SupportSection.tsx", "Mark replied", "button"],
  "Site reads": ["app/admin/queues/page.tsx", 'label: "Site reads"', "page"],
  "Read it again": ["app/admin/queues/RereadButton.tsx", "Read it again", "button"],
  Reviews: ["app/admin/queues/page.tsx", 'label: "Reviews"', "page"],
  "Agent script": ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", "title={`Agent script", "page"],
  "Save script": ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", "Save script", "button"],
  "Channels card": ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", 'title="Channels"', "page"],
  // Lane N2c: go-live, account, offboarding, patient-rights, incidents, vendors, meta, retention.
  Reviews: ["app/admin/queues/ReviewsSection.tsx", 'id="reviews"', "page"],
  Pass: ["app/admin/queues/ReviewQueue.tsx", "Pass\n", "button"],
  Fail: ["app/admin/queues/ReviewQueue.tsx", "Fail\n", "button"],
  "Run the questions again": ["app/admin/queues/ReviewQueue.tsx", "Run the questions again", "button"],
  "Go live": ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", 'title="Go live"', "page"],
  "Check go-live now": ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", "Check go-live now", "button"],
  Channels: ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", 'title="Channels"', "page"],
  "The line is on their website": [
    "app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx",
    "The line is on their website",
    "button",
  ],
  "Ask the practice questions again": [
    "app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx",
    "Ask the practice questions again",
    "button",
  ],
  "Calendar card": ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", 'title="Calendar"', "page"],
  "Meta front door card": ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", "title={`Meta front door", "page"],
  "Save phone settings": ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", "Save phone settings", "button"],
  "To undo": ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", "To undo", "page"],
  "Plan card": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", "title={`Plan — ", "page"],
  "Pause AI and the direct line": [
    "app/admin/clinics/[clinicId]/billing/BillingPanel.tsx",
    "Pause AI and the direct line",
    "page",
  ],
  "Save the direct line": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", "Save the direct line", "button"],
  Resume: ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", "Resume\n", "button"],
  "Offboarding card": ["app/admin/clinics/[clinicId]/care/CarePanel.tsx", 'title="Offboarding"', "page"],
  "Start offboarding": ["app/admin/clinics/[clinicId]/care/CarePanel.tsx", "Start offboarding", "button"],
  "Start a test window": ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", "Start a test window", "button"],
  "What the clinic dials": ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", "What the clinic dials", "page"],
  "Meta front door": ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", "Meta front door — ", "page"],
  "Compliance page": ["app/admin/compliance/page.tsx", 'title: "Compliance"', "page"],
  "Business associate agreements in the chain": [
    "app/admin/compliance/CompliancePanel.tsx",
    "Business associate agreements in the chain",
    "page",
  ],
  Attest: ["app/admin/compliance/CompliancePanel.tsx", '"Attest"', "button"],
  "Attest again": ["app/admin/compliance/CompliancePanel.tsx", "Attest again", "button"],
  Withdraw: ["app/admin/compliance/CompliancePanel.tsx", "Withdraw\n", "button"],
  "Lapses on": ["app/admin/compliance/CompliancePanel.tsx", "Lapses on (optional)", "button"],
  Incidents: ["app/admin/compliance/incidents/page.tsx", 'title: "Incidents"', "page"],
  "Send report": ["app/admin/compliance/incidents/IncidentsBoard.tsx", '"Send report"', "button"],
  "Not reportable": ["app/admin/compliance/incidents/IncidentsBoard.tsx", "Not reportable\n", "button"],
  "Record clinic notified": ["app/admin/clinics/[clinicId]/care/CarePanel.tsx", "Record clinic notified", "button"],
  Resolve: ["app/admin/clinics/[clinicId]/care/CarePanel.tsx", "Resolve\n", "button"],
  "Open incident and start the clock": [
    "app/admin/clinics/[clinicId]/care/CarePanel.tsx",
    "Open incident and start the clock",
    "button",
  ],
  Offboarding: ["app/admin/clinics/[clinicId]/care/CarePanel.tsx", 'title="Offboarding"', "page"],
  "Record export delivered": ["app/admin/clinics/[clinicId]/care/CarePanel.tsx", "Record export delivered", "button"],
  "Record Retell agent release": [
    "app/admin/clinics/[clinicId]/care/CarePanel.tsx",
    "Record Retell agent release",
    "button",
  ],
  Transcripts: ["app/admin/clinics/[clinicId]/deliveries/DeliveriesLedger.tsx", 'label: "Transcripts"', "page"],
  "Newest receipts": ["app/admin/clinics/[clinicId]/deliveries/TranscriptsPanel.tsx", "Newest receipts", "page"],
  "Send again": ["app/admin/clinics/[clinicId]/deliveries/TranscriptsPanel.tsx", '"Send again"', "button"],
  "Enter the change": ["app/admin/clinics/[clinicId]/account/AccountPanel.tsx", "Enter the change", "button"],
  "Jobs page": ["app/admin/system/jobs/page.tsx", 'title: "Jobs"', "page"],
  "Turn on": ["app/admin/system/jobs/JobsTable.tsx", '"Turn on"', "button"],
  "Map page": ["app/admin/system/page.tsx", 'label: "Map"', "page"],
  "Missing or broken": ["app/admin/map/MapLists.tsx", 'label: "Missing or broken"', "button"],
  "Agreements register": ["app/admin/compliance/page.tsx", 'label: "Agreements register"', "page"],
  Manage: ["app/admin/compliance/agreements/AgreementsRegister.tsx", '"Manage"', "button"],
  "Send copy": ["app/admin/compliance/agreements/AgreementsRegister.tsx", '"Send copy"', "button"],
  "Copy sent": ["app/admin/compliance/agreements/AgreementsRegister.tsx", 'label="Copy sent"', "button"],
  "Never delivered": ["app/admin/compliance/agreements/AgreementsRegister.tsx", "Never delivered", "button"],
  "The clinic's address": ["app/admin/clinics/[clinicId]/account/AccountPanel.tsx", `title="The clinic's address"`, "page"],
  "Stop this change": ["app/admin/clinics/[clinicId]/account/AccountPanel.tsx", "Stop this change", "button"],
  "Change the address": [
    "app/admin/clinics/[clinicId]/account/AccountPanel.tsx",
    "Change the address (the clinic lost it)",
    "button",
  ],
  "Send a link to add a device": [
    "app/admin/clinics/[clinicId]/account/DevicesSection.tsx",
    "Send a link to add a device (the clinic lost every device)",
    "button",
  ],
  "Deposits and Stripe Connect": [
    "app/admin/clinics/[clinicId]/billing/BillingPanel.tsx",
    "Deposits and Stripe Connect",
    "page",
  ],
  "Disconnect Stripe": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", "Disconnect Stripe", "button"],
  Plan: ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", 'title="Plan"', "page"],
  "Parked Stripe events": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", "Parked Stripe events", "page"],
  Jobs: ["app/admin/system/jobs/page.tsx", 'title: "Jobs"', "page"],
  Map: ["app/admin/system/page.tsx", 'label: "Map"', "page"],
  "Reports and alerts": ["app/admin/clinics/[clinicId]/deliveries/DeliveriesLedger.tsx", "Reports and alerts", "page"],
  "Billing emails": ["app/admin/clinics/[clinicId]/deliveries/DeliveriesLedger.tsx", "Billing emails", "page"],
};

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether a text names a place as a whole phrase, not inside another word. */
function namesPlace(text: string, place: string): boolean {
  return new RegExp(`(^|[^A-Za-z])${escapeRe(place)}([^A-Za-z]|$)`).test(text);
}

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
  let out = clauseText(text).replace(/\{[^}]*\}/g, "X");
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
      const read = clauseText(step).trim();
      const first = read.split(/\s+/)[0]!;
      expect(VERBS.has(first), `"${step}" starts with a verb`).toBe(true);
      expect(
        Object.keys(PLACES).some((place) => namesPlace(read, place)),
        `"${step}" names a console page or button`,
      ).toBe(true);
    }
    // Somewhere to go, not only a button to press.
    expect(
      wording.steps.some((step) =>
        Object.entries(PLACES).some(([place, [, , kind]]) => kind === "page" && namesPlace(clauseText(step), place)),
      ),
      "the steps name a page, tab or card",
    ).toBe(true);

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

  test("fills in one pass: a value is printed as it is, never filled again", () => {
    const values = { business: "Acme {promisedOn} [x] {clinicName}", promisedOn: "2026-10-22", clinicName: "Glow" };
    expect(fill("From {business} by {promisedOn}.", values)).toBe("From Acme {promisedOn} [x] {clinicName} by 22 Oct.");
    expect(fill("A[: {business}].", values)).toBe("A: Acme {promisedOn} [x] {clinicName}.");
  });

  test("a value or fallback that opens a sentence starts with a capital", () => {
    expect(fill("{clinicName} has used {percent}. Then {clinicName} stops.", {})).toBe(
      "This clinic has used most. Then this clinic stops.",
    );
    for (const event of REWRITTEN) {
      const filled = fillWording(alertWording(event, {}), wordingValues({}, null));
      for (const text of [filled.whatHappened, filled.whyItMatters, ...filled.steps]) {
        for (const sentence of text.split(/(?<=[.!?])\s+/)) expect(sentence, event).toMatch(/^[A-Z0-9]/);
      }
    }
  });

  test("a conditional clause shows only for its listed values", () => {
    const text = "Go.[?recommendation=extend|wait: Extend it.][?recommendation=let_close: Let it close.]";
    expect(fill(text, { recommendation: "wait" })).toBe("Go. Extend it.");
    expect(fill(text, { recommendation: "let_close" })).toBe("Go. Let it close.");
    expect(fill(text, {})).toBe("Go.");
  });

  test("lifecycle_decision_due never tells the operator to extend when the rules say to let it close", () => {
    const steps = (recommendation: string) =>
      fillWording(alertWording("lifecycle_decision_due", {}), { recommendation }).steps.join("\n");
    expect(steps("let_close")).not.toMatch(/Press Extend the setup window/);
    expect(steps("let_close")).toMatch(/Leave the setup window as it is/);
    expect(steps("extend")).toMatch(/Press Extend the setup window on the clinic's Billing tab if the clinic needs more time/);
    expect(steps("wait")).toMatch(/only if the clinic asks for more time/);
    const why = (recommendation: string) =>
      fillWording(alertWording("lifecycle_decision_due", {}), { recommendation }).whyItMatters;
    expect(why("let_close")).toMatch(/letting it close/);
    expect(why("extend")).not.toMatch(/letting it close/);
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
  const KEPT: [string, string][] = [
    ["  Glow   Med Spa ", "Glow Med Spa"],
    ["Dr. Smith's Aesthetics & Laser", "Dr. Smith's Aesthetics & Laser"],
    ["Clinique Étoile 24", "Clinique Étoile 24"],
    ["Spa at the Lake", "Spa at the Lake"],
  ];
  const REFUSED: unknown[] = [
    "owner@glow.test",
    "https://glow.test",
    "www.glowspa",
    "glowspa.com",
    "glow.dental",
    "bit.ly/glow",
    "glow . com",
    "GLOW.COM",
    "Call 5551234567",
    "Call 555 123 4567",
    "(555) 123-4567",
    "+1 555 1234",
    "Spa ٥٥٥١٢٣٤",
    "Spa ５５５１２３４",
    "jane at gmail dot com",
    "jane(at)gmail(dot)com",
    "Glow\u200bSpa",
    "Glow\u2066Spa",
    "Glow=Spa",
    'Glow "Spa"',
    "Glow \u201cSpa\u201d",
    "Glow (Spa)",
    "Glow href Spa",
    "Glow src",
    "url Glow",
    "Glow\\Spa",
    "Glow <b>",
    "Glow `Spa`",
    "",
    "   ",
    42,
    null,
  ];

  test("is kept when it is a name, and cut at 80 characters at a word", () => {
    for (const [given, kept] of KEPT) expect(printableBusinessName(given), given).toBe(kept);
    const long = "The Very Long Name Aesthetic and Wellness Clinic of the Greater Riverside Valley Area North";
    const cut = printableBusinessName(long)!;
    expect(cut.length).toBeLessThanOrEqual(80);
    expect(long.startsWith(cut)).toBe(true);
  });

  test.each(REFUSED.map((v) => [v]))("is refused when it could reach someone or trip the link scanner: %j", (bad) => {
    expect(printableBusinessName(bad)).toBeNull();
    expect(cleanBusinessName(bad)).toBeNull();
  });

  test("is the same rule, character for character, as apps/web's copy", () => {
    const block = (source: string) => {
      const match = /\/\/ <business-name-rule>[\s\S]*?\/\/ <\/business-name-rule>/.exec(source);
      if (!match) throw new Error("the business-name rule block was not found");
      return match[0];
    };
    const ours = readFileSync(join(__dirname, "..", "src", "lib", "ops", "alert-wording", "allow-list.ts"), "utf8");
    expect(block(web("lib/setup-requests.ts"))).toBe(block(ours));
  });

  test("Slack prints a name without its formatting characters", () => {
    expect(slackName("*Glow* _Med_ ~Spa~ `x`")).toBe("Glow Med Spa x");
    const text = slackText({ event: "usage_near_cap", fields: { clinicId: CLINIC, used: 9, included: 10 }, clinicName: "*Bold* Spa" });
    expect(text).not.toContain("*Bold*");
    expect(text).toContain("Bold Spa has used 90%");
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
    // The fall-through is Care, whatever follows issueTabFor in the file.
    const body = /export function issueTabFor\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";
    expect(body).toMatch(/return "care";\s*$/);
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

describe("each rewritten event's fields are the ones its raise site sends", () => {
  const sameKeys = (event: OpsEvent, keys: string[]) => {
    for (const key of keys) expect(EVENT_FIELDS[event], `${event} sends ${key}`).toContain(key);
  };

  test("clinic_availability_changed: changeAlertFields", () => {
    const fields = changeAlertFields(CLINIC, "closures", [
      { summary: { closuresAdded: ["2026-11-01"], closuresRemoved: [] } },
    ] as never);
    sameKeys("clinic_availability_changed", Object.keys(fields));
    expect(Object.keys(fields).sort()).toEqual([...EVENT_FIELDS.clinic_availability_changed!].sort());
  });

  test("lifecycle_decision_due: dueWaves", () => {
    const now = new Date("2026-10-23T12:00:00Z");
    const facts: WaveFacts = {
      stage: "in_setup",
      stageSince: new Date("2026-10-01T12:00:00Z"),
      now,
      windowDay: 22,
      lastDay: "2026-10-31",
      stepsLeft: 3,
      channelsWaiting: 0,
      answeredAScreen: true,
      lastProgressAt: new Date("2026-10-10T12:00:00Z"),
      decision: "none",
      snoozedUntil: null,
      clinicWaves: [],
      recorded: new Set(),
    };
    const wave = dueWaves(facts).find((w) => w.event === "lifecycle_decision_due");
    expect(wave).toBeDefined();
    sameKeys("lifecycle_decision_due", Object.keys(wave!.fields));
  });

  // Their raise sites build the fields inline; their own DB suites pin the
  // exact objects (tests/usage-alerts.test.ts, tests/calendar-write-alerts.test.ts,
  // tests/setup-request-alert.test.ts). Read here from the source.
  test.each([
    ["usage_near_cap", "lib/billing/usage-alerts.ts", /fields: \{([^}]*)\}/],
    ["calendar_write_stuck", "lib/ops/calendar-write-alerts.ts", /found\.push\(\{([\s\S]*?)\}\);/],
  ] as const)("%s: its raise site", (event, file, pattern) => {
    const source = readFileSync(join(__dirname, "..", "src", file), "utf8");
    const body = pattern.exec(source)?.[1] ?? "";
    const keys = body
      .split(",")
      .map((piece) => piece.replace(/^\s*\.\.\.\(\w+ \? \{\s*/, "").trim())
      .map((piece) => /^([a-zA-Z]+)\s*(?::|}|$)/.exec(piece)?.[1])
      .filter((key): key is string => Boolean(key));
    expect(keys.length).toBeGreaterThan(2);
    expect([...new Set(keys)].sort()).toEqual([...EVENT_FIELDS[event]!].sort());
  });
});

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
    // The same facts in both, formatted; no time of day anywhere.
    const raw = alertWording(event, fields);
    for (const [label, value] of sharedFacts(fields, raw)) {
      expect(email.text).toContain(`${label}: ${value}`);
      expect(slack).toContain(`${label}: ${value}`);
    }
    expect(emailFacts(event, { event, ...fields }, raw, clinicName).map(([l]) => l)).not.toContain("Source");
    for (const body of [email.text, slack]) {
      expect(body).not.toMatch(/\d{2}:\d{2}|T\d{2}:|\d{4}-\d{2}-\d{2}|voice_minutes|let_close|setup_request\b/);
    }
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
