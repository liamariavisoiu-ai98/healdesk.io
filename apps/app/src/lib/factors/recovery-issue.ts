import { randomBytes } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { user } from "@/db/auth-schema";
import { clinics, deviceRecoveries } from "@/db/schema";
import { recordSecurityEvent, type ActorContext, type RequestContext } from "@/lib/audit";
import { assertPayloadAllowed } from "@/lib/email/lint";
import { sendEmail, type SendEmailOptions } from "@/lib/email/send";
import { audienceFor, clinicReason } from "@/lib/email/templates/context";
import {
  renderDeviceRecoveryLink,
  type DeviceRecoveryLinkPayload,
} from "@/lib/email/templates/device_recovery_link";
import { describeError, log } from "@/lib/log";
import { publicOriginProblem, publicUrl } from "@/lib/public-url";
import { clinicSignIn, openAddressChange } from "@/lib/sign-in/address-change";
import { withTenant } from "@/lib/tenant";

import { hashRecoveryToken, lockFactors, revokeOpenDeviceRecoveries } from "./recovery";
import { DEVICE_RECOVERY_TTL_HOURS } from "./recovery-terms";

/**
 * Issuing the human route's link (plan Part D3; recovery.ts has the whole
 * route). Apart from recovery.ts because it reads the clinic and sends an
 * email, and the passkey ceremony, which reads recovery.ts, needs neither.
 */

const TOKEN_BYTES = 32;
const WINDOW = sql`${DEVICE_RECOVERY_TTL_HOURS} * interval '1 hour'`;

// -----------------------------------------------------------------------------
// 1. Issue
// -----------------------------------------------------------------------------

export type DeviceRecoveryIssue =
  | {
      status: "issued";
      recoveryId: string;
      expiresAt: Date;
      /** Whether the link reached the transport. */
      emailed: boolean;
      /** Links still open for the sign-in that this one replaced. */
      replaced: number;
    }
  | { status: "refused"; message: string };

/** Why an issue was refused, as recorded: a code, never the words shown. */
type IssueRefusal =
  "no_call_back" | "no_origin" | "no_clinic" | "closed" | "no_sign_in" | "address_changing";

/**
 * Mint the basis and send its link to the clinic's address on file. The
 * caller is the ops operation: the operator's session, the call back and a
 * fresh code from the operator's authenticator were checked on apps/web, and
 * `calledBack` is the operator's tick, carried in the signed request and
 * refused here too when it is missing.
 *
 * Refused while a change of the sign-in's address is open (awaiting its
 * confirmation, or pending its 72 hours): until it applies the address on
 * file is the one being retired, and a link mailed there would hand a device
 * to whoever keeps that inbox. Checked under the factor lock that starting a
 * change also takes (lib/sign-in/address-change.ts), so the two cannot pass
 * each other. The link is bound to the address it is mailed to, read in the
 * same transaction. Every refusal is recorded.
 */
