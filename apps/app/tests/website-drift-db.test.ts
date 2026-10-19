import { randomUUID } from "node:crypto";

import {
  agreementPlatformFor,
  BAA_ASSENT_LABEL,
  CURRENT_BAA_VERSION,
  parseClinicProfile,
  type ClinicProfile,
} from "@healdesk/catalog";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { signAgreement } from "@/lib/agreements";
import { assertPayloadAllowed } from "@/lib/email/lint";
import { runOperation, type Operator } from "@/lib/ops/api";
import { saveKnowledge } from "@/lib/portal/knowledge";
import { readHomeFacts } from "@/lib/portal/home";
import { provisionClinic } from "@/lib/provisioning";
import type { SetupSeed } from "@/lib/setup/seed";
import { saveSetupScreen, type SaveContext } from "@/lib/setup/save";
import { withTenant } from "@/lib/tenant";
import type { SiteReadOutcome } from "@/lib/website/client";
import {
  dueSiteRereads,
  runOneSiteReread,
  runSiteReadsJob,
  runWebsiteDriftJob,
  sweepSiteRereads,
} from "@/lib/website/job";
import { requestSiteReread } from "@/lib/website/queue";
import {
  claimSiteReread,
  countWebsiteChanges,
  decideWebsiteChange,
  readWebsiteChanges,
  recordSiteReread,
} from "@/lib/website/store";

import {
  closePools,
  getAppPool,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant } from "./setup/factories";

/**
 * The signed website re-reads and the drift list against the database (plan
 * Part B, "Re-reads"; Part F3, "Changes on your website"; Annex X5, L23). The
 * read itself is faked: apps/web's route has its own tests, and the signed
 * call its own (website-drift.test.ts).
 *
 * Provisioning asks for a read where the checkout's failed; a corrected
 * website asks for one, and a queued read is moved on rather than doubled; a
 * read that becomes the baseline fills setup and replaces what nobody has
 * touched; the drift check of a live clinic raises only what Knowledge does
 * not say, queues L23 with sections and counts, and keeps the baseline;
 * Confirm goes through the knowledge writers and asks the practice
 * questions, Ignore is remembered, a change the website drops is superseded
 * and comes back; a failure is retried with back-off and then given up; and
 * the runtime role can delete none of it.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "website-drift-test" } as const;
const OPERATOR: Operator = { email: "ops@healdesk.test", request: {} };

const HOURS = {
  sun: [],
  mon: [["09:00", "17:00"]],
  tue: [["09:00", "17:00"]],
  wed: [["09:00", "17:00"]],
  thu: [["09:00", "17:00"]],
  fri: [["09:00", "17:00"]],
  sat: [],
};

function profile(over: Record<string, unknown> = {}): ClinicProfile {
  const p = parseClinicProfile({
    version: 1,
    website: "glowmedspa.com",
    readAt: "2026-09-01T12:00:00.000Z",
    pages: 3,
    locations: [
      {
        label: "Glow Med Spa",
        address: "12 Main St, Springfield, IL 62701",
        phone: "(415) 555-0100",
        hours: HOURS,
      },
    ],
    services: [
      {
        name: "Signature facial",
        priceKind: "exact",
        priceUsd: 199,
        maxUsd: null,
        unit: null,
        durationMinutes: 60,
      },
      {
        name: "Express facial",
        priceKind: "from",
        priceUsd: 99,
        maxUsd: null,
        unit: null,
        durationMinutes: 30,
      },
    ],
    providers: [{ name: "Ana Lee", title: "Lead aesthetician" }],
    policies: ["Cancel 24 hours ahead to keep your deposit."],
    faqs: [{ question: "Is there parking?", answer: "Yes, behind the building." }],
    acceptsInsurance: "unknown",
    practiceKind: "med-spa",
    dropped: 0,
    ...over,
  });
  if (!p) throw new Error("the fixture profile does not parse");
  return p;
}

const BASE = profile();
/** The same website a month on: a price up, a question added, a policy gone, Saturdays open. */
const NEXT = profile({
  readAt: "2026-10-15T12:00:00.000Z",
  services: [{ ...BASE.services[0]!, priceUsd: 219 }, BASE.services[1]!],
  faqs: [...BASE.faqs, { question: "Do you take walk-ins?", answer: "On weekday mornings." }],
  policies: [],
  locations: [{ ...BASE.locations[0]!, hours: { ...HOURS, sat: [["10:00", "14:00"]] } }],
});

