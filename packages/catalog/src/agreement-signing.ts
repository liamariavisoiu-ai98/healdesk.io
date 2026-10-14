import {
  agreementKindFor,
  agreementKindOfVersion,
  assentSentence,
  BAA_ASSENT_LABEL,
  BAA_RELEASE_OVERLAP,
  BaaRenderError,
  buildBaaSelections,
  currentBaaTemplate,
  currentDpaTemplate,
  DPA_ASSENT_LABEL,
  dpaAssentSentence,
  DpaRenderError,
  getBaaTemplate,
  getBookingSystem,
  getDpaTemplate,
  getPlatform,
  isBookingSystemId,
  isCalendarAccount,
  isPlatformId,
  isSpecialtyId,
  NO_PLATFORM_ID,
  prepareBaa,
  prepareDpa,
  supportsVerifiedAttribution,
  templateReadsCalendarAccount,
  type AgreementKind,
  type BaaTemplate,
  type BaaVariables,
  type BookingSystemId,
  type CalendarAccount,
  type CoveredAnswer,
  type DpaTemplate,
  type DpaVariables,
  type Platform,
  type SpecialtyId,
} from "./index";
import { isSendableAddress } from "./mail-address";

/**
 * Signing the data agreement, before payment: what a signature request must
 * be, and the document it signs (the business associate agreement, or, for a
 * practice HIPAA does not reach, the Data Protection Agreement; plan Part L).
 *
 * Moved here from apps/app/src/lib/agreements.ts on 14 October 2026, when the
 * signature started being taken on apps/web so that a buyer can sign, pay and
 * land somewhere honest while the AWS host is in standby
 * (docs/design/checkout-records-on-vercel-2026-10-14.md). apps/web validates
 * and renders with this module when the buyer signs; apps/app runs the same
 * code for its own demo clinic and re-renders the recorded document with the
 * catalogue's prepareBaa/prepareDpa when the record is imported. One
 * implementation, so the two sides cannot disagree about what a signature is.
 *
 * Server-side only (it reaches `node:url` through mail-address), so it is the
 * subpath export `@healdesk/catalog/agreement-signing`, not part of the index.
 *
 * ## Why the server renders the document
 *
 * The browser is shown the agreement, but it does not get to say what the
 * agreement was. The text recorded and hashed is rendered again from the
 * submitted variables, server-side, and compared with the hash of what the
 * screen showed. Otherwise the evidentiary record is only as good as a form
 * field, and nobody could truthfully testify to what the screen displayed.
 *
 * ## No clock but the one it is given, and no environment
 *
 * `prepareSigning` takes the effective date, and `SignableOptions.now` the
 * instant a release overlap is judged at, so a signature is a function of its
 * inputs; whether phase two's verified reporting may be signed is
 * `SignableOptions.phaseTwoAttribution`, which apps/app reads from
 * HEALDESK_PHASE_TWO_ATTRIBUTION and apps/web never sets.
 */

/** The longest typed name or title the agreement will carry. */
export const MAX_SIGNATORY_CHARS = 120;

/** The longest legal name the agreement will carry. */
export const MAX_CLINIC_LEGAL_NAME_CHARS = 200;

/**
 * A signature request larger than this is not one of ours: a dozen short
 * fields and a 64-character hash. Checked by the route before it parses.
 */
export const MAX_SIGN_REQUEST_BYTES = 16_384;

export class AgreementError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "AgreementError";
  }
}

