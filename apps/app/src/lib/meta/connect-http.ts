import type { RequestContext } from "@/lib/audit";
import { env } from "@/lib/env";

import type { MetaAppCredentials } from "./connect";

/**
 * The few things the Meta connect routes share.
 *
 * Every URL a clinic is sent to is built on the PUBLIC origin
 * (`BETTER_AUTH_URL`), never on the request's own host. Behind the load
 * balancer the request arrives addressed to an internal origin, and the
 * OAuth redirect URI in particular must match, character for character, the
 * one registered on the Meta app (`https://app.healdesk.io/api/meta/callback`).
 */

export function publicUrl(path: string): string {
  return `${env.betterAuthUrl().replace(/\/$/, "")}${path}`;
}

export const META_CALLBACK_PATH = "/api/meta/callback";

/** 303, so a POST is followed by a GET, optionally setting or clearing the login cookie. */
export function seeOther(location: string, setCookie?: string): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  if (setCookie) headers.append("Set-Cookie", setCookie);
  return new Response(null, { status: 303, headers });
}

/** The same trace the token pages record (app/connect/[token]/request-context.ts), read off a route's Request. */
export function requestContextFrom(request: Request): RequestContext {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return {
    ipAddress: forwarded || request.headers.get("x-real-ip") || undefined,
    userAgent: request.headers.get("user-agent") ?? undefined,
  };
}

/** The app id and secret together, or null when either is unset. */
export function metaApp(): MetaAppCredentials | null {
  const appId = env.metaAppId();
  const appSecret = env.metaAppSecret();
  return appId && appSecret ? { appId, appSecret } : null;
}

/** The service actor every connect write is audited under. */
export const META_CONNECT_ACTOR = { type: "service" as const, serviceName: "meta-connect" };

export class LinkAlreadySpentError extends Error {
  constructor() {
    super("The link was spent by another request.");
    this.name = "LinkAlreadySpentError";
  }
}