export async function issueDeviceRecovery(
  input: {
    clinicId: string;
    calledBack: boolean;
    /** The operator's address, as a snapshot on the row and the events. */
    operatorLabel: string;
    actor: ActorContext;
    request?: RequestContext;
  },
  options: SendEmailOptions = {},
): Promise<DeviceRecoveryIssue> {
  const operatorLabel = input.operatorLabel.trim().slice(0, 200) || "ops";
  const trace = {
    ipAddress: input.request?.ipAddress ?? null,
    userAgent: input.request?.userAgent ?? null,
  };
  const refuse = async (
    code: IssueRefusal,
    message: string,
    userId: string | null = null,
  ): Promise<DeviceRecoveryIssue> => {
    await recordSecurityEvent(unsafeDb, {
      event: "device_recovery_issue_refused",
      actorLabel: operatorLabel,
      userId,
      ...trace,
      metadata: { code, clinicId: input.clinicId },
    }).catch((error) =>
      log.error("device recovery refusal not recorded", { error: describeError(error) }),
    );
    return { status: "refused", message };
  };

  if (input.calledBack !== true) {
    return refuse(
      "no_call_back",
      "Call the practice back on its published number first, and hear from it that it asked for this. Nothing was sent.",
    );
  }
  // The link must point somewhere: refuse before anything is minted rather
  // than leave a live link nobody can follow (lib/public-url.ts).
  if (publicOriginProblem()) {
    return refuse("no_origin", "Links can't be sent from this deployment yet. Nothing was sent.");
  }

  const clinic = await withTenant(
    { clinicId: input.clinicId, actor: input.actor, request: input.request },
    async (tx) => {
      const [row] = await tx.db
        .select({
          name: clinics.name,
          slug: clinics.slug,
          specialty: clinics.specialty,
          timezone: clinics.timezone,
          offboardingStartedAt: clinics.offboardingStartedAt,
        })
        .from(clinics)
        .where(eq(clinics.id, tx.clinicId))
        .limit(1);
      if (!row) return null;
      return { ...row, signIn: await clinicSignIn(tx), change: await openAddressChange(tx) };
    },
  );
  if (!clinic) return refuse("no_clinic", "No such clinic.");
  if (clinic.offboardingStartedAt) {
    return refuse(
      "closed",
      "This account has closed, so no device can be added. Nothing was sent.",
    );
  }
  if (!clinic.signIn) {
    return refuse("no_sign_in", "This clinic has no sign-in. Nothing was sent.");
  }
  const { userId } = clinic.signIn;
  const changing = (when: Date | null) =>
    `A change of the clinic's sign-in address is under way${
      when ? `, taking effect ${when.toISOString().slice(0, 16).replace("T", " ")} UTC` : ""
    }. Until it takes effect, the address on file is the one being retired, so a link sent now would go there. Nothing was sent: send it once the change has taken effect, or after it is stopped.`;
  if (clinic.change) return refuse("address_changing", changing(clinic.change.effectiveAt), userId);

  const raw = randomBytes(TOKEN_BYTES);
  const token = raw.toString("base64url");
  raw.fill(0);

  const issued = await unsafeDb.transaction(async (tx) => {
    await lockFactors(tx, userId);
    // Again under the lock, across every clinic of the sign-in: a change
    // started at another location, or since the read above, is a change.
    const [open] = await tx
      .execute<{ open: boolean }>(sql`select app_sign_in_address_change_open(${userId}) as open`)
      .then((r) => r.rows);
    if (open?.open) return { refused: "address_changing" as const };
    const [account] = await tx
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    if (!account) return { refused: "no_sign_in" as const };
    const replaced = await revokeOpenDeviceRecoveries(tx, userId, "replaced");
    const [row] = await tx
      .insert(deviceRecoveries)
      .values({
        userId,
        tokenHash: hashRecoveryToken(token),
        // Bound to the address read above, the one the link is mailed to.
        addressHash: sql`app_address_hash(${userId})`,
        landing: `/c/${clinic.slug}/protect`,
        issuedBy: operatorLabel,
        // The database dates the row itself (drizzle/0094); this is its rule.
        expiresAt: sql`now() + ${WINDOW}`,
      })
      .returning({ id: deviceRecoveries.id, expiresAt: deviceRecoveries.expiresAt });
    if (!row) throw new Error("The device recovery was not recorded.");
    if (replaced.ids.length > 0) {
      await recordSecurityEvent(tx, {
        event: "device_recovery_revoked",
        actorLabel: operatorLabel,
        userId,
        ...trace,
        metadata: {
          recoveryIds: replaced.ids,
          reason: "replaced",
          clinicId: input.clinicId,
          browsersSignedOut: replaced.browsersSignedOut,
        },
      });
    }
    await recordSecurityEvent(tx, {
      event: "device_recovery_issued",
      actorLabel: operatorLabel,
      userId,
      ...trace,
      metadata: {
        recoveryId: row.id,
        clinicId: input.clinicId,
        calledBack: true,
        validHours: DEVICE_RECOVERY_TTL_HOURS,
      },
    });
    return { ...row, to: account.email, replaced: replaced.ids.length };
  });
  if ("refused" in issued) {
    return issued.refused === "address_changing"
      ? refuse("address_changing", changing(null), userId)
      : refuse("no_sign_in", "This clinic has no sign-in. Nothing was sent.", userId);
  }

  const emailed = await sendRecoveryLink(
    {
      recoveryId: issued.id,
      userId,
      to: issued.to,
      token,
      clinic,
      operatorLabel,
    },
    options,
  );
  return {
    status: "issued",
    recoveryId: issued.id,
    expiresAt: issued.expiresAt,
    emailed,
    replaced: issued.replaced,
  };
}

/**
 * The link, to the address it is bound to: the sign-in's, as stored when the
 * row was written. Never throws; says whether it went.
 */
async function sendRecoveryLink(
  input: {
    recoveryId: string;
    userId: string;
    /** The sign-in's address, read in the transaction that bound the link to it. */
    to: string;
    token: string;
    clinic: { name: string; specialty: string; timezone: string };
    operatorLabel: string;
  },
  options: SendEmailOptions,
): Promise<boolean> {
  let status = "failed";
  try {
    const payload: DeviceRecoveryLinkPayload = {
      recoveryUrl: publicUrl(`/recover/${input.token}`),
      validHours: DEVICE_RECOVERY_TTL_HOURS,
    };
    assertPayloadAllowed(payload, "device_recovery_link");
    const rendered = renderDeviceRecoveryLink(payload, {
      clinicName: input.clinic.name,
      audience: audienceFor(input.clinic.specialty),
      reason: clinicReason(input.clinic.name),
      raisedAt: options.now ?? new Date(),
      timeZone: input.clinic.timezone,
    });
    // To the address on file, as stored: never one an operator typed.
    const result = await sendEmail(
      {
        to: input.to,
        kind: "device_recovery_link",
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        phiClass: "none",
        deliveryId: input.recoveryId,
        // One row, one link, one send: the row's id tells one from the next.
        idempotencyKey: `hd-device_recovery_link-${input.recoveryId}-1`,
      },
      options,
    );
    status = result.status;
    if (result.status === "failed") {
      log.warn("device recovery link not delivered", {
        deliveryId: input.recoveryId,
        reason: result.reason,
      });
    }
  } catch (error) {
    log.error("device recovery link not sent", {
      deliveryId: input.recoveryId,
      error: describeError(error),
    });
  }
  await recordSecurityEvent(unsafeDb, {
    event: "device_recovery_link_sent",
    actorLabel: input.operatorLabel,
    userId: input.userId,
    metadata: { recoveryId: input.recoveryId, status },
  }).catch((error) =>
    log.error("device recovery send not recorded", { error: describeError(error) }),
  );
  return status !== "failed";
}
