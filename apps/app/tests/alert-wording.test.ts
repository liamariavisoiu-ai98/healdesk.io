import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { subjectProblems } from "@/lib/email/lint";
import { OPS_REASON } from "@/lib/email/templates/context";
import { renderOpsAlert } from "@/lib/email/templates/ops_alert";
import { ALERT_WORDING, alertWording, type AlertWording, LEGACY_WORDING, SECTIONS } from "@/lib/ops/alert-wording";
import {
  allowedAlertFields,
  cleanBusinessName,
  isPlaceholderAllowed,
  printableBusinessName,
  wordingValues,
} from "@/lib/ops/alert-wording/allow-list";
import { emailFacts, sharedFacts } from "@/lib/ops/alert-wording/facts";
import { EVENT_FIELDS } from "@/lib/ops/alert-wording/fields";
import {
  CHANNEL_WORDS,
  CLOSED_WORDS,
  EVENT_WORDS,
  EMAIL_KIND_WORDS,
  PROVIDER_WORDS,
  REQUEST_KIND_WORDS,
  STATUS_WORDS,
  VENDOR_WORDS,
} from "@/lib/ops/alert-wording/words";
import { DIRECT_KINDS } from "@/lib/email/direct-kinds";
import { NOTICE_KINDS } from "@/lib/email/kinds";
import { BILLING_REQUEST_KINDS } from "@/db/schema";
import { PLATFORM_VENDORS } from "@/lib/compliance/subjects";
import { META_PROVIDERS } from "@/lib/meta/providers";
import { CHANNELS } from "@healdesk/catalog";
import {
  clauseText,
  FALLBACKS,
  fill,
  fillWording,
  formatDay,
  formatValue,
  layoutAlert,
  placeholdersOf,
  shortName,
  plural,
  requiredPlaceholdersOf,
} from "@/lib/ops/alert-wording/render";
import { changeAlertFields } from "@/lib/clinic/change-events";
import { dueWaves, type WaveFacts } from "@/lib/lifecycle/waves";
import { PLACES } from "@/lib/ops/alert-wording/places";
import { consoleLinkLabel } from "@/lib/ops/alert-wording/tabs";
import { ACCOUNT, BILLING, DELIVERIES, issueTabFor, NO_CLINIC_PAGE, SETUP } from "@/lib/ops/alert-wording/tabs";
import { OPS_EVENTS, opsConsoleLink, opsConsolePath, type OpsEvent } from "@/lib/ops/notify";
import { packSections, SLACK_SECTION_MAX, slackName, slackPayload, slackText } from "@/lib/ops/slack";
import { compose } from "@/lib/email/templates/compose";
import { emphasisePlaces, mark, neutraliseValue, parseMarkup, plainText, toPlain, toSlack } from "@/lib/ops/alert-wording/markup";
import { URGENCY, URGENCY_LOOK } from "@/lib/ops/alert-wording/urgency";

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
    expect(steps("extend")).toMatch(/Press Extend the setup window on the Setup window card if the clinic needs more time/);
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
    expect(opsConsoleLink("dmarc_review_due", {}, ALERT)).toBe("https://healdesk.test/admin/system/jobs");
    expect(opsConsoleLink("provisioning_follow_up_past_due", {}, ALERT)).toBe("https://healdesk.test/admin/system#attention");
    vi.stubEnv("HEALDESK_CONSOLE_ORIGIN", "");
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
    const both = changeAlertFields(CLINIC, "closures", [
      { summary: { closuresAdded: ["2026-11-01"], closuresRemoved: ["2026-11-02"] } },
    ] as never);
    sameKeys("clinic_availability_changed", Object.keys(both));
    expect(Object.keys(both).sort()).toEqual([...EVENT_FIELDS.clinic_availability_changed!].sort());
    // A count of 0 is not sent (lane N3): a removal-only change never reads "It added 0 closed days".
    const removedOnly = changeAlertFields(CLINIC, "closures", [
      { summary: { closuresAdded: [], closuresRemoved: ["2026-11-02"] } },
    ] as never);
    expect(removedOnly).toEqual({ clinicId: CLINIC, section: "closures", count: 1, deleted: 1 });
    const text = fillWording(alertWording("clinic_availability_changed", removedOnly), wordingValues(removedOnly, "Glow"));
    expect(text.whatHappened).not.toMatch(/added 0|added/);
    expect(text.whatHappened).toContain("1 closed day taken off.");
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
    // Lane N4: the same layout in both: the headline, step 1 as "Do this
    // first" (once), the rest of what happened, why it matters, steps from 2.
    const layout = layoutAlert(alertWording(event, fields), wordingValues(fields, clinicName));
    const slackPlain = slack.replace(/\*/g, "");
    for (const sentence of [layout.headline, layout.detail, layout.whyItMatters].map(plainText).filter(Boolean)) {
      expect(email.text).toContain(sentence);
      expect(slackPlain).toContain(sentence.replace(/&/g, "&amp;"));
    }
    expect(email.text).toContain(`DO THIS FIRST: ${plainText(layout.doFirst!)}`);
    expect(slackPlain).toContain(`Do this first: ${plainText(layout.doFirst!)}`);
    layout.then.forEach((step, i) => {
      expect(email.text).toContain(`${i + 2}. ${plainText(step)}`);
      expect(slackPlain).toContain(`${i + 2}. ${plainText(step)}`);
    });
    expect(email.text).toContain(consoleUrl);
    expect(slack).toContain(`<${consoleUrl}|${consoleLinkLabel(consoleUrl)}>`);
    const filled = fillWording(alertWording(event, fields), wordingValues(fields, clinicName));
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
    expect(slack).toContain("*Glow Med Spa is still waiting for our reply to its setup request*");
    expect(slack).toContain("We promised to reply by *22 Oct*");
    expect(slack).toContain("Business: Glow Med Spa");
    expect(slack).not.toContain(ALERT.slice(0, 8) + "-1111-4222-8333-444455556666#");
    // Without a name or a day, the same alert still reads.
    const bare = slackText({ event: "setup_request_reply_past_due", fields: { requestId: ALERT }, clinicName: null });
    expect(bare).toContain("*A clinic is still waiting for our reply to its setup request*");
    expect(bare).toContain("We promised to reply, and that day has passed.");
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

