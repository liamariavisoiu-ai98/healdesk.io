import { timingSafeEqual } from "node:crypto";

import { after } from "next/server";

import { requestDemo, runDemoBuild } from "@/lib/demo/build";

/**
 * POST /api/demo-sessions, the orchestration webhook: build a personalised demo.
 *
 * For automation (an Instantly reply rule, Zapier, n8n) once the founder has
 * read the reply and decided. The console at /admin/demos does the same thing
 * by hand. Body, as the demo brief specifies it:
 *
 *   { "lead_email", "clinic_name", "website_url", "phone_number", "niche",
 *     "send_email"?: boolean }
 *
 * Only `clinic_name` and `website_url` are required. `send_email: true` mails
 * the link to `lead_email` once the build is ready.
 *
 * Answers 202 at once with the slug and the private link; the scrape and the
 * structuring run after the response (`after()`, inside `maxDuration`), and
 * the link opens on a "being prepared" screen until they finish. That keeps
 * the caller inside the 30-second timeout most automation tools enforce.
 *
 * ## Access
 *
 * `Authorization: Bearer <DEMO_WEBHOOK_SECRET>`, compared in constant time.
 * Unset, the endpoint is off (503), not open. Each call spends a crawl and a
 * model call, so this must never be reachable without the secret.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The build runs after the response, within this. The rendering crawl alone can take three minutes. */
export const maxDuration = 300;

function authorised(request: Request, secret: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const given = Buffer.from(header.replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.DEMO_WEBHOOK_SECRET;
  if (!secret || secret.length < 24) {
    console.error("[healdesk] demo webhook called but DEMO_WEBHOOK_SECRET is unset or too short");
    return Response.json({ error: "Demo webhook is not configured." }, { status: 503 });
  }
  if (!authorised(request, secret)) {
    return Response.json({ error: "Unauthorised." }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const sendEmail = body.send_email === true;
  let result;
  try {
    result = await requestDemo({
      clinicName: str(body.clinic_name) ?? "",
      websiteUrl: str(body.website_url) ?? "",
      leadEmail: str(body.lead_email),
      phone: str(body.phone_number),
      niche: str(body.niche),
      sendEmail,
      createdBy: "webhook",
    });
  } catch (error) {
    console.error("[healdesk] demo webhook could not record the demo", {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json({ error: "The demo register is unavailable. Try again." }, { status: 503 });
  }
  if (!result.ok) {
    return Response.json({ error: result.error, field: result.field }, { status: 422 });
  }

  const { session, url } = result;
  after(() => runDemoBuild(session.slug, { sendEmail }).then(() => undefined));

  return Response.json(
    {
      slug: session.slug,
      url,
      status: session.status,
      expires_at: session.expiresAt.toISOString(),
      email: sendEmail ? "will be sent when the demo is ready" : "not requested",
    },
    { status: 202 },
  );
}