export type SignAgreementRequest = {
  clinicLegalName: string;
  specialty: string;
  signatoryName: string;
  signatoryTitle?: string;
  signatoryEmail: string;
  /** true | false | null — "I don't know" is a real and common answer. */
  isCoveredEntity: boolean | null;
  /**
   * The funnel choices that change the AGREEMENT, not just the product.
   *
   * Verified attribution means we hold read-only credentials to their booking
   * system; estimated means we hold none. The permitted-uses clause differs,
   * so the selection has to travel with the signature rather than being read
   * later off the clinic row — which does not exist yet at signing time.
   */
  attributionMode: "estimated" | "verified";
  /**
   * The phase-two platform id today's checkout picker sends (`platforms`,
   * "none" included). A version before 1.3.0 names it in its data-sources
   * clause, as it always has, so a 1.2.2 document (or any before 1.3.0)
   * keeps the bytes the picker's preview hashed. 1.3.0 names the booking system instead, and
   * takes a platform only as that system's own phase-two platform.
   * Optional because `bookingSystem` can stand in for it: main's checkout
   * sends this until the funnel's M2 ships, and M2 sends `bookingSystem`.
   */
  platform?: string | null;
  /**
   * The answer to "Where do bookings live today?" (booking-systems.ts).
   * Required by a version that reads it (1.3.0 on), where its sync direction
   * chooses the calendar clause; an earlier version names its phase-two
   * platform when `platform` is absent. Absent and null both mean "not sent".
   */
  bookingSystem?: BookingSystemId | null;
  /**
   * The kind of Google account that holds the calendar the assistant books
   * into. Required by a version that reads it (1.3.0 on); refused when it is
   * not one of the three answers, whatever the version.
   */
  calendarAccount?: CalendarAccount | null;
  /** The exact label of the button the signer clicked. */
  assentLabel: string;
  /**
   * Template version the browser rendered: the current one, or one still
   * inside its release overlap (see signableTemplate).
   */
  templateVersion: string;
  /**
   * SHA-256 of the document the browser actually displayed.
   *
   * The server renders its own copy and refuses if the two differ. Without
   * this, the record says "we rendered X" and the screen may have shown Y —
   * and the one question that matters in a dispute is what the signer SAW.
   * Optional only because a browser without Web Crypto (http:// on a LAN)
   * cannot compute it; when absent the mismatch check is skipped and the
   * omission is recorded rather than passing silently.
   */
  displayedHash?: string;
};

const MAX_ASSENT_LABEL = 200;

/**
 * When a signature is judged, and against which release.
 *
 * Each defaults to the real one, and the endpoint passes none of them. They
 * are injectable because a release changes both the current template and the
 * overlap (1.3.0's, plan C19, lists nothing: it replaced 1.2.2 outright), and
 * because a window that closes at a deadline cannot be tested against the
 * wall clock.
 * `current` stands in for a release, for a test that signs as if it had
 * happened; it decides what is signable, so nothing else may pass it.
 */
export type SignableOptions = {
  now?: Date;
  releaseOverlap?: Readonly<Record<string, string>>;
  current?: BaaTemplate;
  /**
   * Stands in for the owner's release of the Data Protection Agreement, for a
   * test that signs one as it will be signed after the release. It decides
   * which agreement a practice signs and whether the DPA template may be
   * signed, so nothing but a test may pass it: the release itself is the
   * template's own flag (`approvedByCounsel`, read by `isDpaReleased`).
   */
  dpaReleased?: boolean;
  /**
   * Whether phase two's verified reporting may be signed: apps/app passes
   * `env.phaseTwoAttribution()` (HEALDESK_PHASE_TWO_ATTRIBUTION), apps/web
   * passes nothing, and nothing is the v1 answer, no.
   */
  phaseTwoAttribution?: boolean;
};

/**
 * Which agreement this request signs, asked of agreementKindFor.
 *
 * That function is the one decision (packages/catalog/src/agreement-kind.ts).
 * This endpoint asks it, and the funnel's agreement step, the checkout
 * intent, provisioning and the go-live check are to ask it too (funnel plan
 * Part L), so that none of them can sign a practice to the wrong paper by
 * deciding separately. The wire keeps `isCoveredEntity`, the field the
 * agreement itself records; its null ("I don't know") asks exactly as the
 * funnel's "not_sure" does.
 *
 * The answer is "baa" or "dpa", and each is signed by its own path below.
 * While the Data Protection Agreement is unreleased the decision never
 * answers "dpa": a practice HIPAA reaches only when covered that answers "No"
 * signs the BAA, as it always has, and a veterinary practice, whose patients
 * HIPAA does not reach, has nothing to sign and is refused by name (it could
 * sign a BAA here before plan C3). `dpaReleased` is for tests; production
 * reads the catalogue's flag.
 */
export function agreementKindForRequest(
  request: { specialty?: unknown; isCoveredEntity?: unknown },
  options: { dpaReleased?: boolean } = {},
): AgreementKind {
  const choice = agreementKindFor({
    specialty: typeof request.specialty === "string" ? request.specialty : "",
    covered: coveredAnswerOf(request.isCoveredEntity),
    dpaReleased: options.dpaReleased,
  });
  if (!choice.ok) {
    throw new AgreementError(
      choice.reason === "dpa_not_released"
        ? "This specialty can't sign up yet."
        : "Unknown specialty.",
      "specialty",
    );
  }
  return choice.kind;
}

/** The agreement's covered-entity answer, as the funnel's question words it. */
function coveredAnswerOf(isCoveredEntity: unknown): CoveredAnswer | null {
  if (isCoveredEntity === true) return "yes";
  if (isCoveredEntity === false) return "no";
  return null;
}

