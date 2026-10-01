import { handleVoiceTool } from "@/lib/voice/tools";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/voice/tools/[clinicId]/context — a mid-call tool for the phone
 * agent (design of 23 September 2026, §E.2). Pre-Retell: called by the
 * Synthflow agent until the Retell endpoint exists. Authentication, the body
 * cap, the rate limits, the audit row and the tool itself all live in
 * lib/voice/tools.ts; this file only names which tool the path is.
 */
export async function POST(request: Request, { params }: { params: Promise<{ clinicId: string }> }): Promise<Response> {
  const { clinicId } = await params;
  return handleVoiceTool(request, clinicId, "context");
}