// -----------------------------------------------------------------------------
// Lane N3: the closed word lists, every event's link, and the facts' labels
// -----------------------------------------------------------------------------

describe("the closed word lists", () => {
  test("cover their closed sets in the code, value for value", () => {
    expect(Object.keys(EMAIL_KIND_WORDS).sort()).toEqual([...NOTICE_KINDS, ...DIRECT_KINDS].sort());
    expect(Object.keys(REQUEST_KIND_WORDS).sort()).toEqual([...BILLING_REQUEST_KINDS].sort());
    expect(Object.keys(VENDOR_WORDS).sort()).toEqual([...PLATFORM_VENDORS].sort());
    expect(Object.keys(CHANNEL_WORDS).sort()).toEqual([...CHANNELS].sort());
    expect(Object.keys(PROVIDER_WORDS).sort()).toEqual(Object.values(META_PROVIDERS).sort());
    // The two lists that share `kind` share no value.
    for (const kind of Object.keys(REQUEST_KIND_WORDS)) expect(Object.hasOwn(EMAIL_KIND_WORDS, kind), kind).toBe(false);
  });

  test("each value prints its words, plain: no underscore, no raw code", () => {
    for (const [key, list] of Object.entries(CLOSED_WORDS)) {
      for (const [value, words] of Object.entries(list)) {
        const allowed = allowedAlertFields({ [key]: value });
        expect(allowed[key], `${key}=${value}`).toBe(value);
        expect(fill(`{${key}}`, wordingValues({ [key]: value }, null)), `${key}=${value}`).toBe(
          words.charAt(0).toUpperCase() + words.slice(1),
        );
        expect(words, `${key}=${value}`).not.toMatch(/_/);
      }
    }
  });

  test("an unknown value prints nothing, never the raw value", () => {
    const junk = { kind: "secret_kind", code: "invalid_grant", channel: "sms", provider: "google", status: "Jane Doe", section: "x" };
    expect(allowedAlertFields(junk)).toEqual({});
    expect(fill("A[ {kind}] B[ {code}] C[ {status}].", wordingValues(junk, null))).toBe("A B C.");
    for (const [label, value] of sharedFacts(junk, alertWording("email_refused", junk))) {
      expect(`${label}: ${value}`).not.toMatch(/secret_kind|invalid_grant|sms|google|Jane/);
    }
    expect(formatValue("kind", "secret_kind")).toBe("");
  });

  // Review of lane N3: `code` and `status` mean different things at different
  // raise sites, so their words are the event's own (words.ts EVENT_WORDS).
  test("a vendor code prints only on the two vendor alerts; a status only as its own event means it", () => {
    for (const event of OPS_EVENTS) {
      const facts = sharedFacts({ clinicId: CLINIC, code: "aws" }, alertWording(event, {}));
      const text = Object.values(fillWording(alertWording(event, {}), wordingValues({ code: "aws" }, "Glow"))).flat().join(" ");
      if (event === "vendor_agreement_expiring" || event === "vendor_agreement_lapsed") {
        expect(text, event).toContain("AWS (our host)");
        expect(facts.length, event).toBe(0); // printed in the sentence, so not repeated
      } else {
        expect(text, event).not.toMatch(/AWS \(our host\)/);
        expect(facts.map(([, v]) => v).join(" "), event).not.toMatch(/AWS|aws/);
      }
    }
    expect(Object.keys(EVENT_WORDS).sort()).toEqual(["code", "status"]);
    // The value's words appear in the headline or as a fact row (a headline
    // that prints a key takes it out of the facts: lane N5a).
    const status = (event: OpsEvent, value: string): (readonly [string, string])[] => {
      const fields = { clinicId: CLINIC, status: value };
      const wording = alertWording(event, fields);
      const facts = sharedFacts(fields, wording);
      const headline = plainText(layoutAlert(wording, wordingValues(fields, "Glow")).headline);
      const words = STATUS_WORDS[event]?.[value];
      return words && headline.includes(words) ? [...facts, ["Status", words] as const] : facts;
    };
    expect(status("calendar_write_stuck", "failed")).toContainEqual(["Status", "not written"]);
    expect(status("calendar_write_stuck", "unknown")).toContainEqual(["Status", "never confirmed by Google"]);
    expect(status("critical_notice_undelivered", "late")).toContainEqual(["Status", "late, still being retried"]);
    expect(status("transcript_undelivered", "complaint")).toContainEqual(["Status", "marked as spam"]);
    // A status from another site prints nothing on this one.
    expect(status("transcript_undelivered", "dead")).toEqual([]);
    expect(status("calendar_write_stuck", "late")).toEqual([]);
    for (const [event, list] of Object.entries(STATUS_WORDS)) {
      for (const [value, words] of Object.entries(list!)) {
        expect(status(event as OpsEvent, value), `${event} ${value}`).toContainEqual(["Status", words]);
      }
    }
  });

  test("a billing request's kind is labelled Request, an email's Email kind, and a Meta provider Meta channel", () => {
    // In the headline or as a fact row under its own label (lane N5a puts
    // the request kind and the Meta channel in the headline).
    const shown = (event: OpsEvent, fields: Record<string, string>, label: string, words: string) => {
      const wording = alertWording(event, fields);
      const headline = plainText(layoutAlert(wording, wordingValues(fields, "Glow")).headline);
      const facts = sharedFacts(fields, wording);
      expect(headline.includes(words) || facts.some(([l, v]) => l === label && v === words), `${event}: ${headline}`).toBe(true);
      expect(facts.some(([l]) => l === "Email kind" && label !== "Email kind"), event).toBe(false);
    };
    const request = { clinicId: CLINIC, kind: "plan_start" };
    for (const event of ["billing_request_dead_lettered", "billing_request_stuck"] as const) {
      shown(event, request, "Request", "starting the plan");
    }
    const email = { clinicId: CLINIC, kind: "receipt" };
    expect(sharedFacts(email, alertWording("clinic_address_bounced", email))).toContainEqual(["Email kind", "a receipt"]);
    const meta = { clinicId: CLINIC, provider: "meta-whatsapp" };
    for (const event of ["connection_broken", "meta_revoke_failed", "meta_revoke_by_hand"] as const) {
      shown(event, meta, "Meta channel", "WhatsApp");
    }
  });

  test("the affected wordings name the vendor, the days and the email kind", () => {
    const vendor = fillWording(alertWording("vendor_agreement_expiring", {}), wordingValues({ code: "retell", expiresOn: "2026-11-30" }, null));
    expect(vendor.whatHappened).toContain("Our business associate agreement with Retell (the voice provider) has a recorded expiry of 30 Nov,");
    const aws = fillWording(alertWording("vendor_agreement_lapsed", {}), wordingValues({ code: "aws" }, null));
    expect(aws.whatHappened).toContain("Our business associate agreement with AWS (our host) was withdrawn");
    const lapsed = fillWording(alertWording("vendor_agreement_lapsed", {}), wordingValues({}, null));
    expect(lapsed.whatHappened).toMatch(/^Our business associate agreement with one of the vendors in our chain was withdrawn/);
    const exportDue = fillWording(
      alertWording("export_due_undelivered", {}),
      wordingValues({ exportDueAt: "2026-11-20T10:00:00.000Z", destroyAt: "2027-01-18T10:00:00.000Z" }, "Glow"),
    );
    // The due day is the headline's now (lane N4 review); the last day stays here.
    expect(plainText(layoutAlert(alertWording("export_due_undelivered", {}), wordingValues({ exportDueAt: "2026-11-20T10:00:00.000Z" }, "Glow")).headline)).toBe(
      "Glow's export is not delivered; the agreement's day for it is 20 Nov",
    );
    expect(exportDue.whatHappened).toContain("The data waits for it until 18 Jan at the latest.");
    const before = fillWording(alertWording("export_undelivered_before_destruction", {}), wordingValues({ destroyAt: "2026-11-30T10:00:00.000Z" }, "Glow"));
    // The destruction day is in the headline; the detail points at Offboarding (lane N4 review).
    expect(plainText(layoutAlert(alertWording("export_undelivered_before_destruction", {}), wordingValues({ destroyAt: "2026-11-30T10:00:00.000Z" }, "Glow")).headline)).toBe(
      "Glow's export must be delivered before its data is destroyed on 30 Nov",
    );
    expect(before.whatHappened).toContain("its data is destroyed on the day Offboarding on its Care tab shows");
    const late = fillWording(alertWording("offboarding_started_late", {}), wordingValues({ serviceEndedAt: "2026-10-01T00:00:00.000Z", lateDays: 3 }, "Glow"));
    expect(late.whatHappened).toContain("Glow's subscription ended on 1 Oct, and");
    const refused = fillWording(alertWording("email_refused", {}), wordingValues({ kind: "receipt" }, "Glow"));
    expect(refused.whatHappened).toContain("was refused on our side before sending. It was a receipt.");
    const critical = fillWording(alertWording("critical_notice_undelivered", {}), wordingValues({ kind: "payment_failed" }, "Glow"));
    expect(critical.whatHappened).toContain("must get at once, a payment-failed notice, was due ten minutes ago");
    const dead = fillWording(alertWording("critical_notice_undelivered", { status: "dead" }), wordingValues({ kind: "suspended", status: "dead" }, "Glow"));
    expect(dead.whatHappened).toContain("was owed, a suspension notice, will not be sent.");
  });

  test("practice_question_failed prints its section as a Knowledge section, not as what changed", () => {
    const fields = { clinicId: CLINIC, section: "prices", count: 2 };
    const facts = sharedFacts(fields, alertWording("practice_question_failed", fields));
    expect(facts.map(([label]) => label)).toContain("Section");
    expect(facts.map(([label]) => label)).not.toContain("What changed");
    const changed = sharedFacts({ ...fields, section: "closures" }, alertWording("clinic_availability_changed", fields));
    expect(changed.every(([label]) => label !== "Section")).toBe(true);
    expect(sharedFacts({ clinicId: CLINIC, section: "never_say" }, alertWording("practice_question_failed", {}))).toContainEqual([
      "Section",
      "never-say list",
    ]);
  });
});

