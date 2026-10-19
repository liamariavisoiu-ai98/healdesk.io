import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { ingestCall } from "@/lib/voice/ingest";

import { axeViolations } from "./setup/axe";
import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant } from "./setup/factories";
import { provisionPortalClinic, type PortalClinic } from "./setup/portal-clinic";
import { brokenLinks } from "./setup/portal-links";
import { renderPage } from "./setup/render-page";

/**
 * Phone goes live without an operator (wave 2, R5), on the clinic's screens:
 *
 *   - the forwarding screen, in the wizard and in Settings → Channels, has a
 *     phone-system picker beside the carrier picker, and the picks are
 *     saved, so the steps emailed on are the ones on the screen;
 *   - "Test it now" opens the clinic's own forwarding-test window, says it
 *     is waiting, and says what the call showed once it lands; it is offered
 *     only while phone waits on forwarding, and a passed test is never wiped.
 */

const portal = { userId: "", clinicId: "", clinicSlug: "" };
const next = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("@/lib/portal/access", () => ({
  requirePortal: async () => portal,
  portalGrants: async () => [],
  currentSessionToken: async () => null,
}));
vi.mock("@/lib/portal/actor", () => ({
  portalActor: async () => ({ label: "the clinic's sign-in", steppedUp: false }),
  SIGN_IN_ACTOR_LABEL: "the clinic's sign-in",
}));
vi.mock("@/lib/portal/step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/portal/step-up")>()),
  touchStepUp: async () => null,
  sessionBinding: async () => ({ userId: portal.userId, sessionTokenHash: randomBytes(32) }),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "vitest" }),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("next/cache", () => ({ refresh: next.refresh, revalidatePath: () => undefined }));

const describeDb = hasTestDatabase ? describe : describe.skip;
const AYA = "+15125550142";
const PUBLISHED = "+15125550100";
const DIRECT = "+15125550199";

let clinic: PortalClinic;

function as(c: PortalClinic) {
  Object.assign(portal, { userId: c.userId, clinicId: c.clinicId, clinicSlug: c.clinicSlug });
}

