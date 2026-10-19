import { createHash, randomUUID } from "node:crypto";

import {
  agreementPlatformFor,
  CURRENT_BAA_VERSION,
  currentDpaTemplate,
  DPA_ASSENT_LABEL,
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
import { inTenant, seedChannels, seedClinic, seedContact, seedEntitled } from "./setup/factories";

/**
 * The DPA→BAA re-sign (package WP9; plan Part L, Annex X5 L22): a practice
 * under the Data Protection Agreement whose answer becomes "Yes" or "Not
 * sure" is sent L22 with a signed one-time link, AYA is paused until it
 * signs, the screen signs the BAA from the practice's own answers, and the
 * supersede puts it in force. Synthetic clinics and fake mail throughout.
 *
 * The DPA is unreleased, as it must be until the owner releases it; the
 * practice here signed it as it will after the release (`dpaReleased`, the
 * stand-in every DPA test uses), and nothing flips its flag.
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
const { setCoveredEntity } = await import("@/lib/agreements/covered-entity");
const {
  dueResignEmail,
  lookUpResignLink,
  mintResignToken,
  readResignToken,
  resignRequest,
  RESIGN_LINK_TTL_MS,
  runAgreementResignsJob,
  signAgreementResign,
} = await import("@/lib/agreements/resign");
const { renderResignPreview } = await import("@/lib/agreements/resign-preview");
const { assistantMayAnswer } = await import("@/lib/billing/answering");
const { pauseAya, PauseError, resumeAya } = await import("@/lib/channels/pause");
const { AGREEMENT_PAUSE_LABEL, pauseBanner } = await import("@/lib/channels/pause-words");
const { withTenant } = await import("@/lib/tenant");

const describeDb = hasTestDatabase ? describe : describe.skip;
const ORIGIN = "https://app.healdesk.test";
const OPERATOR = { type: "service", serviceName: "resign-test" } as const;
const DIRECT_LINE = "+14155550123";
const DAY = 24 * 60 * 60 * 1000;

process.env.BETTER_AUTH_URL = ORIGIN;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The link a sent L22 carries. */
function linkIn(text: string): string {
  const token = text.match(/\/agreement\/([A-Za-z0-9_-]{92})/)?.[1];
  if (!token) throw new Error("no re-sign link in the email");
  return token;
}

describe("the re-sign link", () => {
  const ids = { id: randomUUID(), clinicId: randomUUID() };
  const now = new Date("2026-10-19T12:00:00Z");

  test("names its re-sign and clinic, and is token-shaped for the link scanner", () => {
    const token = mintResignToken(ids, now);
    expect(token).toMatch(/^[A-Za-z0-9_-]{92}$/);
    expect(readResignToken(token, now)).toEqual({
      ok: true,
      resignId: ids.id,
      clinicId: ids.clinicId,
      expiresAt: new Date(Math.floor((now.getTime() + RESIGN_LINK_TTL_MS) / 1000) * 1000),
    });
  });

  test("a changed byte, another key's link, or garbage is unknown; an old one has expired", () => {
    const token = mintResignToken(ids, now);
    const raw = Buffer.from(token, "base64url");
    raw[20] = raw[20]! ^ 1;
    expect(readResignToken(raw.toString("base64url"), now)).toEqual({
      ok: false,
      reason: "unknown",
    });
    expect(readResignToken("not-a-token", now)).toEqual({ ok: false, reason: "unknown" });
    expect(readResignToken(undefined, now)).toEqual({ ok: false, reason: "unknown" });
    const later = new Date(now.getTime() + RESIGN_LINK_TTL_MS + 1000);
    expect(readResignToken(token, later)).toEqual({ ok: false, reason: "expired" });
  });

  test("L22's day: the first, then 3 and 7 days on", () => {
    const start = new Date("2026-10-01T09:00:00Z");
    expect(dueResignEmail(start, new Date(start.getTime() + 2.9 * DAY))).toBe(0);
    expect(dueResignEmail(start, new Date(start.getTime() + 3 * DAY))).toBe(3);
    expect(dueResignEmail(start, new Date(start.getTime() + 7 * DAY))).toBe(7);
    expect(dueResignEmail(start, new Date(start.getTime() + 30 * DAY))).toBe(7);
  });

  test("the header says healdesk paused AYA until the agreement is signed", () => {
    const at = new Date("2026-10-19T16:14:00Z");
    expect(
      pauseBanner(
        { pausedAt: at, byLabel: AGREEMENT_PAUSE_LABEL, until: null },
        "America/New_York",
        at,
      ),
    ).toBe("Paused by healdesk at 12:14 pm, until your updated agreement is signed.");
  });
});

describeDb("the DPA→BAA re-sign", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 120_000);

  beforeEach(async () => {
    await truncateAll();
    sent.emails.length = 0;
    sent.copies = 0;
  });

  afterAll(async () => {
    await closePools();
  });

  /**
   * A med spa under the DPA, signed "No" as it will be after the release:
   * the real signature and variables, bound to its organisation, production,
   * billed, with phone and website chat live and a direct line.
   */
  async function dpaPractice(label: string) {
    const clinic = await seedClinic(label);
    const signed = await signAgreement(
      {
        clinicLegalName: `${label} Med Spa LLC`,
        specialty: "med-spa",
        signatoryName: "Laura Owner",
        signatoryTitle: "Owner",
        signatoryEmail: clinic.staffEmail,
        isCoveredEntity: false,
        attributionMode: "estimated",
        platform: agreementPlatformFor("none"),
        bookingSystem: "none",
        calendarAccount: "workspace_no_baa",
        assentLabel: DPA_ASSENT_LABEL,
        templateVersion: currentDpaTemplate().version,
      },
      {},
      { dpaReleased: true },
    );
    // A day earlier than now, so the BAA signed today is the later signature.
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
          set regulatory_regime = 'hipaa-if-covered', agreement_kind = 'dpa', is_covered_entity = false,
              data_classification = 'production', baa_signed_at = now() - interval '1 day'
        where id = $1`,
      [clinic.clinicId],
    );
    await seedEntitled(clinic.clinicId, { stripe: false });
    const live = new Date(Date.now() - 2 * DAY);
    await seedChannels(clinic.clinicId, [
      { channel: "voice", liveAt: live, readyAt: live },
      { channel: "web", liveAt: live, readyAt: live },
    ]);
    await inTenant(clinic.clinicId, (client) =>
      client.query(
        `insert into clinic_settings (clinic_id, direct_line_e164) values ($1, $2)
           on conflict (clinic_id) do update set direct_line_e164 = excluded.direct_line_e164`,
        [clinic.clinicId, DIRECT_LINE],
      ),
    );
    return { ...clinic, dpaId: signed.agreementId };
  }

  async function acceptsPhi(clinicId: string): Promise<boolean> {
    const { rows } = await getAppPool().query<{ ok: boolean }>(
      `select app_clinic_accepts_phi($1) as ok`,
      [clinicId],
    );
    return rows[0]!.ok;
  }

  async function resigns(clinicId: string) {
    const { rows } = await inTenant(clinicId, (client) =>
      client.query<{
        id: string;
        status: string;
        reason: string;
        source: string;
        paused_at: Date | null;
        superseding_agreement_id: string | null;
        resolved_by: string | null;
      }>(
        `select id, status, reason, source, paused_at, superseding_agreement_id, resolved_by
         from agreement_resigns where clinic_id = $1 order by started_at`,
        [clinicId],
      ),
    );
    return rows;
  }

  async function pause(clinicId: string) {
    const { rows } = await inTenant(clinicId, (client) =>
      client.query<{
        ai_paused_at: Date | null;
        ai_paused_until: Date | null;
        ai_paused_by_label: string | null;
      }>(
        `select ai_paused_at, ai_paused_until, ai_paused_by_label from clinic_settings where clinic_id = $1`,
        [clinicId],
      ),
    );
    return rows[0]!;
  }

  async function noticesOf(clinicId: string, kind: string): Promise<number> {
    const { rows } = await inTenant(clinicId, (client) =>
      client.query<{ n: number }>(
        `select count(*)::int as n from billing_notices where clinic_id = $1 and kind = $2`,
        [clinicId, kind],
      ),
    );
    return rows[0]!.n;
  }

  function l22For(to: string) {
    return sent.emails.filter((e) => e.kind === "agreement_to_sign" && e.to === to);
  }

  test("ops records Yes: the gate closes, AYA pauses with no L15, and L22 goes once with its link", async () => {
    const practice = await dpaPractice("resignyes");
    expect(await acceptsPhi(practice.clinicId)).toBe(true);

    const outcome = await setCoveredEntity({
      clinicId: practice.clinicId,
      answer: "yes",
      actor: OPERATOR,
      actorLabel: "ops@healdesk.test",
    });
    expect(outcome).toMatchObject({
      status: "recorded",
      agreementKind: "dpa",
      covered: false,
      supersede: { fromAgreementId: practice.dpaId, linkSent: true },
    });

    // The PHI gate refuses the practice's data from this write.
    expect(await acceptsPhi(practice.clinicId)).toBe(false);
    await expect(seedContact(practice.clinicId, "+15550190111")).rejects.toMatchObject({
      code: "23514",
    });

    // One open re-sign, holding AYA paused until switched back on, quietly.
    const [resign] = await resigns(practice.clinicId);
    expect(resign).toMatchObject({ status: "open", reason: "now_covered", source: "operator" });
    const held = await pause(practice.clinicId);
    expect(held.ai_paused_at).not.toBeNull();
    expect(held.ai_paused_until).toBeNull();
    expect(held.ai_paused_by_label).toBe(AGREEMENT_PAUSE_LABEL);
    expect(resign!.paused_at?.getTime()).toBe(held.ai_paused_at!.getTime());
    expect(await noticesOf(practice.clinicId, "ai_paused")).toBe(0);

    // L22, to the clinic's one address: paused, where each channel goes, the link.
    const [l22] = l22For(practice.staffEmail);
    expect(l22!.subject).toBe("Sign your updated agreement");
    expect(l22!.text).toContain("Until it's signed, AYA is paused:");
    expect(l22!.text).toContain("Phone: calls go to your direct line ((415) 555-0123)");
    expect(l22!.text).toContain("Website chat: shows a contact form");
    expect(l22!.text).toContain(`${ORIGIN}/agreement/`);
    expect(readResignToken(linkIn(l22!.text))).toMatchObject({
      ok: true,
      resignId: resign!.id,
      clinicId: practice.clinicId,
    });

    // "Not sure" after "Yes" is the same re-sign, and L22 is not sent again.
    await setCoveredEntity({
      clinicId: practice.clinicId,
      answer: "not_sure",
      actor: OPERATOR,
      actorLabel: "ops@healdesk.test",
    });
    expect(await resigns(practice.clinicId)).toHaveLength(1);
    expect(l22For(practice.staffEmail)).toHaveLength(1);
  });

  test("while it is unsigned, calls go to the direct line, and the header cannot lift the pause", async () => {
    const practice = await dpaPractice("resigngate");
    await setCoveredEntity({
      clinicId: practice.clinicId,
      answer: "yes",
      actor: OPERATOR,
      actorLabel: "ops@healdesk.test",
    });

    // Whatever the answer gate reads of the agreement's kind, the pause stops
    // AYA: L22's "AYA is paused until it's signed" is true either way.
    const voice = await assistantMayAnswer({
      clinicId: practice.clinicId,
      channel: "voice",
      actor: OPERATOR,
    });
    expect(voice).toMatchObject({
      decision: "pass_through",
      fallback: "direct_line",
      directLine: DIRECT_LINE,
    });
    const web = await assistantMayAnswer({
      clinicId: practice.clinicId,
      channel: "web",
      actor: OPERATOR,
    });
    expect(web).toMatchObject({ decision: "pass_through", fallback: "contact_form" });

    const header = { clinicId: practice.clinicId, actor: OPERATOR };
    await expect(
      withTenant(header, (tx) => resumeAya(tx, { actorLabel: "Front desk Mac" })),
    ).rejects.toBeInstanceOf(PauseError);
    await expect(
      withTenant(header, (tx) => pauseAya(tx, { choice: "hour", actorLabel: "Front desk Mac" })),
    ).rejects.toBeInstanceOf(PauseError);
    expect((await pause(practice.clinicId)).ai_paused_until).toBeNull();
  });

  test("the screen signs the BAA from the practice's own answers, once, and puts it in force", async () => {
    const practice = await dpaPractice("resignsign");
    await setCoveredEntity({
      clinicId: practice.clinicId,
      answer: "yes",
      actor: OPERATOR,
      actorLabel: "ops@healdesk.test",
    });
    const token = linkIn(l22For(practice.staffEmail)[0]!.text);
    const copiesBefore = sent.copies;

    const link = await lookUpResignLink(token);
    if (!link.ok) throw new Error(`the link did not open: ${link.reason}`);
    expect(link.document).toEqual({
      clinicLegalName: "resignsign Med Spa LLC",
      specialty: "med-spa",
      bookingSystem: "none",
      calendarAccount: "workspace_no_baa",
      isCoveredEntity: true,
      signatoryEmail: practice.staffEmail,
      signatoryName: "Laura Owner",
      signatoryTitle: "Owner",
      templateVersion: CURRENT_BAA_VERSION,
    });

    // What the browser renders is what the server stores, byte for byte.
    const now = new Date();
    const signature = { signatoryName: "Laura Owner", signatoryTitle: "Owner" };
    const shown = renderResignPreview(link.document, signature, effectiveDateOf(now));
    const server = prepareSigning(
      resignRequest(link.document, { ...signature, templateVersion: CURRENT_BAA_VERSION }),
      effectiveDateOf(now),
      {},
    );
    expect(server.kind).toBe("baa");
    expect(sha256(shown.text)).toBe(server.hash);

    // A screen that showed anything else records nothing.
    const refused = await signAgreementResign(token, {
      ...signature,
      displayedHash: "0".repeat(64),
      templateVersion: CURRENT_BAA_VERSION,
    });
    expect(refused).toMatchObject({ status: "refused", field: "displayedHash" });
    expect((await resigns(practice.clinicId))[0]!.status).toBe("open");

    const outcome = await signAgreementResign(
      token,
      { ...signature, displayedHash: sha256(shown.text), templateVersion: CURRENT_BAA_VERSION },
      { ipAddress: "203.0.113.7", userAgent: "ResignTest/1.0" },
    );
    if (outcome.status !== "signed") throw new Error(`not signed: ${JSON.stringify(outcome)}`);
    expect(outcome.version).toBe(CURRENT_BAA_VERSION);
    // The signer's copy, after commit, as every signature's.
    expect(sent.copies).toBe(copiesBefore + 1);

    // The BAA is bound and in force; the DPA ended today; the gate takes data again.
    const { rows: agreements } = await getMigratorPool().query<{
      id: string;
      agreement_kind: string;
      organization_id: string | null;
      terminated_at: Date | null;
      document_hash: string;
    }>(
      `select id, agreement_kind, organization_id, terminated_at, document_hash
         from baa_acceptances where id in ($1, $2)`,
      [practice.dpaId, outcome.agreementId],
    );
    const baa = agreements.find((a) => a.id === outcome.agreementId)!;
    const dpa = agreements.find((a) => a.id === practice.dpaId)!;
    expect(baa).toMatchObject({
      agreement_kind: "baa",
      organization_id: practice.organizationId,
      terminated_at: null,
      document_hash: server.hash,
    });
    expect(dpa.terminated_at).not.toBeNull();
    const { rows: clinicRows } = await getMigratorPool().query<{ agreement_kind: string }>(
      `select agreement_kind from clinics where id = $1`,
      [practice.clinicId],
    );
    expect(clinicRows[0]!.agreement_kind).toBe("baa");
    expect(await acceptsPhi(practice.clinicId)).toBe(true);

    // The re-sign closed, and the pause it set is lifted.
    expect((await resigns(practice.clinicId))[0]).toMatchObject({
      status: "signed",
      superseding_agreement_id: outcome.agreementId,
      resolved_by: practice.staffEmail,
    });
    expect((await pause(practice.clinicId)).ai_paused_at).toBeNull();
    // Both are written in the signing transaction, where occurred_at's now()
    // is the same instant for each, so no column orders them: each once.
    const { rows: events } = await getMigratorPool().query<{ event: string }>(
      `select event from security_events
        where event in ('agreement_superseded', 'agreement_resign_signed')
          and metadata->>'clinicId' = $1 order by event`,
      [practice.clinicId],
    );
    expect(events.map((e) => e.event)).toEqual(["agreement_resign_signed", "agreement_superseded"]);

    // The link is spent: a second signature with it is refused, and it opens on "signed".
    const again = await signAgreementResign(token, {
      ...signature,
      displayedHash: sha256(shown.text),
      templateVersion: CURRENT_BAA_VERSION,
    });
    expect(again).toEqual({ status: "closed", reason: "signed" });
    expect(await lookUpResignLink(token)).toEqual({ ok: false, reason: "signed" });
    const { rows: count } = await getMigratorPool().query<{ n: number }>(
      `select count(*)::int as n from baa_acceptances where accepted_by_email = $1 and agreement_kind = 'baa'`,
      [practice.staffEmail],
    );
    expect(count[0]!.n).toBe(1);
  });

  test("No again withdraws it: the DPA covers the practice, the pause lifts and the link closes", async () => {
    const practice = await dpaPractice("resignno");
    await setCoveredEntity({
      clinicId: practice.clinicId,
      answer: "yes",
      actor: OPERATOR,
      actorLabel: "ops@healdesk.test",
    });
    const token = linkIn(l22For(practice.staffEmail)[0]!.text);
    const outcome = await setCoveredEntity({
      clinicId: practice.clinicId,
      answer: "no",
      actor: OPERATOR,
      actorLabel: "ops@healdesk.test",
    });
    expect(outcome).toMatchObject({ status: "recorded", covered: true, supersede: null });
    expect((await resigns(practice.clinicId))[0]).toMatchObject({
      status: "withdrawn",
      resolved_by: "ops@healdesk.test",
    });
    expect((await pause(practice.clinicId)).ai_paused_at).toBeNull();
    expect(await acceptsPhi(practice.clinicId)).toBe(true);
    expect(await lookUpResignLink(token)).toEqual({ ok: false, reason: "withdrawn" });
  });

  test("a pause the practice set itself stays its own when the agreement is signed", async () => {
    const practice = await dpaPractice("resignown");
    await withTenant({ clinicId: practice.clinicId, actor: OPERATOR }, (tx) =>
      pauseAya(tx, { choice: "indefinite", actorLabel: "Front desk Mac" }),
    );
    await setCoveredEntity({
      clinicId: practice.clinicId,
      answer: "yes",
      actor: OPERATOR,
      actorLabel: "ops@healdesk.test",
      source: "portal",
    });
    expect((await resigns(practice.clinicId))[0]).toMatchObject({
      source: "portal",
      paused_at: null,
    });
    const token = linkIn(l22For(practice.staffEmail)[0]!.text);
    const link = await lookUpResignLink(token);
    if (!link.ok) throw new Error("the link did not open");
    const signature = { signatoryName: "Laura Owner", signatoryTitle: "Owner" };
    const shown = renderResignPreview(link.document, signature, effectiveDateOf(new Date()));
    const outcome = await signAgreementResign(token, {
      ...signature,
      displayedHash: sha256(shown.text),
      templateVersion: CURRENT_BAA_VERSION,
    });
    expect(outcome.status).toBe("signed");
    expect(await pause(practice.clinicId)).toMatchObject({ ai_paused_by_label: "Front desk Mac" });
  });

  test("the hourly job: a fresh link at 3 and 7 days, and ops told once at 7", async () => {
    const practice = await dpaPractice("resignjob");
    await setCoveredEntity({
      clinicId: practice.clinicId,
      answer: "not_sure",
      actor: OPERATOR,
      actorLabel: "ops@healdesk.test",
    });
    const first = l22For(practice.staffEmail);
    expect(first).toHaveLength(1);
    expect(first[0]!.text).toContain("not sure whether");

    // Within the first three days there is nothing more to send.
    await runAgreementResignsJob({ now: new Date(Date.now() + 1 * DAY) });
    expect(l22For(practice.staffEmail)).toHaveLength(1);

    await runAgreementResignsJob({ now: new Date(Date.now() + 3 * DAY + 60_000) });
    const day3 = l22For(practice.staffEmail);
    expect(day3).toHaveLength(2);
    expect(day3[1]!.subject).toBe("Your updated agreement is waiting to be signed");
    expect(day3[1]!.text).toContain("3 days after we sent it");
    expect(linkIn(day3[1]!.text)).not.toBe(linkIn(day3[0]!.text));

    // The same hour again sends nothing: the ledger has the day.
    await runAgreementResignsJob({ now: new Date(Date.now() + 3 * DAY + 120_000) });
    expect(l22For(practice.staffEmail)).toHaveLength(2);

    const day7 = new Date(Date.now() + 7 * DAY + 60_000);
    await runAgreementResignsJob({ now: day7 });
    await runAgreementResignsJob({ now: new Date(day7.getTime() + 60 * 60 * 1000) });
    const all = l22For(practice.staffEmail);
    expect(all).toHaveLength(3);
    expect(all[2]!.text).toContain("7 days after we sent it");
    const { rows } = await getMigratorPool().query<{ n: number }>(
      `select count(*)::int as n from ops_alerts
        where event = 'agreement_unsigned_7_days' and fields->>'clinicId' = $1`,
      [practice.clinicId],
    );
    expect(rows[0]!.n).toBe(1);
  });
});