describe("every event links somewhere", () => {
  test("each has a page to open when it names no clinic, and each page and anchor exists", () => {
    for (const event of OPS_EVENTS) {
      expect(NO_CLINIC_PAGE[event], event).toMatch(/^\/admin\//);
      expect(opsConsoleLink(event, {}, ALERT), event).toBe(`https://healdesk.test${NO_CLINIC_PAGE[event]}`);
      expect(opsConsoleLink(event, { clinicId: CLINIC }, ALERT), event).toContain(`/admin/clinics/${CLINIC}/`);
    }
  });
});

// -----------------------------------------------------------------------------
// Lane N4: an alert scanned in three seconds
// -----------------------------------------------------------------------------

/** Fields for any event, from its EVENT_FIELDS: a value of the right shape for each. */
function sampleFields(event: OpsEvent): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const key of EVENT_FIELDS[event] ?? []) {
    const closed = CLOSED_WORDS[key] ?? EVENT_WORDS[key]?.[event];
    if (key === "clinicId") out[key] = CLINIC;
    else if (key === "business") out[key] = "Glow Med Spa";
    else if (closed) out[key] = Object.keys(closed)[0]!;
    else if (/(At|On)$/.test(key) || key === "windowStart") out[key] = "2026-10-22";
    else if (isCountKeyName(key)) out[key] = 3;
    else out[key] = ALERT;
  }
  return out;
}

