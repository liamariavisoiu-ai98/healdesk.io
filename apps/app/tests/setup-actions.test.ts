import { randomBytes, randomUUID } from "node:crypto";

import { BAA_ASSENT_LABEL, CURRENT_BAA_VERSION } from "@healdesk/catalog";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { signAgreement } from "@/lib/agreements";
import { base32Decode, totpAt } from "@/lib/factors/totp";
import { provisionClinic } from "@/lib/provisioning";
import { readProgress } from "@/lib/setup/screens";
import { withTenant } from "@/lib/tenant";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant } from "./setup/factories";

/**
 * The wizard's server actions (app/c/[slug]/setup/actions.ts), with the
 * sign-in and the session stood in: the step-up asked for to change a direct
 * line once it is set (plan Part D4), the backup factor's ceremony at the end
 * of setup (Part D3), and the screens a form may never answer.
 */

const portal = { userId: "", clinicId: "", clinicSlug: "" };
let steppedUp = false;
const touched = vi.fn();
const sessionTokenHash = randomBytes(32);

vi.mock("@/lib/portal/access", () => ({
  requirePortal: async () => portal,
}));
vi.mock("@/lib/portal/actor", () => ({
  portalActor: async () =>
    steppedUp
      ? { label: "Front desk Mac", steppedUp: true }
      : { label: "the clinic's sign-in", steppedUp: false },
}));
vi.mock("@/lib/portal/step-up", () => ({
  sessionBinding: async () => ({ userId: portal.userId, sessionTokenHash }),
  stepUpPath: (slug: string, next: string) => `/c/${slug}/step-up?next=${encodeURIComponent(next)}`,
  touchStepUp: async () => {
    touched();
    return null;
  },
}));
vi.mock("@/app/c/[slug]/request-meta", () => ({ requestMeta: async () => ({}) }));

const describeDb = hasTestDatabase ? describe : describe.skip;

describeDb("the setup wizard's actions", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    const email = `actions-${randomUUID().slice(0, 8)}@glowspa.test`;
    const signed = await signAgreement({
      clinicLegalName: "Glow Med Spa LLC",
      specialty: "med-spa",
      signatoryName: "Laura Owner",
      signatoryEmail: email,
      isCoveredEntity: false,
      attributionMode: "estimated",
      platform: "none",
      // BAA 1.3.0, the current version, reads both calendar answers.
      bookingSystem: "none",
      calendarAccount: "workspace_no_baa",
      assentLabel: BAA_ASSENT_LABEL,
      templateVersion: CURRENT_BAA_VERSION,
    });
    const result = await provisionClinic({
      clinicName: "Glow Med Spa LLC",
      specialty: "med-spa",
      platform: "none",
      plan: "voice-webchat-1000-1000",
      contactName: "Laura Owner",
      contactEmail: email,
      agreementId: signed.agreementId,
      idempotencyKey: `idem-${randomUUID()}`,
    });
    Object.assign(portal, {
      userId: result.ownerUserId!,
      clinicId: result.clinicId,
      clinicSlug: result.clinicSlug,
    });
  }, 120_000);

  afterAll(async () => {
    await closePools();
  });

  beforeEach(() => {
    steppedUp = false;
    touched.mockClear();
  });

  test("the direct line is set the first time without a step-up, and changed only with one", async () => {
    const { saveScreen } = await import("@/app/c/[slug]/setup/actions");
    expect(
      await saveScreen(portal.clinicSlug, "direct_line", { directLine: "(512) 555-0177" }),
    ).toMatchObject({
      ok: true,
    });
    // The same number, typed another way, is not a change.
    expect(
      await saveScreen(portal.clinicSlug, "direct_line", { directLine: "+1 512 555 0177" }),
    ).toMatchObject({
      ok: true,
    });
    const refused = await saveScreen(portal.clinicSlug, "direct_line", {
      directLine: "(512) 555-0188",
    });
    expect(refused).toEqual({
      ok: false,
      field: "directLine",
      message: expect.stringMatching(/needs Face ID/),
      stepUpHref: `/c/${portal.clinicSlug}/step-up?next=${encodeURIComponent(`/c/${portal.clinicSlug}/setup?s=direct_line`)}`,
    });
    steppedUp = true;
    expect(
      await saveScreen(portal.clinicSlug, "direct_line", { directLine: "(512) 555-0188" }),
    ).toMatchObject({
      ok: true,
    });
    expect(touched).toHaveBeenCalledTimes(1);
    // The history forces row-level security, so it is read inside the tenant.
    const rows = await inTenant(
      portal.clinicId,
      async (c) =>
        (
          await c.query(
            `select field, before_value, after_value, actor_label from clinic_settings_history
            where field = 'direct_line_e164' order by changed_at`,
          )
        ).rows,
    );
    expect(rows.map((r) => [r.before_value, r.after_value, r.actor_label])).toEqual([
      [null, "+15125550177", "the clinic's sign-in"],
      ["+15125550177", "+15125550188", "Front desk Mac"],
    ]);
  });

  test("no form answers the backup, and an unknown screen is refused", async () => {
    const { saveScreen } = await import("@/app/c/[slug]/setup/actions");
    expect(await saveScreen(portal.clinicSlug, "backup", {})).toMatchObject({
      ok: false,
      field: "screen",
    });
    expect(await saveScreen(portal.clinicSlug, "settings", {})).toMatchObject({
      ok: false,
      field: "screen",
    });
  });

  test("the backup: a QR code and its key, a wrong code refused, the right one enrolled with ten codes", async () => {
    const { beginBackup, finishBackup } = await import("@/app/c/[slug]/setup/actions");
    const begun = await beginBackup(portal.clinicSlug);
    if (!begun.ok) throw new Error(begun.message);
    expect(begun.qrDataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(begun.otpauthUri).toContain(`secret=${begun.secret}`);

    expect(
      await finishBackup(portal.clinicSlug, { proposal: begun.proposal, code: "000000" }),
    ).toEqual({
      ok: false,
      message: expect.stringMatching(/didn't match/),
    });
    const code = totpAt(base32Decode(begun.secret)!, new Date());
    const done = await finishBackup(portal.clinicSlug, { proposal: begun.proposal, code });
    if (!done.ok) throw new Error(done.message);
    expect(done.backupCodes).toHaveLength(10);
    const progress = await withTenant(
      { clinicId: portal.clinicId, actor: { type: "service", serviceName: "test" } },
      (tx) => readProgress(tx.db, portal.clinicId),
    );
    expect(progress.get("backup")?.outcome).toBe("done");

    // A second backup needs the step-up the sign-in now has a factor for.
    const again = await beginBackup(portal.clinicSlug);
    expect(again).toMatchObject({
      ok: false,
      stepUpHref: expect.stringContaining("/step-up?next="),
    });
  });
});
