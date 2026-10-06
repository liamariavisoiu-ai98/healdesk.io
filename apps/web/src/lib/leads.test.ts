import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeSheets, __setSheetsClientForTests } from "./sheets/client";
import { CALL_CONSENTS, LEADS, LEAD_EVENTS, TABS, __resetSheetSchemaForTests } from "./sheets/schema";
import {
  COHORT_CREDIT_TOUCH_STEP,
  canEmail,
  cohortCreditLive,
  findLeadByEmail,
  findLeadById,
  leadsForAbandonment,
  leadsForNurture,
  markCallPlaced,
  markCheckoutAbandoned,
  markCheckoutStarted,
  markConverted,
  markDeliveryFailure,
  markUnsubscribed,
  purgeStaleCallConsents,
  purgeStaleLeads,
  recordCallConsent,
  recordDemoUnlock,
  recordTouch,
} from "./leads";

/**
 * The marketing Sheet must never grow a column that could describe a
 * patient. This is a denylist, not an allowlist, because the point is to
 * catch the obvious mistake at review time: someone adds `patient_name` to
 * the claim form and it lands in the wrong store. Anything subtler is a
 * design review, not a regex.
 */
const PHI_SHAPED = [
  /patient/i,
  /\bdob\b|date_of_birth|birth/i,
  /diagnos/i,
  /treatment_history|procedure/i,
  /condition/i,
  /\bnotes?\b/i,
  /medical/i,
  /transcript/i,
  /insurance/i,
];

describe("marketing sheet schema", () => {
  it("has no patient-shaped columns on any tab", () => {
    expect(TABS.map((t) => t.title)).toEqual(["leads", "lead_events", "call_consents", "counters", "demo_sessions"]);
    for (const tab of TABS) {
      for (const column of tab.columns) {
        for (const pattern of PHI_SHAPED) {
          expect(column.header, `${tab.title}.${column.header} looks like PHI`).not.toMatch(pattern);
        }
      }
    }
  });
});

const MONTH = 30 * 24 * 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

