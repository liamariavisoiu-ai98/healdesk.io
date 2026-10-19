import { createHash } from "node:crypto";

import {
  agreementPlatformFor,
  BAA_ASSENT_LABEL,
  BAA_TEMPLATES,
  CURRENT_BAA_VERSION,
  currentDpaTemplate,
  DPA_ASSENT_LABEL,
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

/**
 * Stand-ins for two catalogue facts a release decides: whether the DPA is
 * released (the decision sends a "No" practice to it once it is), and a
 * release overlap. Off unless a test turns them on.
 */
const stand = vi.hoisted(() => ({ dpaReleased: false, overlap: {} as Record<string, string> }));
vi.mock("@healdesk/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@healdesk/catalog")>();
  return {
    ...actual,
    agreementKindFor: (input: Parameters<typeof actual.agreementKindFor>[0]) =>
      actual.agreementKindFor({
        ...input,
        dpaReleased: input.dpaReleased ?? (stand.dpaReleased ? true : undefined),
      }),
    get BAA_RELEASE_OVERLAP() {
      return stand.overlap;
    },
  };
});

/**
 * The switch (lib/agreements/baa-version-ready.ts) is off until the calendar
 * fix lands; these tests stand in for the commit that turns it on, so the
 * mechanism stays tested, and the switch-off test turns it back off.
 */
const resignsSwitch = vi.hoisted(() => ({ ready: true }));
vi.mock("@/lib/agreements/baa-version-ready", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agreements/baa-version-ready")>();
  return { ...actual, baaVersionResignsReady: () => resignsSwitch.ready };
});

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
const { agreementKindForRequest } = await import("@healdesk/catalog/agreement-signing");
const { startBaaVersionResigns } = await import("@/lib/agreements/baa-version");
const { setCoveredEntity } = await import("@/lib/agreements/covered-entity");
const { BAA_VERSION_RESIGNS_READY, BAA_VERSION_RESIGNS_WAITING } =
  await import("@/lib/agreements/baa-version-ready");
