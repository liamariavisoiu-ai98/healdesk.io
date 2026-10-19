import { createHash } from "node:crypto";

import {
  agreementPlatformFor,
  BAA_ASSENT_LABEL,
  CURRENT_BAA_VERSION,
  getBaaTemplate,
  templateReadsCalendarAccount,
} from "@healdesk/catalog";
import { effectiveDateOf, prepareSigning } from "@healdesk/catalog/agreement-signing";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import {
  closePools,
  getAppPool,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import {
  bindAgreementInEffect,
  inTenant,
  seedChannels,
  seedClinic,
  seedEntitled,
} from "./setup/factories";
import { attestPlatform } from "./setup/platform";

/**
 * A newer business associate agreement over an older one (wave 2, R11; plan
 * Part L, "re-acceptance of a superseded BAA"; Annex X5 L22, "a new BAA
 * version"): WP9's re-sign row, link, screen and reminders, with a kind of
 * `baa_version`. The hourly job opens one by itself once a release's floor
 * (app_baa_version_acceptable) has passed the version in force, and AYA
 * pauses only there; the operator's broadcast opens one for every account on
 * an older version, pausing nothing while the version is still acceptable,
 * and the job pauses it once the floor passes it. Synthetic clinics and fake
 * mail throughout.
 *
 * 1.5.0 is the older version: released, registered, and below today's floor
 * (1.5.1). A release that kept it acceptable for an overlap is stood in for
 * by redefining app_baa_version_acceptable() as the migrator, the way
 * tests/setup/platform.ts stands in for Gate B, and put back after.
 */

const sent = vi.hoisted(() => ({
  emails: [] as { to: string; kind: string; subject: string; text: string }[],
  copies: 0,
}));
vi.mock("@/lib/email/send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/send")>();
  return {
    ...actual,
    sendEmail: (
      email: Parameters<typeof actual.sendEmail>[0],
      options: Parameters<typeof actual.sendEmail>[1] = {},
    ) =>
      actual.sendEmail(email, {
        ...options,
        transport: {
          name: "fake",
          send: async (target, message) => {
            sent.emails.push({
              to: target.to,
              kind: email.kind,
              subject: message.subject,
              text: message.text,
            });
            return { status: "sent", messageId: `msg_${sent.emails.length}` };
          },
        },
      }),
  };
});
vi.mock("@/lib/email/agreement-copy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/agreement-copy")>();
  return {
    ...actual,
    sendAgreementCopy: async () => {
      sent.copies += 1;
      return { sent: false, status: "skipped", reason: "No transport in this test." };
    },
  };
});

const { signAgreement } = await import("@/lib/agreements");
const { startBaaVersionResigns } = await import("@/lib/agreements/baa-version");
const {
  baaOlderThanCurrent,
  lookUpResignLink,
  readResignToken,
  resignRequest,
  runAgreementResignsJob,
  signAgreementResign,
} = await import("@/lib/agreements/resign");
const { renderResignPreview } = await import("@/lib/agreements/resign-preview");
const { assistantMayAnswer } = await import("@/lib/billing/answering");
const { PauseError, pauseAya, resumeAya } = await import("@/lib/channels/pause");
const { AGREEMENT_PAUSE_LABEL } = await import("@/lib/channels/pause-words");
const { withTenant } = await import("@/lib/tenant");

const describeDb = hasTestDatabase ? describe : describe.skip;
const ORIGIN = "https://app.healdesk.test";
const OPERATOR = { type: "service", serviceName: "baa-version-test" } as const;
const DIRECT_LINE = "+14155550123";
const DAY = 24 * 60 * 60 * 1000;
const OLD = "1.5.0";

process.env.BETTER_AUTH_URL = ORIGIN;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function linkIn(text: string): string {
  const token = text.match(/\/agreement\/([A-Za-z0-9_-]{92})/)?.[1];
  if (!token) throw new Error("no re-sign link in the email");
  return token;
}