/**
 * The template a signature may be made against: the current one, or a
 * released one still inside its release overlap.
 *
 * A release reaches apps/app and apps/web in two deploys, and a buyer who
 * loaded the agreement before the second would otherwise be refused at the
 * last step for signing what was, minutes earlier, the current text. So the
 * version a release replaces stays signable until the deadline the release
 * writes into BAA_RELEASE_OVERLAP, and not from that instant on. Anything
 * else that is not current is refused outright rather than silently swapped
 * for the current text: someone who left the tab open across a revision
 * must see the new one.
 *
 * Both signing entry points ask this, validateSignRequest and signAgreement
 * (through prepareAgreement), so neither can sign a draft. Provisioning,
 * which binds the acceptance a purchase names, refuses a draft's row too,
 * since plan C15 by the bound row's own version, so neither check alone
 * stands between an unreleased text and a live account.
 */
export function signableTemplate(version: unknown, options: SignableOptions = {}): BaaTemplate {
  const template = typeof version === "string" ? getBaaTemplate(version) : undefined;
  if (!template) {
    throw new AgreementError("Unknown agreement version.", "templateVersion");
  }
  if (template.version === (options.current ?? currentBaaTemplate()).version) return template;

  // Only a released version can be the one a release replaced, so a draft
  // listed in the overlap by mistake stays refused rather than becoming
  // signable through the public endpoint until the deadline. A version that
  // is not listed has no deadline, and NaN compares false.
  const overlap = options.releaseOverlap ?? BAA_RELEASE_OVERLAP;
  const closesAt = Object.hasOwn(overlap, template.version)
    ? overlapClosesAt(overlap[template.version])
    : Number.NaN;
  if (template.approvedByCounsel && (options.now ?? new Date()).getTime() < closesAt) {
    return template;
  }

  throw new AgreementError(
    "The agreement has been updated. Please reload and review the current version.",
    "templateVersion",
  );
}

/**
 * An ISO 8601 date and time that names its own offset: YYYY-MM-DDTHH:mm,
 * optionally with seconds and milliseconds, then Z or ±HH:mm. The first group
 * is what was written down to the minute or second, the rest the offset.
 */
const ISO_INSTANT =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(?:\.\d{1,3})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * When an overlap deadline falls, in epoch milliseconds, or NaN when it does
 * not name one instant exactly as written. NaN compares false, so a typo in
 * the release closes the window rather than holding it open.
 *
 * Date.parse alone is too forgiving for that. It reads "Oct 12 2026" and
 * "2026/10/12", reads a time with no offset in the host's own time zone, and
 * rolls an impossible date or time forward: 30 February becomes 2 March, and
 * 24:00 the next midnight. So the form must be the one above, and the parsed
 * instant, read back in the deadline's own offset, must say what was written.
 */
function overlapClosesAt(deadline: string | undefined): number {
  const match = ISO_INSTANT.exec(deadline ?? "");
  if (!match) return Number.NaN;
  const [instant, written = "", sign, hours, minutes] = match;
  const at = Date.parse(instant);
  if (Number.isNaN(at)) return Number.NaN;

  const offsetMinutes =
    sign === undefined ? 0 : (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes));
  const readBack = new Date(at + offsetMinutes * 60_000).toISOString().slice(0, written.length);
  return readBack === written ? at : Number.NaN;
}

/**
 * The Data Protection Agreement a signature may be made against: the current
 * DPA template, and only once it is released. The rule signableTemplate
 * applies to the BAA, for a document with one version so far: no overlap,
 * because no release has replaced anything yet, and never a draft, because a
 * row signed against an unreleased text would carry it into a live account
 * the day provisioning admitted the version. A BAA version here, or a DPA
 * version that is not current, is refused as stale, so a screen loaded before
 * a change of agreement or of version shows the buyer the document they now
 * sign.
 *
 * `dpaReleased` stands in for the owner's release, in tests only.
 */
export function signableDpaTemplate(
  version: unknown,
  options: Pick<SignableOptions, "dpaReleased"> = {},
): DpaTemplate {
  if (typeof version === "string" && agreementKindOfVersion(version) !== "dpa") {
    throw new AgreementError(
      "This practice signs the Data Protection Agreement. Please reload and review it.",
      "templateVersion",
    );
  }
  const template = typeof version === "string" ? getDpaTemplate(version) : undefined;
  if (!template) {
    throw new AgreementError("Unknown agreement version.", "templateVersion");
  }
  if (template.version !== currentDpaTemplate().version) {
    throw new AgreementError(
      "The agreement has been updated. Please reload and review the current version.",
      "templateVersion",
    );
  }
  if (!(options.dpaReleased ?? template.approvedByCounsel)) {
    throw new AgreementError(
      "The Data Protection Agreement can't be signed yet.",
      "templateVersion",
    );
  }
  return template;
}

