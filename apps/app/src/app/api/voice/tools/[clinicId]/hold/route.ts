import { handleVoiceTool } from "@/lib/voice/tools";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/voice/tools/[clinicId]/hold — a mid-call tool for the phone
 * agent: one offered time held for 60 seconds before anything confirming is
 * said (plan §7.13). Pre-Retell: called by the Synthflow agent until the
 * Retell endpoint exists, and for healdesk's demo clinic only; every other
 * clinic is answered 403 `manual_booking`. Authentication, the body cap,
 * the rate limits, the audit row and the tool itself all live in
 * lib/voice/tools.ts; this file only names which tool the path is.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ clinicId: string }> },
): Promise<Response> {
  const { clinicId } = await params;
  return handleVoiceTool(request, clinicId, "hold");
}
