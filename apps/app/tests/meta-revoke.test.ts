import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { withCredentials } from "@/lib/connections/store";
import { attachMetaChannel, resolveMetaChannel } from "@/lib/meta/channels";
import type { FetchLike } from "@/lib/meta/graph";
import { META_REVOKE_ALERT_AFTER, revokeMetaAccess, revokeTargetOf } from "@/lib/meta/revoke";
import {
  destroyDueClinics,
  markExportDelivered,
  startOffboarding,
} from "@/lib/offboarding/offboarding";
import { runOperation, type Operator } from "@/lib/ops/api";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

/**
 * Terms §7: "We revoke our access to your Google Calendar, your Meta
 * accounts and your payment gateway." Until 19 October 2026 only Google was
 * swept when a service ended; a clinic's Page and WhatsApp tokens stayed
 * sealed, the app stayed subscribed to its webhooks, and its DMs kept
 * arriving until destruction, day 29 to 89 (the audit's R8 item 3). These
 * tests hold lib/meta/revoke.ts to taking the app off each Page and WhatsApp
 * account with the tokens we hold, and erasing the tokens, for a clinic that
 * has left and only for one.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "meta-revoke-test" } as const;
const OPERATOR: Operator = { email: "ops@healdesk.test", request: {} };

type Call = { method: string; url: string; authorization: string | null };

/** A Graph that records each call and answers `answer(url)`, a success by default. */
function fakeGraph(
  answer: (url: string) => { status: number; body: unknown } = () => ({
    status: 200,
    body: { success: true },
  }),
) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ method: init?.method ?? "GET", url, authorization: headers.get("authorization") });
    const { status, body } = answer(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

async function connectAll(
  clinicId: string,
  ids: { page: string; ig: string; phone: string; waba: string },
) {
  await withTenant({ clinicId, actor: ACTOR }, async (tx) => {
    await attachMetaChannel(tx, {
      platform: "messenger",
      externalId: ids.page,
      accessToken: `EAAB-page-${ids.page}`,
      via: "facebook_login",
    });
    await attachMetaChannel(tx, {
      platform: "instagram",
      externalId: ids.ig,
      accessToken: `EAAB-page-${ids.page}`,
      details: { pageId: ids.page },
      via: "facebook_login",
    });
    await attachMetaChannel(tx, {
      platform: "whatsapp",
      externalId: ids.phone,
      accessToken: `EAAB-waba-${ids.waba}`,
      secrets: { registrationPin: "123456" },
      details: { wabaId: ids.waba },
      via: "embedded_signup",
    });
  });
}

async function connections(clinicId: string) {
  return inTenant(
    clinicId,
    async (c) =>
      (
        await c.query<{ id: string; provider: string; status: string; last_error: string | null }>(
          `select id, provider, status::text as status, last_error from provider_connections
          where provider like 'meta-%' order by provider`,
        )
      ).rows,
  );
}

/** The meta_revoke_by_hand alerts raised for a clinic: their code and provider, ids only. */
async function byHand(clinicId: string) {
  return (
    await getMigratorPool().query<{ code: string; provider: string }>(
      `select fields->>'code' as code, fields->>'provider' as provider from ops_alerts
        where event = 'meta_revoke_by_hand' and fields->>'clinicId' = $1
        order by fields->>'provider', fields->>'code'`,
      [clinicId],
    )
  ).rows;
}

async function leave(clinicId: string) {
  await withTenant({ clinicId, actor: ACTOR }, (tx) => startOffboarding(tx, "operator"));
}

describe("where each connection's subscription lives", () => {
  test("Messenger and Instagram at their Page, WhatsApp at its business account, nothing for an id that is not Meta's", () => {
    expect(revokeTargetOf("meta-messenger", { externalId: "1001" })).toEqual({
      kind: "page",
      id: "1001",
    });
    expect(revokeTargetOf("meta-instagram", { externalId: "2002", pageId: "1001" })).toEqual({
      kind: "page",
      id: "1001",
    });
    expect(revokeTargetOf("meta-whatsapp", { externalId: "3003", wabaId: "4004" })).toEqual({
      kind: "waba",
      id: "4004",
    });
    // An Instagram row with no Page, or a WhatsApp row with no account (an
    // operator-pasted token), has nothing to unsubscribe: its token is erased alone.
    expect(revokeTargetOf("meta-instagram", { externalId: "2002" })).toBeNull();
    expect(revokeTargetOf("meta-whatsapp", { externalId: "3003" })).toBeNull();
    expect(revokeTargetOf("meta-messenger", { externalId: "../me" })).toBeNull();
    expect(revokeTargetOf("google-calendar", { externalId: "1001" })).toBeNull();
  });
});

describeDb("revoking healdesk's Meta access when the service ends", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 180_000);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await closePools();
  });

  test("a clinic that has left is taken off its Page and its WhatsApp account with the tokens we hold, and the tokens are erased", async () => {
    const c = await seedClinic("meta-revoke-left");
    await connectAll(c.clinicId, {
      page: "510000000000001",
      ig: "510000000000002",
      phone: "510000000000003",
      waba: "510000000000004",
    });
    const graph = fakeGraph();

    // Still a customer: nothing is revoked, and Meta is not asked.
    expect(await revokeMetaAccess([c.clinicId], { fetchImpl: graph.fetchImpl })).toEqual({
      clinics: 0,
      revoked: 0,
      failed: 0,
    });
    expect(graph.calls).toEqual([]);

    await leave(c.clinicId);
    expect(await revokeMetaAccess([c.clinicId], { fetchImpl: graph.fetchImpl })).toEqual({
      clinics: 1,
      revoked: 3,
      failed: 0,
    });
    // One DELETE per Page (Instagram rides on it) and one per account, each with its own token in the header.
    expect(
      graph.calls
        .map((call) => [
          call.method,
          call.url.replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+/, ""),
          call.authorization,
        ])
        .sort(),
    ).toEqual(
      [
        ["DELETE", "/510000000000001/subscribed_apps", "Bearer EAAB-page-510000000000001"],
        ["DELETE", "/510000000000004/subscribed_apps", "Bearer EAAB-waba-510000000000004"],
      ].sort(),
    );
    for (const call of graph.calls) expect(call.url).not.toMatch(/EAAB/);

    const rows = await connections(c.clinicId);
    expect(rows.map((r) => [r.provider, r.status, r.last_error])).toEqual([
      ["meta-instagram", "revoked", "service_ended"],
      ["meta-messenger", "revoked", "service_ended"],
      ["meta-whatsapp", "revoked", "service_ended"],
    ]);
    // Nothing of a token is left to open, and no webhook resolves to the clinic.
    for (const row of rows) {
      const left = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        withCredentials(
          tx.db,
          { clinicId: c.clinicId, connectionId: row.id },
          async (creds) => creds,
        ),
      );
      expect(left).toEqual({});
    }
    for (const id of ["510000000000001", "510000000000002", "510000000000003"]) {
      expect(await resolveMetaChannel(id)).toBeNull();
    }
    // The audit trail says each went, and why.
    const audited = await inTenant(
      c.clinicId,
      async (q) =>
        (
          await q.query<{ n: number }>(
            `select count(*)::int as n from audit_log
            where resource_type = 'provider_connection' and metadata->>'outcome' = 'revoked' and metadata->>'reason' = 'service_ended'`,
          )
        ).rows[0]!.n,
    );
    expect(audited).toBe(3);

    // Done once: a second run finds nothing standing and asks Meta nothing.
    const again = fakeGraph();
    expect(await revokeMetaAccess([c.clinicId], { fetchImpl: again.fetchImpl })).toEqual({
      clinics: 1,
      revoked: 0,
      failed: 0,
    });
    expect(again.calls).toEqual([]);
  });

  test("a refusal from Meta keeps the token for the next run; a token Meta says is dead is erased at once", async () => {
    const c = await seedClinic("meta-revoke-refused");
    await connectAll(c.clinicId, {
      page: "520000000000001",
      ig: "520000000000002",
      phone: "520000000000003",
      waba: "520000000000004",
    });
    await leave(c.clinicId);

    // The Page answers a server error; the WhatsApp token is already dead (190).
    const flaky = fakeGraph((url) =>
      url.includes("520000000000001")
        ? { status: 500, body: { error: { message: "Please retry", code: 2 } } }
        : { status: 400, body: { error: { message: "Error validating access token", code: 190 } } },
    );
    expect(await revokeMetaAccess([c.clinicId], { fetchImpl: flaky.fetchImpl })).toEqual({
      clinics: 1,
      revoked: 1,
      failed: 2,
    });
    expect((await connections(c.clinicId)).map((r) => [r.provider, r.status])).toEqual([
      ["meta-instagram", "pending"],
      ["meta-messenger", "pending"],
      ["meta-whatsapp", "revoked"],
    ]);

    // The next hourly run, with no list, finds the clinic and finishes it.
    const fine = fakeGraph();
    const run = await revokeMetaAccess(undefined, { fetchImpl: fine.fetchImpl });
    expect(run.revoked).toBeGreaterThanOrEqual(2);
    expect(fine.calls.map((call) => call.url)).toEqual([
      expect.stringMatching(/\/520000000000001\/subscribed_apps$/),
    ]);
    expect((await connections(c.clinicId)).every((r) => r.status === "revoked")).toBe(true);
  });

  test("the hourly run leaves a clinic that is still a customer alone", async () => {
    const live = await seedClinic("meta-revoke-live");
    await connectAll(live.clinicId, {
      page: "530000000000001",
      ig: "530000000000002",
      phone: "530000000000003",
      waba: "530000000000004",
    });
    const graph = fakeGraph();
    await revokeMetaAccess(undefined, { fetchImpl: graph.fetchImpl });
    expect(graph.calls.filter((call) => call.url.includes("53000000000000"))).toEqual([]);
    expect((await connections(live.clinicId)).every((r) => r.status !== "revoked")).toBe(true);
    expect((await resolveMetaChannel("530000000000001"))?.clinicId).toBe(live.clinicId);
  });

  test("an operator's offboarding revokes the clinic's Meta access in the same step", async () => {
    const c = await seedClinic("meta-revoke-ops");
    await connectAll(c.clinicId, {
      page: "540000000000001",
      ig: "540000000000002",
      phone: "540000000000003",
      waba: "540000000000004",
    });
    const graph = fakeGraph();
    vi.stubGlobal("fetch", graph.fetchImpl);
    await runOperation(
      "startOffboarding",
      { clinicId: c.clinicId, reason: "cancelled by phone" },
      OPERATOR,
    );
    expect(
      graph.calls
        .filter((call) => call.method === "DELETE")
        .map((call) => call.url)
        .sort(),
    ).toEqual([
      expect.stringMatching(/\/540000000000001\/subscribed_apps$/),
      expect.stringMatching(/\/540000000000004\/subscribed_apps$/),
    ]);
    expect((await connections(c.clinicId)).every((r) => r.status === "revoked")).toBe(true);
  });

  // The review's finding: Meta's subscription is the WhatsApp Business
  // account's or the Page's, not the clinic's. Two locations can each have
  // their own number on one account (the one-asset rule is on the number), so
  // unsubscribing it for the one that left ended the other's messages, its
  // channel still showing live.
  test("a WhatsApp account or Page another clinic in service still uses is left subscribed, and only the leaving clinic's token goes", async () => {
    const leaving = await seedClinic("meta-revoke-shared-a");
    const staying = await seedClinic("meta-revoke-shared-b");
    const attach = (clinicId: string, input: Parameters<typeof attachMetaChannel>[1]) =>
      withTenant({ clinicId, actor: ACTOR }, (tx) => attachMetaChannel(tx, input));
    await attach(leaving.clinicId, {
      platform: "whatsapp",
      externalId: "560000000000001",
      accessToken: "EAAB-a-waba",
      details: { wabaId: "560000000000009" },
      via: "embedded_signup",
    });
    await attach(staying.clinicId, {
      platform: "whatsapp",
      externalId: "560000000000002",
      accessToken: "EAAB-b-waba",
      details: { wabaId: "560000000000009" },
      via: "embedded_signup",
    });
    await attach(leaving.clinicId, {
      platform: "messenger",
      externalId: "560000000000007",
      accessToken: "EAAB-a-page",
      via: "facebook_login",
    });
    await attach(staying.clinicId, {
      platform: "instagram",
      externalId: "560000000000003",
      accessToken: "EAAB-b-page",
      details: { pageId: "560000000000007" },
      via: "facebook_login",
    });
    await leave(leaving.clinicId);

    const graph = fakeGraph();
    expect(await revokeMetaAccess([leaving.clinicId], { fetchImpl: graph.fetchImpl })).toEqual({
      clinics: 1,
      revoked: 2,
      failed: 0,
    });
    expect(graph.calls).toEqual([]);
    expect((await connections(leaving.clinicId)).every((r) => r.status === "revoked")).toBe(true);
    const outcomes = await inTenant(leaving.clinicId, async (q) =>
      (
        await q.query<{ o: string }>(
          `select metadata->>'outcome' as o from audit_log where resource_type = 'provider_connection' and metadata->>'reason' = 'service_ended'`,
        )
      ).rows.map((r) => r.o),
    );
    expect(outcomes).toEqual(["shared_in_service", "shared_in_service"]);
    // The other location still answers on both.
    expect((await resolveMetaChannel("560000000000002"))?.clinicId).toBe(staying.clinicId);
    expect((await resolveMetaChannel("560000000000003"))?.clinicId).toBe(staying.clinicId);

    // Once the other location leaves too, the account and the Page are taken off.
    await leave(staying.clinicId);
    const last = fakeGraph();
    await revokeMetaAccess([staying.clinicId], { fetchImpl: last.fetchImpl });
    expect(
      last.calls
        .map((call) => call.url.replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+/, ""))
        .sort(),
    ).toEqual(["/560000000000007/subscribed_apps", "/560000000000009/subscribed_apps"]);
  });

  test("a token with no Page or account on record is erased and audited as nothing to unsubscribe, never as revoked at Meta", async () => {
    const c = await seedClinic("meta-revoke-nothing");
    // An operator's pasted WhatsApp token: no business account id.
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      attachMetaChannel(tx, {
        platform: "whatsapp",
        externalId: "570000000000001",
        accessToken: "EAAB-pasted",
      }),
    );
    await leave(c.clinicId);
    const graph = fakeGraph();
    expect(await revokeMetaAccess([c.clinicId], { fetchImpl: graph.fetchImpl })).toEqual({
      clinics: 1,
      revoked: 1,
      failed: 0,
    });
    expect(graph.calls).toEqual([]);
    const outcomes = await inTenant(c.clinicId, async (q) =>
      (
        await q.query<{ o: string }>(
          `select metadata->>'outcome' as o from audit_log where resource_type = 'provider_connection' and metadata->>'reason' = 'service_ended'`,
        )
      ).rows.map((r) => r.o),
    );
    expect(outcomes).toEqual(["nothing_to_unsubscribe"]);
    // Whoever set the subscription up in Meta's dashboard is the only one who
    // can end it, so ops is told once, with ids only (the review's #15).
    expect(await byHand(c.clinicId)).toEqual([
      { code: "no_asset_on_record", provider: "meta-whatsapp" },
    ]);
    await revokeMetaAccess([c.clinicId], { fetchImpl: graph.fetchImpl });
    expect(await byHand(c.clinicId)).toHaveLength(1);
  });

  test("ops is told once a connection has been refused META_REVOKE_ALERT_AFTER times, and when destruction's last try is refused too", async () => {
    const c = await seedClinic("meta-revoke-stuck");
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      attachMetaChannel(tx, {
        platform: "messenger",
        externalId: "580000000000001",
        accessToken: "EAAB-stuck",
        via: "facebook_login",
      }),
    );
    await leave(c.clinicId);
    const refusing = fakeGraph(() => ({
      status: 403,
      body: { error: { message: "Permissions error", code: 200 } },
    }));
    const alerts = async (phase: string) =>
      (
        await getMigratorPool().query(
          `select 1 from ops_alerts where event = 'meta_revoke_failed' and fields->>'clinicId' = $1 and fields->>'phase' = $2`,
          [c.clinicId, phase],
        )
      ).rows.length;
    for (let i = 1; i < META_REVOKE_ALERT_AFTER; i += 1) {
      await revokeMetaAccess([c.clinicId], { fetchImpl: refusing.fetchImpl });
    }
    expect(await alerts("retries")).toBe(0);
    await revokeMetaAccess([c.clinicId], { fetchImpl: refusing.fetchImpl });
    await revokeMetaAccess([c.clinicId], { fetchImpl: refusing.fetchImpl });
    expect(await alerts("retries")).toBe(1);
    const [row] = await connections(c.clinicId);
    expect(row!.status).not.toBe("revoked");

    // Destruction tries once more, and Meta still refuses: ops is told, and
    // the data goes on the agreement's day all the same.
    vi.stubGlobal("fetch", refusing.fetchImpl);
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      markExportDelivered(tx, "bundle handed over"),
    );
    await getMigratorPool().query(
      `update clinics set offboarding_started_at = offboarding_started_at - interval '31 days',
                          destroy_after = destroy_after - interval '31 days',
                          export_delivered_at = export_delivered_at - interval '31 days' where id = $1`,
      [c.clinicId],
    );
    expect((await destroyDueClinics()).map((d) => d.clinicId)).toContain(c.clinicId);
    expect(await alerts("destruction")).toBe(1);
    expect(await connections(c.clinicId)).toEqual([]);
  });
  // The review's N3: an operator's pasted WhatsApp token keeps the number's id
  // and no business account id, so the in-service check could not see that
  // the other location's number might be on the leaving one's account, and
  // unsubscribed it. The same holds for a pasted Instagram token and its Page.
  test("a WhatsApp account or Page that a clinic in service may be on, through a connection with no account or Page on record, is left subscribed and ops is told to check", async () => {
    const leaving = await seedClinic("meta-revoke-unknown-a");
    const staying = await seedClinic("meta-revoke-unknown-b");
    const attach = (clinicId: string, input: Parameters<typeof attachMetaChannel>[1]) =>
      withTenant({ clinicId, actor: ACTOR }, (tx) => attachMetaChannel(tx, input));
    await attach(leaving.clinicId, {
      platform: "whatsapp",
      externalId: "590000000000001",
      accessToken: "EAAB-a-waba",
      details: { wabaId: "590000000000009" },
      via: "embedded_signup",
    });
    await attach(leaving.clinicId, {
      platform: "messenger",
      externalId: "590000000000007",
      accessToken: "EAAB-a-page",
      via: "facebook_login",
    });
    // The other location's, pasted by an operator: no wabaId, no pageId.
    await attach(staying.clinicId, {
      platform: "whatsapp",
      externalId: "590000000000002",
      accessToken: "EAAB-b-pasted-waba",
    });
    await attach(staying.clinicId, {
      platform: "instagram",
      externalId: "590000000000003",
      accessToken: "EAAB-b-pasted-page",
    });
    await leave(leaving.clinicId);

    const graph = fakeGraph();
    expect(await revokeMetaAccess([leaving.clinicId], { fetchImpl: graph.fetchImpl })).toEqual({
      clinics: 1,
      revoked: 2,
      failed: 0,
    });
    expect(graph.calls).toEqual([]);
    expect((await connections(leaving.clinicId)).every((r) => r.status === "revoked")).toBe(true);
    const outcomes = await inTenant(leaving.clinicId, async (q) =>
      (
        await q.query<{ o: string }>(
          `select metadata->>'outcome' as o from audit_log where resource_type = 'provider_connection' and metadata->>'reason' = 'service_ended'`,
        )
      ).rows.map((r) => r.o),
    );
    expect(outcomes).toEqual(["possibly_shared", "possibly_shared"]);
    expect(await byHand(leaving.clinicId)).toEqual([
      { code: "asset_unverified", provider: "meta-messenger" },
      { code: "asset_unverified", provider: "meta-whatsapp" },
    ]);
    expect((await resolveMetaChannel("590000000000002"))?.clinicId).toBe(staying.clinicId);
    expect((await resolveMetaChannel("590000000000003"))?.clinicId).toBe(staying.clinicId);

    // A connection the database can place settles it: with the other
    // location's account on record and not this one, the account is taken off.
    const third = await seedClinic("meta-revoke-unknown-c");
    await attach(third.clinicId, {
      platform: "whatsapp",
      externalId: "590000000000011",
      accessToken: "EAAB-c-waba",
      details: { wabaId: "590000000000019" },
      via: "embedded_signup",
    });
    await leave(staying.clinicId);
    await leave(third.clinicId);
    const last = fakeGraph();
    await revokeMetaAccess([third.clinicId], { fetchImpl: last.fetchImpl });
    expect(
      last.calls.map((call) => call.url.replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+/, "")),
    ).toEqual(["/590000000000019/subscribed_apps"]);
    expect(await byHand(third.clinicId)).toEqual([]);
  });
});
