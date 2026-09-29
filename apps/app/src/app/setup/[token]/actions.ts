"use server";

import { redirect, RedirectType } from "next/navigation";

import { withinConnectAttemptLimit } from "@/lib/connections/attempt-limit";
import { resolveConnectionLink, type ResolvedLink } from "@/lib/connections/links";
import { describeError, log } from "@/lib/log";
import {
  confirmBookingRequirementsWithin,
  SetupLinkSpentError,
  SetupSubmissionError,
} from "@/lib/onboarding/requirements";
import { withTenant } from "@/lib/tenant";

import { connectRequestContext } from "../../connect/[token]/request-context";

/**
 * The setup link's one write (design of 23 September 2026, §H.4).
 *
 * The pattern is app/connect/[token]/actions.ts, and its header note is the
 * reasoning here too: no session, the token re-resolved server-side before a
 * field is read, the clinic taken from the row and never from the form; one
 * tenant transaction that burns the link and writes the set, so a lost burn
 * rolls the write back; success redirecting away from the spent URL, from
 * outside the try. The transaction body lives in lib/onboarding/requirements
 * so the race test can drive it without a request.
 *
 * What is written: the ticked catalogue ids (locked ones added regardless),
 * `booking_requirements_source = 'practice'`, the onboarding step, and — if
 * the Direct booking section was offered and accepted — the election columns
 * with the hash of the addendum as rendered again here with the typed name.
 */

export type SetupFormState =
  | { status: "idle" }
  | { status: "failed"; message: string; field?: string };

const DEAD_LINK_MESSAGE =
  "This link is no longer valid. Reply to the email that brought you here and we'll send a new one.";

export async function submitRequirements(
  _previous: SetupFormState,
  formData: FormData,
): Promise<SetupFormState> {
  const token = formData.get("token");
  if (typeof token !== "string") return { status: "failed", message: DEAD_LINK_MESSAGE };

  const request = await connectRequestContext();
  if (!withinConnectAttemptLimit("submit", token, request.ipAddress ?? null)) {
    return {
      status: "failed",
      message: "That's several attempts in a row. Give it ten minutes, or reply to your setup email and we'll do this with you.",
    };
  }

  const link: ResolvedLink | null = await resolveConnectionLink(token, request, "setup");
  if (!link) return { status: "failed", message: DEAD_LINK_MESSAGE };

  const fields = formData.getAll("fields").filter((v): v is string => typeof v === "string");
  const elect = formData.get("directBooking") === "on";
  const signatoryName = formData.get("signatoryName");
  const signatoryTitle = formData.get("signatoryTitle");
  const election = elect
    ? {
        signatoryName: typeof signatoryName === "string" ? signatoryName : "",
        signatoryTitle: typeof signatoryTitle === "string" ? signatoryTitle : null,
      }
    : null;

  const context = {
    clinicId: link.clinicId,
    actor: { type: "service" as const, serviceName: "setup-link" },
    request,
  };

  try {
    await withTenant(context, (tx) =>
      confirmBookingRequirementsWithin(tx, {
        token,
        ip: request.ipAddress ?? null,
        fields,
        election,
        clinicName: link.clinicName,
        platformId: link.platformId,
      }),
    );
  } catch (error) {
    // Lost the burn: the same person's other tab already confirmed. From
    // where they sit it worked, and the losing attempt was audited by the
    // consume itself — in the transaction we rolled back, so record it again.
    if (error instanceof SetupLinkSpentError) {
      await recordLostBurn(context);
    } else if (error instanceof SetupSubmissionError) {
      return { status: "failed", message: error.message, field: error.field };
    } else {
      log.error("setup-link submission failed", { error: describeError(error) });
      return { status: "failed", message: "We couldn't save that. Please try again, or reply to your setup email." };
    }
  }

  // Outside the try: redirect() throws, and the catch above would swallow a
  // finished setup as a failure. `replace`, so Back does not re-open a spent
  // link and tell someone who just finished that it is dead.
  redirect("/setup/done", RedirectType.replace);
}

async function recordLostBurn(context: {
  clinicId: string;
  actor: { type: "service"; serviceName: string };
  request: { ipAddress?: string; userAgent?: string };
}): Promise<void> {
  try {
    await withTenant(context, async (tx) => {
      tx.audit.record({
        action: "update",
        resourceType: "connection_link",
        metadata: { surface: "setup_form", outcome: "rejected", reason: "lost_the_burn", told_clinic: "stored" },
      });
    });
  } catch (error) {
    log.error("could not record a losing setup-link submission", { error: describeError(error) });
  }
}
