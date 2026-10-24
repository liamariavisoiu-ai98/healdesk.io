import { ASKED_FOR_WORDS, RIGHTS_KIND_WORDS, VERIFICATION_WORDS } from "@/components/admin/rights-words";
import type { RecordRightsIntakeInput, RightsAskedFor, RightsKind, RightsVerification } from "@/lib/admin/ops-client";

/**
 * What the Record a request form sends, checked on the server before the
 * signed request goes (ops automation lane P6b): the browser chose each
 * value from a list the page drew, so anything off a list is a bug or a
 * forgery and is refused in a plain sentence rather than sent for apps/app
 * to refuse with a 400, which would reach the operator only as the ops
 * client's generic "refused". The rules are apps/app's own (lib/ops/
 * rights-ops.ts opRecordRightsIntake): a uuid for the clinic and the key,
 * the closed lists, a real day no later than tomorrow in UTC (a clinic east
 * of UTC can already be in tomorrow), and what was asked for exactly when
 * the kind is a patient's own request. Pure, so a client component may
 * import its type and this test can run it.
 */

export type RecordRequestInput = {
  clinicId: string;
  /** Generated once when the form opened: the same key again is the same request. */
  requestKey: string;
  kind: string;
  /** YYYY-MM-DD, the day the request reached us. */
  receivedOn: string;
  verifiedVia: string;
  askedFor?: string | null;
};

export type RecordRequestCheck = { ok: true; input: RecordRightsIntakeInput } | { ok: false; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function isIsoDay(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DAY.test(value)) return false;
  const at = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

function has<T extends string>(table: Record<T, unknown>, value: unknown): value is T {
  return typeof value === "string" && Object.hasOwn(table, value);
}

/** `input` as apps/app takes it, or the one sentence saying what is wrong. `today` is the UTC day, YYYY-MM-DD. */
export function checkRecordInput(input: unknown, today: string): RecordRequestCheck {
  if (typeof input !== "object" || input === null) return { ok: false, message: "Nothing was sent." };
  const i = input as Record<string, unknown>;
  if (typeof i.clinicId !== "string" || !UUID.test(i.clinicId)) return { ok: false, message: "Choose a clinic." };
  if (typeof i.requestKey !== "string" || !UUID.test(i.requestKey)) {
    return { ok: false, message: "This form has no request key. Reload the page and record it again." };
  }
  if (!has(RIGHTS_KIND_WORDS, i.kind)) return { ok: false, message: "Choose what the request asks for." };
  const kind: RightsKind = i.kind;
  if (!has(VERIFICATION_WORDS, i.verifiedVia)) return { ok: false, message: "Say how the request was verified." };
  const verifiedVia: RightsVerification = i.verifiedVia;
  if (!isIsoDay(i.receivedOn)) return { ok: false, message: "Enter the day the request reached us." };
  const tomorrow = new Date(new Date(`${today}T00:00:00Z`).getTime() + DAY_MS).toISOString().slice(0, 10);
  if (i.receivedOn > tomorrow) return { ok: false, message: "A request cannot be received after today." };
  let askedFor: RightsAskedFor | undefined;
  if (kind === "patient_request") {
    if (!has(ASKED_FOR_WORDS, i.askedFor)) return { ok: false, message: "Say what the patient asked for." };
    askedFor = i.askedFor;
  } else if (i.askedFor !== undefined && i.askedFor !== null && i.askedFor !== "") {
    return { ok: false, message: "What was asked for is recorded for a patient's own request only." };
  }
  return {
    ok: true,
    input: {
      clinicId: i.clinicId.toLowerCase(),
      requestKey: i.requestKey.toLowerCase(),
      kind,
      receivedOn: i.receivedOn,
      verifiedVia,
      ...(askedFor ? { askedFor } : {}),
    },
  };
}