type Clinic = { clinicId: string; slug: string; userId: string };

async function provision(label: string, setup: SetupSeed): Promise<Clinic> {
  const email = `${label}-${randomUUID().slice(0, 8)}@glowspa.test`;
  const platform = agreementPlatformFor("none");
  const signed = await signAgreement({
    clinicLegalName: `${label} Med Spa LLC`,
    specialty: "med-spa",
    signatoryName: "Laura Owner",
    signatoryEmail: email,
    isCoveredEntity: false,
    attributionMode: "estimated",
    platform,
    bookingSystem: "none",
    calendarAccount: "workspace_no_baa",
    assentLabel: BAA_ASSENT_LABEL,
    templateVersion: CURRENT_BAA_VERSION,
  });
  const result = await provisionClinic(
    {
      clinicName: `${label} Med Spa LLC`,
      specialty: "med-spa",
      platform,
      plan: "voice-webchat-1000-1000",
      contactName: "Laura Owner",
      contactEmail: email,
      agreementId: signed.agreementId,
      idempotencyKey: `idem-${randomUUID()}`,
    },
    {},
    { setup },
  );
  return { clinicId: result.clinicId, slug: result.clinicSlug, userId: result.ownerUserId! };
}

function ctx(clinic: Clinic): SaveContext & { actorLabel: string } {
  return {
    clinicId: clinic.clinicId,
    slug: clinic.slug,
    userId: clinic.userId,
    actorLabel: "Front desk Mac",
  };
}

async function rows(
  clinicId: string,
  sql: string,
  values: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  return inTenant(clinicId, async (c) => (await c.query(sql, values)).rows);
}

const reads = (clinicId: string) =>
  rows(clinicId, `select * from site_rereads order by requested_at, id`);
const changes = (clinicId: string) =>
  rows(clinicId, `select * from website_changes order by detected_at, section, item_key`);

async function goLive(clinicId: string): Promise<void> {
  await inTenant(clinicId, (c) =>
    c.query(`update clinic_channels set live_at = now() - interval '40 days'`),
  );
}

async function askFor(
  clinicId: string,
  reason: "missing" | "corrected" | "drift" | "ops",
  website = "glowmedspa.com",
) {
  return withTenant({ clinicId, actor: ACTOR }, (tx) => requestSiteReread(tx, { reason, website }));
}

/** Run the clinic's queued read with apps/web faked to answer `outcome`. */
async function readNow(clinicId: string, outcome: SiteReadOutcome | ClinicProfile) {
  const [queued] = (await reads(clinicId)).filter((r) => r.status === "queued");
  expect(queued, "a queued read").toBeDefined();
  const answer: SiteReadOutcome =
    "status" in outcome ? outcome : { status: "read", profile: outcome };
  return runOneSiteReread(clinicId, String(queued!.id), { read: async () => answer });
}

async function noticeRows(clinicId: string) {
  return rows(
    clinicId,
    `select dedupe_key, payload from billing_notices where kind = 'website_changes' order by created_at`,
  );
}

async function knowledge(clinicId: string) {
  const [row] = await rows(clinicId, `select services, policies, quick_answers from agent_configs`);
  return row as {
    services: Record<string, unknown>[];
    policies: string[];
    quick_answers: Record<string, unknown>[];
  };
}

async function clinicRow(clinicId: string) {
  const [row] = await rows(
    clinicId,
    `select website, site_profile, address, published_phone_e164, opening_hours from clinics where id = $1`,
    [clinicId],
  );
  return row as {
    website: string | null;
    site_profile: ClinicProfile | null;
    address: string | null;
    published_phone_e164: string | null;
    opening_hours: Record<string, unknown> | null;
  };
}