/** Text as a person reads it: tags out, entities back. */
function text(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function wizard(): Promise<string> {
  const { default: SetupPage } = await import("@/app/c/[slug]/setup/page");
  return renderPage(
    <SetupPage
      params={Promise.resolve({ slug: portal.clinicSlug })}
      searchParams={Promise.resolve({ s: "channels" })}
    />,
  );
}

async function clinicRow() {
  const { rows } = await getMigratorPool().query<{
    carrier: string | null;
    phone_system_type: string;
    forwarding_test_until: Date | null;
    forwarding_test_observed: Record<string, unknown> | null;
    onboarding: Record<string, unknown>;
  }>(
    `select carrier, phone_system_type, forwarding_test_until, forwarding_test_observed, onboarding
       from clinics where id = $1`,
    [clinic.clinicId],
  );
  return rows[0]!;
}

/** Phone ready for forwarding and waiting on it, as the channel events and the runtime leave it. */
async function phoneWaiting(options: { published?: boolean } = {}) {
  await inTenant(clinic.clinicId, async (c) => {
    await c.query(
      `update clinic_channels set ready_at = now(), waiting_on = 'forwarding', live_at = null
        where clinic_id = $1 and channel = 'voice'`,
      [clinic.clinicId],
    );
    await c.query(`update clinic_settings set direct_line_e164 = $2 where clinic_id = $1`, [
      clinic.clinicId,
      DIRECT,
    ]);
  });
  await getMigratorPool().query(
    `update clinics set assistant_number_e164 = $2, published_phone_e164 = $3, carrier = 'att',
            phone_system_type = 'landline', forwarding_test_until = null, forwarding_test_observed = null
      where id = $1`,
    [clinic.clinicId, AYA, options.published === false ? null : PUBLISHED],
  );
}

async function actions() {
  return import("@/app/c/[slug]/forwarding-actions");
}

describeDb("phone go-live on the clinic's screens", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    clinic = await provisionPortalClinic("fwdpages", { plan: "voice-webchat-1000-1000" });
    as(clinic);
    await import("@/app/c/[slug]/setup/page");
    await import("@/app/c/[slug]/forwarding-actions");
  }, 300_000);

  beforeEach(async () => {
    next.refresh.mockReset();
    await phoneWaiting();
  });

  afterAll(async () => {
    await closePools();
  });

  test("the wizard's forwarding screen: a phone-system picker beside the carrier picker, then waiting for forwarding with Test it now", async () => {
    const html = await wizard();
    const words = text(html);
    expect(words).toContain("What runs your main line");
    expect(html).toMatch(
      /<option value="landline" selected="">A line from a phone company \(landline or mobile\)<\/option>/,
    );
    expect(words).toContain(
      "A cloud phone system (RingCentral, Nextiva, Dialpad, 8x8, Zoom and the like)",
    );
    expect(words).toContain("Who provides your main line");
    expect(html).toMatch(/<option value="att" selected="">AT&amp;T<\/option>/);
    expect(words).toContain("*905125550142#");
    expect(words).toContain("Waiting for call forwarding");
    expect(words).toContain(
      "Phone goes live by itself once a call forwarded from your main line reaches AYA.",
    );
    expect(html).toMatch(/<button type="button"[^>]*>Test it now<\/button>/);
    expect(brokenLinks(html, clinic.clinicSlug)).toEqual([]);
    expect(await axeViolations(html, "Set up AYA")).toEqual([]);
  });

  test("a cloud phone system: the admin rule instead of star codes, and no carrier to pick", async () => {
    await getMigratorPool().query(`update clinics set phone_system_type = 'voip' where id = $1`, [
      clinic.clinicId,
    ]);
    const html = await wizard();
    const words = text(html);
    expect(html).toMatch(/<option value="voip" selected="">/);
    expect(words).not.toContain("Who provides your main line");
    expect(words).toContain("In your phone system's admin");
    expect(words).not.toContain("*905125550142#");
    expect(await axeViolations(html, "Set up AYA")).toEqual([]);
  });

  test("the pickers save what was picked, so the steps sent on are the ones on screen", async () => {
    const { savePhoneLineAction } = await actions();
    expect(
      await savePhoneLineAction(clinic.clinicSlug, { phoneSystem: "voip", carrier: "att" }),
    ).toEqual({
      ok: true,
    });
    let row = await clinicRow();
    expect(row).toMatchObject({ phone_system_type: "voip", carrier: "att" });
    expect(row.onboarding.phone_type_confirmed).toBeTruthy();

    expect(
      await savePhoneLineAction(clinic.clinicSlug, { phoneSystem: "landline", carrier: "verizon" }),
    ).toEqual({ ok: true });
    row = await clinicRow();
    expect(row).toMatchObject({ phone_system_type: "landline", carrier: "verizon" });

    expect(
      await savePhoneLineAction(clinic.clinicSlug, { phoneSystem: "fax", carrier: "att" }),
    ).toEqual({
      ok: false,
      message: "Choose what runs your main line.",
    });
    expect(
      await savePhoneLineAction(clinic.clinicSlug, { phoneSystem: "landline", carrier: "bell" }),
    ).toEqual({ ok: false, message: "Choose who provides your main line." });
    expect(await clinicRow()).toMatchObject({ phone_system_type: "landline", carrier: "verizon" });
  });

  test("Test it now opens the clinic's own window, waits for the call, and says what it showed", async () => {
    const { forwardingTestStatusAction, startForwardingTestAction } = await actions();
    expect(await forwardingTestStatusAction(clinic.clinicSlug)).toEqual({
      state: { kind: "waiting" },
      canTest: true,
    });

    const started = await startForwardingTestAction(clinic.clinicSlug);
    expect(started).toMatchObject({ ok: true, state: { kind: "open" } });
    const until = (await clinicRow()).forwarding_test_until!;
    expect(until.getTime()).toBeGreaterThan(Date.now());
    // Asked again while it is open: the same window, not a new one.
    expect(await startForwardingTestAction(clinic.clinicSlug)).toEqual({
      ok: true,
      state: { kind: "open", until: until.toISOString() },
    });
    expect(await forwardingTestStatusAction(clinic.clinicSlug)).toEqual({
      state: { kind: "open", until: until.toISOString() },
      canTest: false,
    });
    expect(text(await wizard())).toContain("Testing your call forwarding");

    // The clinic rings its main number from a mobile; forwarding sends it to AYA.
    await ingestCall({
      externalCallId: `call-${randomUUID()}`,
      clinicId: clinic.clinicId,
      callerPhone: "+15125550777",
      startedAt: new Date(),
      durationSeconds: 20,
      outcome: "abandoned",
    });
    next.refresh.mockReset();
    expect(await forwardingTestStatusAction(clinic.clinicSlug)).toEqual({
      state: { kind: "passed", via: "test" },
      canTest: false,
    });
    // The page is read again, so the phone row's status word follows the result.
    expect(next.refresh).toHaveBeenCalled();
    const observed = (await clinicRow()).forwarding_test_observed;
    expect(observed).toMatchObject({ callerIdPreserved: true });

    // A second click never wipes a passed test.
    expect(await startForwardingTestAction(clinic.clinicSlug)).toEqual({
      ok: true,
      state: { kind: "passed", via: "test" },
    });
    expect((await clinicRow()).forwarding_test_observed).toEqual(observed);
    const after = await wizard();
    expect(text(after)).toContain("Call forwarding works");
    expect(after).not.toMatch(/<button type="button"[^>]*>Test it now<\/button>/);
  });

  test("the window that saw no call, and one whose caller's number didn't come through, offer the test again", async () => {
    const { forwardingTestStatusAction } = await actions();
    await getMigratorPool().query(
      `update clinics set forwarding_test_until = now() - interval '1 minute' where id = $1`,
      [clinic.clinicId],
    );
    expect(await forwardingTestStatusAction(clinic.clinicSlug)).toEqual({
      state: { kind: "no_call" },
      canTest: true,
    });
    expect(text(await wizard())).toContain("No call reached AYA in those five minutes.");

    await getMigratorPool().query(
      `update clinics set forwarding_test_until = null, forwarding_test_observed = $2::jsonb where id = $1`,
      [
        clinic.clinicId,
        JSON.stringify({
          arrivedAt: new Date().toISOString(),
          conversationId: randomUUID(),
          callerIdPreserved: false,
          condition: "unknown",
          via: "forwarded_call",
        }),
      ],
    );
    expect(await forwardingTestStatusAction(clinic.clinicSlug)).toEqual({
      state: { kind: "caller_id_lost", via: "forwarded_call" },
      canTest: true,
    });
    expect(text(await wizard())).toContain("the caller's number didn't come through");
  });

  test("Test it now is refused where there is nothing to test, and never once phone answers", async () => {
    const { startForwardingTestAction } = await actions();
    await phoneWaiting({ published: false });
    expect(await startForwardingTestAction(clinic.clinicSlug)).toEqual({
      ok: false,
      message:
        "Add your main phone number in setup first (Your practice), so the test can check the caller's number came through.",
    });
    expect((await clinicRow()).forwarding_test_until).toBeNull();

    await phoneWaiting();
    await inTenant(clinic.clinicId, (c) =>
      c.query(
        `update clinic_channels set ready_at = null, waiting_on = null where channel = 'voice'`,
      ),
    );
    expect(await startForwardingTestAction(clinic.clinicSlug)).toEqual({
      ok: false,
      message: "Phone isn't ready for call forwarding yet, so there's nothing to test.",
    });

    await phoneWaiting();
    await inTenant(clinic.clinicId, (c) =>
      c.query(
        `update clinic_channels set live_at = now(), waiting_on = null where channel = 'voice'`,
      ),
    );
    expect(await startForwardingTestAction(clinic.clinicSlug)).toEqual({
      ok: false,
      message: "Phone is live already: AYA is answering your forwarded calls.",
    });
    expect((await clinicRow()).forwarding_test_until).toBeNull();
  });
});
