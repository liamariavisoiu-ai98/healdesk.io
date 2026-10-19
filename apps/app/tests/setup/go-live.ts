import { randomUUID } from "node:crypto";

import { CURRENT_BAA_VERSION } from "@healdesk/catalog";

import { SETUP_SCREENS } from "@/lib/setup/screen-ids";

import { getMigratorPool } from "./db";
import { inTenant, seedChannels } from "./factories";
import { passPracticeQuestions } from "./practice";

/**
 * A synthetic clinic with everything automatic go-live asks
 * (lib/onboarding/go-live.ts, drizzle/0090) but whatever a test leaves out,
 * written as the migrator, standing in for provisioning, the wizard, a pass
 * of the practice questions (tests/setup/practice.ts; since 19 October 2026
 * nothing else passes a channel's audit) and the definers. Website chat is the channel that
 * meets Gate B: it needs no number of ours, only its line confirmed on the
 * clinic's site. The platform's attestations are tests/setup/platform.ts's.
 */

export type GoLiveFixture = {
  /** The agreement gate's columns. Default a med spa that does not bill insurance, under a BAA. */
  regime?: "hipaa" | "hipaa-if-covered" | "non-hipaa" | null;
  kind?: "baa" | "dpa" | null;
  covered?: boolean | null;
  /** The agreement in effect's version, or null for none. Default the current BAA. */
  version?: string | null;
  /** Website chat's Gate B inputs. Default all of them. */
  web?: { audit?: boolean; runtime?: boolean; setup?: boolean };
};

/** The clinic's agreement gate and its agreement in effect. Returns the agreement's accepted_at. */
export async function setAgreement(
  clinicId: string,
  organizationId: string,
  fixture: Pick<GoLiveFixture, "regime" | "kind" | "covered" | "version"> = {},
): Promise<Date | null> {
  await getMigratorPool().query(
    `update clinics set regulatory_regime = $2, agreement_kind = $3, is_covered_entity = $4 where id = $1`,
    [
      clinicId,
      fixture.regime === undefined ? "hipaa-if-covered" : fixture.regime,
      fixture.kind === undefined ? "baa" : fixture.kind,
      fixture.covered === undefined ? false : fixture.covered,
    ],
  );
  const version = fixture.version === undefined ? CURRENT_BAA_VERSION : fixture.version;
  if (version === null) return null;
  const { rows } = await getMigratorPool().query<{ accepted_at: Date }>(
    `insert into baa_acceptances
       (id, organization_id, document_version, document_hash, rendered_text, variables, assent_label,
        accepted_by_name, accepted_by_email, accepted_at, bound_at)
     values ($1, $2, $3, repeat('f', 64), 'AGREEMENT (synthetic test)', '{}'::jsonb, 'I agree',
             'Alex Chen', 'alex@golive.test', now() - interval '2 days', now() - interval '2 days')
     returning accepted_at`,
    [randomUUID(), organizationId, version],
  );
  return rows[0]!.accepted_at;
}

/** Every wizard screen this clinic is shown, skipped, and the services screen answered. */
export async function finishWizard(clinicId: string): Promise<void> {
  await inTenant(clinicId, async (client) => {
    for (const screen of SETUP_SCREENS) {
      if (screen === "backup") continue;
      await client.query(
        `insert into clinic_setup_screens (clinic_id, screen, outcome, at, actor_label)
         values ($1, $2, $3, now(), 'test')
         on conflict (clinic_id, screen) do update set outcome = excluded.outcome`,
        [clinicId, screen, screen === "services" ? "done" : "skipped"],
      );
    }
  });
}

/** Website chat bought, and as much of its Gate B as the fixture asks for. */
export async function readyWebChat(
  clinicId: string,
  web: NonNullable<GoLiveFixture["web"]> = {},
): Promise<void> {
  const { rows } = await inTenant(clinicId, (c) =>
    c.query(`select 1 from clinic_channels where channel = 'web'`),
  );
  if (rows.length === 0) await seedChannels(clinicId, [{ channel: "web" }]);
  if (web.setup !== false) await finishWizard(clinicId);
  if (web.audit !== false) await passPracticeQuestions(clinicId, ["web"]);
  await inTenant(clinicId, async (client) => {
    if (web.runtime !== false) {
      await client.query(
        `insert into channel_events (clinic_id, channel, kind, actor, detail)
         values ($1, 'web', 'runtime_seen', 'ops', '{"via":"ops_confirmed"}')
         on conflict do nothing`,
        [clinicId],
      );
    }
  });
}

/** Everything go-live asks of the clinic: its agreement gate and website chat's Gate B. */
export async function readyForGoLive(
  clinicId: string,
  organizationId: string,
  fixture: GoLiveFixture = {},
): Promise<Date | null> {
  const acceptedAt = await setAgreement(clinicId, organizationId, fixture);
  await readyWebChat(clinicId, fixture.web);
  return acceptedAt;
}
