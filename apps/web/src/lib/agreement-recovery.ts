import type { AgreementResult } from "@/components/checkout/AgreementStep";

/**
 * Session-scoped, per-tab, and deliberately not localStorage.
 *
 * The record holds the buyer's own name, email and clinic, their data, on
 * their machine, for the length of one tab. Persisting it beyond that would
 * outlive the purchase it belongs to. Every access is wrapped: a browser with
 * storage disabled must fall back to today's behaviour, not throw on mount.
 */
export const AGREEMENT_KEY = "healdesk.agreement.v1";

export function readStoredAgreement(): AgreementResult | null {
  try {
    const raw = sessionStorage.getItem(AGREEMENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AgreementResult;
    return parsed?.agreementId ? parsed : null;
  } catch {
    return null;
  }
}

export function storeAgreement(result: AgreementResult): void {
  try {
    sessionStorage.setItem(AGREEMENT_KEY, JSON.stringify(result));
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
