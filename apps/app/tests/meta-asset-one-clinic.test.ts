import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { attachMetaChannel, MetaAssetTakenError, resolveMetaChannel } from "@/lib/meta/channels";
import { runOperation, type Operator } from "@/lib/ops/api";
import { withTenant } from "@/lib/tenant";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

/**
 * One Meta asset, one clinic (the C19 audit's edge row): a Page, an
 * Instagram account or a WhatsApp number connected to one practice cannot
 * be connected to a second while the first connection stands. With two, the
 * webhook routed every message to the older clinic, which is an
 * impermissible disclosure of the other practice's patients. The database
 * refuses it (provider_connections_meta_asset_live_idx), and the connect
 * paths say so in plain words.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "meta-asset-test" } as const;
const OPERATOR: Operator = { email: "ops@healdesk.test", request: {} };

function attach(
  clinicId: string,
  platform: "messenger" | "instagram" | "whatsapp",
  externalId: string,
) {
  return withTenant({ clinicId, actor: ACTOR }, (tx) =>
    attachMetaChannel(tx, {
      platform,
      externalId,
      accessToken: `EAAB-${platform}-token-0123456789`,
      via: "facebook_login",
    }),
  );
}

describeDb("one Meta asset, one clinic", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 180_000);

  afterAll(async () => {
    await closePools();
  });

  test("a second clinic is refused the same Page, account or number, in plain words, and gets it once the first lets it go", async () => {
    const first = await seedClinic("asset-first");
    const second = await seedClinic("asset-second");
    for (const [platform, externalId, words] of [
      [
        "messenger",
        "410000000000001",
        /That Facebook Page is already connected to another practice/,
      ],
      [
        "instagram",
        "410000000000002",
        /That Instagram account is already connected to another practice/,
      ],
      [
        "whatsapp",
        "410000000000003",
        /That WhatsApp number is already connected to another practice/,
      ],
    ] as const) {
      await attach(first.clinicId, platform, externalId);
      const refused = attach(second.clinicId, platform, externalId);
      await expect(refused).rejects.toBeInstanceOf(MetaAssetTakenError);
      await expect(attach(second.clinicId, platform, externalId)).rejects.toThrow(words);
      // Nothing of the refused attempt was kept, and messages still reach the first.
      expect((await resolveMetaChannel(externalId))?.clinicId).toBe(first.clinicId);
      const kept = await inTenant(
        second.clinicId,
        async (c) =>
          (
            await c.query(
              `select 1 from provider_connections where clinic_id = $1 and provider = $2`,
              [second.clinicId, `meta-${platform}`],
            )
          ).rows,
      );
      expect(kept).toEqual([]);
    }

    // The same clinic reconnecting its own asset is its own row, replaced.
    await attach(first.clinicId, "messenger", "410000000000001");

    // The operator's console says the same, and attaches nothing.
    expect(
      (
        await runOperation(
          "attachMetaChannel",
          {
            clinicId: second.clinicId,
            platform: "instagram",
            externalId: "410000000000002",
            accessToken: "EAAB-instagram-token-0123456789",
          },
          OPERATOR,
        )
      ).body,
    ).toMatchObject({
      data: {
        status: "error",
        message: expect.stringMatching(/already connected to another practice/),
      },
    });

    // Once the first clinic's connection is revoked, the asset is free.
    await inTenant(first.clinicId, (c) =>
      c.query(
        `update provider_connections set status = 'revoked' where clinic_id = $1 and provider = 'meta-whatsapp'`,
        [first.clinicId],
      ),
    );
    await attach(second.clinicId, "whatsapp", "410000000000003");
    expect((await resolveMetaChannel("410000000000003"))?.clinicId).toBe(second.clinicId);
  });

  test("an id one clinic holds under one Meta platform is refused under another, as the router matches it under any", async () => {
    // app_meta_channel resolves an id under every meta-% provider, so the
    // index is on the id alone: a second clinic can't hold it as Instagram
    // while the first holds it as Messenger.
    const first = await seedClinic("asset-cross-first");
    const second = await seedClinic("asset-cross-second");
    await attach(first.clinicId, "messenger", "420000000000001");
    await expect(attach(second.clinicId, "instagram", "420000000000001")).rejects.toBeInstanceOf(
      MetaAssetTakenError,
    );
    expect((await resolveMetaChannel("420000000000001"))?.clinicId).toBe(first.clinicId);
  });
});
