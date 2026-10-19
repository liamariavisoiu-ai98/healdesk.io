/**
 * The Graph API calls Healdesk makes to Meta, on one pinned version.
 *
 * ## Why v25.0
 *
 * The send path used v21.0, which Meta retires on 21 January 2027, three months
 * after the 21 October launch. v25.0 (released 18 February 2026) runs until
 * 29 July 2028, and it is the version Meta's own Facebook Login for Business
 * and Embedded Signup pages are written against. One constant, so the send
 * path, the connect flows and the JavaScript SDK on the WhatsApp page can
 * never disagree about which API they speak. Moving it is one line plus a
 * re-read of Meta's changelog for the endpoints below.
 *
 * ## Three rules
 *
 *   1. **Tokens travel in the Authorization header, never in a URL.** A URL
 *      lands in access logs, proxies and error reports. The single exception
 *      is the code exchange, where Meta defines the parameters as a query
 *      string; it is a server-to-server call that is never logged here.
 *   2. **An id is checked before it is put in a path.** Every id below comes
 *      from Meta or from a browser that relayed Meta's message. A value that
 *      is not a plain number never becomes `/{id}/register`.
 *   3. **Nothing here touches the database.** These calls run with no
 *      transaction open (the calendar write's rule, lib/booking/calendar.ts),
 *      so a Graph call that takes ten seconds to time out holds nothing.
 *
 * `fetchImpl` is injected so the connect flows are testable without Meta.
 */

export const GRAPH_VERSION = "v25.0";

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const TIMEOUT_MS = 10_000;

/** Meta object ids are decimal strings. Anything else is refused before it reaches a path. */
const META_ID = /^\d{1,32}$/;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class GraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = "GraphError";
  }
}

export function isMetaId(value: unknown): value is string {
  return typeof value === "string" && META_ID.test(value);
}

function requireId(value: string, what: string): string {
  if (!isMetaId(value)) throw new GraphError(`Refusing a malformed ${what}.`, 400);
  return value;
}

async function call<T>(fetchImpl: FetchLike, url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const err = body.error as { message?: unknown; code?: unknown } | undefined;
  if (!res.ok || err) {
    // Meta's error text names the failing field, never the token, so it is
    // safe to carry upward. The token itself is never part of any message.
    const message = typeof err?.message === "string" ? err.message : `Graph API answered ${res.status}.`;
    throw new GraphError(message, res.status, typeof err?.code === "number" ? err.code : undefined);
  }
  return body as T;
}

function bearer(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

/**
 * The Facebook Login for Business dialog for the Messenger and Instagram
 * configuration. `config_id` replaces `scope`: the permissions, the assets and
 * the token type live in the configuration on the app dashboard. The two
 * response-type parameters ask for an authorization code, which is what a
 * system-user token requires (docs/meta-app-review.md).
 */
export function loginDialogUrl(input: {
  appId: string;
  configId: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.appId,
    redirect_uri: input.redirectUri,
    config_id: input.configId,
    response_type: "code",
    override_default_response_type: "true",
    state: input.state,
  });
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
}

/**
 * Exchange an authorization code for the business's token.
 *
 * `redirectUri` must be the exact URI the dialog was opened with, or Meta
 * refuses the code. The WhatsApp flow runs in the JavaScript SDK, opens no
 * redirect, and so passes none.
 */
export async function exchangeCode(
  fetchImpl: FetchLike,
  input: { appId: string; appSecret: string; code: string; redirectUri?: string },
): Promise<string> {
  const params = new URLSearchParams({
    client_id: input.appId,
    client_secret: input.appSecret,
    code: input.code,
  });
  if (input.redirectUri) params.set("redirect_uri", input.redirectUri);
  const body = await call<{ access_token?: unknown }>(fetchImpl, `${GRAPH}/oauth/access_token?${params.toString()}`);
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new GraphError("Meta returned no access token.", 502);
  }
  return body.access_token;
}

export type GrantedPage = {
  id: string;
  name: string;
  /** The Page's own token, which is what Messenger and Instagram sends use. */
  accessToken: string;
  /** The Instagram professional account linked to the Page, when there is one. */
  instagram: { id: string; username: string | null } | null;
};