/** The answers that choose what the document names, however typed. */
type AnswerFields = {
  attributionMode?: unknown;
  platform?: unknown;
  bookingSystem?: unknown;
  calendarAccount?: unknown;
};

/**
 * An answer that is not one of the catalogue's is refused whatever the
 * version reads. It is a stale client or a tampered request either way, and
 * signAgreement records each answer that was sent beside the signature, so
 * an unknown value would otherwise reach the evidence even where the
 * document ignores it.
 */
function checkKnownAnswers(body: AnswerFields): void {
  if (body.platform != null && !isPlatformId(body.platform)) {
    throw new AgreementError("Unknown platform.", "platform");
  }
  if (body.bookingSystem != null && !isBookingSystemId(body.bookingSystem)) {
    throw new AgreementError("Unknown booking system.", "bookingSystem");
  }
  if (body.calendarAccount != null && !isCalendarAccount(body.calendarAccount)) {
    throw new AgreementError("Unknown kind of Google account.", "calendarAccount");
  }
}

/**
 * The answers this version cannot render without, and a system for verified
 * reporting to read in the document it will render.
 *
 * Run by both entry points, validateSignRequest and signAgreement (through
 * prepareAgreement), because renderBaa's own refusals surface as the generic
 * "we couldn't prepare your agreement": right for a template bug, useless
 * for a caller error. Checking here gives both the same precise answer.
 */
function checkAnswersFor(template: BaaTemplate, body: AnswerFields): void {
  if (templateReadsCalendarAccount(template)) {
    // 1.3.0's calendar clause is chosen by both answers. A default would sign
    // the practice to manual booking and no agreement with Google without its
    // having said either, which is why the version's render guard refuses one.
    if (body.bookingSystem == null) {
      throw new AgreementError("Answer where the practice's bookings live today.", "bookingSystem");
    }
    if (body.calendarAccount == null) {
      throw new AgreementError(
        "Answer which kind of Google account holds the practice's calendar.",
        "calendarAccount",
      );
    }
    // The document names the booking system and ignores `platform`, but the
    // acceptance keeps a platform that was sent, beside the booking system,
    // and whatever reads the signed row later may read either. Mindbody kept
    // beside Cal.com would record a one-way system next to live calendar
    // terms. So a platform is taken only as the booking system's own phase-two
    // platform, or "none" for a system that has none; a client of 1.3.0 need
    // not send one at all.
    const own = getBookingSystem(body.bookingSystem)?.phaseTwoPlatformId ?? NO_PLATFORM_ID;
    if (body.platform != null && body.platform !== own) {
      throw new AgreementError("The platform doesn't match the booking system.", "platform");
    }
  } else if (body.platform == null && body.bookingSystem == null) {
    // An earlier version names the practice's system in its data-sources
    // clause, and either answer can name it; with neither, nothing can.
    throw new AgreementError("Answer where the practice's bookings live today.", "bookingSystem");
  }

  // Verified reporting needs something to read from. Signing an agreement
  // that describes a connection to nothing would be describing a data flow
  // that cannot exist.
  if (body.attributionMode === "verified") {
    const source = verifiedSourceOf(template, body);
    if (!source || !supportsVerifiedAttribution(source)) {
      throw new AgreementError(
        source
          ? `Verified reporting needs a system to read from; ${source.name} has none.`
          : "Verified reporting needs a system to read from; nothing is connected.",
        "attributionMode",
      );
    }
  }
}

/**
 * The phase-two platform verified reporting would read, chosen as
 * buildBaaSelections chooses what the document names: for a version before
 * 1.3.0, the picker's platform, else the booking system's; for 1.3.0, the
 * booking system's alone, because that is the system its document names.
 */
function verifiedSourceOf(template: BaaTemplate, body: AnswerFields): Platform | undefined {
  const system = getBookingSystem(body.bookingSystem);
  const platformId = typeof body.platform === "string" ? body.platform : null;
  const id = templateReadsCalendarAccount(template)
    ? system?.phaseTwoPlatformId
    : (platformId ?? system?.phaseTwoPlatformId);
  return id ? getPlatform(id) : undefined;
}

