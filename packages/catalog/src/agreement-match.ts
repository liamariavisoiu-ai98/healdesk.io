import { agreementKindOfVersion, type AgreementKind } from "./agreement-kind";
import { getBaaTemplate, isBaaVersionAcceptable, templateReadsCalendarAccount } from "./baa";
import type { BookingSystemId } from "./booking-systems";
import type { CalendarAccount } from "./calendar-terms";
import { getDpaTemplate } from "./dpa";
import { getPlatform, NO_PLATFORM_ID } from "./platforms";
import { isSpecialtyId, regimeFor, specialties, type RegulatoryRegime } from "./specialties";

/**
 * Whether a signed agreement is the document a purchase describes, and the two
 * rules that judgement leans on.
 *
 * Pure, and in the catalog since 14 October 2026 because both apps ask it:
 * apps/web when the buyer presses Pay, against the agreement record it holds
 * in the marketing Sheet (docs/design/checkout-records-on-vercel-2026-10-14.md),
 * and apps/app, whose PHI gate and provisioning rest on the same two rules
 * (lib/agreements/kind.ts re-exports them, and tests/agreement-kinds.test.ts
 * holds the TypeScript mirror against the SQL function).
 */

/**
 * The mirror of app_agreement_kind_sufficient(regime, kind, covered): a BAA
 * covers a practice HIPAA can reach, whatever it answered; a DPA covers a
 * veterinary practice, and a practice HIPAA reaches only if covered while it
 * is not covered; nothing else covers anything. Total, like the SQL.
 */
export function agreementKindSufficient(
  regime: RegulatoryRegime | string | null | undefined,
  kind: AgreementKind | string | null | undefined,
  covered: boolean | null | undefined,
): boolean {
  if (kind === "baa") return regime === "hipaa" || regime === "hipaa-if-covered";
  if (kind === "dpa") {
    return regime === "non-hipaa" || (regime === "hipaa-if-covered" && covered === false);
  }
  return false;
}

/**
 * Whether a stored acceptance may be put in force: a released DPA template,
 * or a BAA version go-live accepts (isBaaVersionAcceptable, the TypeScript
 * twin of 0048's app_baa_version_acceptable), so released but superseded BAA
 * versions are refused as the database refuses them.
 */
export function agreementTemplateReleased(version: string): boolean {
  if (agreementKindOfVersion(version) === "dpa") {
    return getDpaTemplate(version)?.approvedByCounsel === true;
  }
  return isBaaVersionAcceptable(version);
}

/** The answers of a purchase that name or select the agreement's document. */
export type AgreementMatchPurchase = {
  clinicName: string;
  specialty: string;
  platform: string;
  isCoveredEntity: boolean | null;
  bookingSystem?: BookingSystemId;
  calendarAccount?: CalendarAccount;
};

/**
 * Why a signed agreement is not the document this purchase describes, or
 * null when it is.
 *
 * - Its template must be one that may be put in force
 *   (agreementTemplateReleased): a released DPA, or a BAA go-live accepts.
 * - Its kind must cover the practice, by the rule the PHI gate applies
 *   (agreementKindSufficient): a veterinary practice never pays on a BAA
 *   only for provisioning to refuse it afterwards.
 * - Every answer that names or selects the document must be the one signed:
 *   the legal name, the specialty, the covered-entity answer, and the booking
 *   system, as the platform it names before 1.3.0, and with the kind of
 *   Google account from 1.3.0 on (and always on a DPA), which read both.
 *
 * Each side is compared as signing wrote it: the name trimmed, a BAA's
 * specialty by the catalogue's name (a DPA's by its id), and a DPA's covered
 * answer as "No", the only one a DPA is signed on. `variables` is the
 * acceptance row's `variables` (agreement-signing.ts, storedVariables).
 *
 * `options.released` stands in for the release gate, for a test that reads
 * the rule for a version the real floor no longer admits; nothing else may
 * pass it.
 */
export function agreementMismatch(
  version: string,
  variables: unknown,
  purchase: AgreementMatchPurchase,
  options: { released?: (version: string) => boolean } = {},
): string | null {
  if (!(options.released ?? agreementTemplateReleased)(version)) {
    return "That agreement's version can no longer be used for a new account. Please sign it again.";
  }
  if (!isSpecialtyId(purchase.specialty)) {
    return "The agreement you signed is for a different kind of practice. Please sign it again.";
  }
  const kind = agreementKindOfVersion(version);
  const signed = (variables ?? {}) as Record<string, unknown>;

  if (!agreementKindSufficient(regimeFor(purchase.specialty), kind, purchase.isCoveredEntity)) {
    return "That agreement doesn't cover this practice. Please sign the one for it.";
  }
  if (signed.clinicLegalName !== purchase.clinicName.trim()) {
    return "The agreement you signed names a different practice. Please sign it again.";
  }
  const specialty =
    kind === "dpa"
      ? purchase.specialty
      : (specialties.find((s) => s.id === purchase.specialty)?.name ?? purchase.specialty);
  if (signed.specialty !== specialty) {
    return "The agreement you signed is for a different kind of practice. Please sign it again.";
  }
  const covered = kind === "dpa" ? (signed.isCoveredEntity ?? false) : signed.isCoveredEntity;
  if (covered !== purchase.isCoveredEntity) {
    return "The agreement you signed has a different answer about billing insurance. Please sign it again.";
  }

  const readsCalendar = kind === "dpa" || templateReadsCalendarAccount(getBaaTemplate(version)!);
  if (readsCalendar) {
    if (signed.bookingSystem !== purchase.bookingSystem || signed.calendarAccount !== purchase.calendarAccount) {
      return "The agreement you signed names a different booking system or Google account. Please sign it again.";
    }
  } else {
    const platform =
      purchase.platform === NO_PLATFORM_ID ? null : (getPlatform(purchase.platform)?.name ?? null);
    if ((signed.connectedPlatform ?? null) !== platform) {
      return "The agreement you signed names a different booking system. Please sign it again.";
    }
  }
  return null;
}
