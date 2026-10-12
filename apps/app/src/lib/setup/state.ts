import {
  CHANNELS,
  type AgreementKind,
  type BillingInterval,
  type Channel,
  type ClinicProfile,
  type OnboardingState,
  type RegulatoryRegime,
} from "@healdesk/catalog";
import { eq } from "drizzle-orm";

import type { Transaction } from "@/db";
import { clinics, entitlements, type BillingStatus } from "@/db/schema";
import { billingRecipients } from "@/lib/billing/recipients";
import { readChannelStates, type ChannelState } from "@/lib/channels/state";
import type { OpeningHours } from "@/lib/clinic/opening-hours";
import { activeFactors } from "@/lib/factors/authority";
import type { ActorContext } from "@/lib/audit";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { readKnowledge, type Knowledge } from "./knowledge";
import { readUpcomingClosures, type Closure } from "./practice";
import { readProgress, screensFor, type Progress } from "./screens";
import type { SetupScreenId } from "./screen-ids";
import { readSetupSettings, type SetupSettings } from "./settings";

/**
 * Everything a setup screen, the clinic's page and the setup emails read
 * about one clinic, in one tenant transaction: the clinic, its bought
 * channels and where each stands, its settings and knowledge, the wizard's
 * progress, its billing row, its one address and whether the sign-in has a
 * backup factor. Configuration and business data only; nothing here is
 * about a patient.
 */

export type SetupClinic = {
  id: string;
  slug: string;
  name: string;
  specialty: string;
  timezone: string;
  timezoneConfirmed: boolean;
  address: string | null;
  website: string | null;
  publishedPhoneE164: string | null;
  openingHours: OpeningHours | null;
  siteProfile: ClinicProfile | null;
  regulatoryRegime: RegulatoryRegime | null;
  agreementKind: AgreementKind | null;
  isCoveredEntity: boolean | null;
  onboarding: OnboardingState;
  offboardingStartedAt: Date | null;
  createdAt: Date;
};

export type SetupBilling = {
  boughtPlanId: string;
  interval: BillingInterval;
  status: BillingStatus;
  firstPaidAt: Date | null;
  setupDeadlineAt: Date | null;
  planStartedAt: Date | null;
};

export type SetupState = {
  clinic: SetupClinic;
  /** The bought channels, in the catalog's order. */
  channels: ChannelState[];
  settings: SetupSettings;
  knowledge: Knowledge;
  closures: Closure[];
  progress: Progress;
  /** The clinic's own screens, in order. */
  screens: SetupScreenId[];
  billing: SetupBilling | null;
  /** The clinic's one address: its sign-in, and where every email goes. */
  address: string | null;
  hasPasskey: boolean;
  hasBackup: boolean;
};

/** Read the state inside an open tenant transaction. */
export async function readSetupState(
  tx: TenantTx,
  input: { userId: string | null; now?: Date },
): Promise<SetupState | null> {
  const now = input.now ?? new Date();
  const [row] = await tx.db
    .select({
      id: clinics.id,
      slug: clinics.slug,
      name: clinics.name,
      specialty: clinics.specialty,
      timezone: clinics.timezone,
      timezoneConfirmedAt: clinics.timezoneConfirmedAt,
      address: clinics.address,
      website: clinics.website,
      publishedPhoneE164: clinics.publishedPhoneE164,
      openingHours: clinics.openingHours,
      siteProfile: clinics.siteProfile,
      regulatoryRegime: clinics.regulatoryRegime,
      agreementKind: clinics.agreementKind,
      isCoveredEntity: clinics.isCoveredEntity,
      onboarding: clinics.onboarding,
      offboardingStartedAt: clinics.offboardingStartedAt,
      createdAt: clinics.createdAt,
    })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!row) return null;

  const clinic: SetupClinic = {
    ...row,
    timezoneConfirmed: row.timezoneConfirmedAt !== null,
  };
  const states = await readChannelStates(tx.db, tx.clinicId, now);
  const channels = states.filter((s) => (CHANNELS as readonly Channel[]).includes(s.channel));
  const settings = await readSetupSettings(tx.db, tx.clinicId);
  const knowledge = await readKnowledge(tx.db, tx.clinicId);
  const closures = await readUpcomingClosures(tx.db, tx.clinicId, clinic.timezone, now);
  const progress = await readProgress(tx.db, tx.clinicId);
  const billing = await readBilling(tx.db, tx.clinicId);
  const [recipient] = await billingRecipients(tx);

  const factors = input.userId ? await activeFactors(input.userId) : null;
  const hasBackup = (factors?.totp ?? 0) > 0;
  const screens = screensFor(
    {
      channels: channels.map((c) => c.channel),
      regulatoryRegime: clinic.regulatoryRegime,
      agreementKind: clinic.agreementKind,
      isCoveredEntity: clinic.isCoveredEntity,
      hasBackup,
    },
    progress,
  );

  return {
    clinic,
    channels,
    settings,
    knowledge,
    closures,
    progress,
    screens,
    billing,
    address: recipient?.email ?? null,
    hasPasskey: (factors?.passkeys ?? 0) > 0,
    hasBackup,
  };
}

/** Open the clinic's tenant and read its state. */
export async function loadSetupState(input: {
  clinicId: string;
  userId: string | null;
  actor: ActorContext;
  now?: Date;
}): Promise<SetupState | null> {
  return withTenant({ clinicId: input.clinicId, actor: input.actor }, (tx) =>
    readSetupState(tx, { userId: input.userId, now: input.now }),
  );
}

async function readBilling(db: Transaction, clinicId: string): Promise<SetupBilling | null> {
  const [row] = await db
    .select({
      planCode: entitlements.planCode,
      boughtPlanId: entitlements.boughtPlanId,
      interval: entitlements.billingInterval,
      status: entitlements.status,
      firstPaidAt: entitlements.firstPaidAt,
      setupDeadlineAt: entitlements.setupDeadlineAt,
      planStartedAt: entitlements.planStartedAt,
    })
    .from(entitlements)
    .where(eq(entitlements.clinicId, clinicId))
    .limit(1);
  if (!row) return null;
  return {
    boughtPlanId: row.boughtPlanId ?? row.planCode,
    interval: row.interval,
    status: row.status,
    firstPaidAt: row.firstPaidAt,
    setupDeadlineAt: row.setupDeadlineAt,
    planStartedAt: row.planStartedAt,
  };
}
