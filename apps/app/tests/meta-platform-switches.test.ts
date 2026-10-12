import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  connectedMetaPlatforms,
  DEFAULT_META_PLATFORM_SWITCHES,
  readMetaPlatformSwitches,
  setMetaPlatformEnabled,
} from "@/lib/channels/meta-platforms";
import { attachMetaChannel } from "@/lib/meta/channels";
import type { MetaPlatform } from "@/lib/meta/front-door";
import { runOperation } from "@/lib/ops/api";
import { metaPlatformToast, SETTING_CHANNELS, SETTING_KEYS } from "@/lib/portal/settings";
import { readSettingsView } from "@/lib/portal/settings-view";
import { readSetupState } from "@/lib/setup/state";
import { withTenant } from "@/lib/tenant";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant } from "./setup/factories";
import { provisionPortalClinic, type PortalClinic } from "./setup/portal-clinic";

/**
 * Instagram, Messenger and WhatsApp, each switched on its own (spec, "Every
 * switch in the portal"; drizzle/0061; lib/channels/meta-platforms.ts): the
 * defaults, the one writer and how it keeps the Meta channel's own switch in
 * step with the CONNECTED platforms, connecting a platform, the Settings
 * view, the ops console's operation, and the migration's backfill. The
 * webhook's skip is in tests/meta-front-door.test.ts, and the Settings page's
 * switches, toasts and gate in tests/settings-screen.test.ts.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "meta-platforms-test" } as const;
const OPERATOR = { email: "ops@healdesk.test", request: {} };

let n = 0;
async function connect(clinic: PortalClinic, platform: MetaPlatform, via: "facebook_login" | "embedded_signup" | "operator" = "facebook_login") {
  n += 1;
  await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
    attachMetaChannel(tx, {
      platform,
      externalId: `9${String(n).padStart(4, "0")}${Date.now()}`,
      accessToken: `EAAB-${platform}-token-0123456789`,
      via,
    }),
  );
}

async function setPlatform(clinic: PortalClinic, platform: MetaPlatform, on: boolean, label = "Front desk Mac") {
  return withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
    setMetaPlatformEnabled(tx, platform, on, label),
  );
}

async function metaChannelOn(clinic: PortalClinic): Promise<boolean> {
  const rows = await inTenant(clinic.clinicId, async (c) =>
    (await c.query<{ enabled: boolean }>(`select enabled from clinic_channels where channel = 'meta'`)).rows,
  );
  return rows[0]!.enabled;
}

async function metaEvents(clinic: PortalClinic) {
  return inTenant(clinic.clinicId, async (c) =>
    (
      await c.query<{ kind: string; platform: string | null; actor: string }>(
        `select kind, detail->>'platform' as platform, actor from channel_events
          where channel = 'meta' and kind in ('turned_on', 'turned_off')
          order by occurred_at, (detail ? 'platform') desc`,
      )
    ).rows,
  );
}

describe("the Settings keys", () => {
  test("three platform switches replace the Meta channel's one, each governing the Meta channel", () => {
    expect(SETTING_KEYS).not.toContain("channel_meta");
    for (const key of ["channel_instagram", "channel_messenger", "channel_whatsapp"] as const) {
      expect(SETTING_KEYS).toContain(key);
      expect(SETTING_CHANNELS[key]).toEqual(["meta"]);
    }
  });

  test("each toast names the platform as patients do, with no jargon and no date", () => {
    expect(metaPlatformToast("whatsapp", false)).toBe(
      "WhatsApp is off. Messages there wait for your team in WhatsApp.",
    );
    expect(metaPlatformToast("messenger", true)).toBe("Messenger is on. AYA answers messages there.");
    for (const platform of ["instagram", "messenger", "whatsapp"] as const) {
      for (const on of [true, false]) {
        expect(metaPlatformToast(platform, on)).not.toMatch(/meta|webhook|token|api|\d/i);
      }
    }
  });
});

describeDb("Instagram, Messenger and WhatsApp switches", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 180_000);

  afterAll(async () => {
    await closePools();
  });

  test("On by default, in the columns and in the reader, for a clinic with or without a settings row", async () => {
    const { rows } = await getMigratorPool().query<{ column_name: string; column_default: string; is_nullable: string }>(
      `select column_name, column_default, is_nullable from information_schema.columns
        where table_name = 'clinic_settings' and column_name in ('instagram_enabled', 'messenger_enabled', 'whatsapp_enabled')
        order by column_name`,
    );
    expect(rows).toEqual([
      { column_name: "instagram_enabled", column_default: "true", is_nullable: "NO" },
      { column_name: "messenger_enabled", column_default: "true", is_nullable: "NO" },
      { column_name: "whatsapp_enabled", column_default: "true", is_nullable: "NO" },
    ]);
    expect(DEFAULT_META_PLATFORM_SWITCHES).toEqual({ instagram: true, messenger: true, whatsapp: true });

    const clinic = await provisionPortalClinic("defaults", { plan: "complete" });
    expect(
      await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
        readMetaPlatformSwitches(tx.db, tx.clinicId),
      ),
    ).toEqual({ instagram: true, messenger: true, whatsapp: true });
    await inTenant(clinic.clinicId, (c) => c.query(`delete from clinic_settings`));
    expect(
      await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
        readMetaPlatformSwitches(tx.db, tx.clinicId),
      ),
    ).toEqual({ instagram: true, messenger: true, whatsapp: true });
    // Switching one Off from the default writes the row it needs.
    expect((await setPlatform(clinic, "messenger", false)).changed).toBe(true);
    expect(
      await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
        readMetaPlatformSwitches(tx.db, tx.clinicId),
      ),
    ).toEqual({ instagram: true, messenger: false, whatsapp: true });
  });

  test("the Meta channel follows its CONNECTED platforms: untouched before any is connected, Off once every connected one is, On again with the first; connecting one that answers turns it back On", async () => {
    const clinic = await provisionPortalClinic("follow", { plan: "complete" });

    // Nothing connected: the platform's own switch changes, the channel's
    // does not, so its status keeps saying what the clinic has to do.
    expect(await setPlatform(clinic, "instagram", false)).toEqual({
      changed: true,
      switches: { instagram: false, messenger: true, whatsapp: true },
    });
    expect(await metaChannelOn(clinic)).toBe(true);
    // A repeat writes nothing.
    expect((await setPlatform(clinic, "instagram", false)).changed).toBe(false);
    expect(await metaEvents(clinic)).toEqual([
      { kind: "turned_off", platform: "instagram", actor: "Front desk Mac" },
    ]);

    // Connecting Instagram, which is switched Off: nothing connected answers,
    // so the channel goes Off, under the connection's name.
    await connect(clinic, "instagram");
    expect(
      await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) => connectedMetaPlatforms(tx.db, tx.clinicId)),
    ).toEqual(["instagram"]);
    expect(await metaChannelOn(clinic)).toBe(false);

    // Connecting Messenger, On by default: the channel answers again.
    await connect(clinic, "messenger");
    expect(await metaChannelOn(clinic)).toBe(true);

    // Messenger Off: both connected platforms are Off, so the channel is,
    // whatever the unconnected WhatsApp switch says.
    await setPlatform(clinic, "messenger", false);
    expect(await metaChannelOn(clinic)).toBe(false);
    await setPlatform(clinic, "instagram", true, "Back office PC");
    expect(await metaChannelOn(clinic)).toBe(true);

    expect(await metaEvents(clinic)).toEqual([
      { kind: "turned_off", platform: "instagram", actor: "Front desk Mac" },
      { kind: "turned_off", platform: null, actor: "Facebook login" },
      { kind: "turned_on", platform: null, actor: "Facebook login" },
      { kind: "turned_off", platform: "messenger", actor: "Front desk Mac" },
      { kind: "turned_off", platform: null, actor: "Front desk Mac" },
      { kind: "turned_on", platform: "instagram", actor: "Back office PC" },
      { kind: "turned_on", platform: null, actor: "Back office PC" },
    ]);

    // Each platform flip is in the clinic's audit trail, flags only.
    const audit = await inTenant(clinic.clinicId, async (c) =>
      (
        await c.query<{ metadata: Record<string, unknown> }>(
          `select metadata from audit_log where resource_type = 'clinic_meta_platform' order by occurred_at`,
        )
      ).rows.map((r) => r.metadata),
    );
    expect(audit).toEqual([
      { platform: "instagram", enabled: false },
      { platform: "messenger", enabled: false },
      { platform: "instagram", enabled: true },
    ]);
  });

  test("a connection the clinic has lost no longer counts as connected", async () => {
    const clinic = await provisionPortalClinic("lost", { plan: "complete" });
    await connect(clinic, "whatsapp", "embedded_signup");
    await inTenant(clinic.clinicId, (c) =>
      c.query(`update provider_connections set status = 'revoked' where provider = 'meta-whatsapp'`),
    );
    expect(
      await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) => connectedMetaPlatforms(tx.db, tx.clinicId)),
    ).toEqual([]);
  });

  test("Settings shows a switch for each connected platform only, each with its own status word, and none for the channel itself", async () => {
    const clinic = await provisionPortalClinic("view", { plan: "complete" });
    const view = async () =>
      withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, async (tx) => {
        const state = await readSetupState(tx, { userId: clinic.userId });
        return state!;
      }).then((state) =>
        readSettingsView({ slug: clinic.clinicSlug, state, actor: ACTOR }),
      );

    const before = (await view()).channels.find((c) => c.channel === "meta")!;
    expect(before).toMatchObject({ key: null, name: "Instagram, Messenger & WhatsApp", platforms: [] });

    await connect(clinic, "instagram");
    await connect(clinic, "whatsapp", "embedded_signup");
    await setPlatform(clinic, "whatsapp", false);
    const after = (await view()).channels.find((c) => c.channel === "meta")!;
    expect(after.key).toBeNull();
    expect(after.platforms).toEqual([
      {
        platform: "instagram",
        key: "channel_instagram",
        name: "Instagram",
        on: true,
        statusWord: before.statusWord,
        switchLine: "Off leaves Instagram messages for your team to answer in Instagram.",
      },
      {
        platform: "whatsapp",
        key: "channel_whatsapp",
        name: "WhatsApp",
        on: false,
        statusWord: "Off",
        switchLine: "Off leaves WhatsApp messages for your team to answer in WhatsApp.",
      },
    ]);
    // Every other channel keeps its own one switch.
    for (const c of (await view()).channels.filter((c) => c.channel !== "meta")) {
      expect(c.key).toBe(`channel_${c.channel}`);
      expect(c.platforms).toEqual([]);
    }
  });

  test("the ops console switches a platform through the same writer, recorded as healdesk support, and reads the three flags back", async () => {
    const clinic = await provisionPortalClinic("ops", { plan: "complete" });
    await connect(clinic, "messenger");
    const run = async (op: Parameters<typeof runOperation>[0], args: Record<string, unknown>) => {
      const outcome = await runOperation(op, args, OPERATOR);
      expect(outcome.status, JSON.stringify(outcome)).toBe(200);
      return (outcome.body as { data: Record<string, unknown> }).data;
    };

    expect(await run("setMetaPlatform", { clinicId: clinic.clinicId, platform: "telegram", enabled: false })).toEqual({
      status: "error",
      message: "Instagram, Messenger or WhatsApp?",
    });
    expect(await run("setMetaPlatform", { clinicId: clinic.clinicId, platform: "messenger" })).toEqual({
      status: "error",
      message: "On or off?",
    });
    expect(await run("setMetaPlatform", { clinicId: clinic.clinicId, platform: "messenger", enabled: false })).toEqual({
      status: "updated",
    });
    expect(await metaChannelOn(clinic)).toBe(false);
    expect(await metaEvents(clinic)).toEqual([
      { kind: "turned_off", platform: "messenger", actor: "healdesk support" },
      { kind: "turned_off", platform: null, actor: "healdesk support" },
    ]);
    // A repeat changes nothing and adds no security event.
    await run("setMetaPlatform", { clinicId: clinic.clinicId, platform: "messenger", enabled: false });
    const { rows } = await getMigratorPool().query<{ event: string; actor_label: string; metadata: Record<string, unknown> }>(
      `select event, actor_label, metadata from security_events
        where event like 'meta_platform_%' and metadata ->> 'clinicSlug' = $1`,
      [clinic.clinicSlug],
    );
    expect(rows).toEqual([
      {
        event: "meta_platform_disabled",
        actor_label: OPERATOR.email,
        metadata: { clinicSlug: clinic.clinicSlug, platform: "messenger" },
      },
    ]);

    // The onboarding view carries the three flags and nothing more about them.
    const onboarding = await run("getOnboarding", { clinicId: clinic.clinicId });
    const meta = onboarding.meta as Record<string, unknown>;
    expect(meta.platforms).toEqual({ instagram: true, messenger: false, whatsapp: true });
    // The operator's front door is untouched by a platform switch.
    expect(meta.enabled).toBe(false);
  });

  test("the migration's backfill: a clinic whose Meta channel was Off has all three Off; every other clinic keeps them On", async () => {
    const off = await provisionPortalClinic("was-off", { plan: "complete" });
    const on = await provisionPortalClinic("was-on", { plan: "complete" });
    const none = await provisionPortalClinic("no-meta", { plan: "chat-web" });
    // The state the migration found: the single switch Off, with no row of
    // switches yet for one of them.
    await inTenant(off.clinicId, async (c) => {
      await c.query(`update clinic_channels set enabled = false where channel = 'meta'`);
      await c.query(`delete from clinic_settings`);
    });

    // Read from the migration, found by its tag, not its number (the number
    // is assigned when the branch merges).
    const drizzleDir = fileURLToPath(new URL("../drizzle/", import.meta.url));
    const files = readdirSync(drizzleDir).filter((name) => /^\d{4}_meta_platform_switches\.sql$/.test(name));
    expect(files).toHaveLength(1);
    const migration = readFileSync(`${drizzleDir}${files[0]!}`, "utf8");
    const backfill = migration.match(/DO \$\$[\s\S]*?END;\n\$\$;/)?.[0];
    expect(backfill).toContain("INSERT INTO clinic_settings");
    await getMigratorPool().query(backfill!);

    const switches = (clinic: PortalClinic) =>
      withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) => readMetaPlatformSwitches(tx.db, tx.clinicId));
    expect(await switches(off)).toEqual({ instagram: false, messenger: false, whatsapp: false });
    expect(await switches(on)).toEqual({ instagram: true, messenger: true, whatsapp: true });
    expect(await switches(none)).toEqual({ instagram: true, messenger: true, whatsapp: true });
    // Run twice, it changes nothing more.
    await getMigratorPool().query(backfill!);
    expect(await switches(off)).toEqual({ instagram: false, messenger: false, whatsapp: false });
  });
});
