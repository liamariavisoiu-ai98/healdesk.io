import { and, count, eq, gt, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { session } from "@/db/auth-schema";
import type { DeviceRecoveryRevokeReason } from "@/lib/factors/recovery-terms";
import { anyClinicMayHoldPatientData } from "@/lib/factors/authority";
import {
  endDeviceRecovery,
  listDeviceRecoveries,
  type DeviceRecoveryState,
} from "@/lib/factors/recovery";
import { issueDeviceRecovery } from "@/lib/factors/recovery-issue";
import { operatorSignOut } from "@/lib/factors/someone-left";
import { readSignInFactors } from "@/lib/portal/devices";
import { clinicSignIn } from "@/lib/sign-in/address-change";
import { withTenant } from "@/lib/tenant";

import {
  actorFor,
  booleanArg,
  clinicById,
  ok,
  opsProblem,
  stringArg,
  type Operator,
  type OpsOutcome,
} from "./api";

/**
 * The console's device operations (wave 2, R4; plan Part D3 and Annex X5's
 * O3), on the clinic's account page in /admin:
 *
 *   - getClinicDevices: the clinic's sign-in's devices by the names staff
 *     gave them, whether its backup is set, how many sessions are open,
 *     whether patient data can exist yet (so whether a link alone can add a
 *     first device), and the human route's links;
 *   - issueDeviceRecovery: the human route for a clinic that has lost every
 *     device, a one-time link to the clinic's address on file;
 *   - endDeviceRecovery: that link ended unused, when the clinic says nobody
 *     there asked for it;
 *   - removeClinicDevices: O3's promise, the devices named removed, every
 *     session ended and the backup reset, as "Someone left" does.
 *
 * issueDeviceRecovery and removeClinicDevices are sent only after a call back
 * to the practice's published number and a fresh code from the operator's
 * authenticator, both checked on apps/web before the request is signed
 * (apps/web lib/admin/device-recovery.ts); the tick travels as `calledBack`
 * and is refused here too when it is missing. The reply to an O3 is never
 * enough by itself: nothing here runs on an email.
 *
 * Projections apps/app decides: ids, device names staff chose, counts,
 * states and times. Never a patient, never a token, never a session.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OpsDevice = {
  id: string;
  label: string;
  addedAt: string;
  lastUsedAt: string | null;
};

export type OpsDeviceRecovery = {
  id: string;
  state: DeviceRecoveryState;
  issuedBy: string;
  createdAt: string;
  expiresAt: string;
  claimedAt: string | null;
  usedAt: string | null;
  revokedAt: string | null;
  revokedReason: DeviceRecoveryRevokeReason | null;
};

export type ClinicDevicesView = {
  clinicId: string;
  /** The clinic has a sign-in at all. Without one, nothing below applies. */
  hasSignIn: boolean;
  devices: OpsDevice[];
  hasBackup: boolean;
  backupCodesLeft: number;
  /** Sessions of the sign-in not yet expired: browsers signed in now. */
  sessions: number;
  /** Any clinic of the sign-in is in production or has gone live: a link alone adds no device. */
  patientDataMayExist: boolean;
  recoveries: OpsDeviceRecovery[];
};

/** The clinic's sign-in, read in its tenant, or null. */
async function signInOf(clinicId: string, operator: Operator) {
  return withTenant(
    { clinicId, actor: actorFor(operator), request: operator.request },
    async (tx) => {
      tx.audit.record({ action: "read", resourceType: "clinic_devices", resourceId: tx.clinicId });
      return clinicSignIn(tx);
    },
  );
}

export async function opGetClinicDevices(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return opsProblem("No such clinic.", 404, "invalid_args");
  const signIn = await signInOf(clinic.id, operator);
  if (!signIn) {
    return ok({
      clinicId: clinic.id,
      hasSignIn: false,
      devices: [],
      hasBackup: false,
      backupCodesLeft: 0,
      sessions: 0,
      patientDataMayExist: false,
      recoveries: [],
    } satisfies ClinicDevicesView);
  }
  const factors = await readSignInFactors(signIn.userId, null);
  const [open] = await unsafeDb
    .select({ n: count() })
    .from(session)
    .where(and(eq(session.userId, signIn.userId), gt(session.expiresAt, sql`now()`)));
  const recoveries = await listDeviceRecoveries(signIn.userId, 10);
  return ok({
    clinicId: clinic.id,
    hasSignIn: true,
    devices: factors.devices.map((d) => ({
      id: d.id,
      label: d.label,
      addedAt: d.addedAt.toISOString(),
      lastUsedAt: d.lastUsedAt?.toISOString() ?? null,
    })),
    hasBackup: factors.hasBackup,
    backupCodesLeft: factors.backupCodesLeft,
    sessions: Number(open?.n ?? 0),
    patientDataMayExist: await anyClinicMayHoldPatientData(signIn.userId),
    recoveries: recoveries.map((r) => ({
      id: r.id,
      state: r.state,
      issuedBy: r.issuedBy,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      claimedAt: r.claimedAt?.toISOString() ?? null,
      usedAt: r.usedAt?.toISOString() ?? null,
      revokedAt: r.revokedAt?.toISOString() ?? null,
      revokedReason: r.revokedReason,
    })),
  } satisfies ClinicDevicesView);
}