function isCountKeyName(key: string): boolean {
  return /(Count|Days|Hours|Minutes|Percent)$/.test(key) || ["count", "attempts", "used", "included", "written", "deleted", "failures"].includes(key);
}

const MARKER_LEFT = /\*\*|__|==|[-]|undefined|null\b|\{|\}/;

describe("the markup", () => {
  test("balanced markers become emphasis in all three outputs", () => {
    const segments = parseMarkup("Open **Billing** then __Usage__ by ==22 Oct==.");
    expect(segments).toEqual([
      { text: "Open " },
      { text: "Billing", bold: true },
      { text: " then " },
      { text: "Usage", underline: true },
      { text: " by " },
      { text: "22 Oct", highlight: true },
      { text: "." },
    ]);
    expect(toPlain(segments)).toBe("Open Billing then Usage by 22 Oct.");
    expect(toSlack(segments, (t) => t)).toBe("Open *Billing* then *Usage* by *22 Oct*.");
    const html = compose({ subject: "s", preheader: "p", blocks: [{ type: "rich", segments }] }, CTX).html;
    expect(html).toContain("<strong>Billing</strong>");
    expect(html).toContain("<u>Usage</u>");
    expect(html).toMatch(/<mark style="background:#fff3a3;[^"]*">22 Oct<\/mark>/);
  });

  test("unbalanced or nested markers print as plain characters, never as broken markup", () => {
    for (const text of ["a **b", "**a __b__ c**", "x == y", "__", "** spaced **", "a==b==c=="]) {
      const segments = parseMarkup(text);
      const html = compose({ subject: "s", preheader: "p", blocks: [{ type: "rich", segments }] }, CTX).html;
      const body = /<div class="hd-wrap"[^>]*>\n([\s\S]*?)\n<hr/.exec(html)![1]!;
      // Every tag opened is closed, and nested input never nests emphasis.
      for (const tag of ["strong", "u", "mark"]) {
        expect(body.split(`<${tag}`).length, `${text} ${tag}`).toBe(body.split(`</${tag}>`).length);
      }
      expect(segments.filter((s) => s.bold && s.underline).length, text).toBe(0);
    }
    expect(toPlain(parseMarkup("a **b"))).toBe("a **b");
    expect(toPlain(parseMarkup("**a __b__ c**"))).toBe("**a b c**");
  });

  test("a hostile value creates no emphasis and no markup, in the email, the text and Slack", () => {
    const hostile = "**Glow** __x__ ==y== <b>z</b> & w";
    expect(neutraliseValue(hostile)).toBe("*Glow* _x_ =y= <b>z</b> & w");
    const marked = fill("{clinicName} has used {percent}.", { clinicName: hostile, percent: 91 }, { values: true });
    const segments = parseMarkup(marked);
    // The only emphasis is the renderer's own bold around each whole value.
    expect(segments.filter((s) => s.underline || s.highlight)).toEqual([]);
    expect(toPlain(segments)).toBe("*Glow* _x_ =y= <b>z</b> & w has used 91%.");
    const email = renderOpsAlert(
      { event: "usage_near_cap", clinicId: CLINIC, clinicName: "Glow ==Spa== <i>", used: 9, included: 10, meter: "voice_minutes" },
      CTX,
    );
    expect(email.html).not.toContain("<i>");
    expect(email.html).toContain("&lt;i&gt;");
    expect(email.html).not.toMatch(/<mark[^>]*>Spa/);
    const slack = slackText({ event: "usage_near_cap", fields: { clinicId: CLINIC, used: 9, included: 10 }, clinicName: "*Bold* _it_ <!here>" });
    expect(slack).not.toContain("<!here>");
    expect(slack.split("\n")[0]).toBe(":large_yellow_circle: [app] *Bold it &lt;!here&gt; has used 90% of its allowance for this billing period*");
  });

  test("console places in a step are bold and underlined, longest name first, once", () => {
    const step = emphasisePlaces("Press Extend the setup window on the Setup window card, then open the Setup tab.");
    const segments = parseMarkup(step);
    const marked = segments.filter((s) => s.bold && s.underline).map((s) => s.text);
    expect(marked).toEqual(["Extend the setup window on the Setup window card", "Setup tab"]);
    // Never inside a value the renderer marked.
    expect(parseMarkup(emphasisePlaces(mark("bold", "Setup tab"))).filter((s) => s.underline)).toEqual([]);
  });
});

