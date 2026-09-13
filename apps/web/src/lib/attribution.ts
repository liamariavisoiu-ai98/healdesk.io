/**
 * Campaign attribution, browser side.
 *
 * A cold email links to `https://healdesk.io/...?c=<campaign>`. The code is
 * remembered in sessionStorage the first time any page sees it, so a visitor
 * who reads three pages before unlocking the demo or starting checkout still
 * attributes to the email that brought them. It is a short slug, validated
 * on both ends, never a person's data.
 */
const KEY = "hd_campaign";
const SHAPE = /^[a-z0-9_-]{1,64}$/i;

export function rememberCampaignFromUrl(): void {
  if (typeof window === "undefined") return;
  try {
    const code = new URLSearchParams(window.location.search).get("c");
    if (code && SHAPE.test(code)) window.sessionStorage.setItem(KEY, code);
  } catch {
    // Storage blocked; attribution is best-effort.
  }
}

export function campaignCode(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("c");
    if (fromUrl && SHAPE.test(fromUrl)) return fromUrl;
    const stored = window.sessionStorage.getItem(KEY);
    return stored && SHAPE.test(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

export function isCampaignCode(value: unknown): value is string {
  return typeof value === "string" && SHAPE.test(value);
}

/** `?lead=<uuid>` on a claim link; validated server-side against the store. */
export function leadIdFromUrl(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const id = new URLSearchParams(window.location.search).get("lead");
    return id && /^[0-9a-f-]{36}$/i.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}
