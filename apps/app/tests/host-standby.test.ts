import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { queueTranscriptEmail } from "@/lib/conversations/transcript-outbox";
import { isMutating, isOpName, runOperation, type Operator } from "@/lib/ops/api";
import { withTenant } from "@/lib/tenant";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { bindAgreementInEffect, inTenant, seedClinic, seedConversation } from "./setup/factories";

/**
 * hostStandbyCheck (lib/ops/host-standby.ts): what /admin/host asks before it
 * puts the AWS host in standby, which deletes the database after a snapshot
 * and stops every task. It must say no while a clinic is in production, an
 * agreement is in effect or a transcript has not reached SES, and say so in
 * counts only. Synthetic clinics and words throughout.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const OPERATOR: Operator = { email: "ops@healdesk.test", request: {} };
const ACTOR = { type: "service", serviceName: "host-standby-test" } as const;

describe("hostStandbyCheck", () => {
  test("is a read: on the list, off the mutating half, so it writes no audit row", () => {
    expect(isOpName("hostStandbyCheck")).toBe(true);
    expect(isMutating("hostStandbyCheck")).toBe(false);
  });
});

describeDb("hostStandbyCheck, against the database", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 180_000);

  beforeEach(async () => {
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  async function check(): Promise<Record<string, unknown>> {
    const outcome = await runOperation("hostStandbyCheck", {}, OPERATOR);
    expect(outcome.status, JSON.stringify(outcome)).toBe(200);
    return (outcome.body as { data: Record<string, unknown> }).data;
  }

  async function makeProduction(clinicId: string): Promise<void> {
    await bindAgreementInEffect(clinicId);
    await getMigratorPool().query(
      `update clinics set data_classification = 'production', baa_signed_at = now() where id = $1`,
      [clinicId],
    );
  }

  async function queueTranscript(clinicId: string): Promise<string> {
    const { conversationId } = await seedConversation(clinicId, { startedAt: new Date() });
    const id = await withTenant({ clinicId, actor: ACTOR }, (tx) =>
      queueTranscriptEmail(tx, {
        conversationId,
        channel: "voice",
        startedAt: new Date("2026-10-14T15:00:00Z"),
        turns: [
          { speaker: "assistant", text: "Hi, I'm the clinic's AI assistant, and this call is transcribed." },
          { speaker: "person", text: "Synthetic caller: is there a consultation on Friday?" },
        ],
      }),
    );
    if (!id) throw new Error("no transcript queued");
    return id;
  }

  test("an empty host may go into standby", async () => {
    expect(await check()).toEqual({ ok: true, productionClinics: 0, boundAgreements: 0, openTranscripts: 0 });
  });

  test("synthetic clinics with nothing bound or waiting do not stop it", async () => {
    await seedClinic("standby-synthetic-a");
    await seedClinic("standby-synthetic-b");
    expect(await check()).toEqual({ ok: true, productionClinics: 0, boundAgreements: 0, openTranscripts: 0 });
  });

  test("a clinic in production stops it, and so does the agreement it went live under", async () => {
    const live = await seedClinic("standby-live");
    await seedClinic("standby-other");
    await makeProduction(live.clinicId);
    expect(await check()).toEqual({ ok: false, productionClinics: 1, boundAgreements: 1, openTranscripts: 0 });
  });

  test("an agreement in effect stops it on a synthetic clinic too; once terminated it does not", async () => {
    // A paid clinic is owed the service whatever its classification; a test
    // purchase's agreement is terminated when its account is closed.
    const paid = await seedClinic("standby-paid");
    const agreementId = await bindAgreementInEffect(paid.clinicId);
    expect(await check()).toMatchObject({ ok: false, productionClinics: 0, boundAgreements: 1 });

    await getMigratorPool().query(`update baa_acceptances set terminated_at = now() where id = $1`, [agreementId]);
    expect(await check()).toEqual({ ok: true, productionClinics: 0, boundAgreements: 0, openTranscripts: 0 });
  });

  test("a transcript SES has not taken stops it; one SES has taken does not", async () => {
    const clinic = await seedClinic("standby-transcript");
    const id = await queueTranscript(clinic.clinicId);
    expect(await check()).toEqual({ ok: false, productionClinics: 0, boundAgreements: 0, openTranscripts: 1 });

    await inTenant(clinic.clinicId, (client) =>
      client.query(
        `update transcript_emails set status = 'sent', sent_at = now(), ses_message_id = 'ses-standby-test' where id = $1`,
        [id],
      ),
    );
    expect(await check()).toEqual({ ok: true, productionClinics: 0, boundAgreements: 0, openTranscripts: 0 });
  });

  test("counts transcripts in every clinic, each behind its own tenant", async () => {
    const first = await seedClinic("standby-first");
    const second = await seedClinic("standby-second");
    await queueTranscript(first.clinicId);
    await queueTranscript(second.clinicId);
    await queueTranscript(second.clinicId);
    expect(await check()).toMatchObject({ ok: false, openTranscripts: 3 });
  });

  test("answers counts and nothing else: no name, slug, id or address crosses", async () => {
    const clinic = await seedClinic("standby-shape");
    await makeProduction(clinic.clinicId);
    await queueTranscript(clinic.clinicId);

    const data = await check();
    expect(Object.keys(data).sort()).toEqual(["boundAgreements", "ok", "openTranscripts", "productionClinics"]);
    expect(typeof data.ok).toBe("boolean");
    for (const key of ["boundAgreements", "openTranscripts", "productionClinics"]) {
      expect(Number.isInteger(data[key]), key).toBe(true);
    }
    const wire = JSON.stringify(data);
    for (const leak of [clinic.clinicId, clinic.slug, clinic.organizationId, clinic.staffEmail, "standby-shape", "Synthetic caller"]) {
      expect(wire).not.toContain(leak);
    }
  });

  test("writes nothing: no audit row, no security event", async () => {
    const clinic = await seedClinic("standby-quiet");
    await queueTranscript(clinic.clinicId);
    const count = async () =>
      (
        await getMigratorPool().query<{ n: number }>(
          `select (select count(*) from security_events)::int + (select count(*) from audit_log)::int as n`,
        )
      ).rows[0]!.n;
    const before = await count();
    await check();
    expect(await count()).toBe(before);
  });
});
