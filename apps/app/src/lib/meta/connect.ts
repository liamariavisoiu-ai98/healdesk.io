import { randomInt } from "node:crypto";

import {
  displayPhoneNumber,
  exchangeCode,
  GraphError,
  isMetaId,
  listGrantedPages,
  registerPhoneNumber,
  subscribePage,
  subscribeWaba,
  type FetchLike,
} from "./graph";
import type { MetaPlatform } from "./front-door";

/**
 * What a clinic's Facebook login or WhatsApp signup turns into: the channels
 * to store, worked out entirely before anything is written.
 *
 * Every Graph call happens here, with no transaction open. The route then
 * burns the clinic's link and stores what this returns in ONE tenant
 * transaction (the burn-and-store rule of app/connect/[token]/actions.ts), so
 * a link is spent exactly when its channels are saved, never one without the
 * other. A failure anywhere in here stores nothing and spends nothing: the
 * clinic sees why and can try again with the same link.
 *
 * Subscription comes before storage on purpose. A channel stored without its
 * webhook subscription would show as connected while no message ever reached
 * it, which is the false green light the spec forbids ("No channel is ever
 * shown as live before it is").
 */

export type ChannelToStore = {
  platform: MetaPlatform;
  /** The id Meta's webhooks name as the recipient: Page, Instagram account or phone number. */
  externalId: string;
  accessToken: string;
  /** What the clinic sees: the Page name, the Instagram handle, the number. Business data, not PHI. */
  label: string;
  /** Further secrets sealed with the token. Today only the WhatsApp registration PIN. */
  secrets?: Record<string, string>;
  /** Non-secret ids kept in plain metadata. */
  details?: Record<string, string>;
};

export type MetaLoginProblem =
  /** The person backed out of Meta's dialog. */
  | "cancelled"
  /** No Page was selected, or the account administers none. */
  | "no_page"
  /** More than one Page selected. One account answers on one Page, for all its locations. */
  | "several_pages"
  /** Meta refused a call. `detail` carries its message. */
  | "meta_error";

export type MetaLoginOutcome =
  | { ok: true; page: { id: string; name: string }; instagram: { id: string; username: string | null } | null; channels: ChannelToStore[] }
  | { ok: false; problem: MetaLoginProblem; detail?: string };

export type MetaAppCredentials = { appId: string; appSecret: string };

/**
 * A Facebook Login for Business code → the Page, and its Instagram account when
 * it has one.
 *
 * Exactly one Page. One AYA answers for every location of an account, and the
 * account answers on one Page for all of them (several Pages per account are a
 * later item of the extra-locations plan); a login that selected two would
 * otherwise force a silent guess about which one is the practice's, and
 * `saveConnection` keeps one connection per provider, so the guess would be
 * stored as fact. The clinic is asked to choose one instead.
 *
 * A Page with no linked Instagram professional account connects Messenger
 * alone, and the screen says what Instagram still needs. That is not an
 * error: plenty of clinics buy the Meta channel for Messenger and add
 * Instagram later.
 */
export async function prepareMetaLogin(
  fetchImpl: FetchLike,
  app: MetaAppCredentials,
  input: { code: string; redirectUri: string },
): Promise<MetaLoginOutcome> {
  try {
    const userToken = await exchangeCode(fetchImpl, { ...app, code: input.code, redirectUri: input.redirectUri });
    const pages = await listGrantedPages(fetchImpl, userToken);
    if (pages.length === 0) return { ok: false, problem: "no_page" };
    if (pages.length > 1) return { ok: false, problem: "several_pages" };

    const page = pages[0]!;
    await subscribePage(fetchImpl, page.id, page.accessToken);

    const channels: ChannelToStore[] = [
      { platform: "messenger", externalId: page.id, accessToken: page.accessToken, label: page.name },
    ];
    if (page.instagram) {
      // Instagram messaging through the Messenger Platform sends with the
      // Page's token; the webhook names the Instagram account as recipient,
      // which is what routes a DM to this clinic.
      channels.push({
        platform: "instagram",
        externalId: page.instagram.id,
        accessToken: page.accessToken,
        label: page.instagram.username ? `@${page.instagram.username}` : page.name,
        details: { pageId: page.id },
      });
    }
    return { ok: true, page: { id: page.id, name: page.name }, instagram: page.instagram, channels };
  } catch (error) {
    if (error instanceof GraphError) return { ok: false, problem: "meta_error", detail: error.message };
    throw error;
  }
}

export type WhatsAppSignupInput = {
  code: string;
  wabaId: string;
  phoneNumberId: string;
};

export type WhatsAppOutcome =
  | { ok: true; displayNumber: string | null; channel: ChannelToStore }
  | { ok: false; problem: "bad_request" | "meta_error"; detail?: string };

/** Six random digits for a number's two-step verification. Ours to choose, and sealed with the token. */
export function generateRegistrationPin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * Embedded Signup's code and session info → the WhatsApp channel.
 *
 * The two ids arrive from the browser, which relayed them from Meta's
 * `WA_EMBEDDED_SIGNUP` message. They are checked for shape here and then
 * proved by Meta itself: subscribing to an account, or registering a number,
 * that this business's token does not cover is refused by Graph, and nothing
 * is stored.
 *
 * A number that stays on the WhatsApp Business app through coexistence is not
 * registered this way, and is not supported yet (docs/meta-app-review.md).
 */
export async function prepareWhatsApp(
  fetchImpl: FetchLike,
  app: MetaAppCredentials,
  input: WhatsAppSignupInput,
  pin: string = generateRegistrationPin(),
): Promise<WhatsAppOutcome> {
  if (!input.code || !isMetaId(input.wabaId) || !isMetaId(input.phoneNumberId)) {
    return { ok: false, problem: "bad_request" };
  }
  try {
    const token = await exchangeCode(fetchImpl, { ...app, code: input.code });
    await subscribeWaba(fetchImpl, input.wabaId, token);
    await registerPhoneNumber(fetchImpl, input.phoneNumberId, token, pin);
    const displayNumber = await displayPhoneNumber(fetchImpl, input.phoneNumberId, token);
    return {
      ok: true,
      displayNumber,
      channel: {
        platform: "whatsapp",
        externalId: input.phoneNumberId,
        accessToken: token,
        label: displayNumber ?? input.phoneNumberId,
        secrets: { registrationPin: pin },
        details: { wabaId: input.wabaId },
      },
    };
  } catch (error) {
    if (error instanceof GraphError) return { ok: false, problem: "meta_error", detail: error.message };
    throw error;
  }
}