const { runOperation } = await import("@/lib/ops/api");
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
  /** app_baa_version_acceptable() as the migrations left it, saved before any test stands in for a release. */
  let floor = "";
  /** The registered versions that definition accepts. */
  let accepted: string[] = [];

  beforeAll(async () => {
    await runMigrations();
    const { rows } = await getMigratorPool().query<{ def: string }>(
      `select pg_get_functiondef('app_baa_version_acceptable(text)'::regprocedure) as def`,
    );
    floor = rows[0]!.def;
    for (const template of BAA_TEMPLATES) {
      const { rows: ok } = await getMigratorPool().query<{ ok: boolean }>(
        `select app_baa_version_acceptable($1) as ok`,
        [template.version],
      );
      if (ok[0]!.ok) accepted.push(template.version);
    }
    expect(accepted).not.toContain(OLD);
  }, 120_000);

  beforeEach(async () => {
    await truncateAll();
    await attestPlatform();
    await acceptOld(false);
    stand.dpaReleased = false;
    stand.overlap = {};
    resignsSwitch.ready = true;
    sent.emails.length = 0;
    sent.copies = 0;
  });

  afterAll(async () => {
    await acceptOld(false);
    await closePools();
  });

  /**
   * The floor: false puts back the migrations' own definition, saved in
   * beforeAll, whatever a later release makes it; true stands in for a
   * release that kept 1.5.0 acceptable too, beside everything that accepts.
   */
  async function acceptOld(old: boolean): Promise<void> {
    if (!old) {
      await getMigratorPool().query(floor);
      return;
    }
    const list = [...accepted, OLD].map((v) => `'${v}'`).join(", ");
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
    options: {
      version?: string;
      synthetic?: boolean;
      live?: boolean;
      covered?: boolean | null;
    } = {},
  ) {
    const covered = options.covered === undefined ? null : options.covered;
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
        isCoveredEntity: covered,
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
          set regulatory_regime = 'hipaa-if-covered', agreement_kind = 'baa', is_covered_entity = $3,
              data_classification = $2, baa_signed_at = now() - interval '1 day'
        where id = $1`,
      [clinic.clinicId, options.synthetic ? "synthetic" : "production", covered],
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
      client.query<{
        ai_paused_at: Date | null;
        ai_paused_by_label: string | null;
        ai_paused_until: Date | null;
      }>(
        `select ai_paused_at, ai_paused_by_label, ai_paused_until from clinic_settings where clinic_id = $1`,
        [clinicId],
      ),
    );
    return rows[0]!;
  }

  function l22For(to: string) {
    return sent.emails.filter((e) => e.kind === "agreement_to_sign" && e.to === to);
  }

  /**
   * A second location of the practice, as add-location will make one
   * (LOCATION_CLINICS_READY is false, so it is seeded as the billing tests
   * seed one): in its organisation, billed on it, production, with phone
   * live and a direct line of its own.
   */
  async function seedLocation(
    practice: { clinicId: string; organizationId: string },
    label: string,
    kind: "baa" | "dpa" = "baa",
  ) {
    const { rows } = await getMigratorPool().query<{ id: string }>(
      `insert into clinics (organization_id, slug, name, specialty, billing_clinic_id)
       values ($1, $2, $3, 'med-spa', $4) returning id`,
      [
        practice.organizationId,
        `${label}-${Date.now().toString(36)}`,
        `${label} Clinic`,
        practice.clinicId,
      ],
    );
    const locationId = rows[0]!.id;
    await getMigratorPool().query(
      `update clinics
          set regulatory_regime = 'hipaa-if-covered', agreement_kind = $2,
              is_covered_entity = case when $2 = 'dpa' then false else null end,
              data_classification = 'production', baa_signed_at = now() - interval '1 day'
        where id = $1`,
      [locationId, kind],
    );
    const live = new Date(Date.now() - 2 * DAY);
    await seedChannels(locationId, [{ channel: "voice", liveAt: live, readyAt: live }]);
    await inTenant(locationId, (client) =>
      client.query(
        `insert into clinic_settings (clinic_id, direct_line_e164) values ($1, '+14155550199')
           on conflict (clinic_id) do update set direct_line_e164 = excluded.direct_line_e164`,
        [locationId],
      ),
    );
    return locationId;
  }

  /** Sign the open re-sign the latest L22 to `to` links to, as the screen does. */
  async function signFromL22(to: string, now = new Date()) {
    const token = linkIn(l22For(to).at(-1)!.text);
    const link = await lookUpResignLink(token, now);
    if (!link.ok) throw new Error(`the link did not open: ${link.reason}`);
    const signature = { signatoryName: "Laura Owner", signatoryTitle: "Owner" };
    const shown = renderResignPreview(link.document, signature, effectiveDateOf(now));
    return signAgreementResign(
      token,
      {
        ...signature,
        displayedHash: sha256(shown.text),
        templateVersion: link.document.templateVersion,
      },
      {},
      now,
    );
  }

  test("switched off until the calendar fix: the job opens no BAA-version re-sign, the broadcast refuses and changes nothing, and the DPA re-sign is untouched", async () => {
    // The commit that merges the calendar fix turns it on; until then it is off.
    expect(BAA_VERSION_RESIGNS_READY).toBe(false);
    resignsSwitch.ready = false;
    const practice = await baaPractice("bvoff");

    expect(await runAgreementResignsJob()).toMatchObject({ opened: 0, open: 0 });
    const refused = await startBaaVersionResigns({ actorLabel: "ops@healdesk.test" });
    expect(refused).toEqual({
      status: "refused",
      message: expect.stringMatching(/calendar fix.*Nothing was changed\./),
    });
    const operator = { email: "ops@healdesk.test", request: {} };
    const viaOps = (await runOperation("startBaaVersionResigns", {}, operator)) as {
      status: number;
      body: { data?: { status: string; message: string } };
    };
    expect(viaOps.body.data).toMatchObject({ status: "refused" });
    expect(await resigns(practice.clinicId)).toEqual([]);
    expect(l22For(practice.staffEmail)).toEqual([]);

    // The console reads the switch, with the line it shows.
    const view = (await runOperation("getOperatorNotices", {}, operator)) as {
      body: { data: { baaVersionResigns: unknown } };
    };
    expect(view.body.data.baaVersionResigns).toEqual({
      ready: false,
      waiting: BAA_VERSION_RESIGNS_WAITING,
    });

    // WP9's DPA→BAA re-sign is not behind it.
    const dpa = await dpaPractice("bvoffdpa");
    await yes(dpa.clinicId);
    expect(await resigns(dpa.clinicId)).toMatchObject([{ reason: "now_covered", status: "open" }]);
  });

  test("the floor passed the version in force: the job opens the re-sign and sends L22 once, and AYA keeps answering", async () => {
    const practice = await baaPractice("bvfloor");

    const first = await runAgreementResignsJob();
    expect(first).toMatchObject({ opened: 1, sent: 1 });
    const [resign] = await resigns(practice.clinicId);
    expect(resign).toMatchObject({
      status: "open",
      reason: "baa_version",
      source: "release",
      from_agreement_id: practice.agreementId,
      paused_at: null,
    });
    // Never a pause (owner, 19 October 2026): the version signed governs until the newer one is.
    expect((await pause(practice.clinicId)).ai_paused_at).toBeNull();

    const [l22] = l22For(practice.staffEmail);
    expect(l22!.subject).toBe("Sign your updated agreement");
    expect(l22!.text).toContain(
      `version ${CURRENT_BAA_VERSION}, in place of version ${OLD}, which you signed`,
    );
    expect(l22!.text).toContain("AYA keeps answering while you read it and sign it.");
    expect(l22!.text).not.toContain("paused");
    expect(l22!.text).not.toContain("insurance");
    expect(readResignToken(linkIn(l22!.text))).toMatchObject({ ok: true, resignId: resign!.id });

    // She answers, and the header works as always.
    const voice = await assistantMayAnswer({
      clinicId: practice.clinicId,
      channel: "voice",
      actor: OPERATOR,
    });
    expect(voice).toMatchObject({ decision: "answer" });
    const header = { clinicId: practice.clinicId, actor: OPERATOR };
    await withTenant(header, (tx) =>
      pauseAya(tx, { choice: "hour", actorLabel: "Front desk Mac" }),
    );
    await withTenant(header, (tx) => resumeAya(tx, { actorLabel: "Front desk Mac" }));

    // The next hour opens nothing more and sends nothing again.
    expect(await runAgreementResignsJob()).toMatchObject({ opened: 0, open: 1 });
    expect(await resigns(practice.clinicId)).toHaveLength(1);
    expect(l22For(practice.staffEmail)).toHaveLength(1);
  });

  test("still unsigned below the floor at 7 days, ops is told once to phone the practice; within the floor, the usual alert", async () => {
    const alerts = async (event: string, clinicId: string) => {
      const { rows } = await getMigratorPool().query<{ n: number }>(
        `select count(*)::int as n from ops_alerts where event = $1 and fields->>'clinicId' = $2`,
        [event, clinicId],
      );
      return rows[0]!.n;
    };
    const below = await baaPractice("bvweekbelow");
    await runAgreementResignsJob();
    const day7 = new Date(Date.now() + 7 * DAY + 60_000);
    await runAgreementResignsJob({ now: day7 });
    await runAgreementResignsJob({ now: new Date(day7.getTime() + 60 * 60 * 1000) });
    expect(await alerts("agreement_below_floor_unsigned", below.clinicId)).toBe(1);
    expect(await alerts("agreement_unsigned_7_days", below.clinicId)).toBe(0);
    expect((await pause(below.clinicId)).ai_paused_at).toBeNull();

    // A version still acceptable (an overlap): the generic alert, and no pause either.
    await acceptOld(true);
    const within = await baaPractice("bvweekwithin");
    await startBaaVersionResigns({ actorLabel: "ops@healdesk.test" });
    await runAgreementResignsJob({ now: day7 });
    expect(await alerts("agreement_unsigned_7_days", within.clinicId)).toBe(1);
    expect(await alerts("agreement_below_floor_unsigned", within.clinicId)).toBe(0);
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
      holdsPause: false,
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

  test("the broadcast starts a version still acceptable, and AYA keeps answering when a later floor passes it", async () => {
    await acceptOld(true);
    const practice = await baaPractice("bvoverlap");
    // An overlap: go-live accepts 1.5.0, so the hourly job opens nothing.
    expect(await runAgreementResignsJob()).toMatchObject({ opened: 0, open: 0 });

    const started = await startBaaVersionResigns({ actorLabel: "ops@healdesk.test" });
    expect(started).toEqual({
      status: "started",
      version: CURRENT_BAA_VERSION,
      opened: 1,
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

    // The release that moves the floor past 1.5.0 pauses nothing either.
    await acceptOld(false);
    await runAgreementResignsJob({ now: new Date(Date.now() + 60 * 60 * 1000) });
    expect((await resigns(practice.clinicId))[0]).toMatchObject({
      status: "open",
      paused_at: null,
    });
    expect((await pause(practice.clinicId)).ai_paused_at).toBeNull();
    await withTenant(header, (tx) =>
      pauseAya(tx, { choice: "hour", actorLabel: "Front desk Mac" }),
    );
    await withTenant(header, (tx) => resumeAya(tx, { actorLabel: "Front desk Mac" }));
    expect(await lookUpResignLink(linkIn(l22!.text))).toMatchObject({
      ok: true,
      holdsPause: false,
    });
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
    // A person is told, once, however many hours it is asked again.
    await runAgreementResignsJob();
    const { rows } = await getMigratorPool().query<{ n: number }>(
      `select count(*)::int as n from ops_alerts
        where event = 'agreement_resign_unrenderable' and fields->>'clinicId' = $1`,
      [clinic.clinicId],
    );
    expect(rows[0]!.n).toBe(1);
  });

  /**
   * A med spa under the DPA, signed "No" as it will be after the release (the
   * stand-in every DPA test uses), bound, production, billed, with phone and
   * website chat live and a direct line: the DPA→BAA re-sign's practice.
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
    return clinic;
  }

  const yes = (clinicId: string) =>
    setCoveredEntity({ clinicId, answer: "yes", actor: OPERATOR, actorLabel: "ops@healdesk.test" });

  test("the DPA re-sign pauses every location of the organisation, which can't be turned back on from its own header and answers again when it is signed", async () => {
    const practice = await dpaPractice("bvorg");
    const location = await seedLocation(practice, "bvorgtwo", "dpa");
    const header = { clinicId: location, actor: OPERATOR };

    expect(await yes(practice.clinicId)).toMatchObject({ status: "recorded", covered: false });
    // One re-sign, the account's: the agreement is the organisation's.
    expect(await resigns(practice.clinicId)).toHaveLength(1);
    expect(await resigns(location)).toEqual([]);
    expect(await pause(location)).toMatchObject({ ai_paused_by_label: AGREEMENT_PAUSE_LABEL });

    // The location's own gate reads its own pause: its calls go to its direct line.
    const voice = await assistantMayAnswer({
      clinicId: location,
      channel: "voice",
      actor: OPERATOR,
    });
    expect(voice).toMatchObject({ decision: "pass_through", directLine: "+14155550199" });
    // And its header reads the account's re-sign, which the tenant policy hides from it.
    await expect(
      withTenant(header, (tx) => resumeAya(tx, { actorLabel: "Front desk iPad" })),
    ).rejects.toBeInstanceOf(PauseError);

    expect((await signFromL22(practice.staffEmail)).status).toBe("signed");
    expect((await pause(practice.clinicId)).ai_paused_at).toBeNull();
    expect((await pause(location)).ai_paused_at).toBeNull();
    await withTenant(header, (tx) =>
      pauseAya(tx, { choice: "hour", actorLabel: "Front desk iPad" }),
    );
  });

  test("a location the practice paused itself stays paused its own way through the DPA re-sign", async () => {
    const practice = await dpaPractice("bvorgown");
    const location = await seedLocation(practice, "bvorgowntwo", "dpa");
    await withTenant({ clinicId: location, actor: OPERATOR }, (tx) =>
      pauseAya(tx, { choice: "indefinite", actorLabel: "Front desk iPad" }),
    );
    await yes(practice.clinicId);
    expect(await pause(practice.clinicId)).toMatchObject({
      ai_paused_by_label: AGREEMENT_PAUSE_LABEL,
    });
    expect(await pause(location)).toMatchObject({ ai_paused_by_label: "Front desk iPad" });

    expect((await signFromL22(practice.staffEmail)).status).toBe("signed");
    expect((await pause(practice.clinicId)).ai_paused_at).toBeNull();
    expect(await pause(location)).toMatchObject({ ai_paused_by_label: "Front desk iPad" });
  });

  test("a location's own timed pause the DPA re-sign made indefinite gets its end back when it is signed, or ends if that has passed", async () => {
    const held = async (clinicId: string) => {
      const { rows } = await inTenant(clinicId, (client) =>
        client.query<{ paused_at: Date | null; held_pauses: unknown }>(
          `select paused_at, held_pauses from agreement_resigns where clinic_id = $1`,
          [clinicId],
        ),
      );
      return rows[0]!;
    };
    for (const [label, signedAfter] of [
      ["bvtimed", 0],
      ["bvtimedover", 2 * 60 * 60 * 1000],
    ] as const) {
      const practice = await dpaPractice(label);
      const location = await seedLocation(practice, `${label}two`, "dpa");
      await withTenant({ clinicId: location, actor: OPERATOR }, (tx) =>
        pauseAya(tx, { choice: "hour", actorLabel: "Front desk iPad" }),
      );
      const staff = await pause(location);
      expect(staff.ai_paused_until).not.toBeNull();

      await yes(practice.clinicId);
      // Made indefinite while the agreement waits, the practice's label and start kept.
      expect(await pause(location)).toEqual({ ...staff, ai_paused_until: null });
      const own = await pause(practice.clinicId);
      expect(await held(practice.clinicId)).toEqual({
        paused_at: own.ai_paused_at,
        held_pauses: [
          { clinicId: practice.clinicId, pausedAt: own.ai_paused_at!.toISOString(), until: null },
          {
            clinicId: location,
            pausedAt: staff.ai_paused_at!.toISOString(),
            until: staff.ai_paused_until!.toISOString(),
          },
        ],
      });

      const at = new Date(Date.now() + signedAfter);
      expect((await signFromL22(practice.staffEmail, at)).status).toBe("signed");
      expect((await pause(practice.clinicId)).ai_paused_at).toBeNull();
      if (signedAfter === 0) {
        // Signed within the hour: the location's own pause, as it set it.
        expect(await pause(location)).toEqual(staff);
      } else {
        // Its hour is over: nothing holds it paused any more.
        expect((await pause(location)).ai_paused_at).toBeNull();
        const voice = await assistantMayAnswer({
          clinicId: location,
          channel: "voice",
          actor: OPERATOR,
          now: at,
        });
        expect(voice).toMatchObject({ decision: "answer" });
      }
    }
  });

  test("a BAA version's re-sign pauses no location either", async () => {
    const practice = await baaPractice("bvorgbaa");
    const location = await seedLocation(practice, "bvorgbaatwo");
    expect(await runAgreementResignsJob()).toMatchObject({ opened: 1 });
    expect((await pause(location)).ai_paused_at).toBeNull();
    const voice = await assistantMayAnswer({
      clinicId: location,
      channel: "voice",
      actor: OPERATOR,
    });
    expect(voice).toMatchObject({ decision: "answer" });
  });

  test("a practice that answered No and holds the BAA signs its newer version as a BAA once the DPA is released", async () => {
    const practice = await baaPractice("bvno", { covered: false });
    await runAgreementResignsJob();
    stand.dpaReleased = true;
    // The decision alone now sends a No practice to the DPA.
    expect(agreementKindForRequest({ specialty: "med-spa", isCoveredEntity: false })).toBe("dpa");
    const token = linkIn(l22For(practice.staffEmail)[0]!.text);
    const link = await lookUpResignLink(token);
    if (!link.ok) throw new Error(`the link did not open: ${link.reason}`);
    expect(link.document.isCoveredEntity).toBe(false);
    const outcome = await signFromL22(practice.staffEmail);
    expect(outcome).toMatchObject({ status: "signed", version: CURRENT_BAA_VERSION });
    const { rows } = await getMigratorPool().query<{ agreement_kind: string }>(
      `select agreement_kind from clinics where id = $1`,
      [practice.clinicId],
    );
    expect(rows[0]!.agreement_kind).toBe("baa");
  });

  test("the screen signs only the version it showed: a crafted older version is refused, overlap or not", async () => {
    await acceptOld(true);
    stand.overlap = { [OLD]: "2999-01-01T00:00:00Z" };
    const practice = await baaPractice("bvcrafted");
    await startBaaVersionResigns({ actorLabel: "ops@healdesk.test" });
    const token = linkIn(l22For(practice.staffEmail)[0]!.text);
    const crafted = await signAgreementResign(token, {
      signatoryName: "Laura Owner",
      signatoryTitle: "Owner",
      templateVersion: OLD,
    });
    expect(crafted).toMatchObject({ status: "refused", field: "templateVersion" });
    expect((await resigns(practice.clinicId))[0]).toMatchObject({ status: "open" });
  });

  test("a BAA version's re-sign never records a pause, and no row's pause moves once written", async () => {
    await acceptOld(true);
    const practice = await baaPractice("bvguard");
    await startBaaVersionResigns({ actorLabel: "ops@healdesk.test" });
    const [resign] = await resigns(practice.clinicId);
    // As the runtime role, in the clinic's tenant, as the job would write it.
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
    // The runtime role has no grant on paused_at at all.
    await expect(
      asApp(`update agreement_resigns set paused_at = now() where id = $1`, [resign!.id]),
    ).rejects.toMatchObject({ code: "42501" });
    // Nor does anyone move it: 0088's guard fixes it once a row is written,
    // and the pauses it holds elsewhere with it (0102).
    await expect(
      inTenant(practice.clinicId, (client) =>
        client.query(`update agreement_resigns set paused_at = now() where id = $1`, [resign!.id]),
      ),
    ).rejects.toMatchObject({ message: expect.stringMatching(/fixed once opened/) });
    await expect(
      inTenant(practice.clinicId, (client) =>
        client.query(
          `update agreement_resigns set held_pauses = '[{"clinicId":"x","pausedAt":"y","until":null}]' where id = $1`,
          [resign!.id],
        ),
      ),
    ).rejects.toMatchObject({ message: expect.stringMatching(/fixed once opened/) });
    await expect(
      asApp(`update agreement_resigns set held_pauses = '[]' where id = $1`, [resign!.id]),
    ).rejects.toMatchObject({ code: "42501" });
    // And a BAA-version re-sign is never written paused, by anyone.
    const other = await baaPractice("bvguardinsert");
    await expect(
      inTenant(other.clinicId, (client) =>
        client.query(
          `insert into agreement_resigns (clinic_id, from_agreement_id, reason, source, requested_by, paused_at)
           values ($1, $2, 'baa_version', 'operator', 'ops@healdesk.test', now())`,
          [other.clinicId, other.agreementId],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    // Why it opened is never the runtime role's to rewrite.
    await expect(
      asApp(`update agreement_resigns set reason = 'not_sure' where id = $1`, [resign!.id]),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
