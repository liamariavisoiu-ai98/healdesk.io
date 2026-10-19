import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { purgeStaleLeads, recordDemoUnlock } from "./leads";
import { createSetupRequest, purgeStaleSetupRequests, setupRequestsPastReply, updateSetupRequest } from "./setup-requests";
import { FakeSheets, __setSheetsClientForTests } from "./sheets/client";
import { __resetSheetSchemaForTests } from "./sheets/schema";

/**
 * Setup requests keep to the privacy policy's clock: twelve months after the
 * last update, then gone. A purged lead leaves no dangling id behind on a
 * request that came from it.
 */

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

async function request(email: string, leadId: string | null = null, at = new Date()) {
  const created = await createSetupRequest(
    { name: "Alex Chen", clinicName: "Radiance", website: null, email, channels: ["web"], leadId, ipAddress: null },
    at,
  );
  if (!created.ok) throw new Error("the fake Sheet refused a request");
  return created.request;
}

describe("setup request retention", () => {
  test("a request untouched for the retention period is deleted; a recent one stays", async () => {
    const old = new Date();
    old.setUTCMonth(old.getUTCMonth() - 13);
    await request("old@clinic.com", null, old);
    await request("new@clinic.com");
    expect(await purgeStaleSetupRequests(12)).toBe(1);
    expect(sheets.records("setup_requests").map((r) => r.email)).toEqual(["new@clinic.com"]);
  });

  test("purging a lead blanks the lead id on a request that came from it", async () => {
    const lead = await recordDemoUnlock({ email: "lead@clinic.com", isBusinessEmail: true });
    if (!lead.ok) throw new Error("no lead");
    await request("lead@clinic.com", lead.leadId);
    const row = sheets.records("leads")[0]!;
    const longAgo = new Date();
    longAgo.setUTCMonth(longAgo.getUTCMonth() - 13);
    const leads = sheets.tabs.get("leads")!;
    const header = leads[0]!;
    leads[1]![header.indexOf("last_seen_at")] = longAgo.toISOString();
    expect(row.id).toBe(lead.leadId);

    expect(await purgeStaleLeads(12)).toBe(1);
    expect(sheets.records("setup_requests")[0]!.lead_id).toBe("");
  });
});

describe("setup requests past the reply day P2 promised", () => {
  test("a new request whose day has passed in New York is owed; one replied to, declined, unsubscribed or still on its day is not", async () => {
    // Tuesday 6 October 2026, 11:00 in New York: P2 promised Wednesday 7 October.
    const asked = new Date("2026-10-06T15:00:00Z");
    const owed = await request("owed@clinic.com", null, asked);
    const invited = await request("invited@clinic.com", null, asked);
    const declined = await request("declined@clinic.com", null, asked);
    const unsubscribed = await request("unsubscribed@clinic.com", null, asked);
    await updateSetupRequest(invited.id, { status: "invited", invitedAt: asked });
    await updateSetupRequest(declined.id, { status: "declined" });
    await updateSetupRequest(unsubscribed.id, { unsubscribedAt: asked });

    // 22:00 on the 7th in New York: still the promised day.
    expect(await setupRequestsPastReply(new Date("2026-10-08T02:00:00Z"))).toEqual([]);
    // 09:07 on the 8th, when the cron runs.
    const due = await setupRequestsPastReply(new Date("2026-10-08T13:07:00Z"));
    expect(due.map((r) => r.id)).toEqual([owed.id]);
    // A month on, it has long been raised once; the check stops looking.
    expect(await setupRequestsPastReply(new Date("2026-11-08T13:07:00Z"))).toEqual([]);
  });
});