describe("the lead store over the Sheet", () => {
  let sheets: FakeSheets;

  beforeEach(() => {
    sheets = new FakeSheets();
    __setSheetsClientForTests(sheets);
    __resetSheetSchemaForTests();
  });

  afterEach(() => {
    __setSheetsClientForTests(null);
    __resetSheetSchemaForTests();
  });

  it("provisions the five tabs with their header rows on first use, and leaves the owner's tabs alone", async () => {
    await recordDemoUnlock({ email: "a@b.co", isBusinessEmail: true });
    expect([...sheets.tabs.keys()]).toEqual(["Sheet1", "leads", "lead_events", "call_consents", "counters", "demo_sessions"]);
    expect(sheets.tabs.get("leads")![0]).toEqual(LEADS.columns.map((c) => c.header));
    expect(sheets.tabs.get("lead_events")![0]).toEqual(LEAD_EVENTS.columns.map((c) => c.header));
    expect(sheets.tabs.get("call_consents")![0]).toEqual(CALL_CONSENTS.columns.map((c) => c.header));
    // Once per process: a second call does not re-read the sheet list.
    const calls = sheets.calls.length;
    await recordDemoUnlock({ email: "c@d.co", isBusinessEmail: true });
    expect(sheets.calls.slice(calls).filter((c) => c === "getSheetTitles")).toHaveLength(0);
  });

  it("refuses a tab whose header row is not ours", async () => {
    sheets.tabs.set("leads", [["something", "else"], ["x", "y"]]);
    const r = await recordDemoUnlock({ email: "a@b.co", isBusinessEmail: true });
    expect(r).toEqual({ ok: false, reason: "unavailable" });
    expect(sheets.tabs.get("leads")![0]).toEqual(["something", "else"]);
  });

  it("stores one row per normalised email and counts repeat unlocks", async () => {
    const a = await recordDemoUnlock({ email: "Dr.Chen@Clinic.com", isBusinessEmail: true });
    const b = await recordDemoUnlock({ email: "  dr.chen@clinic.com ", isBusinessEmail: true });
    expect(a.ok && a.created).toBe(true);
    expect(b.ok && !b.created).toBe(true);
    expect(a.ok && b.ok && a.leadId === b.leadId).toBe(true);

    const rows = sheets.records("leads");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email_normalized).toBe("dr.chen@clinic.com");
    expect(rows[0]!.email).toBe("Dr.Chen@Clinic.com");
    expect(rows[0]!.unlock_count).toBe(2);
    expect(rows[0]!.lead_score).toBe("business");
    expect(rows[0]!.is_business_email).toBe(true);
    // Timestamps are ISO strings, never date cells.
    expect(rows[0]!.first_seen_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(sheets.records("lead_events").map((e) => e.name)).toEqual(["demo_unlocked", "demo_unlocked"]);
    expect(sheets.records("lead_events").every((e) => e.lead_id === (a.ok ? a.leadId : ""))).toBe(true);
  });

  it("records consent only with the wording, and never withdraws it on a later unlock", async () => {
    await recordDemoUnlock({ email: "owner@spa.com", isBusinessEmail: true });
    let row = sheets.records("leads")[0]!;
    expect(row.marketing_consent).toBe(false);
    expect(row.consent_at).toBe("");
    expect(row.consent_text).toBe("");

    await recordDemoUnlock({
      email: "owner@spa.com",
      isBusinessEmail: true,
      marketingConsent: true,
      noticeVersion: "v-test",
      consentText: "Email me about AYA.",
    });
    row = sheets.records("leads")[0]!;
    expect(row.marketing_consent).toBe(true);
    expect(row.consent_at).not.toBe("");
    expect(row.consent_text).toBe("Email me about AYA.");
    expect(row.consent_notice_version).toBe("v-test");

    // A third unlock with the box unticked leaves the consent exactly as it was.
    const consentAt = row.consent_at;
    await recordDemoUnlock({ email: "owner@spa.com", isBusinessEmail: true });
    row = sheets.records("leads")[0]!;
    expect(row.marketing_consent).toBe(true);
    expect(row.consent_text).toBe("Email me about AYA.");
    expect(row.consent_at).toBe(consentAt);

    // And the wording is never stored without the tick.
    await recordDemoUnlock({ email: "other@spa.com", isBusinessEmail: true, consentText: "Email me", noticeVersion: "v" });
    const other = sheets.records("leads")[1]!;
    expect(other.marketing_consent).toBe(false);
    expect(other.consent_text).toBe("");
    expect(other.consent_notice_version).toBe("");
  });

  it("purges leads not seen for the retention period, with their events, and keeps the call evidence", async () => {
    const old = await recordDemoUnlock({ email: "old@clinic.com", isBusinessEmail: true });
    await recordDemoUnlock({ email: "fresh@clinic.com", isBusinessEmail: true });
    const consentId = await recordCallConsent({
      phoneE164: "+14155550100",
      consentVersion: "v1",
      consentText: "Call me once.",
      leadEmail: "old@clinic.com",
    });
    expect(consentId).not.toBeNull();
    expect(sheets.records("call_consents")[0]!.lead_id).toBe(old.ok ? old.leadId : "");

    sheets.setCell("leads", 2, "last_seen_at", iso(13 * MONTH));
    expect(await purgeStaleLeads(12)).toBe(1);

    expect(sheets.records("leads").map((r) => r.email_normalized)).toEqual(["fresh@clinic.com"]);
    // Events went with the lead; none are orphaned.
    const remainingIds = new Set(sheets.records("leads").map((r) => r.id));
    for (const event of sheets.records("lead_events")) expect(remainingIds.has(String(event.lead_id))).toBe(true);
    // The consent row stays, with the link blanked: ON DELETE SET NULL, by hand.
    const consent = sheets.records("call_consents")[0]!;
    expect(consent.id).toBe(consentId);
    expect(consent.lead_id).toBe("");
    expect(consent.consent_text).toBe("Call me once.");

    // Nothing newer goes, and a second run finds nothing.
    expect(await purgeStaleLeads(12)).toBe(0);
  });

  it("purges consent records past the limitation period and nothing newer", async () => {
    await recordCallConsent({ phoneE164: "+14155550100", consentVersion: "v1", consentText: "t" });
    await recordCallConsent({ phoneE164: "+14155550101", consentVersion: "v1", consentText: "t" });
    sheets.setCell("call_consents", 2, "at", iso(49 * MONTH));
    expect(await purgeStaleCallConsents(4)).toBe(1);
    expect(sheets.records("call_consents").map((r) => r.phone_e164)).toEqual(["+14155550101"]);
  });

  it("keeps only the referrer's host and a well-formed campaign", async () => {
    await recordDemoUnlock({
      email: "x@y.com",
      isBusinessEmail: true,
      referrer: "https://www.google.com/search?q=med+spa+ai&utm=secret",
      campaign: "dental-q4",
    });
    const row = sheets.records("leads")[0]!;
    expect(row.referrer_host).toBe("www.google.com");
    expect(row.source_campaign).toBe("dental-q4");
    expect(JSON.stringify(sheets.tabs.get("leads"))).not.toContain("secret");
  });

  it("dedupes on the earliest row if a race ever produced two", async () => {
    const first = await recordDemoUnlock({ email: "race@clinic.com", isBusinessEmail: true });
    // A second instance appended the same address before it could see the first.
    const clone = [...sheets.tabs.get("leads")![1]!];
    clone[0] = "11111111-1111-4111-8111-111111111111";
    sheets.tabs.get("leads")!.push(clone);

    const found = await findLeadByEmail("race@clinic.com");
    expect(found?.id).toBe(first.ok ? first.leadId : "");
    expect(await findLeadById("11111111-1111-4111-8111-111111111111")).toBeNull();
    // A further unlock updates the surviving row, not the duplicate.
    await recordDemoUnlock({ email: "race@clinic.com", isBusinessEmail: true });
    const rows = sheets.records("leads");
    expect(rows[0]!.unlock_count).toBe(2);
    expect(rows[1]!.unlock_count).toBe(1);
  });

  it("stamps the cohort credit once, at the Day 7 step, and the checkout honours it inside the window", async () => {
    const r = await recordDemoUnlock({ email: "n@clinic.com", isBusinessEmail: true, marketingConsent: true, consentText: "yes", noticeVersion: "v" });
    const id = r.ok ? r.leadId : "";

    await recordTouch(id, { kind: "nurture", step: 0 });
    let lead = (await findLeadById(id))!;
    expect(lead.nurtureStep).toBe(1);
    expect(lead.lastTouchAt).toBeInstanceOf(Date);
    expect(lead.cohortCreditOfferedAt).toBeNull();
    expect(cohortCreditLive(lead)).toBe(false);

    await recordTouch(id, { kind: "nurture", step: COHORT_CREDIT_TOUCH_STEP });
    lead = (await findLeadById(id))!;
    expect(lead.nurtureStep).toBe(COHORT_CREDIT_TOUCH_STEP + 1);
    const offeredAt = lead.cohortCreditOfferedAt;
    expect(offeredAt).toBeInstanceOf(Date);
    expect(cohortCreditLive(lead)).toBe(true);

    // A resent Day 7 touch does not move the stamp.
    await recordTouch(id, { kind: "nurture", step: COHORT_CREDIT_TOUCH_STEP });
    lead = (await findLeadById(id))!;
    expect(lead.cohortCreditOfferedAt?.getTime()).toBe(offeredAt!.getTime());

    // And the window closes when the email said it would.
    const later = new Date(offeredAt!.getTime() + 15 * 24 * 60 * 60 * 1000);
    expect(cohortCreditLive(lead, later)).toBe(false);
    expect(sheets.records("lead_events").map((e) => e.name)).toEqual([
      "demo_unlocked",
      "nurture_sent",
      "nurture_sent",
      "nurture_sent",
    ]);
  });

  it("selects leads for nurture and for abandonment, and stops on the right facts", async () => {
    const consented = { isBusinessEmail: true, marketingConsent: true, consentText: "yes", noticeVersion: "v" };
    const nurture = await recordDemoUnlock({ email: "nurture@c.com", ...consented });
    await recordDemoUnlock({ email: "silent@c.com", isBusinessEmail: true });
    const unsub = await recordDemoUnlock({ email: "unsub@c.com", ...consented });
    await recordDemoUnlock({ email: "bounced@c.com", ...consented });
    await recordDemoUnlock({ email: "customer@c.com", ...consented });
    const done = await recordDemoUnlock({ email: "done@c.com", ...consented });

    expect(await markUnsubscribed(unsub.ok ? unsub.leadId : "", "link")).toBe(true);
    expect(await markUnsubscribed(unsub.ok ? unsub.leadId : "", "link")).toBe(false);
    expect(await markDeliveryFailure("bounced@c.com", "bounce")).toBe(true);
    expect(await markDeliveryFailure("nobody@c.com", "bounce")).toBe(false);
    await markConverted({ email: "customer@c.com", plan: "growth", mrrUsd: 499.6 });
    await recordTouch(done.ok ? done.leadId : "", { kind: "nurture", step: 3 });

    const due = await leadsForNurture(4);
    expect(due.map((l) => l.emailNormalized)).toEqual(["nurture@c.com"]);
    expect(nurture.ok && due[0]!.id === nurture.leadId).toBe(true);
    expect(canEmail((await findLeadByEmail("unsub@c.com"))!, "marketing")).toEqual({ ok: false, reason: "unsubscribed" });
    expect(canEmail((await findLeadByEmail("bounced@c.com"))!, "relationship")).toEqual({ ok: false, reason: "bounced" });
    expect(canEmail((await findLeadByEmail("customer@c.com"))!, "marketing")).toEqual({ ok: false, reason: "already a customer" });
    const customer = (await findLeadByEmail("customer@c.com"))!;
    expect(customer.convertedPlan).toBe("growth");
    expect(customer.convertedMrrUsd).toBe(500);

    // Abandonment: a checkout that started over an hour ago, unfinished, not yet nudged.
    const started = await markCheckoutStarted({ email: "buyer@c.com", clinicName: "Radiance", plan: "growth", interval: "monthly" });
    expect(started).toMatch(/^[0-9a-f-]{36}$/);
    await markCheckoutStarted({ email: "customer@c.com", plan: "growth", interval: "monthly" });
    // Started just now: not yet older than a minute ago, so not yet due.
    expect(await leadsForAbandonment(new Date(Date.now() - 60_000))).toEqual([]);
    await markCheckoutAbandoned("buyer@c.com");
    const abandoned = await leadsForAbandonment(new Date(Date.now() + 60_000));
    expect(abandoned.map((l) => l.emailNormalized)).toEqual(["buyer@c.com"]);
    expect(abandoned[0]!.clinicName).toBe("Radiance");
    expect(abandoned[0]!.checkoutAbandonedAt).toBeInstanceOf(Date);

    await recordTouch(started!, { kind: "abandonment" });
    expect(await leadsForAbandonment(new Date(Date.now() + 60_000))).toEqual([]);
    // A new attempt reopens the question.
    await markCheckoutStarted({ email: "buyer@c.com", plan: "growth", interval: "annual" });
    expect((await findLeadByEmail("buyer@c.com"))!.checkoutAbandonedAt).toBeNull();
    expect(sheets.records("leads")).toHaveLength(7);
  });

  it("writes the call consent before the call and stamps it when placed", async () => {
    const lead = await recordDemoUnlock({ email: "caller@c.com", isBusinessEmail: true });
    const id = await recordCallConsent({
      phoneE164: "+14155550123",
      consentVersion: "2026-09-01",
      consentText: "AYA may call this number once.",
      ipAddress: "203.0.113.9",
      userAgent: "x".repeat(400),
      leadEmail: "caller@c.com",
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    let row = sheets.records("call_consents")[0]!;
    expect(row.id).toBe(id);
    expect(row.lead_id).toBe(lead.ok ? lead.leadId : "");
    expect(row.phone_e164).toBe("+14155550123");
    expect(row.consent_version).toBe("2026-09-01");
    expect(row.consent_text).toBe("AYA may call this number once.");
    expect(String(row.user_agent)).toHaveLength(300);
    expect(row.call_placed_at).toBe("");
    expect(sheets.records("lead_events").map((e) => e.name)).toContain("call_requested");

    await markCallPlaced(id);
    row = sheets.records("call_consents")[0]!;
    expect(row.call_placed_at).toMatch(/Z$/);

    // Without a lead the record is still written.
    const anon = await recordCallConsent({ phoneE164: "+14155550124", consentVersion: "v", consentText: "t" });
    expect(anon).not.toBeNull();
    expect(sheets.records("call_consents")[1]!.lead_id).toBe("");
    await markCallPlaced(null);
    await markCallPlaced("no-such-id");
  });

  it("fails open when the Sheet is unreachable, and says so without the address", async () => {
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      sheets.getValues = async () => {
        throw new Error("boom");
      };
      sheets.appendRows = async () => {
        throw new Error("boom");
      };
      const r = await recordDemoUnlock({ email: "secret@c.com", isBusinessEmail: true });
      expect(r).toEqual({ ok: false, reason: "unavailable" });
      expect(await recordCallConsent({ phoneE164: "+1", consentVersion: "v", consentText: "t" })).toBeNull();
      expect(JSON.stringify(errors)).not.toContain("secret@c.com");
    } finally {
      console.error = original;
    }
  });
});

describe("recordDemoUnlock without a store", () => {
  it("fails open and reports why", async () => {
    __setSheetsClientForTests(null);
    delete process.env.MARKETING_SHEET_ID;
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    const r = await recordDemoUnlock({ email: "a@b.co", isBusinessEmail: false });
    expect(r).toEqual({ ok: false, reason: "unconfigured" });
    expect(await findLeadByEmail("a@b.co")).toBeNull();
    expect(await leadsForNurture(4)).toEqual([]);
    expect(await purgeStaleLeads(12)).toBe(0);
  });
});
