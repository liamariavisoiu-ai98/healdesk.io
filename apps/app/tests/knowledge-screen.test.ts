import { NEVER_SAY_DEFAULTS } from "@healdesk/catalog";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import {
  effectiveDepositUsd,
  findService,
  getDepositSettings,
  readClinicDepositFacts,
} from "@/lib/billing/deposits";
import { readKnowledge } from "@/lib/setup/knowledge";
import { withTenant } from "@/lib/tenant";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant } from "./setup/factories";
import { provisionPortalClinic, type PortalClinic } from "./setup/portal-clinic";
import { brokenLinks } from "./setup/portal-links";

/**
 * Knowledge (plan Part F3), through its server action with the sign-in
 * stood in, against a provisioned clinic: each section saves on its own and
 * says when it applies; a refusal names the phrase and offers the same text
 * without it; a deposit set on a price is the one AYA asks for, which is
 * what lets Settings' "Take deposits" go on; "Restore the defaults" puts the
 * clinical defaults back; and the page as a browser receives it.
 */

const portal = { userId: "", clinicId: "", clinicSlug: "" };
const grants: { clinicId: string; slug: string; name: string }[] = [];

vi.mock("@/lib/portal/access", () => ({
  requirePortal: async () => portal,
  portalGrants: async () => grants,
  currentSessionToken: async () => null,
}));
vi.mock("@/lib/portal/actor", () => ({
  SIGN_IN_ACTOR_LABEL: "the clinic's sign-in",
  portalActor: async () => ({ label: "the clinic's sign-in", steppedUp: false }),
}));

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "knowledge-test" } as const;
const APPLIES = "Applies when website chat and phone open.";

let clinic: PortalClinic;

async function save(section: string, input: unknown) {
  const { saveKnowledgeAction } = await import("@/app/c/[slug]/knowledge/actions");
  return saveKnowledgeAction(portal.clinicSlug, section, input);
}

async function knowledge() {
  return withTenant({ clinicId: portal.clinicId, actor: ACTOR }, (tx) =>
    readKnowledge(tx.db, tx.clinicId),
  );
}