/**
 * What a Data Protection Agreement cannot be rendered without, checked by
 * name before rendering, as checkAnswersFor checks a BAA's.
 *
 * - Both calendar answers, which choose its Google Calendar clause exactly as
 *   they choose 1.3.0's; and a platform, where one is sent, only as the
 *   booking system's own phase-two platform, so the row cannot name two
 *   systems.
 * - Estimated reporting: the DPA describes no read-back from a practice's
 *   systems, so it never signs verified reporting, whatever phase two's
 *   switch says.
 * - No "yes" to billing insurance electronically. The DPA is signed only by a
 *   practice HIPAA does not cover: a "No", which its status clause records
 *   as the practice's warranty, or a veterinary practice, which the funnel
 *   never asks. A covered practice is sent to the BAA before this; a "yes"
 *   here can only come from a request the funnel did not build.
 */
function checkDpaAnswers(body: AnswerFields & { isCoveredEntity?: unknown }): void {
  if (body.bookingSystem == null) {
    throw new AgreementError("Answer where the practice's bookings live today.", "bookingSystem");
  }
  if (body.calendarAccount == null) {
    throw new AgreementError(
      "Answer which kind of Google account holds the practice's calendar.",
      "calendarAccount",
    );
  }
  const own = getBookingSystem(body.bookingSystem)?.phaseTwoPlatformId ?? NO_PLATFORM_ID;
  if (body.platform != null && body.platform !== own) {
    throw new AgreementError("The platform doesn't match the booking system.", "platform");
  }
  if (body.attributionMode !== "estimated") {
    throw new AgreementError(
      "The Data Protection Agreement describes no verified reporting.",
      "attributionMode",
    );
  }
  if (body.isCoveredEntity === true) {
    throw new AgreementError(
      "The Data Protection Agreement is only for a practice that bills no health insurance electronically.",
      "isCoveredEntity",
    );
  }
}

export function validateSignRequest(
  input: unknown,
  options: SignableOptions = {},
): asserts input is SignAgreementRequest {
  const body = input as Partial<SignAgreementRequest> | null;
  if (!body || typeof body !== "object") {
    throw new AgreementError("Invalid request body.");
  }

  if (!body.clinicLegalName?.trim()) {
    throw new AgreementError("Clinic name is required.", "clinicLegalName");
  }
  if (body.clinicLegalName.length > MAX_CLINIC_LEGAL_NAME_CHARS) {
    throw new AgreementError("Clinic name is too long.", "clinicLegalName");
  }
  if (!isSpecialtyId(body.specialty)) {
    throw new AgreementError("Unknown specialty.", "specialty");
  }
  // Which agreement, before anything about this one: a practice that cannot
  // sign it is told so first, not asked to correct its other fields.
  const kind = agreementKindForRequest(body, options);

  // The typed name IS the signature. A single character is not a signature, and
  // an empty one would render a contract signed by nobody.
  if (!body.signatoryName?.trim() || body.signatoryName.trim().length < 2) {
    throw new AgreementError(
      "Type your full name to sign.",
      "signatoryName",
    );
  }
  if (body.signatoryName.length > MAX_SIGNATORY_CHARS) {
    throw new AgreementError("Name is too long.", "signatoryName");
  }
  // The title prints beside the signature on the document and the PDF, so it
  // is held to the name's limit; until 14 October 2026 it had none.
  if (body.signatoryTitle !== undefined && body.signatoryTitle !== null) {
    if (typeof body.signatoryTitle !== "string") {
      throw new AgreementError("Invalid title.", "signatoryTitle");
    }
    if (body.signatoryTitle.length > MAX_SIGNATORY_CHARS) {
      throw new AgreementError("Title is too long.", "signatoryTitle");
    }
  }
  if (typeof body.signatoryEmail !== "string" || !isSendableAddress(body.signatoryEmail)) {
    throw new AgreementError("A valid work email is required.", "signatoryEmail");
  }

  if (
    body.isCoveredEntity !== true &&
    body.isCoveredEntity !== false &&
    body.isCoveredEntity !== null
  ) {
    throw new AgreementError(
      "Answer whether the practice bills insurance electronically.",
      "isCoveredEntity",
    );
  }

  if (
    body.attributionMode !== "estimated" &&
    body.attributionMode !== "verified"
  ) {
    throw new AgreementError("Invalid attribution mode.", "attributionMode");
  }

  checkKnownAnswers(body);

  // Verified attribution is phase two (v1 spec: attended-and-collected
  // figures are "not available in v1"). Checkout no longer offers it, but a
  // hand-crafted request could still ask for it, and the clause it selects
  // describes read-only access to a practice system and reports "revenue",
  // neither of which v1 has. Refused here, under the same flag that keeps
  // the phase-two jobs switched off, so the only way to sign that clause is
  // to switch phase two on deliberately.
  if (body.attributionMode === "verified" && options.phaseTwoAttribution !== true) {
    throw new AgreementError(
      "Verified reporting is not offered in v1; it stays off until HEALDESK_PHASE_TWO_ATTRIBUTION is \"true\".",
      "attributionMode",
    );
  }

  // The one field that must not be caller-controlled. The record's value is
  // what makes a click-through enforceable — "what did the button say" — so
  // the client may only confirm it showed the published label, exactly; the
  // sentence that is stored is derived server-side (see signAgreement).
  // Each kind's own label: a DPA signed under the BAA's words, or the reverse,
  // would record a click on a button that named another document.
  if (!body.assentLabel?.trim() || body.assentLabel.length > MAX_ASSENT_LABEL) {
    throw new AgreementError("Missing assent label.", "assentLabel");
  }
  if (body.assentLabel.trim() !== (kind === "dpa" ? DPA_ASSENT_LABEL : BAA_ASSENT_LABEL)) {
    throw new AgreementError(
      "The assent label does not match the published agreement label.",
      "assentLabel",
    );
  }

  if (
    body.displayedHash !== undefined &&
    !/^[0-9a-f]{64}$/i.test(body.displayedHash)
  ) {
    throw new AgreementError("Malformed document hash.", "displayedHash");
  }

  // What the answers must be depends on the version they will be rendered
  // into, so the version is settled first.
  if (kind === "dpa") {
    signableDpaTemplate(body.templateVersion, options);
    checkDpaAnswers(body);
    return;
  }
  checkAnswersFor(signableTemplate(body.templateVersion, options), body);
}

