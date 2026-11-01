import type { ActorContext } from "@/lib/audit";
import { readKnowledgeFile } from "@/lib/knowledge-file/flow";
import { anthropicFileClient, FILE_HEADER, FILE_LIMITS, FILE_REFUSAL_WORDS } from "@/lib/knowledge-file/read";
import { describeError, log } from "@/lib/log";
import { requirePortal } from "@/lib/portal/access";
import { portalActor } from "@/lib/portal/actor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The file's own limit plus room; the TLS proxy refuses anything over 4 MiB before it gets here. */
const MAX_BODY_BYTES = FILE_LIMITS.maxBytes + 64 * 1024;

/**
 * POST /c/<slug>/knowledge/file: "Add from a file" on Your practice (portal
 * redesign, owner, 1 November 2026). The body is the file's own bytes
 * (application/octet-stream), never a form, so a page on another site
 * cannot post one without a CORS preflight, and the card sends its own
 * header too; a browser also says the request is from this app's pages in
 * Sec-Fetch-Site. The sign-in must be on this clinic (requirePortal, never
 * inside a try/catch, since it answers by Next's own signals). No step-up,
 * as for every edit on Your practice.
 *
 * A route rather than a server action because a server action's body is
 * capped at 1 MB app-wide, and raising that for one card would raise it for
 * every action.
 *
 * Keeps nothing: lib/knowledge-file reads the bytes in memory, asks the
 * model once and answers with the rows to choose from; the log line names
 * the clinic and the outcome, never the file.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  const portal = await requirePortal(slug);

  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return json({ ok: false, message: "Not from this site." }, 403);
  if (request.headers.get(FILE_HEADER) !== "1") return json({ ok: false, message: "Use the card on Your practice." }, 400);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/octet-stream")) {
    return json({ ok: false, message: FILE_REFUSAL_WORDS.wrong_type }, 415);
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return json({ ok: false, message: FILE_REFUSAL_WORDS.too_big }, 413);

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await request.arrayBuffer());
  } catch {
    return json({ ok: false, message: FILE_REFUSAL_WORDS.unreadable }, 400);
  }

  const actorLabel = (await portalActor(portal)).label;
  const actor: ActorContext = { type: "user", userId: portal.userId, label: actorLabel };
  try {
    const outcome = await readKnowledgeFile({
      clinicId: portal.clinicId,
      userId: portal.userId,
      actor,
      bytes,
      client: await anthropicFileClient(),
    });
    log.info("knowledge file read", {
      clinicId: portal.clinicId,
      outcome: outcome.ok ? `rows=${outcome.rows.length}` : outcome.refusal,
    });
    return json(outcome, outcome.ok ? 200 : outcome.refusal === "daily_limit" ? 429 : 422);
  } catch (error) {
    log.error("knowledge file read failed", { clinicId: portal.clinicId, error: describeError(error) });
    return json({ ok: false, refusal: "unavailable", message: FILE_REFUSAL_WORDS.unavailable }, 500);
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