export type IssueDeviceRecoveryState =
  | {
      status: "issued";
      recoveryId: string;
      /** When the link and the device it allows lapse. ISO. */
      expiresAt: string;
      /** Whether the link reached the transport. */
      emailed: boolean;
      /** Open links of the sign-in this one replaced. */
      replaced: number;
    }
  | { status: "refused"; message: string };

/**
 * issueDeviceRecovery (plan Part D3, "Lost every device"): a one-time link to
 * the clinic's address on file that lets one device be added, within 24
 * hours. The core records every step (lib/factors/recovery-issue.ts).
 */
export async function opIssueDeviceRecovery(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) {
    return ok({ status: "refused", message: "No such clinic." } satisfies IssueDeviceRecoveryState);
  }
  const outcome = await issueDeviceRecovery({
    clinicId: clinic.id,
    calledBack: booleanArg(args, "calledBack") === true,
    operatorLabel: operator.email,
    actor: actorFor(operator),
    request: operator.request,
  });
  if (outcome.status === "refused") {
    return ok({ status: "refused", message: outcome.message } satisfies IssueDeviceRecoveryState);
  }
  return ok({
    status: "issued",
    recoveryId: outcome.recoveryId,
    expiresAt: outcome.expiresAt.toISOString(),
    emailed: outcome.emailed,
    replaced: outcome.replaced,
  } satisfies IssueDeviceRecoveryState);
}

export type EndDeviceRecoveryState = { status: "ended" | "none" };

/** The clinic's open link, ended unused. It only takes access away, so it needs no fresh code. */
export async function opEndDeviceRecovery(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return opsProblem("No such clinic.", 404, "invalid_args");
  const signIn = await signInOf(clinic.id, operator);
  if (!signIn) return ok({ status: "none" } satisfies EndDeviceRecoveryState);
  const outcome = await endDeviceRecovery({
    userId: signIn.userId,
    clinicId: clinic.id,
    operatorLabel: operator.email,
    request: operator.request,
  });
  return ok(outcome satisfies EndDeviceRecoveryState);
}

export type RemoveClinicDevicesState =
  | {
      status: "done";
      removedDevices: number;
      sessionsEnded: number;
      backupReset: boolean;
      codesRevoked: number;
    }
  | { status: "refused"; message: string };

/**
 * removeClinicDevices (Annex X5, O3: "reply ... we'll remove the device and
 * sign everyone out"): after the clinic replied and the operator called it
 * back, the devices named are removed, every session ends and the backup is
 * reset, in one transaction (lib/factors/someone-left.ts, operatorSignOut),
 * and O3 tells the address healdesk did it.
 */
export async function opRemoveClinicDevices(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const refused = (message: string) =>
    ok({ status: "refused", message } satisfies RemoveClinicDevicesState);
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return refused("No such clinic.");
  if (booleanArg(args, "calledBack") !== true) {
    return refused(
      "Call the practice back on its published number first, and hear from it that it asked for this. Nothing was changed.",
    );
  }
  const raw = args.factorIds;
  if (
    !Array.isArray(raw) ||
    raw.length > 50 ||
    !raw.every((id): id is string => typeof id === "string" && UUID.test(id))
  ) {
    return refused("Pick the devices to remove from the list. Nothing was changed.");
  }
  const signIn = await signInOf(clinic.id, operator);
  if (!signIn) return refused("This clinic has no sign-in. Nothing was changed.");
  const outcome = await operatorSignOut({
    userId: signIn.userId,
    removeFactorIds: raw,
    operatorLabel: operator.email,
    clinicId: clinic.id,
    request: operator.request,
  });
  if (!outcome.ok) {
    return refused(
      "A device picked is no longer this sign-in's. Reload the page and pick again. Nothing was changed.",
    );
  }
  return ok({
    status: "done",
    removedDevices: outcome.removedDevices,
    sessionsEnded: outcome.sessionsEnded,
    backupReset: outcome.backupReset,
    codesRevoked: outcome.codesRevoked,
  } satisfies RemoveClinicDevicesState);
}