describe("every alert, laid out", () => {
  test("the urgency map covers every event, and an urgent subject still fits", () => {
    expect(Object.keys(URGENCY).sort()).toEqual([...OPS_EVENTS].sort());
    for (const event of OPS_EVENTS) {
      const rendered = renderOpsAlert({ event, ...sampleFields(event) }, CTX);
      expect(subjectProblems(rendered.subject), event).toEqual([]);
      expect(rendered.subject.length, event).toBeLessThanOrEqual(70);
      expect(rendered.subject.startsWith("healdesk ops: URGENT: "), event).toBe(URGENCY[event] === "urgent");
      expect(rendered.preheader, event).toMatch(/^(URGENT|TODAY|FYI): /);
    }
  });

  test.each(OPS_EVENTS.map((e) => [e]))("%s: headline, do-first once, no marker left, nothing undefined", (event) => {
    const fields = sampleFields(event as OpsEvent);
    const clinicName = fields.clinicId ? "Glow Med Spa" : null;
    const consoleUrl = opsConsoleLink(event as OpsEvent, fields, ALERT)!;
    const email = renderOpsAlert({ event: event as OpsEvent, ...fields, ...(clinicName ? { clinicName } : {}), consoleUrl }, CTX);
    const slack = slackText({ event: event as OpsEvent, fields, clinicName, alertId: ALERT });
    const layout = layoutAlert(alertWording(event as OpsEvent, fields), wordingValues(fields, clinicName));
    const headline = plainText(layout.headline);
    expect(headline.length).toBeGreaterThan(10);
    expect(email.text.split("\n")[0]).toBe(`${URGENCY_LOOK[URGENCY[event as OpsEvent]].tag}: ${headline}`);
    expect(slack.split("\n")[0]).toContain(`*${headline.replace(/&/g, "&amp;")}*`);
    // Step 1 is the do-first box, and appears nowhere else.
    const first = plainText(layout.doFirst!);
    expect(email.text.split(first).length - 1).toBe(1);
    expect(slack.replace(/\*/g, "").split(first.replace(/\*/g, "")).length - 1).toBe(1);
    expect(email.text).not.toMatch(/^1\. /m);
    expect(email.html).toContain("Do this first");
    for (const body of [email.text, slack]) expect(body, event).not.toMatch(MARKER_LEFT);
    const visible = email.html.replace(/<style>[\s\S]*?<\/style>/, "");
    expect(visible, event).not.toMatch(/\*\*|__|==|[-]|undefined/);
  });

  test("a headline is a plain line of at most 90 characters, not the title again, from allow-listed fields", () => {
    // Every event has a headline (lanes N5a and N5b): an event added without
    // one fails here, so its writer adds the headline with it.
    const withHeadline = OPS_EVENTS.filter((e) => ALERT_WORDING[e]!.headline);
    expect([...withHeadline].sort()).toEqual([...OPS_EVENTS].sort());
    for (const event of withHeadline) {
      const wording = ALERT_WORDING[event]!;
      const headline = wording.headline!;
      expect(codeProblems(headline), event).toEqual([]);
      expect(placeholdersOf(headline).every((k) => isPlaceholderAllowed(k) && (k === "clinicName" || k === "percent" || EVENT_FIELDS[event]!.includes(k))), event).toBe(true);
      const rendered = plainText(layoutAlert(alertWording(event, sampleFields(event)), wordingValues(sampleFields(event), "Radiance Med Spa")).headline);
      expect(rendered.length, `${event}: ${rendered}`).toBeLessThanOrEqual(90);
      // Not the title again, however it is cased, punctuated or named.
      const norm = (t: string) => t.toLowerCase().replace(/radiance med spa|this clinic|a clinic('s)?|the clinic('s)?/g, "").replace(/[^a-z0-9]+/g, " ").trim();
      expect(norm(rendered), event).not.toBe(norm(wording.title));
      expect(norm(rendered).startsWith(norm(wording.title)), event).toBe(false);
    }
    // The dead letter's own headline.
    const dead = layoutAlert(alertWording("critical_notice_undelivered", { status: "dead" }), wordingValues({ kind: "suspended" }, "Glow"));
    expect(plainText(dead.headline)).toBe("Glow never got a suspension notice: it will not be sent");
    // The headline replaces the first sentence; the rest does not restate it.
    expect(plainText(dead.detail)).toBe("It used every retry, was refused outright on its first try, or the clinic has no address to send to.");
  });

  test("without a headline, the title with the clinic's name stands in, and the whole of what happened stays", () => {
    // Every real event has a headline now, so the fallback is proved on synthetic wordings.
    const synthetic = (title: string): AlertWording => ({
      title,
      whatHappened: "Something changed at {clinicName}. Nothing else is known.",
      whyItMatters: "It matters.",
      steps: ["Open the clinic's Setup tab.", "Check the Care tab."],
      event: "connection_broken",
    });
    const possessive = layoutAlert(synthetic("A clinic's connection stopped working"), wordingValues({}, "Glow"));
    expect(possessive.headlineIsFallback).toBe(true);
    expect(plainText(possessive.headline)).toBe("Glow's connection stopped working");
    expect(plainText(possessive.detail)).toBe("Something changed at Glow. Nothing else is known.");
    expect(plainText(layoutAlert(synthetic("A clinic is held back from going live"), wordingValues({}, "Glow")).headline)).toBe(
      "Glow is held back from going live",
    );
    expect(plainText(layoutAlert(synthetic("A channel's first answer was lost"), wordingValues({}, "Glow")).headline)).toBe(
      "Glow: A channel's first answer was lost",
    );
    expect(plainText(layoutAlert(synthetic("Time to review the reports"), wordingValues({}, null)).headline)).toBe(
      "Time to review the reports",
    );
  });
;

  test("the six previews read as the owner was shown them", () => {
    const late = renderOpsAlert(
      { event: "critical_notice_undelivered", clinicId: CLINIC, clinicName: "Radiance Med Spa", kind: "payment_failed", status: "late", attempts: 3 },
      CTX,
    );
    expect(late.preheader).toBe("URGENT: Radiance Med Spa has not received a payment-failed notice: over 10 minutes late");
    expect(late.html).toContain("<strong>Radiance Med Spa</strong> has not received <strong>a payment-failed notice</strong>");
    expect(late.html).toContain("background:#cf222e");
    expect(late.text).toContain("MORE DETAIL");
    expect(late.text).toContain("WHY IT MATTERS:");
    expect(late.text).toContain("THEN:\n2. ");
  });
});

