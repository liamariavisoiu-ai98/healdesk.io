import { SIGNATURE_HEADER, TIMESTAMP_HEADER, sign, WELCOME_NONCE_TTL_SECONDS } from "@healdesk/catalog";

/**
 * Signed calls from the purchase routes to apps/app, and the cookie that
 * binds /welcome to the browser that paid.
 *
 * The same HMAC channel /api/checkout has always used for provisioning
 * (HEALDESK_PROVISION_SECRET over the body and a timestamp), so apps/app
 * can trust the body without trusting the browser that started it.
 */

export type AppConfig = { target: string; secret: string };

export type AppAnswer =
  | { reached: true; status: number; json: Record<string, unknown> | null; text: string }
  | { reached: false; error: unknown };

export async function postToApp(path: string, body: unknown, config: AppConfig): Promise<AppAnswer> {
  const raw = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  try {
    const response = await fetch(new URL(path, config.target), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: sign(raw, timestamp, config.secret),
      },
      body: raw,
    });
    const text = await response.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = null;
    }
    return { reached: true, status: response.status, json, text };
  } catch (error) {
    return { reached: false, error };
  }
}

export type WelcomeCookieOptions = {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/welcome";
  maxAge: number;
  domain?: string;
};

/**
 * The nonce cookie's attributes. It is read by apps/app's /welcome, which is
 * on another host (app.healdesk.io beside healdesk.io), so it is set on the
 * parent domain the two share; on one host (localhost in development) it is
 * host-only, and cookies ignore ports. Path /welcome, so no other request on
 * either app carries it.
 */
export function welcomeCookieOptions(siteHost: string, successUrl: string): WelcomeCookieOptions {
  const domain = sharedParentDomain(siteHost, new URL(successUrl).hostname);
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/welcome",
    maxAge: WELCOME_NONCE_TTL_SECONDS,
    ...(domain ? { domain } : {}),
  };
}

/** The longest domain two hosts share, of at least two labels, or none when they are one host. */
export function sharedParentDomain(a: string, b: string): string | undefined {
  if (a === b) return undefined;
  const left = a.split(".").reverse();
  const right = b.split(".").reverse();
  const common: string[] = [];
  for (let i = 0; i < Math.min(left.length, right.length) && left[i] === right[i]; i += 1) common.push(left[i]!);
  return common.length >= 2 ? common.reverse().join(".") : undefined;
}
