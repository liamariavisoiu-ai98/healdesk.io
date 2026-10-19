import type { ActorContext } from "@/lib/audit";
import { describeError, log } from "@/lib/log";
import { requirePortal } from "@/lib/portal/access";
import { portalActor } from "@/lib/portal/actor";
import { sessionBinding } from "@/lib/portal/step-up";
import { readAccountState } from "@/lib/support/account-reader";
import { handleSupportChat, readChatRequest, supportLines } from "@/lib/support/chat";
import { readForwardingSteps } from "@/lib/support/forwarding";
import { supportLimiter } from "@/lib/support/limits";
import { anthropicSupportClient } from "@/lib/support/model";
import type { SupportEvent } from "@/lib/support/turn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The body is the conversation so far: twenty messages of 2,000 characters fit with room. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * POST /c/<slug>/help/chat: one message of the portal's support chat (plan
 * Part H), answered as a stream of events, one JSON object a line
 * (lib/support/turn.ts, SupportEvent).
 *
 * The sign-in must be on this clinic (requirePortal, which answers by Next's
 * own redirect or not-found signals, so it is never called inside a
 * try/catch). The request must come from this app's own pages: a browser
 * says so in Sec-Fetch-Site, and the body must be JSON, which a form on
 * another site cannot send without a preflight this route never answers. No
 * step-up: nothing here shows a patient.
 *
 * Stores nothing (lib/support/chat.ts): the body is read, answered and
 * dropped, and the log line names the clinic and the outcome only.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  const portal = await requirePortal(slug);

  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return plain("Not from this site.", 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return plain("Send JSON.", 415);
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return plain("Too long.", 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return plain("Not JSON.", 400);
  }
  const chat = readChatRequest(body);
  if (!chat) return plain("Not a chat message.", 400);

  const actorLabel = (await portalActor(portal)).label;
  const actor: ActorContext = { type: "user", userId: portal.userId, label: actorLabel };
  const binding = await sessionBinding(portal);
  const deviceKey = binding ? binding.sessionTokenHash.toString("hex") : `user:${portal.userId}`;
  const client = await anthropicSupportClient();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: SupportEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      try {
        await handleSupportChat(
          {
            clinicId: portal.clinicId,
            slug: portal.clinicSlug,
            deviceKey,
            actor,
            limiter: supportLimiter,
            client,
            readAccount: () =>
              readAccountState({ clinicId: portal.clinicId, userId: portal.userId, actor }),
            readForwarding: () => readForwardingSteps({ clinicId: portal.clinicId, actor }),
          },
          chat,
          emit,
        );
      } catch (error) {
        log.error("support chat failed", {
          clinicId: portal.clinicId,
          error: describeError(error),
        });
        emit({ type: "replace", text: supportLines().failure });
        emit({ type: "done", outcome: "failed" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}

function plain(text: string, status: number): Response {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
