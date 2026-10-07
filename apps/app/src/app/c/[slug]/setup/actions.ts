"use server";

import { toDataURL } from "qrcode";

import { unsafeDb } from "@/db";
import { backupEnrolAllowed } from "@/lib/factors/authority";
import { actorLabelFor, enrolTotp, proposeTotp } from "@/lib/factors/totp";
import { requirePortal } from "@/lib/portal/access";
import { portalActor } from "@/lib/portal/actor";
import { sessionBinding, stepUpPath, touchStepUp } from "@/lib/portal/step-up";
import {
  isSetupScreen,
  saveSetupScreen,
  skipSetupScreen,
  type SaveContext,
  type ScreenResult,
} from "@/lib/setup/save";
import { recordScreen } from "@/lib/setup/screens";
import { readSetupSettings, toE164 } from "@/lib/setup/settings";
import { withTenant } from "@/lib/tenant";

import { requestMeta } from "../request-meta";

/**
 * The setup wizard's server actions (plan Part E). Each calls
 * requirePortal(slug) itself; lib/setup/save.ts validates and writes inside
 * the clinic's tenant, and says where the wizard goes next.
 *
 * One change needs a passkey step-up here (plan Part D4): the direct line,
 * once it has been set, because it is where calls go whenever AYA cannot
 * answer. Setting it the first time needs none.
 */

export type ScreenActionResult =
  ScreenResult | { ok: false; field: string; message: string; stepUpHref: string };

const NOT_A_SCREEN: ScreenResult = {
  ok: false,
  field: "screen",
  message: "That step isn't part of setup.",
};

async function contextFor(slug: string): Promise<{ ctx: SaveContext; steppedUp: boolean }> {
  const portal = await requirePortal(String(slug));
  const actor = await portalActor(portal);
  return {
    ctx: {
      clinicId: portal.clinicId,
      slug: portal.clinicSlug,
      userId: portal.userId,
      actorLabel: actor.label,
    },
    steppedUp: actor.steppedUp,
  };
}

export async function saveScreen(
  slug: string,
  screen: string,
  input: unknown,
): Promise<ScreenActionResult> {
  if (!isSetupScreen(screen) || screen === "backup") return NOT_A_SCREEN;
  const { ctx, steppedUp } = await contextFor(slug);

  if (screen === "direct_line") {
    const current = await withTenant(
      {
        clinicId: ctx.clinicId,
        actor: { type: "user", userId: ctx.userId, label: ctx.actorLabel },
      },
      async (tx) => (await readSetupSettings(tx.db, ctx.clinicId)).directLineE164,
    );
    const typed = (input as { directLine?: unknown } | null)?.directLine;
    const wanted = typeof typed === "string" ? (toE164(typed) ?? typed.trim()) : null;
    if (current && wanted !== current) {
      if (!steppedUp) {
        return {
          ok: false,
          field: "directLine",
          message:
            "Your direct line is where calls go whenever AYA can't answer, so changing it needs Face ID or your screen lock on a device you've added.",
          stepUpHref: stepUpPath(ctx.slug, `/c/${ctx.slug}/setup?s=direct_line`),
        };
      }
      const portal = await requirePortal(String(slug));
      await touchStepUp(portal);
    }
  }

  return saveSetupScreen(ctx, screen, input);
}

export async function skipScreen(slug: string, screen: string): Promise<ScreenResult> {
  if (!isSetupScreen(screen)) return NOT_A_SCREEN;
  const { ctx } = await contextFor(slug);
  return skipSetupScreen(ctx, screen);
}

// -----------------------------------------------------------------------------
// The backup factor, offered at the end of setup (plan Part D3)
// -----------------------------------------------------------------------------

export type BeginBackup =
  | { ok: true; proposal: string; secret: string; qrDataUrl: string; otpauthUri: string }
  | { ok: false; message: string; stepUpHref?: string };

export async function beginBackup(slug: string): Promise<BeginBackup> {
  const portal = await requirePortal(String(slug));
  const session = await sessionBinding(portal);
  if (!session) return { ok: false, message: "Your sign-in has ended. Sign in again to continue." };
  if (!(await backupEnrolAllowed(portal.userId, session.sessionTokenHash))) {
    return {
      ok: false,
      message:
        "Adding a backup needs Face ID or your screen lock on a device you've added, so nobody with only your inbox can add one.",
      stepUpHref: stepUpPath(portal.clinicSlug, `/c/${portal.clinicSlug}/setup?s=backup`),
    };
  }
  const email = await actorLabelFor(unsafeDb, portal.userId);
  const proposal = proposeTotp({ userId: portal.userId, email });
  const qrDataUrl = await toDataURL(proposal.otpauthUri, { margin: 1, width: 220 });
  return {
    ok: true,
    proposal: proposal.proposal,
    secret: proposal.secret,
    qrDataUrl,
    otpauthUri: proposal.otpauthUri,
  };
}

export type FinishBackup = { ok: true; backupCodes: string[] } | { ok: false; message: string };

export async function finishBackup(
  slug: string,
  input: { proposal?: unknown; code?: unknown },
): Promise<FinishBackup> {
  const portal = await requirePortal(String(slug));
  const session = await sessionBinding(portal);
  if (!session) return { ok: false, message: "Your sign-in has ended. Sign in again to continue." };
  const enrolled = await enrolTotp({
    userId: portal.userId,
    sessionTokenHash: session.sessionTokenHash,
    proposal: typeof input?.proposal === "string" ? input.proposal : "",
    code: typeof input?.code === "string" ? input.code : "",
    request: await requestMeta(),
  });
  if (!enrolled.ok) {
    const messages = {
      needs_step_up:
        "Adding a backup needs Face ID or your screen lock on a device you've added. Confirm with it, then try again.",
      proposal_expired: "That took a little too long. Start again for a fresh code.",
      code_incorrect:
        "That code didn't match. Check the app shows healdesk, and try the newest code.",
      already_enrolled: "This sign-in already has an authenticator app.",
    } as const;
    return { ok: false, message: messages[enrolled.reason] };
  }
  const actor = await portalActor(portal);
  await withTenant(
    {
      clinicId: portal.clinicId,
      actor: { type: "user", userId: portal.userId, label: actor.label },
    },
    (tx) => recordScreen(tx, "backup", "done", actor.label),
  );
  return { ok: true, backupCodes: enrolled.backupCodes };
}