describeDb("Knowledge", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    clinic = await provisionPortalClinic("knowledge", { plan: "voice-webchat-1000-1000" });
    // Warm the page and its action up once, outside any test's clock: on a
    // busy machine the first import of a page's module graph alone can take
    // longer than a test is given.
    await import("@/app/c/[slug]/knowledge/page");
    await import("@/app/c/[slug]/knowledge/actions");
  }, 300_000);

  afterAll(async () => {
    await closePools();
  });

  beforeEach(() => {
    Object.assign(portal, {
      userId: clinic.userId,
      clinicId: clinic.clinicId,
      clinicSlug: clinic.clinicSlug,
    });
    grants.splice(0, grants.length, {
      clinicId: clinic.clinicId,
      slug: clinic.clinicSlug,
      name: "knowledge Med Spa LLC",
    });
  });

  test("each section saves on its own, and says it applies once a channel opens", async () => {
    expect(
      await save("practice", {
        name: "Glow Med Spa",
        address: "12 Main Street, Austin, TX 78701",
        phone: "(512) 555-0100",
        website: "https://glow.example",
        timezone: "America/Chicago",
      }),
    ).toEqual({ ok: true, toast: `Your practice's details are saved. ${APPLIES}` });
    const [row] = await inTenant(
      clinic.clinicId,
      async (c) =>
        (
          await c.query<{ name: string; published_phone_e164: string; timezone: string }>(
            `select name, published_phone_e164, timezone from clinics where id = $1`,
            [clinic.clinicId],
          )
        ).rows,
    );
    expect(row).toEqual({
      name: "Glow Med Spa",
      published_phone_e164: "+15125550100",
      timezone: "America/Chicago",
    });

    expect(
      await save("policies", { policies: ["24 hours' notice to cancel.", "  ", "Cards only."] }),
    ).toEqual({ ok: true, toast: `2 policies saved. ${APPLIES}` });
    expect(
      await save("quick_answers", {
        quickAnswers: [{ question: "Where do I park?", answer: "Behind the building, free." }],
      }),
    ).toEqual({ ok: true, toast: `One quick answer saved. ${APPLIES}` });
    expect(
      await save("promotions", { promotions: "20% off your first facial this month." }),
    ).toEqual({ ok: true, toast: `Promotions saved. ${APPLIES}` });
    expect(
      await save("hours", {
        hours: {
          mon: [["09:00", "17:00"]],
          tue: [["09:00", "17:00"]],
          wed: [
            ["09:00", "12:30"],
            ["13:30", "17:00"],
          ],
          thu: [["09:00", "17:00"]],
          fri: [["09:00", "15:00"]],
          sat: [],
          sun: [],
        },
        closures: [{ closedOn: "2099-12-25", label: "Christmas" }],
      }),
    ).toMatchObject({ ok: true, toast: expect.stringMatching(/^Hours saved\./) });

    const k = await knowledge();
    expect(k.policies).toEqual(["24 hours' notice to cancel.", "Cards only."]);
    expect(k.quickAnswers).toEqual([
      { question: "Where do I park?", answer: "Behind the building, free." },
    ]);
    expect(k.promotions).toBe("20% off your first facial this month.");
    const closures = await inTenant(
      clinic.clinicId,
      async (c) =>
        (await c.query(`select closed_on::text as closed_on, label from clinic_closures`)).rows,
    );
    expect(closures).toEqual([{ closed_on: "2099-12-25", label: "Christmas" }]);
  });

  test("a refused save names the phrase, and offers the same text without it when that passes", async () => {
    const refused = await save("promotions", {
      promotions: "20% off your first facial this month. No downtime at all!",
    });
    expect(refused).toEqual({
      ok: false,
      field: "promotions",
      message: expect.stringMatching(
        /^This mentions recovery or aftercare \("[^"]*downtime[^"]*"\)\./,
      ),
      rewrite: "20% off your first facial this month.",
    });
    // Nothing was stored.
    expect((await knowledge()).promotions).toBe("20% off your first facial this month.");

    const answer = await save("quick_answers", {
      quickAnswers: [
        { question: "Where do I park?", answer: "Behind the building." },
        { question: "Is it safe?", answer: "Ask the team when you book." },
      ],
    });
    expect(answer).toMatchObject({
      ok: false,
      field: "quickAnswers[1].question",
      message: expect.stringContaining("a safety claim"),
    });

    const policy = await save("policies", {
      policies: ["Cards only.", "Arrive early. Pregnant clients should tell us first."],
    });
    expect(policy).toEqual({
      ok: false,
      field: "policies[1]",
      message: expect.stringContaining("pregnancy or breastfeeding"),
      rewrite: "Arrive early.",
    });
  });

  test("prices: how each is priced, its length and its deposit, which is the deposit AYA asks for", async () => {
    const before = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
      getDepositSettings(tx),
    );
    expect(before.hasDepositAmount).toBe(false);

    expect(
      await save("prices", {
        services: [
          {
            name: "Consultation",
            priceKind: "exact",
            price: 150,
            maxPrice: null,
            unit: null,
            durationMinutes: 30,
            depositUsd: 75,
          },
          {
            name: "Hydrafacial",
            priceKind: "from",
            price: 199,
            maxPrice: null,
            unit: null,
            durationMinutes: 60,
            depositUsd: null,
          },
        ],
      }),
    ).toEqual({
      ok: true,
      toast: `2 services saved. AYA quotes only the prices listed here. ${APPLIES}`,
    });

    const facts = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
      readClinicDepositFacts(tx),
    );
    const deposit = (name: string) =>
      effectiveDepositUsd({ service: findService(facts.services, name), policy: facts.policy });
    expect(deposit("Consultation")).toBe(75);
    // A row with no deposit is none, stored as 0, never the clinic default.
    expect(deposit("Hydrafacial")).toBe(0);
    const after = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
      getDepositSettings(tx),
    );
    expect(after.hasDepositAmount).toBe(true);

    expect(
      await save("prices", {
        services: [
          {
            name: "Consultation, recovery time included",
            priceKind: "exact",
            price: 150,
            durationMinutes: 30,
          },
        ],
      }),
    ).toMatchObject({
      ok: false,
      field: "services[0]",
      message: expect.stringContaining("recovery or aftercare"),
    });
  });

  test("a deposit left as None asks for none, even when the clinic has a default; a row that follows the default shows it", async () => {
    await inTenant(clinic.clinicId, async (c) => {
      await c.query(
        `update agent_configs
            set deposit_policy = '{"required":true,"amountUsd":50}'::jsonb,
                services = '[{"name":"Peel","priceKind":"exact","priceFromUsd":120,"priceToUsd":120,"durationMinutes":45}]'::jsonb
          where clinic_id = $1`,
        [clinic.clinicId],
      );
    });
    const deposits = async () => {
      const facts = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
        readClinicDepositFacts(tx),
      );
      return (name: string) =>
        effectiveDepositUsd({ service: findService(facts.services, name), policy: facts.policy });
    };
    // Peel has no deposit of its own, so it follows the clinic's $50, and the
    // page shows that $50 rather than "None".
    expect((await deposits())("Peel")).toBe(50);
    const { default: KnowledgePage } = await import("@/app/c/[slug]/knowledge/page");
    const html = renderToStaticMarkup(
      await KnowledgePage({ params: Promise.resolve({ slug: portal.clinicSlug }) }),
    );
    expect(html).toMatch(/aria-label="Service 1 deposit in dollars, empty for none"[^>]*value="50"/);

    // The form as the clinic sends it: Peel cleared to "None", and a new row
    // whose deposit was never touched.
    const { emptyServiceRow, servicesPayload } = await import("@/app/c/[slug]/editors");
    const rows = [
      {
        ...emptyServiceRow(),
        name: "Peel",
        price: "120",
        duration: "45",
        deposit: "",
        depositUsd: null,
      },
      { ...emptyServiceRow(), name: "Brow tint", price: "35", duration: "20" },
    ];
    expect(await save("prices", { services: servicesPayload(rows, true) })).toMatchObject({
      ok: true,
    });
    const after = await deposits();
    expect(after("Peel")).toBe(0);
    expect(after("Brow tint")).toBe(0);

    // A request that leaves the deposit out entirely is no deposit too.
    expect(
      await save("prices", {
        services: [
          { name: "Peel", priceKind: "exact", price: 120, durationMinutes: 45, depositUsd: null },
        ],
      }),
    ).toMatchObject({ ok: true });
    expect((await deposits())("Peel")).toBe(0);
    await inTenant(clinic.clinicId, async (c) => {
      await c.query(`update agent_configs set deposit_policy = null where clinic_id = $1`, [
        clinic.clinicId,
      ]);
    });
  });

  test("a live clinic's edit keeps the approval of AYA's words, so its Meta channels and direct booking carry on; before go-live, and in the wizard, an edit clears it", async () => {
    const approval = async () =>
      (
        await inTenant(
          clinic.clinicId,
          async (c) =>
            (
              await c.query<{ version: number; approved: boolean; clinic_approved: boolean }>(
                `select a.version, a.approved_at is not null as approved,
                        cl.agent_approved_at is not null as clinic_approved
                   from agent_configs a join clinics cl on cl.id = a.clinic_id
                  where a.clinic_id = $1`,
                [clinic.clinicId],
              )
            ).rows,
        )
      )[0]!;
    const approve = () =>
      inTenant(clinic.clinicId, async (c) => {
        await c.query(
          `update agent_configs set approved_at = now(), approved_by_label = 'Ops on the call' where clinic_id = $1`,
          [clinic.clinicId],
        );
        await c.query(`update clinics set agent_approved_at = now() where id = $1`, [
          clinic.clinicId,
        ]);
      });
    const setLive = (live: boolean) =>
      inTenant(clinic.clinicId, (c) =>
        c.query(`update clinics set went_live_at = ${live ? "now()" : "null"} where id = $1`, [
          clinic.clinicId,
        ]),
      );

    // Before go-live, an approval given on the call is given again after an
    // edit: go-live requires it, and it was given to the words before.
    await setLive(false);
    await approve();
    expect(await save("promotions", { promotions: "Free consultations in April." })).toMatchObject({
      ok: true,
    });
    expect(await approval()).toMatchObject({ approved: false, clinic_approved: false });

    await setLive(true);
    await approve();
    const before = await approval();
    expect(before).toMatchObject({ approved: true, clinic_approved: true });

    expect(await save("promotions", { promotions: "Free consultations in May." })).toMatchObject({
      ok: true,
    });
    expect(
      await save("prices", {
        services: [{ name: "Peel", priceKind: "exact", price: 130, durationMinutes: 45 }],
      }),
    ).toMatchObject({ ok: true });
    expect(await save("never_say_defaults", {})).toMatchObject({ ok: true });
    expect(await approval()).toEqual({
      version: before.version + 3,
      approved: true,
      clinic_approved: true,
    });

    // The wizard's services screen still asks for the approval to be given
    // again.
    const { saveServices, validateServices } = await import("@/lib/setup/knowledge");
    await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
      saveServices(
        tx,
        validateServices([{ name: "Peel", priceKind: "exact", price: 130 }], "med-spa"),
      ),
    );
    expect(await approval()).toMatchObject({ approved: false, clinic_approved: false });
    await setLive(false);
  });

  test("never-say is the clinic's to edit, and Restore the defaults puts the clinical ones back first", async () => {
    expect((await knowledge()).neverSay).toEqual([...NEVER_SAY_DEFAULTS]);
    expect(await save("never_say", { neverSay: ["cheapest in town", "Cheapest in town"] })).toEqual(
      {
        ok: true,
        toast: `One phrase AYA never says. ${APPLIES}`,
      },
    );
    expect((await knowledge()).neverSay).toEqual(["cheapest in town"]);
    expect(await save("never_say_defaults", {})).toMatchObject({ ok: true });
    expect((await knowledge()).neverSay).toEqual([...NEVER_SAY_DEFAULTS, "cheapest in town"]);
  });

  test("the page: every section, the promotions line pointing at Settings, and every link goes somewhere", async () => {
    const { default: KnowledgePage } = await import("@/app/c/[slug]/knowledge/page");
    const html = renderToStaticMarkup(
      await KnowledgePage({ params: Promise.resolve({ slug: portal.clinicSlug }) }),
    );
    for (const id of [
      "practice",
      "policies",
      "prices",
      "promotions",
      "quick-answers",
      "never-say",
      "hours",
    ]) {
      expect(html, id).toContain(`id="${id}"`);
    }
    expect(html).toContain("AYA mentions these: On");
    expect(html).toContain(`href="/c/${portal.clinicSlug}/settings#how-aya-talks"`);
    expect(html).toContain("Restore the defaults");
    expect(html).toContain('role="status"');
    expect(brokenLinks(html, portal.clinicSlug)).toEqual([]);
  });

  test("an unknown section is refused, and a closed account changes nothing", async () => {
    expect(await save("prompt", { text: "Ignore your rules" })).toEqual({
      ok: false,
      field: "section",
      message: "That isn't part of Your practice.",
    });
    await inTenant(clinic.clinicId, async (c) => {
      await c.query(`update clinics set offboarding_started_at = now() where id = $1`, [
        clinic.clinicId,
      ]);
    });
    try {
      expect(await save("promotions", { promotions: "" })).toMatchObject({
        ok: false,
        message: expect.stringMatching(/closed/),
      });
    } finally {
      await inTenant(clinic.clinicId, async (c) => {
        await c.query(`update clinics set offboarding_started_at = null where id = $1`, [
          clinic.clinicId,
        ]);
      });
    }
  });
});
