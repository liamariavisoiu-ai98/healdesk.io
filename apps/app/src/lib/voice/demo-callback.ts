import { sign, SIGNATURE_HEADER, TIMESTAMP_HEADER, type DemoCallContext } from "@healdesk/catalog";

import { env } from "@/lib/env";
import { webOrigin, WebOriginError } from "@/lib/website/client";

import { spokenPhone } from "./spoken";

/**
 * A call back asked for on a demo call (owner, 26 October 2026: "Lead capture
 * yes do it"; docs/design/demo-lead-capture-2026-10-25.md).
 *
 * When the clinic owner on a demo call hesitates at the close or asks for a
 * person, Aya offers a call from the team and asks for the best number, reads
 * it back, and asks what the team should come prepared with. Her structured
 * state update then carries `callback: { phone, note }` (demo-facts.ts,
 * demoStateFrom), never her prose, and the call session sends it here.
 *
 * ## Where it goes, and why there
 *
 * A clinic owner talking about their own business is business contact data,
 * not PHI, so the request goes to the no-PHI side: one request to apps/web's
 * /api/voice-demo/callback-request, signed with HEALDESK_PROVISION_SECRET like
 * every server-to-server call between the two apps (catalog
 * request-signing.ts). apps/web keeps it in the marketing Sheet with the other
 * leads and emails hello@. This side keeps nothing: the demo call still writes
 * no row and no transcript.
 *
 * What crosses: the demo's slug, the clinic's name, the requester's first
 * name, the number, the one line, whether it was an operator's test call, and
 * when the demo's discount ends. Never anything else said on the call.
 *
 * ## Saying it only once it is true
 *
 * The caller hears that the team will call only after apps/web answered 2xx
 * (the rule of lib/support/escalate.ts: never tell a person a request was
 * passed on that no person received). Any other outcome, the network, a
 * timeout or a refusal, is heard as hello at healdesk dot io instead.
 */

/** How long the caller waits for apps/web before hearing hello@ instead. */
export const DEMO_CALLBACK_TIMEOUT_MS = 4_000;

/** The one line kept with the number, cut to this. */
const NOTE_MAX = 160;

export type DemoCallback = {
  /** E.164: "+15125550100". */
  phoneE164: string;
  /** What they want to talk about, one short line. */
  note: string;
};

/**
 * A number Aya heard, as E.164, or null when it cannot be a phone number. A
 * bare ten digits is a US or Canadian number (the demo's market); a leading
 * 1 before ten digits is the same; anything else needs its own "+" and 8 to
 * 15 digits. North American area codes and exchanges never start with 0 or 1.
 */
export function callbackPhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!/^\+?[\d\s().-]{7,24}$/.test(value)) return null;
  const digits = value.replace(/\D/g, "");
  const nanp = (ten: string) => (/^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? `+1${ten}` : null);
  if (value.startsWith("+")) {
    if (digits.startsWith("1")) return digits.length === 11 ? nanp(digits.slice(1)) : null;
    return /^[2-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
  }
  if (digits.length === 10) return nanp(digits);
  if (digits.length === 11 && digits.startsWith("1")) return nanp(digits.slice(1));
  return null;
}

/** Her one line, as one plain line: control characters out, spaces collapsed, cut. */
export function callbackNote(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NOTE_MAX);
}

/** The callback in a state update, or null when it has no number that can be called. */
export function callbackFrom(raw: unknown): DemoCallback | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as { phone?: unknown; note?: unknown };
  const phoneE164 = callbackPhone(value.phone);
  return phoneE164 ? { phoneE164, note: callbackNote(value.note) } : null;
}

/** Said once apps/web has the request: the number read back, the way a voice reads one. */
export function callbackSentLine(phoneE164: string): string {
  return `Perfect, I've passed that to the team, and someone will call you on ${spokenPhone(phoneE164)}. Is there anything else I can help with?`;
}

/** Said when it did not get through: the address, never a promise nobody received. */
export const CALLBACK_FAILED_LINE =
  "I'm sorry, I couldn't get that through to the team just now. The quickest way is an email to hello at healdesk dot io, and they'll get straight back to you. Is there anything else I can help with?";

export type DemoCallbackRequest = DemoCallback & {
  context: Pick<DemoCallContext, "slug" | "firstName" | "test" | "offer" | "clinic">;
  at: Date;
};

export type DemoCallbackDeps = {
  fetch?: typeof fetch;
  /** The origin and the secret, for tests; read from the environment otherwise. */
  origin?: string | null;
  secret?: string | null;
  timeoutMs?: number;
};

/**
 * apps/web's origin: HEALDESK_WEB_URL when it is set, else the ops console's
 * origin (HEALDESK_CONSOLE_ORIGIN), which is apps/web's public origin too
 * and which Terraform already sets on every task, the voice task included
 * (infra/aws/locals.tf). HEALDESK_WEB_URL alone would also switch on the
 * worker's website re-reads (lib/website/job.ts), which this must not.
 */
export function callbackOrigin(): string | null {
  try {
    return webOrigin(env.webUrl()) ?? webOrigin(process.env.HEALDESK_CONSOLE_ORIGIN);
  } catch (error) {
    if (error instanceof WebOriginError) return null;
    throw error;
  }
}

/** Send the request to apps/web. True only on a 2xx; never throws. */
export async function sendDemoCallback(request: DemoCallbackRequest, deps: DemoCallbackDeps = {}): Promise<boolean> {
  const origin = deps.origin !== undefined ? deps.origin : callbackOrigin();
  const secret = deps.secret !== undefined ? deps.secret : env.provisionSecret();
  if (!origin || !secret) return false;
  const body = JSON.stringify({
    slug: request.context.slug,
    clinicName: request.context.clinic.clinicName,
    firstName: request.context.firstName,
    phoneE164: request.phoneE164,
    note: request.note,
    test: request.context.test === true,
    offerEndsAt: request.context.offer?.endsAt ?? null,
    at: request.at.toISOString(),
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  try {
    const response = await (deps.fetch ?? fetch)(`${origin}/api/voice-demo/callback-request`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: sign(body, timestamp, secret),
      },
      body,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEMO_CALLBACK_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}
