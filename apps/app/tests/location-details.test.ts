import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { recordLocationAcknowledgement } from "@/lib/location-acknowledgements";
import { locationById } from "@/lib/locations";
import { needsAttention } from "@/lib/portal/attention";
import {
  confirmLocationDetails,
  locationDetailsPath,
  readLaterLocations,
  saveLocationDetail,
  type LocationDetailContext,
} from "@/lib/portal/location-details";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getAppPool,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic, seedEntitled, type SeededClinic } from "./setup/factories";

/**
 * A later location's details, confirmed (drizzle/0110; the owner's decision
 * of 21 October 2026 to keep the toast after a location is added, "Next,
 * confirm its address, hours and phone numbers", and build the page it
 * names). What it pins: each field is validated on the server and saved
 * inside the clinic's own tenant; the address, the direct line and the
 * transfer number need a live step-up to change once set; confirming needs
 * what it checks and is stamped once by the database; another account's
 * location can be neither read nor edited; the main location and a retired
 * one are refused; Home and Settings say a location waits on its details;
 * and the toast after an add links to a page that exists.
 */

// The toast's action, with the add itself stood in: what is under test is
// the link it returns, not the charge (tests/add-location.test.ts has that).
const portal = { userId: "", clinicId: "", clinicSlug: "" };
const addResult: { status: "added"; locationId: string } = { status: "added", locationId: "" };
vi.mock("@/lib/portal/access", () => ({ requirePortal: async () => portal }));
vi.mock("@/lib/portal/actor", () => ({
  portalActor: async () => ({ label: "Front desk Mac", steppedUp: true }),
}));
vi.mock("@/lib/portal/step-up", () => ({
  stepUpPath: (slug: string, next: string) => `/c/${slug}/step-up?next=${encodeURIComponent(next)}`,
  touchStepUp: async () => ({
    stepUpId: randomUUID(),
    passkeyId: randomUUID(),
    deviceLabel: "Mac",
  }),
}));
vi.mock("@/lib/billing/stripe-actions", () => ({
  addLocation: async () => addResult,
  changePlan: async () => ({}),
  createPortalSession: async () => ({}),
}));

const describeDb = hasTestDatabase ? describe : describe.skip;

const HOURS = {
  sun: [],
  mon: [["09:00", "17:00"]],
  tue: [["09:00", "17:00"]],
  wed: [
    ["09:00", "12:30"],
    ["13:30", "18:00"],
  ],
  thu: [["09:00", "17:00"]],
  fri: [["09:00", "16:00"]],
  sat: [],
};

const DOCUMENT = "central-assistant-acknowledgement/1.0.0";
const TEXT =
  "I have authority to bind Radiance Aesthetics LLC. Downtown, at 2 Side St, is operated by Radiance Aesthetics LLC, and I accept that AYA answers for it as one central assistant for all our locations.";

async function seedStepUp(userId: string) {
  const pool = getMigratorPool();
  const device = "Front desk Mac";
  const { rows: factor } = await pool.query<{ id: string }>(
    `insert into user_factors (user_id, kind, device_label, credential_id, public_key, counter, backed_up)
     values ($1, 'passkey', $2, $3, '\\x01', 0, true) returning id`,
    [userId, device, randomBytes(16).toString("base64url")],
  );
  const { rows: stepUp } = await pool.query<{ id: string }>(
    `insert into step_ups (session_token_hash, user_id, factor_id, device_label, created_at, last_activity_at)
     values ($1, $2, $3, $4, now(), now()) returning id`,
    [createHash("sha256").update(randomBytes(24)).digest(), userId, factor[0]!.id, device],
  );
  return { stepUpId: stepUp[0]!.id, passkeyId: factor[0]!.id, deviceLabel: device };
}

/** A later location, pending, as the add writes it: its acceptance, then the row. */
async function addLocationRow(clinic: SeededClinic, position: number, label: string) {
  const stepUp = await seedStepUp(clinic.staffUserId);
  const locationId = randomUUID();
  const { rows } = await getMigratorPool().query<{ timezone: string }>(
    `select timezone from clinics where id = $1`,
    [clinic.clinicId],
  );
  await withTenant(
    {
      clinicId: clinic.clinicId,
      actor: { type: "user", userId: clinic.staffUserId, label: stepUp.deviceLabel },
    },
    async (tx) => {
      const recorded = await recordLocationAcknowledgement(tx, {
        locationId,
        documentVersion: DOCUMENT,
        renderedText: TEXT,
        acceptedBy: { userId: clinic.staffUserId, label: "Laura Owner, owner", stepUp },
      });
      await tx.db.execute(
        sql`insert into clinic_locations
          (id, clinic_id, position, label, add_request_id, acknowledgement_id, timezone, address)
          values (${locationId}::uuid, ${clinic.clinicId}::uuid, ${position}, ${label}, ${randomUUID()}::uuid,
                  ${recorded.id}::uuid, ${rows[0]!.timezone}, '2 Side St, Austin TX')`,
      );
    },
  );
  return locationId;
}

