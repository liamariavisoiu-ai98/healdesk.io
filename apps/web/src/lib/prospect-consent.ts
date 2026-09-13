import { CALL_CONSENT } from "@/lib/consent";

/**
 * The rule, in one place: no AI voice ever dials a prospect on our initiative.
 *
 * FCC Declaratory Ruling 24-17 (February 2024) made an AI-generated voice an
 * "artificial voice" under TCPA §227(b)(1). That prong does not care how the
 * number was dialled, so an AI-voiced call to a prospect needs prior express
 * written consent, every time, however the number was obtained. A scraped
 * listing has given none. Statutory damages are $500–1,500 per call, and TCPA
 * is excluded from the insurance.
 *
 * So there is exactly one way a prospect's phone rings with our voice on it:
 * the prospect asked for it, on this site, just now, by ticking the consent
 * box whose exact words are CALL_CONSENT.text. This function is the gate that
 * decision passes through, the callback route is its only caller, and
 * tests/no-outbound-voice.test.ts asserts that placeCall() is reachable from
 * nowhere else in apps/web.
 *
 * It does not check rate limits or phone shape — those are the route's job —
 * it decides only whether the LAW permits the call.
 */

export type ProspectContactRequest = {
  channel: "voice" | "sms";
  /** The literal boolean from the form. `=== true`, never truthy. */
  consent: unknown;
  /** The version string the client says it rendered. */
  consentVersion: unknown;
};

export type ProspectContactDecision =
  | { allowed: true; consentVersion: string; consentText: string }
  | { allowed: false; code: "no_consent" | "stale_consent" | "channel_not_offered"; reason: string };

export function canContactProspect(request: ProspectContactRequest): ProspectContactDecision {
  if (request.channel !== "voice") {
    // No prospect SMS exists and none is planned without its own consent
    // wording; a caller asking for it gets a no, not a default.
    return {
      allowed: false,
      code: "channel_not_offered",
      reason: "healdesk does not text prospects.",
    };
  }
  if (request.consent !== true) {
    return {
      allowed: false,
      code: "no_consent",
      reason: "Tick the consent box so we're allowed to call you.",
    };
  }
  if (request.consentVersion !== CALL_CONSENT.version) {
    return {
      allowed: false,
      code: "stale_consent",
      reason: "This page is out of date, reload and try again.",
    };
  }
  return { allowed: true, consentVersion: CALL_CONSENT.version, consentText: CALL_CONSENT.text };
}