/** What prepareBaa returns: the text, its hash, the version and the variant. */
type PreparedBaa = ReturnType<typeof prepareBaa>;

/**
 * The document a request signs, exactly as signAgreement will store it.
 *
 * It renders the version the request names, no longer always the current
 * one, because a buyer inside a release overlap signs the version on their
 * screen. That version is settled by signableTemplate, the rule
 * validateSignRequest applies, so a direct caller (a test, an operator
 * script) can sign only what the endpoint would accept: never a draft, and
 * never a superseded version outside its overlap. Before plan C3 this
 * rendered the current template whatever the request said, which kept every
 * caller off a draft; a version taken from the request has to be held to
 * the same rule here, on the path that writes the row, not only on the
 * endpoint's.
 *
 * The selections come from buildBaaSelections, the one builder the funnel's
 * preview calls too, so the two renders cannot drift: for a version before
 * 1.3.0 it names the picker's platform, else the booking system's phase-two
 * platform, byte for byte as signing did before it; for 1.3.0 it names the
 * booking system and carries both calendar answers.
 *
 * No database, and no clock but the one signableTemplate is given. That is
 * what lets a test hold the server's render against the browser's without
 * writing a row.
 */
export function prepareAgreement(
  request: SignAgreementRequest,
  effectiveDate: string,
  options: SignableOptions = {},
): { template: BaaTemplate; variables: BaaVariables; prepared: PreparedBaa } {
  // Settled first: what the answers must be depends on the version.
  const template = signableTemplate(request.templateVersion, options);
  // What this prepares is a business associate agreement. A practice the
  // decision sends to the DPA is prepared by prepareDpaAgreement, and this
  // keeps it from a BAA row whoever calls.
  if (agreementKindForRequest(request, options) !== "baa") {
    throw new AgreementError(
      "This practice signs the Data Protection Agreement, not this one.",
      "specialty",
    );
  }
  checkKnownAnswers(request);
  checkAnswersFor(template, request);

  try {
    const variables: BaaVariables = {
      ...buildBaaSelections({
        specialtyId: request.specialty,
        attributionMode: request.attributionMode,
        bookingSystem: request.bookingSystem ?? null,
        platformId: request.platform ?? null,
        isCoveredEntity: request.isCoveredEntity,
        calendarAccount: request.calendarAccount ?? null,
        template,
      }),
      clinicLegalName: request.clinicLegalName.trim(),
      signatoryName: request.signatoryName.trim(),
      signatoryTitle: request.signatoryTitle?.trim() || undefined,
      signatoryEmail: request.signatoryEmail.trim().toLowerCase(),
      effectiveDate,
    };
    return { template, variables, prepared: prepareBaa(template, variables) };
  } catch (error) {
    // A template that cannot render is our bug, not the buyer's: the checks
    // above have answered every caller error by name. It must never fall
    // through to storing a half-substituted contract.
    if (error instanceof BaaRenderError) {
      throw new AgreementError(
        "We couldn't prepare your agreement. Nothing has been charged — please contact us.",
      );
    }
    throw error;
  }
}

/** What prepareDpa returns: the text, its hash, the version and the variant. */
type PreparedDpa = ReturnType<typeof prepareDpa>;