describe("lane N4 review", () => {
  test("no wording or headline carries an author marker it did not mean", () => {
    // No wording uses author markers today; one that does must say so here.
    const INTENDED: readonly string[] = [];
    for (const [event, wording] of Object.entries(ALERT_WORDING)) {
      const texts = [wording!.title, wording!.headline ?? "", wording!.whatHappened, wording!.whyItMatters, ...wording!.steps];
      for (const text of texts) {
        if (INTENDED.includes(event)) continue;
        expect(text, `${event}: ${text.slice(0, 60)}`).not.toMatch(/\*\*|__|==/);
      }
    }
  });

  test("a name in a step is never taken for a console place", () => {
    const step = fill("Phone {clinicName} from its Care tab.", { clinicName: "Care tab Clinic" }, { values: false, neutral: true });
    const places = parseMarkup(emphasisePlaces(step)).filter((s) => s.underline).map((s) => s.text);
    expect(places).toEqual(["Care tab"]);
    expect(plainText(emphasisePlaces(step))).toBe("Phone Care tab Clinic from its Care tab.");
  });

  test("usage alerts label the window's first day Counted since", () => {
    // usage_cap_reached has no headline yet, so its sentence still says "counted since".
    for (const event of ["usage_near_cap"] as const) {
      const fields = { clinicId: CLINIC, meter: "voice_minutes", windowStart: "2026-10-01T00:00:00.000Z", used: 9, included: 10 };
      expect(sharedFacts(fields, alertWording(event, fields)), event).toContainEqual(["Counted since", "1 Oct"]);
    }
  });

  test("a zero count reads as words, never 0 days or 0 steps", () => {
    const decision = layoutAlert(alertWording("lifecycle_decision_due", {}), wordingValues({ remainingDays: 0, stepsLeftCount: 2 }, "Glow"));
    expect(plainText(decision.headline)).toBe("Glow has less than a day left to set up AYA, with 2 steps to go");
    const soon = layoutAlert(alertWording("lifecycle_closing_soon", {}), wordingValues({ remainingDays: 0, stepsLeftCount: 0 }, "Glow"));
    expect(plainText(soon.headline)).not.toMatch(/\b0 /);
    // A zero count in an optional clause drops the clause (lane N4 review).
    expect(plainText(soon.headline)).toBe("Glow is nearly set up, less than a day left");
    const waiting = layoutAlert(alertWording("lifecycle_closing_waiting_on_us", {}), wordingValues({ waitedDays: 0, remainingDays: 3 }, "Glow"));
    expect(plainText(waiting.headline)).toContain("waited on us less than a day");
    expect(fill("{count:connection} went unchecked", { count: 0 })).toBe("No connections went unchecked");
  });

  test("a long clinic name is cut in the headline only, at a word, with an ellipsis", () => {
    const long = "The Very Long Name Aesthetic and Wellness Clinic of the Greater Riverside Valley Area North Campus Annex";
    expect(shortName(long)).toBe("The Very Long Name Aesthetic and…");
    expect(shortName("Glow")).toBe("Glow");
    const over: string[] = [];
    for (const event of OPS_EVENTS) {
      const fields = sampleFields(event);
      const layout = layoutAlert(alertWording(event, fields), wordingValues(fields, long));
      const headline = plainText(layout.headline);
      if (headline.length > 90) over.push(`${headline.length} ${event}: ${headline}`);
      expect(headline, event).not.toContain(long);
    }
    expect(over).toEqual([]);
    const email = renderOpsAlert({ event: "usage_near_cap", clinicId: CLINIC, clinicName: long, used: 9, included: 10 }, CTX);
    expect(email.text.split("\n")[0]).toContain("The Very Long Name Aesthetic and…");
    expect(email.text).toContain(`Clinic: ${long}`);
  });

  // Ten events of different shapes: with a clinic and without, a business
  // name, counts, days, closed words.
  const HOSTILE_EVENTS: readonly OpsEvent[] = [
    "critical_notice_undelivered",
    "setup_request_reply_past_due",
    "usage_near_cap",
    "calendar_write_stuck",
    "lifecycle_decision_due",
    "clinic_availability_changed",
    "export_due_undelivered",
    "dmarc_review_due",
    "daily_email_count_70",
    "vendor_agreement_lapsed",
    "calendar_broken",
    "ops_digest_summary",
  ];
  test.each(HOSTILE_EVENTS.map((e) => [e]))("%s: a hostile name brings no emphasis or markup", (event) => {
    const hostile = "**Glow** __x__ ==y== <b>z</b> & co";
    const fields = { ...sampleFields(event as OpsEvent) };
    if ("business" in fields) fields.business = "Glow __Med__ Spa";
    const email = renderOpsAlert({ event: event as OpsEvent, ...fields, clinicName: hostile }, CTX);
    expect(email.html, event).not.toContain("<b>z</b>");
    expect(email.html, event).not.toMatch(/<u>x<\/u>|<mark[^>]*>y<\/mark>|<strong>Glow<\/strong>|<u>Med<\/u>/);
    const slack = slackText({ event: event as OpsEvent, fields, clinicName: hostile });
    expect(slack, event).not.toContain("<b>");
    // Slack: the name's own * and _ are stripped (slackName), so they cannot bold or italicise.
    expect(slack, event).not.toMatch(/\*\*?Glow\*|_x_/);
    for (const body of [email.text, slack]) expect(body, event).not.toMatch(/[-]|undefined/);
  });
});