describe("which BAA versions are older than the current one", () => {
  test("by place in the catalogue: an older release is, the current one and the DPA are not", () => {
    expect(baaOlderThanCurrent(OLD)).toBe(true);
    expect(baaOlderThanCurrent("1.2.2")).toBe(true);
    expect(baaOlderThanCurrent(CURRENT_BAA_VERSION)).toBe(false);
    expect(baaOlderThanCurrent("dpa/1.0.0")).toBe(false);
    // One the catalogue cannot render again is older: only a re-sign fixes it.
    expect(baaOlderThanCurrent("0.0.1")).toBe(true);
  });
});

describeDb("re-signing a newer BAA over an older one", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 120_000);

  beforeEach(async () => {
    await truncateAll();
    await attestPlatform();
    await acceptOld(false);
    sent.emails.length = 0;
    sent.copies = 0;
  });

  afterAll(async () => {
    await acceptOld(false);
    await closePools();
  });

  /**
   * The floor as a release leaves it: false is today's (1.5.1 and nothing
   * else, drizzle/0081), true a release that kept 1.5.0 acceptable too.
   */
  async function acceptOld(accepted: boolean): Promise<void> {
    const list = accepted ? `'1.5.1', '${OLD}'` : `'1.5.1'`;
    await getMigratorPool().query(
      `create or replace function app_baa_version_acceptable(version text) returns boolean
         language sql immutable set search_path = public, pg_temp
         as $$ select coalesce(version = any (array[${list}]), false) $$`,
    );
  }

  /**
   * A med spa under BAA `version`, signed a day ago with the real document
   * and variables and bound to its organisation, billed, with phone and
   * website chat live and a direct line: production unless `synthetic`.
   */
  async function baaPractice(
    label: string,
    options: { version?: string; synthetic?: boolean; live?: boolean } = {},
  ) {
    const version = options.version ?? OLD;
    const clinic = await seedClinic(label);
    const legacy = !templateReadsCalendarAccount(getBaaTemplate(version)!);
    const signed = await signAgreement(
      {
        clinicLegalName: `${label} Med Spa LLC`,
        specialty: "med-spa",
        signatoryName: "Laura Owner",
        signatoryTitle: "Owner",
        signatoryEmail: clinic.staffEmail,
        isCoveredEntity: null,
        attributionMode: "estimated",
        platform: agreementPlatformFor("none"),
        ...(legacy ? {} : { bookingSystem: "none", calendarAccount: "workspace_no_baa" }),
        assentLabel: BAA_ASSENT_LABEL,
        templateVersion: version,
      },
      {},
      { current: getBaaTemplate(version)! },
    );
    await getMigratorPool().query(
      `update baa_acceptances set accepted_at = now() - interval '1 day' where id = $1`,
      [signed.agreementId],
    );
    await getMigratorPool().query(`select app_bind_agreement($1::uuid, $2)`, [
      signed.agreementId,
      clinic.organizationId,
    ]);
    await getMigratorPool().query(
      `update clinics
          set regulatory_regime = 'hipaa-if-covered', agreement_kind = 'baa', is_covered_entity = null,
              data_classification = $2, baa_signed_at = now() - interval '1 day'
        where id = $1`,
      [clinic.clinicId, options.synthetic ? "synthetic" : "production"],
    );
    await seedEntitled(clinic.clinicId, { stripe: false });
    if (options.live !== false) {
      const live = new Date(Date.now() - 2 * DAY);
      await seedChannels(clinic.clinicId, [
        { channel: "voice", liveAt: live, readyAt: live },
        { channel: "web", liveAt: live, readyAt: live },
      ]);
    }
    await inTenant(clinic.clinicId, (client) =>
      client.query(
        `insert into clinic_settings (clinic_id, direct_line_e164, booking_system, calendar_account)
           values ($1, $2, 'calendly', 'personal')
           on conflict (clinic_id) do update
             set direct_line_e164 = excluded.direct_line_e164,
                 booking_system = excluded.booking_system,
                 calendar_account = excluded.calendar_account`,
        [clinic.clinicId, DIRECT_LINE],
      ),
    );
    return { ...clinic, agreementId: signed.agreementId };
  }

  async function resigns(clinicId: string) {
    const { rows } = await inTenant(clinicId, (client) =>
      client.query<{
        id: string;
        status: string;
        reason: string;
        source: string;
        paused_at: Date | null;
        from_agreement_id: string;
      }>(
        `select id, status, reason, source, paused_at, from_agreement_id
           from agreement_resigns where clinic_id = $1 order by started_at`,
        [clinicId],
      ),
    );
    return rows;
  }

  async function pause(clinicId: string) {
    const { rows } = await inTenant(clinicId, (client) =>
      client.query<{ ai_paused_at: Date | null; ai_paused_by_label: string | null }>(
        `select ai_paused_at, ai_paused_by_label from clinic_settings where clinic_id = $1`,
        [clinicId],
      ),
    );
    return rows[0]!;
  }

  function l22For(to: string) {
    return sent.emails.filter((e) => e.kind === "agreement_to_sign" && e.to === to);
  }

  test("the floor passed the version in force: the job opens the re-sign, pauses AYA and sends L22 once", async () => {
    const practice = await baaPractice("bvfloor");

    const first = await runAgreementResignsJob();
    expect(first).toMatchObject({ opened: 1, sent: 1 });
    const [resign] = await resigns(practice.clinicId);
    expect(resign).toMatchObject({
      status: "open",
      reason: "baa_version",
      source: "release",
      from_agreement_id: practice.agreementId,
    });
    const held = await pause(practice.clinicId);
    expect(held.ai_paused_by_label).toBe(AGREEMENT_PAUSE_LABEL);
    expect(resign!.paused_at?.getTime()).toBe(held.ai_paused_at!.getTime());

    const [l22] = l22For(practice.staffEmail);
    expect(l22!.subject).toBe("Sign your updated agreement");
    expect(l22!.text).toContain(
      `version ${CURRENT_BAA_VERSION}, in place of version ${OLD}, which you signed`,
    );
    expect(l22!.text).toContain("until the newer version is signed, AYA is paused:");
    expect(l22!.text).toContain("Phone: calls go to your direct line ((415) 555-0123)");
    expect(l22!.text).not.toContain("insurance");
    expect(readResignToken(linkIn(l22!.text))).toMatchObject({ ok: true, resignId: resign!.id });

    // Calls go to the direct line, and the header cannot turn her back on.
    const voice = await assistantMayAnswer({
      clinicId: practice.clinicId,
      channel: "voice",
      actor: OPERATOR,
    });
    expect(voice).toMatchObject({ decision: "pass_through", directLine: DIRECT_LINE });
    await expect(
      withTenant({ clinicId: practice.clinicId, actor: OPERATOR }, (tx) =>
        resumeAya(tx, { actorLabel: "Front desk Mac" }),
      ),
    ).rejects.toBeInstanceOf(PauseError);

    // The next hour opens nothing more and sends nothing again.
    expect(await runAgreementResignsJob()).toMatchObject({ opened: 0, open: 1 });
    expect(await resigns(practice.clinicId)).toHaveLength(1);
    expect(l22For(practice.staffEmail)).toHaveLength(1);
  });

  test("the screen signs the current BAA from the practice's answers, and the supersede puts it in force", async () => {
    const practice = await baaPractice("bvsign");
    await runAgreementResignsJob();
    const token = linkIn(l22For(practice.staffEmail)[0]!.text);
    const copiesBefore = sent.copies;

    const link = await lookUpResignLink(token);
    if (!link.ok) throw new Error(`the link did not open: ${link.reason}`);
    expect(link).toMatchObject({
      reason: "baa_version",
      replaces: { kind: "baa", version: OLD },
      holdsPause: true,
    });
    expect(link.document).toEqual({
      clinicLegalName: "bvsign Med Spa LLC",
      // The BAA keeps the specialty's name; the id is the clinic's own.
      specialty: "med-spa",
      // What 1.5.0 recorded, not the settings' later answers.
      bookingSystem: "none",
      calendarAccount: "workspace_no_baa",
      isCoveredEntity: null,
      signatoryEmail: practice.staffEmail,
      signatoryName: "Laura Owner",
      signatoryTitle: "Owner",
      templateVersion: CURRENT_BAA_VERSION,
    });

    const signature = { signatoryName: "Laura Owner", signatoryTitle: "Owner" };
    const shown = renderResignPreview(link.document, signature, effectiveDateOf(new Date()));
    const server = prepareSigning(
      resignRequest(link.document, { ...signature, templateVersion: CURRENT_BAA_VERSION }),
      effectiveDateOf(new Date()),
      {},
    );
    expect(sha256(shown.text)).toBe(server.hash);

    const outcome = await signAgreementResign(token, {
      ...signature,
      displayedHash: sha256(shown.text),
      templateVersion: CURRENT_BAA_VERSION,
    });
    if (outcome.status !== "signed") throw new Error(`not signed: ${JSON.stringify(outcome)}`);
    expect(outcome.version).toBe(CURRENT_BAA_VERSION);
    expect(sent.copies).toBe(copiesBefore + 1);

    const { rows } = await getMigratorPool().query<{
      id: string;
      document_version: string;
      organization_id: string | null;
      terminated_at: Date | null;
    }>(
      `select id, document_version, organization_id, terminated_at
         from baa_acceptances where id in ($1, $2)`,
      [practice.agreementId, outcome.agreementId],
    );
    expect(rows.find((r) => r.id === practice.agreementId)!.terminated_at).not.toBeNull();
    expect(rows.find((r) => r.id === outcome.agreementId)).toMatchObject({
      document_version: CURRENT_BAA_VERSION,
      organization_id: practice.organizationId,
      terminated_at: null,
    });
    expect((await resigns(practice.clinicId))[0]).toMatchObject({ status: "signed" });
    expect((await pause(practice.clinicId)).ai_paused_at).toBeNull();
    expect(await lookUpResignLink(token)).toEqual({ ok: false, reason: "signed" });

    // On the current version now: neither the job nor the broadcast opens another.
    expect(await runAgreementResignsJob()).toMatchObject({ opened: 0 });
    expect(await startBaaVersionResigns({ actorLabel: "ops@healdesk.test" })).toMatchObject({
      status: "started",
      opened: 0,
    });
  });

  test("the broadcast starts a version still acceptable without a pause, and the job pauses it when the floor passes it", async () => {
    await acceptOld(true);
    const practice = await baaPractice("bvoverlap");
    // An overlap: go-live accepts 1.5.0, so the hourly job opens nothing.
    expect(await runAgreementResignsJob()).toMatchObject({ opened: 0, open: 0 });

    const started = await startBaaVersionResigns({ actorLabel: "ops@healdesk.test" });
    expect(started).toEqual({
      status: "started",
      version: CURRENT_BAA_VERSION,
      opened: 1,
      paused: 0,
      emailed: 1,
      alreadyOpen: 0,
      failed: 0,
    });
    const [resign] = await resigns(practice.clinicId);
    expect(resign).toMatchObject({ reason: "baa_version", source: "operator", paused_at: null });
    expect((await pause(practice.clinicId)).ai_paused_at).toBeNull();
    const [l22] = l22For(practice.staffEmail);
    expect(l22!.text).toContain("AYA keeps answering while you read it and sign it.");
    expect(l22!.text).not.toContain("AYA is paused");

    // The header works as always while it waits.
    const header = { clinicId: practice.clinicId, actor: OPERATOR };
    await withTenant(header, (tx) =>
      pauseAya(tx, { choice: "hour", actorLabel: "Front desk Mac" }),
    );
    await withTenant(header, (tx) => resumeAya(tx, { actorLabel: "Front desk Mac" }));
    const link = await lookUpResignLink(linkIn(l22!.text));
    expect(link).toMatchObject({ ok: true, holdsPause: false });

    // Sent again, it reaches nobody new.
    expect(await startBaaVersionResigns({ actorLabel: "ops@healdesk.test" })).toMatchObject({
      opened: 0,
      alreadyOpen: 1,
    });

    // The release that moves the floor past 1.5.0: the next hour pauses AYA,
    // records the pause on the re-sign, and the header cannot lift it.
    await acceptOld(false);
    expect(
      await runAgreementResignsJob({ now: new Date(Date.now() + 60 * 60 * 1000) }),
    ).toMatchObject({ paused: 1, opened: 0 });
    const after = (await resigns(practice.clinicId))[0]!;
    const held = await pause(practice.clinicId);
    expect(held.ai_paused_by_label).toBe(AGREEMENT_PAUSE_LABEL);
    expect(after.paused_at?.getTime()).toBe(held.ai_paused_at!.getTime());
    await expect(
      withTenant(header, (tx) => resumeAya(tx, { actorLabel: "Front desk Mac" })),
    ).rejects.toBeInstanceOf(PauseError);
    expect(await runAgreementResignsJob()).toMatchObject({ paused: 0 });
  });

  test("a practice not answering yet is told its go-live waits, and pauses nothing", async () => {
    const practice = await baaPractice("bvsetup", { synthetic: true, live: false });
    expect(await runAgreementResignsJob()).toMatchObject({ opened: 1 });
    expect((await resigns(practice.clinicId))[0]).toMatchObject({ paused_at: null });
    expect((await pause(practice.clinicId)).ai_paused_at).toBeNull();
    const [l22] = l22For(practice.staffEmail);
    expect(l22!.text).toContain("AYA starts answering your patients only once it's signed.");
  });

  test("an agreement from before 1.3.0 is re-signed with the booking answers the clinic's settings hold", async () => {
    const practice = await baaPractice("bvlegacy", { version: "1.2.2", synthetic: true });
    await runAgreementResignsJob();
    const link = await lookUpResignLink(linkIn(l22For(practice.staffEmail)[0]!.text));
    if (!link.ok) throw new Error(`the link did not open: ${link.reason}`);
    expect(link.document).toMatchObject({
      bookingSystem: "calendly",
      calendarAccount: "personal",
      templateVersion: CURRENT_BAA_VERSION,
    });
    expect(link.replaces).toEqual({ kind: "baa", version: "1.2.2" });
  });

  test("an agreement that could not be rendered again opens no re-sign it could never sign, and pauses nothing", async () => {
    const clinic = await seedClinic("bvbare");
    // As a hand-made row is: a version and no answers to render the current one from.
    await bindAgreementInEffect(clinic.clinicId, OLD);
    await getMigratorPool().query(
      `update clinics set data_classification = 'production', baa_signed_at = now() where id = $1`,
      [clinic.clinicId],
    );
    expect(await runAgreementResignsJob()).toMatchObject({ opened: 0, open: 0 });
    expect(await resigns(clinic.clinicId)).toEqual([]);
    expect(l22For(clinic.staffEmail)).toEqual([]);
  });

  test("the row's pause is set once, while open, and never moved", async () => {
    await acceptOld(true);
    const practice = await baaPractice("bvguard");
    await startBaaVersionResigns({ actorLabel: "ops@healdesk.test" });
    const [resign] = await resigns(practice.clinicId);
    // As the runtime role, in the clinic's tenant, as the hourly job writes it.
    const asApp = async (text: string, values: unknown[]) => {
      const client = await getAppPool().connect();
      try {
        await client.query("begin");
        await client.query(`select set_config('app.clinic_id', $1, true)`, [practice.clinicId]);
        await client.query(text, values);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    };
    const setPause = (at: string) =>
      asApp(`update agreement_resigns set paused_at = $2::timestamptz where id = $1`, [
        resign!.id,
        at,
      ]);
    await setPause("2026-10-19T10:00:00Z");
    await expect(setPause("2026-10-19T11:00:00Z")).rejects.toMatchObject({
      message: expect.stringMatching(/recorded once/),
    });
    // Why it opened is never the runtime role's to rewrite.
    await expect(
      asApp(`update agreement_resigns set reason = 'not_sure' where id = $1`, [resign!.id]),
    ).rejects.toMatchObject({ code: "42501" });
    // And a closed re-sign gains no pause, for any role.
    await inTenant(practice.clinicId, (client) =>
      client.query(
        `update agreement_resigns set status = 'withdrawn', resolved_at = now(), resolved_by = 'ops@healdesk.test'
          where id = $1`,
        [resign!.id],
      ),
    );
    await expect(
      inTenant(practice.clinicId, (client) =>
        client.query(`update agreement_resigns set paused_at = null where id = $1`, [resign!.id]),
      ),
    ).rejects.toMatchObject({ message: expect.stringMatching(/recorded once/) });
  });
});