/**
 * The Data Protection Agreement a request signs, exactly as signAgreement
 * will store it: prepareAgreement's counterpart for a practice HIPAA does not
 * reach (plan Part L), held to the same rules.
 *
 * The kind is agreementKindFor's, never the request's: a practice the
 * decision sends to the BAA is refused here, and while the DPA is unreleased
 * the decision sends nobody here at all. The version is settled by
 * signableDpaTemplate, the rule validateSignRequest applies, so a direct
 * caller can sign only the current, released DPA. The variables are the
 * DPA's own (`DpaVariables`): the specialty by its id, which chooses the
 * status clause and the practice's descriptor, and both calendar answers,
 * which choose the Google Calendar clause as 1.3.0's are chosen. The funnel's
 * preview builds the same eight values (apps/web's agreement-kinds.ts), so
 * the browser's hash and this render agree byte for byte.
 */
export function prepareDpaAgreement(
  request: SignAgreementRequest,
  effectiveDate: string,
  options: SignableOptions = {},
): { template: DpaTemplate; variables: DpaVariables; prepared: PreparedDpa } {
  if (agreementKindForRequest(request, options) !== "dpa") {
    throw new AgreementError(
      "This practice signs the Business Associate Agreement, not this one.",
      "specialty",
    );
  }
  const template = signableDpaTemplate(request.templateVersion, options);
  checkKnownAnswers(request);
  checkDpaAnswers(request);

  try {
    const variables: DpaVariables = {
      clinicLegalName: request.clinicLegalName.trim(),
      signatoryName: request.signatoryName.trim(),
      signatoryTitle: request.signatoryTitle?.trim() || undefined,
      signatoryEmail: request.signatoryEmail.trim().toLowerCase(),
      effectiveDate,
      // The checks above have proved all three are the catalogue's.
      specialty: request.specialty as SpecialtyId,
      bookingSystem: request.bookingSystem as BookingSystemId,
      calendarAccount: request.calendarAccount as CalendarAccount,
    };
    return { template, variables, prepared: prepareDpa(template, variables) };
  } catch (error) {
    // As for the BAA: every caller error has been answered by name above, so
    // a render that fails here is our bug, never a half-built contract.
    if (error instanceof DpaRenderError) {
      throw new AgreementError(
        "We couldn't prepare your agreement. Nothing has been charged — please contact us.",
      );
    }
    throw error;
  }
}

/**
 * One prepared signature, whichever agreement it is: what the row stores and
 * the security event records. Built by `prepareSigning` from the kind's own
 * path, so the write below cannot tell the two apart and cannot treat them
 * differently.
 */
export type PreparedSigning = {
  kind: AgreementKind;
  version: string;
  hash: string;
  text: string;
  clauseIds: string[];
  approvedByCounsel: boolean;
  /** The row's `variables`: the document's own, and beside them, outside its hash, the answers. */
  stored: Record<string, unknown>;
  /**
   * The variables the document was rendered from, exactly: what re-renders it
   * (`renderSignedDocument`). `stored` holds these and the answers beside
   * them, which a template version may not read and must not be handed.
   */
  documentVariables: BaaVariables | DpaVariables;
  /** The answers kept beside the document, outside its hash (see `storedVariables`). */
  answers: Record<string, unknown>;
  effectiveDate: string;
  /** The full sentence beside the checkbox, re-derived from the validated clinic name. */
  assentSentence: string;
  signatoryName: string;
  signatoryEmail: string;
  signatoryTitle: string | null;
};