/** The Pages the business selected in the login dialog, each with its linked Instagram account. */
export async function listGrantedPages(fetchImpl: FetchLike, userToken: string): Promise<GrantedPage[]> {
  const fields = "id,name,access_token,instagram_business_account{id,username}";
  const body = await call<{ data?: unknown }>(fetchImpl, `${GRAPH}/me/accounts?fields=${encodeURIComponent(fields)}&limit=25`, {
    headers: bearer(userToken),
  });
  const rows = Array.isArray(body.data) ? body.data : [];
  const pages: GrantedPage[] = [];
  for (const raw of rows) {
    const row = (raw ?? {}) as Record<string, unknown>;
    if (!isMetaId(row.id) || typeof row.access_token !== "string" || !row.access_token) continue;
    const ig = (row.instagram_business_account ?? null) as Record<string, unknown> | null;
    pages.push({
      id: row.id,
      name: typeof row.name === "string" ? row.name : row.id,
      accessToken: row.access_token,
      instagram: ig && isMetaId(ig.id) ? { id: ig.id, username: typeof ig.username === "string" ? ig.username : null } : null,
    });
  }
  return pages;
}

/**
 * Subscribe the app to a Page's `messages` webhook. This one subscription
 * delivers the Page's Messenger conversations and, through the Messenger
 * Platform, the direct messages of the Instagram account linked to it.
 */
export async function subscribePage(fetchImpl: FetchLike, pageId: string, pageToken: string): Promise<void> {
  const body = await call<{ success?: unknown }>(fetchImpl, `${GRAPH}/${requireId(pageId, "Page id")}/subscribed_apps`, {
    method: "POST",
    headers: { ...bearer(pageToken), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ subscribed_fields: "messages" }).toString(),
  });
  if (body.success !== true) throw new GraphError("Meta did not confirm the Page subscription.", 502);
}

/** Subscribe the app to a WhatsApp Business account's webhooks. */
export async function subscribeWaba(fetchImpl: FetchLike, wabaId: string, token: string): Promise<void> {
  const body = await call<{ success?: unknown }>(fetchImpl, `${GRAPH}/${requireId(wabaId, "WhatsApp Business account id")}/subscribed_apps`, {
    method: "POST",
    headers: bearer(token),
  });
  if (body.success !== true) throw new GraphError("Meta did not confirm the WhatsApp subscription.", 502);
}

/**
 * Register a business phone number for the Cloud API, setting its two-step
 * verification PIN. The PIN is ours to choose and must be kept: registering
 * the number again later needs the same one.
 */
export async function registerPhoneNumber(
  fetchImpl: FetchLike,
  phoneNumberId: string,
  token: string,
  pin: string,
): Promise<void> {
  if (!/^\d{6}$/.test(pin)) throw new GraphError("A registration PIN is six digits.", 400);
  const body = await call<{ success?: unknown }>(fetchImpl, `${GRAPH}/${requireId(phoneNumberId, "phone number id")}/register`, {
    method: "POST",
    headers: { ...bearer(token), "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", pin }),
  });
  if (body.success !== true) throw new GraphError("Meta did not confirm the number's registration.", 502);
}

/** The number as the business would recognise it, for the confirmation screen and the audit label. */
export async function displayPhoneNumber(fetchImpl: FetchLike, phoneNumberId: string, token: string): Promise<string | null> {
  const body = await call<{ display_phone_number?: unknown }>(
    fetchImpl,
    `${GRAPH}/${requireId(phoneNumberId, "phone number id")}?fields=display_phone_number`,
    { headers: bearer(token) },
  );
  return typeof body.display_phone_number === "string" ? body.display_phone_number : null;
}

/**
 * Take the app off a Page's webhooks, with the Page's own token: its
 * Messenger conversations, and the direct messages of the Instagram account
 * linked to it, stop reaching us. The reverse of subscribePage, and what
 * "we revoke our access to your Meta accounts" (Terms §7) does for a Page
 * (lib/meta/revoke.ts).
 */
export async function unsubscribePage(fetchImpl: FetchLike, pageId: string, pageToken: string): Promise<void> {
  const body = await call<{ success?: unknown }>(fetchImpl, `${GRAPH}/${requireId(pageId, "Page id")}/subscribed_apps`, {
    method: "DELETE",
    headers: bearer(pageToken),
  });
  if (body.success !== true) throw new GraphError("Meta did not confirm the Page unsubscription.", 502);
}

/** Take the app off a WhatsApp Business account's webhooks, with the business's token. The reverse of subscribeWaba. */
export async function unsubscribeWaba(fetchImpl: FetchLike, wabaId: string, token: string): Promise<void> {
  const body = await call<{ success?: unknown }>(fetchImpl, `${GRAPH}/${requireId(wabaId, "WhatsApp Business account id")}/subscribed_apps`, {
    method: "DELETE",
    headers: bearer(token),
  });
  if (body.success !== true) throw new GraphError("Meta did not confirm the WhatsApp unsubscription.", 502);
}
