import { handleVoiceTool } from "@/lib/voice/tools";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/voice/tools/[clinicId]/request — a mid-call tool for the phone
 * agent: the caller's preferred time as a request for the clinic to confirm
 * (plan §7.13). Pre-Retell: called by the Synthflow agent until the Retell
 * endpoint exists, and for healdesk's demo clinic only; every other clinic
 * is answered 403 `not_available`, and its requests are the post-call
 * webhook's, which mails the desk. Authentication, the body cap, the rate
 * limits, the audit row and the tool itself all live in lib/voice/tools.ts;
 * this file only names which tool the path is.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ clinicId: string }> },
): Promise<Response> {
  const { clinicId } = await params;
  return handleVoiceTool(request, clinicId, "request");
}