export function prepareSigning(
  request: SignAgreementRequest,
  effectiveDate: string,
  options: SignableOptions,
): PreparedSigning {
  if (agreementKindForRequest(request, options) === "dpa") {
    const { template, variables, prepared } = prepareDpaAgreement(request, effectiveDate, options);
    const answers: Record<string, unknown> = {
      // The determination the DPA is signed on, not an answer: a "No"
      // practice said it, and a veterinary practice is never asked. It is
      // what provisioning puts on the clinic row and what the checkout
      // intent compares (agreementForProvisioning, agreementMismatch), and
      // checkDpaAnswers has refused a "yes".
      isCoveredEntity: false,
      // A platform that was sent, which checkDpaAnswers has proved to be the
      // booking system's own; the booking system and the account kind are
      // the document's variables already.
      ...(request.platform != null ? { platformId: request.platform } : {}),
    };
    return {
      kind: "dpa",
      version: prepared.version,
      hash: prepared.hash,
      text: prepared.text,
      clauseIds: prepared.clauseIds,
      approvedByCounsel: template.approvedByCounsel,
      stored: storedVariables(variables, answers, prepared.clauseIds, Boolean(request.displayedHash)),
      documentVariables: variables,
      answers,
      effectiveDate,
      assentSentence: dpaAssentSentence(variables.clinicLegalName),
      signatoryName: variables.signatoryName,
      signatoryEmail: variables.signatoryEmail,
      signatoryTitle: variables.signatoryTitle ?? null,
    };
  }

  const { template, variables, prepared } = prepareAgreement(request, effectiveDate, options);
  // The answers, as they were sent, beside the document and outside its
  // hash. The variables of a version before 1.3.0 hold none of the three
  // ids, only the name the document gives the platform, which is why they
  // are kept here: the booking system is what provisioning is to read into
  // the clinic row (plan C15) rather than asking again, and the platform is
  // what named a 1.2.x document. 1.3.0's variables carry the booking system
  // and the account kind already, as these same values, and a platform
  // beside them has been checked to be the booking system's own
  // (checkAnswersFor).
  const answers: Record<string, unknown> = {
    ...(request.platform != null ? { platformId: request.platform } : {}),
    ...(request.bookingSystem != null ? { bookingSystem: request.bookingSystem } : {}),
    ...(request.calendarAccount != null ? { calendarAccount: request.calendarAccount } : {}),
  };
  return {
    kind: "baa",
    version: prepared.version,
    hash: prepared.hash,
    text: prepared.text,
    clauseIds: prepared.clauseIds,
    approvedByCounsel: template.approvedByCounsel,
    stored: storedVariables(variables, answers, prepared.clauseIds, Boolean(request.displayedHash)),
    documentVariables: variables,
    answers,
    effectiveDate,
    // validateSignRequest has already proved the client displayed the
    // published label.
    assentSentence: assentSentence(variables.clinicLegalName),
    signatoryName: variables.signatoryName,
    signatoryEmail: variables.signatoryEmail,
    signatoryTitle: variables.signatoryTitle ?? null,
  };
}

/**
 * The acceptance row's `variables`, as signing has always written them: the
 * document's own variables, the answers beside them, the variant that applied
 * (reproducing the document years from now must not depend on the clause
 * predicates still evaluating the same way), and whether the screen's hash
 * was checked (its ABSENCE is itself a fact about the signature).
 *
 * One function, so the row apps/app imports from a checkout record holds
 * exactly what a signature taken on apps/app would have written.
 */
export function storedVariables(
  documentVariables: BaaVariables | DpaVariables | Record<string, unknown>,
  answers: Record<string, unknown>,
  appliedClauses: readonly string[],
  displayedHashVerified: boolean,
): Record<string, unknown> {
  return {
    ...(documentVariables as Record<string, unknown>),
    ...answers,
    appliedClauses: [...appliedClauses],
    displayedHashVerified,
  };
}

/** The effective date of a signature made at `at`: that day, in UTC. The signer's own clock is not asked. */
export function effectiveDateOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * The document a recorded signature signed, rendered again from what was
 * recorded: the template version, its kind and the variables, exactly as
 * signing rendered them. No release rule is applied, because what is asked
 * is what the signer signed, not whether it may be signed today; whether it
 * may be put in force is provisioning's question (agreementTemplateReleased).
 * Undefined when the version is not one this catalogue knows.
 *
 * tests/baa-golden.test.ts in apps/app pins that the renderer is
 * deterministic: no clock, no environment, nothing random. That is what lets
 * a record that stores no text be trusted to reproduce it.
 */
export function renderSignedDocument(
  version: string,
  variables: Record<string, unknown>,
): { text: string; hash: string; clauseIds: string[] } | undefined {
  try {
    if (agreementKindOfVersion(version) === "dpa") {
      const template = getDpaTemplate(version);
      if (!template) return undefined;
      const prepared = prepareDpa(template, variables as unknown as DpaVariables);
      return { text: prepared.text, hash: prepared.hash, clauseIds: prepared.clauseIds };
    }
    const template = getBaaTemplate(version);
    if (!template) return undefined;
    const prepared = prepareBaa(template, variables as unknown as BaaVariables);
    return { text: prepared.text, hash: prepared.hash, clauseIds: prepared.clauseIds };
  } catch (error) {
    if (error instanceof BaaRenderError || error instanceof DpaRenderError) return undefined;
    throw error;
  }
}

/** The full sentence beside the tick box, as signing stores it, for a recorded document of this kind. */
export function storedAssentSentence(kind: AgreementKind, clinicLegalName: string): string {
  return kind === "dpa" ? dpaAssentSentence(clinicLegalName) : assentSentence(clinicLegalName);
}