describeDb("website re-reads and the drift list", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  });

  afterAll(async () => {
    await closePools();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("provisioning asks for a read where the checkout's failed, and keeps the read it has as the baseline", async () => {
    const missing = await provision("missing", { website: "glowmedspa.com" });
    expect((await reads(missing.clinicId)).map((r) => [r.reason, r.status, r.website])).toEqual([
      ["missing", "queued", "glowmedspa.com"],
    ]);

    const read = await provision("baseline", { website: "glowmedspa.com", profile: BASE });
    expect(await reads(read.clinicId)).toEqual([]);
    expect((await clinicRow(read.clinicId)).site_profile?.website).toBe("glowmedspa.com");

    const none = await provision("nosite", { website: null });
    expect(await reads(none.clinicId)).toEqual([]);
  });

  test("a corrected website asks for a read, and a queued one is moved on to the latest, never doubled", async () => {
    const clinic = await provision("corrected-ask", { website: "glowmedspa.com", profile: BASE });
    const basics = (website: string) =>
      saveSetupScreen(ctx(clinic), "basics", {
        name: "Glow Med Spa",
        address: "12 Main St, Springfield, IL 62701",
        phone: "(415) 555-0100",
        website,
        timezone: "America/New_York",
      });
    expect(await basics("glowmedspa.com")).toMatchObject({ ok: true });
    expect(await reads(clinic.clinicId)).toEqual([]);

    expect(await basics("glow-medspa.com")).toMatchObject({ ok: true });
    expect(await basics("https://glowspa.co/")).toMatchObject({ ok: true });
    // The monthly check asking now changes nothing but the time.
    await askFor(clinic.clinicId, "drift", "glowspa.co");
    expect((await reads(clinic.clinicId)).map((r) => [r.reason, r.status, r.website])).toEqual([
      ["corrected", "queued", "glowspa.co"],
    ]);

    // No website at all asks for nothing.
    expect(await basics("")).toMatchObject({ ok: true });
    expect(await reads(clinic.clinicId)).toHaveLength(1);
  });

  test("a missing profile's read becomes the baseline and fills setup, raising nothing and mailing nothing", async () => {
    const clinic = await provision("fill", { website: "glowmedspa.com" });
    const result = await readNow(clinic.clinicId, BASE);
    expect(result).toMatchObject({ status: "read", changes: 0, emailed: false });
    expect(result!.refilled.sort()).toEqual([
      "hours",
      "policies",
      "practice",
      "prices",
      "quick_answers",
    ]);

    const after = await clinicRow(clinic.clinicId);
    expect(after.site_profile?.website).toBe("glowmedspa.com");
    expect(after.address).toBe("12 Main St, Springfield, IL 62701");
    expect(after.published_phone_e164).toBe("+14155550100");
    expect(after.opening_hours).toMatchObject({ mon: [["09:00", "17:00"]] });
    const k = await knowledge(clinic.clinicId);
    expect(k.services.map((s) => [s.name, s.priceFromUsd])).toEqual([
      ["Signature facial", 199],
      ["Express facial", 99],
    ]);
    expect(k.policies).toEqual(["Cancel 24 hours ahead to keep your deposit."]);
    expect(k.quick_answers).toEqual([
      { question: "Is there parking?", answer: "Yes, behind the building." },
    ]);
    expect(await changes(clinic.clinicId)).toEqual([]);
    expect(await noticeRows(clinic.clinicId)).toEqual([]);
    // The practice questions are asked again for what was filled.
    expect(
      await rows(
        clinic.clinicId,
        `select status from practice_question_runs where status = 'queued'`,
      ),
    ).toHaveLength(1);
  });

  test("before go-live, a corrected website's read replaces what the old read seeded, and never what the clinic wrote", async () => {
    const clinic = await provision("replace", { website: "glowmedspa.com", profile: BASE });
    expect(
      await saveKnowledge(ctx(clinic), "policies", { policies: ["Our own policy, in our words."] }),
    ).toMatchObject({ ok: true });
    expect(
      await saveSetupScreen(ctx(clinic), "basics", {
        name: "Glow Med Spa",
        address: "12 Main St, Springfield, IL 62701",
        phone: "(415) 555-0100",
        website: "glowspa.co",
        timezone: "America/New_York",
      }),
    ).toMatchObject({ ok: true });

    const right = profile({
      website: "glowspa.co",
      services: [
        {
          name: "Brow shaping",
          priceKind: "exact",
          priceUsd: 45,
          maxUsd: null,
          unit: null,
          durationMinutes: 30,
        },
      ],
      policies: ["Deposits are refundable up to 48 hours ahead."],
      faqs: [{ question: "Do you take walk-ins?", answer: "On weekday mornings." }],
    });
    const result = await readNow(clinic.clinicId, right);
    expect(result).toMatchObject({ status: "read", emailed: false });
    expect(result!.refilled.sort()).toEqual(["prices", "quick_answers"]);

    const k = await knowledge(clinic.clinicId);
    expect(k.services.map((s) => s.name)).toEqual(["Brow shaping"]);
    expect(k.quick_answers.map((a) => a.question)).toEqual(["Do you take walk-ins?"]);
    expect(k.policies).toEqual(["Our own policy, in our words."]);
    expect((await clinicRow(clinic.clinicId)).site_profile?.website).toBe("glowspa.co");
    // What the clinic wrote stands; what the right website says beside it waits on the list.
    expect((await changes(clinic.clinicId)).map((c) => [c.section, c.kind, c.state])).toEqual([
      ["policies", "added", "new"],
    ]);
  });

  describe("the drift check of a live clinic", () => {
    let clinic: Clinic;

    beforeAll(async () => {
      clinic = await provision("drift", { website: "glowmedspa.com", profile: BASE });
      await goLive(clinic.clinicId);
    });

    test("raises what Knowledge does not say, mails the sections and counts, and keeps the baseline", async () => {
      await askFor(clinic.clinicId, "drift");
      const result = await readNow(clinic.clinicId, NEXT);
      expect(result).toMatchObject({ status: "read", changes: 4, refilled: [], emailed: true });

      expect(
        (await changes(clinic.clinicId)).map((c) => `${c.section}:${c.kind}:${c.state}`).sort(),
      ).toEqual([
        "hours:changed:new",
        "policies:removed:new",
        "prices:changed:new",
        "quick_answers:added:new",
      ]);
      // The baseline is the purchase read, still.
      expect((await clinicRow(clinic.clinicId)).site_profile?.readAt).toBe(BASE.readAt);

      const [notice] = await noticeRows(clinic.clinicId);
      const read = (await reads(clinic.clinicId)).at(-1)!;
      expect(notice!.dedupe_key).toBe(`website_changes:${read.id}`);
      expect(notice!.payload).toEqual({
        sectionRows: [
          { section: "prices", count: 1 },
          { section: "hours", count: 1 },
          { section: "policies", count: 1 },
          { section: "quick_answers", count: 1 },
        ],
        count: 4,
        reviewUrl: expect.stringMatching(new RegExp(`/c/${clinic.slug}/knowledge#website$`)),
      });
      expect(() => assertPayloadAllowed(notice!.payload, "website_changes")).not.toThrow();
      expect(JSON.stringify(notice!.payload)).not.toMatch(/facial|walk-ins|219/i);

      // Home's "Needs attention" and the list on Knowledge.
      expect(
        await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
          countWebsiteChanges(tx),
        ),
      ).toBe(4);
      const facts = await readHomeFacts({ clinicId: clinic.clinicId, address: null, actor: ACTOR });
      expect(facts.websiteChanges).toBe(4);
      const list = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
        readWebsiteChanges(tx),
      );
      expect(list.changes.map((c) => c.section)).toEqual([
        "prices",
        "hours",
        "policies",
        "quick_answers",
      ]);
      expect(list.changes[0]).toMatchObject({
        text: "On your website: Signature facial, $219, 60 minutes.",
        detail: "Before: $199, 60 minutes.",
        canConfirm: true,
      });
    });

    test("Confirm goes through the knowledge writers and asks the practice questions; Ignore is remembered", async () => {
      const byKey = Object.fromEntries(
        (await changes(clinic.clinicId)).map((c) => [String(c.section), String(c.id)]),
      );
      // A deposit the clinic set beside the price is kept.
      await inTenant(clinic.clinicId, (c) =>
        c.query(
          `update agent_configs set services = jsonb_set(services, '{0,depositUsd}', '50'::jsonb)`,
        ),
      );

      const confirmed = await decideWebsiteChange(ctx(clinic), byKey.prices, "confirm");
      expect(confirmed).toEqual({ ok: true, toast: "Prices updated. AYA uses it from now on." });
      const k = await knowledge(clinic.clinicId);
      expect(k.services[0]).toMatchObject({
        name: "Signature facial",
        priceFromUsd: 219,
        priceToUsd: 219,
        depositUsd: 50,
      });
      expect(
        await rows(
          clinic.clinicId,
          `select trigger_section from practice_question_runs where status = 'queued'`,
        ),
      ).toEqual([{ trigger_section: "prices" }]);

      expect(await decideWebsiteChange(ctx(clinic), byKey.hours, "confirm")).toMatchObject({
        ok: true,
      });
      expect((await clinicRow(clinic.clinicId)).opening_hours).toMatchObject({
        sat: [["10:00", "14:00"]],
      });
      expect(await decideWebsiteChange(ctx(clinic), byKey.policies, "confirm")).toMatchObject({
        ok: true,
      });
      expect((await knowledge(clinic.clinicId)).policies).toEqual([]);

      expect(await decideWebsiteChange(ctx(clinic), byKey.quick_answers, "ignore")).toEqual({
        ok: true,
        toast: "Ignored. We won't raise that change again.",
      });
      expect(await decideWebsiteChange(ctx(clinic), byKey.quick_answers, "confirm")).toMatchObject({
        ok: false,
        message: expect.stringMatching(/already dealt with/),
      });
      expect(
        (await changes(clinic.clinicId))
          .map((c) => [c.section, c.state, c.decided_by_label])
          .sort(),
      ).toEqual([
        ["hours", "confirmed", "Front desk Mac"],
        ["policies", "confirmed", "Front desk Mac"],
        ["prices", "confirmed", "Front desk Mac"],
        ["quick_answers", "ignored", "Front desk Mac"],
      ]);
      expect(
        await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
          countWebsiteChanges(tx),
        ),
      ).toBe(0);
    });

    test("the same check next month raises nothing it raised before, and sends no second L23", async () => {
      await askFor(clinic.clinicId, "drift");
      expect(await readNow(clinic.clinicId, NEXT)).toMatchObject({
        status: "read",
        changes: 0,
        emailed: false,
      });
      expect(await noticeRows(clinic.clinicId)).toHaveLength(1);
      expect((await changes(clinic.clinicId)).filter((c) => c.state === "new")).toEqual([]);
    });

    test("a change the website drops is superseded, and comes back if the website says it again", async () => {
      // Saturday's hours were confirmed; reopen the question with Knowledge back on the old week.
      await inTenant(clinic.clinicId, (c) =>
        c.query(`update clinics set opening_hours = $1::jsonb`, [JSON.stringify(HOURS)]),
      );
      const later = profile({
        ...NEXT,
        locations: [{ ...BASE.locations[0]!, hours: { ...HOURS, sat: [["10:00", "15:00"]] } }],
      });
      await askFor(clinic.clinicId, "drift");
      expect(await readNow(clinic.clinicId, later)).toMatchObject({ changes: 1, emailed: true });
      const waiting = (await changes(clinic.clinicId)).filter((c) => c.state === "new");
      expect(waiting.map((c) => c.section)).toEqual(["hours"]);

      // The website goes back to what Knowledge says: nothing waits.
      await askFor(clinic.clinicId, "drift");
      expect(await readNow(clinic.clinicId, BASE)).toMatchObject({ changes: 0 });
      expect((await changes(clinic.clinicId)).find((c) => c.id === waiting[0]!.id)?.state).toBe(
        "superseded",
      );

      await askFor(clinic.clinicId, "drift");
      expect(await readNow(clinic.clinicId, later)).toMatchObject({ changes: 1, emailed: true });
      expect((await changes(clinic.clinicId)).find((c) => c.id === waiting[0]!.id)?.state).toBe(
        "new",
      );
      // The ignored question is still ignored.
      expect(
        (await changes(clinic.clinicId)).find((c) => c.section === "quick_answers")?.state,
      ).toBe("ignored");
    });

    test("a change Knowledge comes to say leaves the list at once", async () => {
      expect(
        await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
          countWebsiteChanges(tx),
        ),
      ).toBe(1);
      expect(
        await saveKnowledge(ctx(clinic), "hours", {
          hours: { ...HOURS, sat: [["10:00", "15:00"]] },
          closures: [],
        }),
      ).toMatchObject({ ok: true });
      expect(
        await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
          countWebsiteChanges(tx),
        ),
      ).toBe(0);
    });

    test("a provider is set up in Settings, never confirmed from the list", async () => {
      const [read] = await reads(clinic.clinicId);
      const [row] = await rows(
        clinic.clinicId,
        `insert into website_changes (clinic_id, reread_id, section, kind, item_key, fingerprint, after)
         values ('${clinic.clinicId}', '${read!.id}', 'providers', 'added', 'maya cho', repeat('a', 64),
                 '{"name": "Maya Cho", "title": null}'::jsonb)
         returning id`,
      );
      expect(await decideWebsiteChange(ctx(clinic), String(row!.id), "confirm")).toEqual({
        ok: false,
        message: "Providers are set up with their calendars, in Settings → Calendar.",
      });
      expect(await decideWebsiteChange(ctx(clinic), String(row!.id), "ignore")).toMatchObject({
        ok: true,
      });
    });
  });

  test("a failure is tried again later, twice, then given up; a refusal is given up at once", async () => {
    const clinic = await provision("fails", { website: "glowmedspa.com" });
    const fail = { status: "failed", failure: "network" } as const;
    const before = Date.now();
    expect(await readNow(clinic.clinicId, fail)).toMatchObject({
      status: "queued",
      failure: "network",
    });
    let [row] = await reads(clinic.clinicId);
    expect(row).toMatchObject({ status: "queued", attempts: 1, failure: "network" });
    expect((row!.run_after as Date).getTime()).toBeGreaterThanOrEqual(before + 29 * 60_000);
    // Not due yet.
    expect((await dueSiteRereads(50)).some((d) => d.id === row!.id)).toBe(false);

    const due = () =>
      inTenant(clinic.clinicId, (c) =>
        c.query(`update site_rereads set run_after = now() - interval '1 minute'`),
      );
    await due();
    expect(
      await readNow(clinic.clinicId, {
        status: "failed",
        failure: "rate_limited",
        retryAfterSeconds: 86_400,
      }),
    ).toMatchObject({ status: "queued" });
    [row] = await reads(clinic.clinicId);
    expect((row!.run_after as Date).getTime()).toBeGreaterThanOrEqual(before + 86_000_000);
    await due();
    expect(await readNow(clinic.clinicId, fail)).toMatchObject({ status: "failed" });
    [row] = await reads(clinic.clinicId);
    expect(row).toMatchObject({ status: "failed", attempts: 3, failure: "network" });
    expect(row!.finished_at).not.toBeNull();

    await askFor(clinic.clinicId, "ops");
    expect(await readNow(clinic.clinicId, { status: "failed", failure: "refused" })).toMatchObject({
      status: "failed",
    });
  });

  test("a read of a website the clinic has since corrected is superseded, and the corrected one runs next", async () => {
    const clinic = await provision("overtaken", { website: "glowmedspa.com" });
    const [queued] = await reads(clinic.clinicId);
    const claimed = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
      claimSiteReread(tx, String(queued!.id)),
    );
    expect(claimed).not.toBeNull();
    // While it runs, the clinic corrects its website.
    expect(
      await saveSetupScreen(ctx(clinic), "basics", {
        name: "Glow Med Spa",
        address: "",
        phone: "",
        website: "glowspa.co",
        timezone: "America/New_York",
      }),
    ).toMatchObject({ ok: true });
    const recorded = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
      recordSiteReread(tx, { reread: claimed!, outcome: { status: "read", profile: BASE } }),
    );
    expect(recorded).toMatchObject({ status: "superseded", changes: 0 });
    expect((await clinicRow(clinic.clinicId)).site_profile).toBeNull();
    expect((await reads(clinic.clinicId)).map((r) => [r.reason, r.status, r.website])).toEqual([
      ["missing", "superseded", "glowmedspa.com"],
      ["corrected", "queued", "glowspa.co"],
    ]);
  });

  test("the database: forced isolation, no deletes, and nothing about a change rewritten but its state", async () => {
    const pool = getMigratorPool();
    for (const table of ["site_rereads", "website_changes"]) {
      const {
        rows: [rls],
      } = await pool.query<{ forced: boolean }>(
        `select relforcerowsecurity as forced from pg_class where relname = $1`,
        [table],
      );
      expect(rls!.forced, table).toBe(true);
      const {
        rows: [del],
      } = await pool.query<{ deletable: boolean }>(
        `select has_table_privilege('healdesk_app', $1::regclass, 'DELETE') as deletable`,
        [table],
      );
      expect(del!.deletable, table).toBe(false);
    }
    for (const [table, column, allowed] of [
      ["website_changes", "state", true],
      ["website_changes", "fingerprint", false],
      ["website_changes", "item_key", false],
      ["website_changes", "after", false],
      ["website_changes", "section", false],
      ["site_rereads", "status", true],
      ["site_rereads", "clinic_id", false],
      ["site_rereads", "requested_at", false],
    ] as const) {
      const {
        rows: [p],
      } = await pool.query<{ ok: boolean }>(
        `select has_column_privilege('healdesk_app', $1, $2, 'UPDATE') as ok`,
        [table, column],
      );
      expect(p!.ok, `${table}.${column}`).toBe(allowed);
    }

    // One clinic's reads are invisible from another's tenant, as the runtime role.
    const a = await provision("iso-a", { website: "glowmedspa.com" });
    const b = await provision("iso-b", { website: "glowspa.co" });
    const client = await getAppPool().connect();
    try {
      await client.query("begin");
      await client.query(`select set_config('app.clinic_id', $1, true)`, [b.clinicId]);
      const seen = await client.query(`select clinic_id from site_rereads`);
      expect(seen.rows.map((r) => r.clinic_id)).toEqual([b.clinicId]);
      await expect(
        client.query(
          `insert into site_rereads (clinic_id, reason, website) values ($1, 'ops', 'glowmedspa.com')`,
          [a.clinicId],
        ),
      ).rejects.toThrow(/row-level security/);
    } finally {
      await client.query("rollback");
      client.release();
    }

    // The walk the minute job uses answers ids only.
    const { rows: walked } = await getAppPool().query(`select * from app_due_site_rereads(50)`);
    expect(Object.keys(walked[0] ?? { clinic_id: 1, id: 1 }).sort()).toEqual(["clinic_id", "id"]);
    expect(walked.some((r) => r.clinic_id === a.clinicId)).toBe(true);
  });

  test("the sweeps: a missing read once a day and three times at most; the monthly check only of a live clinic, a month on", async () => {
    const missing = await provision("sweep-missing", { website: "glowmedspa.com" });
    // Provisioning's own ask, failed and given up.
    await inTenant(missing.clinicId, (c) =>
      c.query(
        `update site_rereads set status = 'failed', finished_at = now(), requested_at = now() - interval '2 days'`,
      ),
    );
    const now = new Date();
    await sweepSiteRereads({ drift: false, now });
    expect((await reads(missing.clinicId)).map((r) => r.status)).toEqual(["failed", "queued"]);
    await inTenant(missing.clinicId, (c) =>
      c.query(
        `update site_rereads set status = 'failed', finished_at = now() where status = 'queued'`,
      ),
    );
    // Asked today already: not again until tomorrow.
    await sweepSiteRereads({ drift: false, now });
    expect(await reads(missing.clinicId)).toHaveLength(2);
    const tomorrow = new Date(now.getTime() + 25 * 60 * 60 * 1000);
    await sweepSiteRereads({ drift: false, now: tomorrow });
    await inTenant(missing.clinicId, (c) =>
      c.query(
        `update site_rereads set status = 'failed', finished_at = now() where status = 'queued'`,
      ),
    );
    // Three asks, then it is the operator's.
    await sweepSiteRereads({ drift: false, now: new Date(now.getTime() + 50 * 60 * 60 * 1000) });
    expect(await reads(missing.clinicId)).toHaveLength(3);

    const live = await provision("sweep-live", {
      website: "glowmedspa.com",
      profile: { ...BASE, readAt: new Date().toISOString() },
    });
    const setup = await provision("sweep-setup", { website: "glowmedspa.com", profile: BASE });
    await goLive(live.clinicId);
    await sweepSiteRereads({ drift: true, now });
    expect(await reads(live.clinicId)).toEqual([]);
    const month = new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000);
    await sweepSiteRereads({ drift: false, now: month });
    expect(await reads(live.clinicId)).toEqual([]);
    await sweepSiteRereads({ drift: true, now: month });
    expect((await reads(live.clinicId)).map((r) => [r.reason, r.status])).toEqual([
      ["drift", "queued"],
    ]);
    // A clinic still in setup has its purchase read, fresh: no check.
    expect(await reads(setup.clinicId)).toEqual([]);
  });

  test("the jobs: switched, and nothing is read until HEALDESK_WEB_URL names apps/web", async () => {
    const clinic = await provision("job", { website: "glowmedspa.com" });
    expect(await runSiteReadsJob()).toEqual({ status: "disabled" });
    expect(await runWebsiteDriftJob()).toEqual({ status: "disabled" });

    await getMigratorPool().query(
      `update scheduled_jobs set enabled = true where name = 'site-reads'`,
    );
    try {
      vi.stubEnv("HEALDESK_WEB_URL", "");
      expect(await runSiteReadsJob()).toEqual({
        status: "ok",
        note: "HEALDESK_WEB_URL is not set: nothing read.",
      });
      expect((await reads(clinic.clinicId)).map((r) => r.status)).toEqual(["queued"]);

      vi.stubEnv("HEALDESK_WEB_URL", "healdesk.io");
      expect(await runSiteReadsJob()).toMatchObject({
        status: "failed",
        note: expect.stringMatching(/HEALDESK_WEB_URL/),
      });

      // Two reads a minute, a clinic's in turn: earlier tests' clinics may be ahead of this one.
      const read = async () => ({ status: "read", profile: BASE }) as const;
      for (let i = 0; i < 30 && (await reads(clinic.clinicId))[0]!.status === "queued"; i += 1) {
        expect((await runSiteReadsJob({ read })).status).toBe("ok");
      }
      expect((await reads(clinic.clinicId)).map((r) => r.status)).toEqual(["read"]);
    } finally {
      await getMigratorPool().query(
        `update scheduled_jobs set enabled = false where name = 'site-reads'`,
      );
    }
  });

  test("ops: requestSiteReread queues an operator's read, and refuses a clinic with no website", async () => {
    const clinic = await provision("ops-read", { website: "glowmedspa.com", profile: BASE });
    const queued = await runOperation("requestSiteReread", { clinicId: clinic.clinicId }, OPERATOR);
    expect(queued).toMatchObject({
      status: 200,
      body: { data: { status: "queued", auditRecorded: true } },
    });
    const [row] = await reads(clinic.clinicId);
    expect(row).toMatchObject({ reason: "ops", status: "queued", website: "glowmedspa.com" });
    expect((queued.body as { data: { rereadId: string } }).data.rereadId).toBe(row!.id);

    // With a baseline, an operator's read is a drift check now, mailed like one.
    await goLive(clinic.clinicId);
    expect(await readNow(clinic.clinicId, NEXT)).toMatchObject({
      status: "read",
      changes: 4,
      emailed: true,
    });

    const none = await provision("ops-none", { website: null });
    expect(
      await runOperation("requestSiteReread", { clinicId: none.clinicId }, OPERATOR),
    ).toMatchObject({
      status: 200,
      body: { data: { status: "refused", message: "This clinic has no website to read." } },
    });
    expect(
      await runOperation("requestSiteReread", { clinicId: randomUUID() }, OPERATOR),
    ).toMatchObject({ status: 404 });
  });
});