function ctxOf(clinic: SeededClinic, steppedUp: boolean): LocationDetailContext {
  return {
    clinicId: clinic.clinicId,
    userId: clinic.staffUserId,
    actorLabel: steppedUp ? "Front desk Mac" : "the clinic's sign-in",
    steppedUp,
  };
}

async function row(clinicId: string, id: string) {
  return withTenant({ clinicId, actor: { type: "system" } }, (tx) => locationById(tx, id));
}

describeDb("a later location's details, confirmed (0110)", () => {
  let chat: SeededClinic;
  let voice: SeededClinic;
  let other: SeededClinic;
  let chatLocation: string;
  let voiceLocation: string;
  let otherLocation: string;

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    chat = await seedClinic("locdet-chat");
    voice = await seedClinic("locdet-voice");
    other = await seedClinic("locdet-other");
    await seedEntitled(chat.clinicId, { planId: "webchat-1000" });
    await seedEntitled(voice.clinicId, { planId: "voice-webchat-1000-1000" });
    await seedEntitled(other.clinicId, { planId: "webchat-1000" });
    chatLocation = await addLocationRow(chat, 2, "Downtown");
    voiceLocation = await addLocationRow(voice, 2, "Uptown");
    otherLocation = await addLocationRow(other, 2, "Lakeside");
  }, 240_000);

  afterAll(async () => {
    await closePools();
  });

  test("a new location starts unconfirmed, and Settings and Home say it waits on its details", async () => {
    const later = await withTenant({ clinicId: chat.clinicId, actor: { type: "system" } }, (tx) =>
      readLaterLocations(tx),
    );
    expect(later).toEqual([
      {
        id: chatLocation,
        name: "Downtown",
        address: "2 Side St, Austin TX",
        status: "pending",
        confirmed: false,
      },
    ]);
    const items = needsAttention({
      slug: chat.slug,
      state: {
        screens: [],
        progress: [],
        clinic: { specialty: "med-spa" },
        hasPasskey: true,
        hasBackup: true,
        billing: null,
        address: null,
      } as unknown as Parameters<typeof needsAttention>[0]["state"],
      addressUndeliverable: false,
      locationsToConfirm: later.filter((l) => !l.confirmed),
    }).filter((i) => i.id === "location_details");
    expect(items).toEqual([
      {
        key: `location_details:${chatLocation}`,
        id: "location_details",
        text: "Downtown is waiting for you to confirm its address, hours and phone numbers.",
        action: {
          label: "Confirm its details",
          href: locationDetailsPath(chat.slug, chatLocation),
        },
      },
    ]);
  });

  test("a location's hours saved unchanged record no change for ops, whatever order they were stored in", async () => {
    const ctx = ctxOf(chat, false);
    const changes = async () =>
      (
        await inTenant(chat.clinicId, (c) =>
          c.query<{ n: number }>(`select count(*)::int as n from clinic_change_events where kind = 'location_hours'`),
        )
      ).rows[0]!.n;
    // Stored with its days and keys in another order than the parsed hours'.
    const reversed = Object.fromEntries(Object.entries(HOURS).reverse());
    await inTenant(chat.clinicId, (c) =>
      c.query(`update clinic_locations set opening_hours = $2::jsonb where id = $1`, [chatLocation, JSON.stringify(reversed)]),
    );
    const before = await changes();
    expect(await saveLocationDetail(ctx, chatLocation, "opening_hours", HOURS)).toMatchObject({ ok: true });
    expect(await changes()).toBe(before);
    // A real change is one row.
    expect(
      await saveLocationDetail(ctx, chatLocation, "opening_hours", { ...HOURS, sat: [["10:00", "14:00"]] }),
    ).toMatchObject({ ok: true });
    expect(await changes()).toBe(before + 1);
    // Back as the tests after this one expect it: no hours yet.
    await inTenant(chat.clinicId, (c) =>
      c.query(`update clinic_locations set opening_hours = null where id = $1`, [chatLocation]),
    );
  });

  test("validation: hours in the engine's shape, readable E.164 numbers, a non-empty address", async () => {
    const ctx = ctxOf(chat, false);
    const badHours = await saveLocationDetail(ctx, chatLocation, "opening_hours", {
      ...HOURS,
      mon: [["9am", "5pm"]],
    });
    expect(badHours).toMatchObject({ ok: false, field: "opening_hours" });
    const missingDay = await saveLocationDetail(ctx, chatLocation, "opening_hours", {
      mon: [["09:00", "17:00"]],
    });
    expect(missingDay.ok).toBe(false);
    expect(await saveLocationDetail(ctx, chatLocation, "published_phone", "call us")).toMatchObject(
      {
        ok: false,
        field: "published_phone",
      },
    );
    expect(await saveLocationDetail(ctx, chatLocation, "published_phone", "")).toMatchObject({
      ok: false,
    });
    expect(await saveLocationDetail(ctx, chatLocation, "direct_line", "12")).toMatchObject({
      ok: false,
      field: "direct_line",
    });
    expect(await saveLocationDetail(ctx, chatLocation, "nonsense", "x")).toMatchObject({
      ok: false,
      field: "key",
    });
    // The address needs a step-up (it is set), but an empty one is refused
    // first, whatever the step-up.
    expect(
      await saveLocationDetail(ctxOf(chat, true), chatLocation, "address", "   "),
    ).toMatchObject({
      ok: false,
      field: "address",
    });
    const unchanged = await row(chat.clinicId, chatLocation);
    expect(unchanged).toMatchObject({
      openingHours: null,
      publishedPhoneE164: null,
      directLineE164: null,
      address: "2 Side St, Austin TX",
    });
  });

  test("hours and the location's own number save without a step-up, normalised to E.164", async () => {
    const ctx = ctxOf(chat, false);
    expect(await saveLocationDetail(ctx, chatLocation, "opening_hours", HOURS)).toEqual({
      ok: true,
      toast: "Downtown's hours are saved.",
    });
    expect(
      await saveLocationDetail(ctx, chatLocation, "published_phone", "(512) 555-0142"),
    ).toEqual({
      ok: true,
      toast: "Downtown's phone number: (512) 555-0142.",
    });
    // The first direct line is part of setting the location up: no step-up.
    expect(
      await saveLocationDetail(ctx, chatLocation, "direct_line", "512-555-0143"),
    ).toMatchObject({
      ok: true,
    });
    expect(
      await saveLocationDetail(ctx, chatLocation, "transfer_number", "+15125550144"),
    ).toMatchObject({
      ok: true,
    });
    const saved = await row(chat.clinicId, chatLocation);
    expect(saved).toMatchObject({
      publishedPhoneE164: "+15125550142",
      directLineE164: "+15125550143",
      transferE164: "+15125550144",
    });
    expect(saved!.openingHours).toEqual(HOURS);
  });

  test("the address, the direct line and the transfer number need a step-up to change once set", async () => {
    const plain = ctxOf(chat, false);
    for (const [key, value] of [
      ["address", "9 New Rd, Austin TX"],
      ["direct_line", "+15125550199"],
      ["transfer_number", "+15125550198"],
    ] as const) {
      const refused = await saveLocationDetail(plain, chatLocation, key, value);
      expect(refused).toMatchObject({ ok: false, field: key, needsStepUp: true });
    }
    // The transfer number cleared is a change too.
    expect(await saveLocationDetail(plain, chatLocation, "transfer_number", "")).toMatchObject({
      ok: false,
      needsStepUp: true,
    });
    expect(await row(chat.clinicId, chatLocation)).toMatchObject({
      address: "2 Side St, Austin TX",
      directLineE164: "+15125550143",
      transferE164: "+15125550144",
    });

    const stepped = ctxOf(chat, true);
    expect(
      await saveLocationDetail(stepped, chatLocation, "address", " 9 New Rd,\n Austin TX "),
    ).toEqual({
      ok: true,
      toast: "Downtown's address is saved: 9 New Rd, Austin TX.",
    });
    expect(
      await saveLocationDetail(stepped, chatLocation, "direct_line", "+15125550199"),
    ).toMatchObject({
      ok: true,
    });
    // Never removed once set, step-up or not.
    expect(await saveLocationDetail(stepped, chatLocation, "direct_line", "")).toMatchObject({
      ok: false,
      field: "direct_line",
    });
    expect(await row(chat.clinicId, chatLocation)).toMatchObject({
      address: "9 New Rd, Austin TX",
      directLineE164: "+15125550199",
    });
  });

  test("every change is an audit row naming the field, never its value", async () => {
    const rows = await inTenant(
      chat.clinicId,
      async (c) =>
        (
          await c.query<{ metadata: Record<string, unknown> }>(
            `select metadata from audit_log where clinic_id = $1 and resource_type = 'clinic_location'
             and resource_id = $2 and action = 'update'`,
            [chat.clinicId, chatLocation],
          )
        ).rows,
    );
    expect(rows.length).toBeGreaterThanOrEqual(5);
    const text = JSON.stringify(rows);
    expect(text).not.toContain("555");
    expect(text).not.toContain("New Rd");
  });

  test("confirming needs what it checks, then is stamped once by the database", async () => {
    // Phone bought: the direct line is needed too.
    const ctx = ctxOf(voice, false);
    await saveLocationDetail(ctx, voiceLocation, "opening_hours", HOURS);
    await saveLocationDetail(ctx, voiceLocation, "published_phone", "+15125550150");
    expect(await confirmLocationDetails(ctx, voiceLocation)).toEqual({
      ok: false,
      field: "confirm",
      message: "Save its direct line first, then confirm.",
    });
    await saveLocationDetail(ctx, voiceLocation, "direct_line", "+15125550151");
    expect(await confirmLocationDetails(ctx, voiceLocation)).toEqual({
      ok: true,
      toast: "Uptown's address, hours and phone numbers are confirmed.",
    });
    const first = (await row(voice.clinicId, voiceLocation))!.detailsConfirmedAt;
    expect(first).toBeInstanceOf(Date);
    expect(await confirmLocationDetails(ctx, voiceLocation)).toEqual({
      ok: true,
      toast: "Uptown's details are already confirmed.",
    });
    expect((await row(voice.clinicId, voiceLocation))!.detailsConfirmedAt).toEqual(first);

    // Chat only: no direct line needed; the location confirmed leaves Home's list.
    expect(await confirmLocationDetails(ctxOf(chat, false), chatLocation)).toMatchObject({
      ok: true,
    });
    const later = await withTenant({ clinicId: chat.clinicId, actor: { type: "system" } }, (tx) =>
      readLaterLocations(tx),
    );
    expect(later.filter((l) => !l.confirmed)).toEqual([]);

    // A confirmed location keeps its number.
    expect(await saveLocationDetail(ctx, voiceLocation, "published_phone", "")).toMatchObject({
      ok: false,
    });
  });

  test("the database: the stamp is its own clock, set once, never on the main location or an insert", async () => {
    const app = getAppPool();
    const client = await app.connect();
    const fails = async (statement: string, values: unknown[]) => {
      await client.query("begin");
      await client.query(`select set_config('app.clinic_id', $1, true)`, [voice.clinicId]);
      try {
        await client.query(statement, values);
        return null;
      } catch (error) {
        return (error as { code?: string }).code ?? "error";
      } finally {
        await client.query("rollback");
      }
    };
    try {
      // Moved or cleared once set.
      expect(
        await fails(
          `update clinic_locations set details_confirmed_at = now() - interval '1 day' where id = $1`,
          [voiceLocation],
        ),
      ).toBe("42501");
      expect(
        await fails(`update clinic_locations set details_confirmed_at = null where id = $1`, [
          voiceLocation,
        ]),
      ).toBe("42501");
      // The main location is never confirmed here.
      expect(
        await fails(
          `update clinic_locations set details_confirmed_at = now() where clinic_id = $1 and position = 1`,
          [voice.clinicId],
        ),
      ).not.toBeNull();
      // A confirmed location cannot lose what confirming checked.
      expect(
        await fails(`update clinic_locations set published_phone_e164 = null where id = $1`, [
          voiceLocation,
        ]),
      ).toBe("23514");
    } finally {
      client.release();
    }

    // Unconfirmed and incomplete: the CHECK refuses a stamp without the facts.
    const bare = await addLocationRow(other, 3, "Northside");
    const code = await inTenant(other.clinicId, async (c) => {
      try {
        await c.query(`update clinic_locations set details_confirmed_at = now() where id = $1`, [
          bare,
        ]);
        return null;
      } catch (error) {
        return (error as { code?: string }).code ?? "error";
      }
    }).catch((error: { code?: string }) => error.code ?? "error");
    expect(code).toBe("23514");

    // A stamp written by the runtime role is replaced with the database's clock.
    const ctx = ctxOf(other, false);
    await saveLocationDetail(ctx, otherLocation, "opening_hours", HOURS);
    await saveLocationDetail(ctx, otherLocation, "published_phone", "+15125550160");
    const before = new Date();
    const c2 = await app.connect();
    try {
      await c2.query("begin");
      await c2.query(`select set_config('app.clinic_id', $1, true)`, [other.clinicId]);
      await c2.query(
        `update clinic_locations set details_confirmed_at = '2000-01-01T00:00:00Z' where id = $1`,
        [otherLocation],
      );
      await c2.query("commit");
    } finally {
      c2.release();
    }
    const stamped = (await row(other.clinicId, otherLocation))!.detailsConfirmedAt!;
    expect(stamped.getTime()).toBeGreaterThanOrEqual(before.getTime() - 5_000);
  });

  test("tenant isolation: another account's location can be neither read nor edited", async () => {
    // From chat's tenant, other's location is not there.
    expect(await row(chat.clinicId, otherLocation)).toBeNull();
    const before = await row(other.clinicId, otherLocation);
    for (const [key, value] of [
      ["opening_hours", HOURS],
      ["published_phone", "+15125550170"],
      ["address", "1 Elsewhere St"],
    ] as const) {
      expect(await saveLocationDetail(ctxOf(chat, true), otherLocation, key, value)).toEqual({
        ok: false,
        field: "location",
        message: "That location isn't one of yours.",
      });
    }
    expect(await confirmLocationDetails(ctxOf(chat, true), otherLocation)).toMatchObject({
      ok: false,
      field: "location",
    });
    expect(await row(other.clinicId, otherLocation)).toEqual(before);

    // The runtime role, in chat's tenant, updates none of other's rows.
    const client = await getAppPool().connect();
    try {
      await client.query("begin");
      await client.query(`select set_config('app.clinic_id', $1, true)`, [chat.clinicId]);
      const res = await client.query(
        `update clinic_locations set address = 'hijacked' where id = $1`,
        [otherLocation],
      );
      expect(res.rowCount).toBe(0);
      await client.query("rollback");
    } finally {
      client.release();
    }
  });

  test("the main location and an id that is not one of the account's locations are refused", async () => {
    const main = await withTenant(
      { clinicId: chat.clinicId, actor: { type: "system" } },
      async (tx) => {
        const r = await tx.db.execute<{ id: string }>(
          sql`select id from clinic_locations where clinic_id = ${chat.clinicId}::uuid and position = 1`,
        );
        return r.rows[0]!.id;
      },
    );
    expect(await saveLocationDetail(ctxOf(chat, true), main, "opening_hours", HOURS)).toMatchObject(
      {
        ok: false,
        field: "location",
      },
    );
    expect(
      await saveLocationDetail(ctxOf(chat, true), "not-a-uuid", "opening_hours", HOURS),
    ).toMatchObject({ ok: false, field: "location" });
    expect(await saveLocationDetail(ctxOf(chat, true), 42, "opening_hours", HOURS)).toMatchObject({
      ok: false,
      field: "location",
    });
  });

  test("the toast after an add links to the location's page, and that page exists", async () => {
    Object.assign(portal, {
      userId: chat.staffUserId,
      clinicId: chat.clinicId,
      clinicSlug: chat.slug,
    });
    addResult.locationId = chatLocation;
    const { addLocationAction } = await import("@/app/c/[slug]/billing/actions");
    const result = await addLocationAction(chat.slug, {
      requestId: randomUUID(),
      name: "Downtown",
      address: "2 Side St",
      acceptedBy: "Laura Owner, owner",
      accepted: true,
    });
    expect(result).toEqual({
      ok: true,
      toast:
        "The location is added. Next, confirm its address, hours and phone numbers, so AYA can answer for it.",
      link: {
        href: `/c/${chat.slug}/settings/locations/${chatLocation}`,
        label: "Confirm them now",
      },
    });
    const route = join(
      __dirname,
      "..",
      "src",
      "app",
      "c",
      "[slug]",
      "settings",
      "locations",
      "[id]",
      "page.tsx",
    );
    expect(existsSync(route)).toBe(true);
  });

  test("the page's form renders every field and says what confirming waits on", async () => {
    const { LocationDetailsForm } =
      await import("@/app/c/[slug]/settings/locations/[id]/LocationDetailsForm");
    const html = renderToStaticMarkup(
      createElement(LocationDetailsForm, {
        slug: "glow",
        locationId: randomUUID(),
        name: "Downtown",
        address: "2 Side St",
        hours: null,
        publishedPhone: "",
        directLine: "",
        transfer: "",
        needsDirectLine: true,
        confirmed: false,
      }),
    );
    for (const words of [
      "Street address",
      "Opening hours",
      "The location&#x27;s phone number",
      "Direct line",
      "Transfer number (optional)",
      "Save Downtown&#x27;s address, hours and phone number and direct line first.",
    ]) {
      expect(html).toContain(words);
    }
    expect(html).not.toMatch(/HIPAA compliant|live in two minutes/i);
  });
});
