import { setupLastDay } from "@/lib/clinic/setup-window";
import { renderAgreementQuestion, type AgreementQuestionPayload } from "@/lib/email/templates/agreement_question";
import { renderBaaResignChase, type BaaResignChasePayload } from "@/lib/email/templates/baa_resign_chase";
import { clinicReason } from "@/lib/email/templates/context";
import { renderSetupExtended, type SetupExtendedPayload } from "@/lib/email/templates/setup_extended";
import { renderSetupHelpOffer, type SetupHelpOfferPayload } from "@/lib/email/templates/setup_help_offer";
import { renderSetupWaitingOnUs, type SetupWaitingOnUsPayload } from "@/lib/email/templates/setup_waiting_on_us";
import type { RenderedEmail, TemplateContext } from "@/lib/email/templates/types";
import { RESIGN_LINK_TTL_MS } from "@/lib/agreements/resign";
import { publicUrl } from "@/lib/public-url";
import { emailCallUrl, helpContacts } from "@/lib/setup/help";

import type { ContactPayloads, DraftKind, RenderContext } from "./contact-payloads";
import type { Draft } from "./drafts";

/**
 * Each clinic-contact kind's draft, rendered by the email's own template
 * from the stored payload and nothing else (ops automation lane P6f; owner
 * decision D12). The owner reads the draft in the inbox; his edit is a new
 * set of fields, which renders a new draft here the same way, so the text
 * he approves is exactly what the template prints from those fields.
 *
 * The draft is the email's plain-text part, footer included, as the clinic
 * reads it. The BAA chase's signing link is minted when the email is sent
 * (./contact-executors.ts), never here: the draft shows LINK_PLACEHOLDER
 * where it goes, so no token is ever stored in ops_approvals.draft.
 */

/** What the draft prints where the chase's signing link goes. */
export const LINK_PLACEHOLDER = "[a fresh signing link, made when this email is sent]";

/** The path the draft renders the chase with, swapped for LINK_PLACEHOLDER. Not token-shaped. */
const LINK_SENTINEL_PATH = "/agreement/link-made-when-sent";

/** The template context an email renders in, from the payload's own copy of it. */
export function contextOf(ctx: RenderContext, raisedAt: Date = new Date(0)): TemplateContext {
  return {
    clinicName: ctx.clinicName,
    audience: ctx.audience,
    reason: clinicReason(ctx.clinicName),
    raisedAt,
    timeZone: ctx.timeZone,
  };
}

/** YYYY-MM-DD plus whole calendar days. */
function addDays(localDate: string, days: number): string {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** The setup window's new last day once `days` are added to the deadline the proposal read. */
export function extendedLastDay(payload: Pick<ContactPayloads["setup_extended"], "fromDeadline" | "days" | "timeZone">): string {
  return addDays(setupLastDay(new Date(payload.fromDeadline), payload.timeZone), payload.days);
}

/** The email payload each kind sends, from the approval's payload; the chase's link is the caller's. */
export function emailPayloadOf(kind: "baa_resign_chase", p: ContactPayloads["baa_resign_chase"], signUrl: string): BaaResignChasePayload;
export function emailPayloadOf(kind: "agreement_question", p: ContactPayloads["agreement_question"]): AgreementQuestionPayload;
export function emailPayloadOf(
  kind: "setup_extended",
  p: ContactPayloads["setup_extended"],
  closesOn?: string,
): SetupExtendedPayload;
export function emailPayloadOf(kind: "setup_waiting_on_us", p: ContactPayloads["setup_waiting_on_us"]): SetupWaitingOnUsPayload;
export function emailPayloadOf(kind: "setup_help_offer", p: ContactPayloads["setup_help_offer"]): SetupHelpOfferPayload;
export function emailPayloadOf(kind: DraftKind, p: ContactPayloads[DraftKind], extra?: string): unknown {
  switch (kind) {
    case "baa_resign_chase": {
      const c = p as ContactPayloads["baa_resign_chase"];
      return {
        signUrl: extra ?? "",
        validDays: Math.round(RESIGN_LINK_TTL_MS / 86_400_000),
        fromVersion: c.fromVersion,
        toVersion: c.toVersion,
        isAnswering: c.isAnswering,
        note: c.note,
      } satisfies BaaResignChasePayload;
    }
    case "agreement_question": {
      const q = p as ContactPayloads["agreement_question"];
      return { locations: q.locations, isAnswering: q.isAnswering, note: q.note } satisfies AgreementQuestionPayload;
    }
    case "setup_extended": {
      const e = p as ContactPayloads["setup_extended"];
      return {
        closesOn: extra ?? extendedLastDay(e),
        extendedDays: e.days,
        stepsLeftCount: e.stepsLeftCount,
        rows: e.rows,
        setupUrl: publicUrl(`/c/${e.clinicSlug}/setup`),
        helpPhoneE164: helpContacts().phoneE164,
        note: e.note,
      } satisfies SetupExtendedPayload;
    }
    case "setup_waiting_on_us": {
      const w = p as ContactPayloads["setup_waiting_on_us"];
      return { phrase: w.phrase, note: w.note } satisfies SetupWaitingOnUsPayload;
    }
    case "setup_help_offer": {
      const h = p as ContactPayloads["setup_help_offer"];
      return { phrase: h.phrase, callUrl: emailCallUrl(), note: h.note } satisfies SetupHelpOfferPayload;
    }
  }
}

/** The email as its template renders it from the approval's payload, for the given link (the chase only). */
export function renderContactEmail(kind: DraftKind, payload: ContactPayloads[DraftKind], signUrl?: string): RenderedEmail {
  const ctx = contextOf(payload);
  switch (kind) {
    case "baa_resign_chase":
      return renderBaaResignChase(
        emailPayloadOf(kind, payload as ContactPayloads["baa_resign_chase"], signUrl ?? publicUrl(LINK_SENTINEL_PATH)),
        ctx,
      );
    case "agreement_question":
      return renderAgreementQuestion(emailPayloadOf(kind, payload as ContactPayloads["agreement_question"]), ctx);
    case "setup_extended":
      return renderSetupExtended(emailPayloadOf(kind, payload as ContactPayloads["setup_extended"]), ctx);
    case "setup_waiting_on_us":
      return renderSetupWaitingOnUs(emailPayloadOf(kind, payload as ContactPayloads["setup_waiting_on_us"]), ctx);
    case "setup_help_offer":
      return renderSetupHelpOffer(emailPayloadOf(kind, payload as ContactPayloads["setup_help_offer"]), ctx);
  }
}

/** The draft the owner reads: the email's subject and plain text, the chase's link shown as a placeholder. */
export function renderContactDraft(kind: DraftKind, payload: ContactPayloads[DraftKind]): Draft {
  const rendered = renderContactEmail(kind, payload);
  let body = rendered.text;
  if (kind === "baa_resign_chase") body = body.split(publicUrl(LINK_SENTINEL_PATH)).join(LINK_PLACEHOLDER);
  return { subject: rendered.subject, body };
}

/** The draft of an email as it was sent, for its hash: the subject and the plain text. */
export function sentDraft(rendered: RenderedEmail): Draft {
  return { subject: rendered.subject, body: rendered.text };
}
