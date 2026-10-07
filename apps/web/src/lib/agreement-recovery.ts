import type { AgreementResult } from "@/components/checkout/AgreementStep";
import { type AgreementInputs, parseAgreementInputs } from "@/lib/checkout/funnel";

/**
 * Session-scoped, per-tab, and deliberately not localStorage.
 *
 * The record holds the buyer's own name, email and clinic, their data, on
 * their machine, for the length of one tab. Persisting it beyond that would
 * outlive the purchase it belongs to. Every access is wrapped: a browser with
 * storage disabled must fall back to today's behaviour, not throw on mount.
 *
 * The signature is kept with the answers it was made from (`inputs`), because
 * it is reused only while every one of them still matches (plan Part A5): a
 * buyer who goes back and changes the practice's name, its booking system or
 * the covered-entity answer has described a different document, and signs
 * that one instead.
 */
export const AGREEMENT_KEY = "healdesk.agreement.v1";

export type StoredAgreement = AgreementResult & { inputs?: AgreementInputs };

export function readStoredAgreement(): StoredAgreement | null {
  try {
    const raw = sessionStorage.getItem(AGREEMENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredAgreement;
    if (!parsed?.agreementId) return null;
    const inputs = parseAgreementInputs(parsed.inputs);
    const { inputs: _stored, ...result } = parsed;
    return inputs ? { ...result, inputs } : result;
  } catch {
    return null;
  }
}

export function storeAgreement(result: AgreementResult, inputs?: AgreementInputs): void {
  try {
    sessionStorage.setItem(AGREEMENT_KEY, JSON.stringify(inputs ? { ...result, inputs } : result));
  } catch {
    // Private mode, or a full quota. The in-memory copy still works for this
    // session; only the recovery net is lost.
  }
}

export function clearStoredAgreement(): void {
  try {
    sessionStorage.removeItem(AGREEMENT_KEY);
  } catch {
    // Nothing to do, see storeAgreement.
  }
}
