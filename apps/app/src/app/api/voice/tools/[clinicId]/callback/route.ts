import { handleVoiceTool } from "@/lib/voice/tools";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/voice/tools/[clinicId]/callback — a mid-call tool for the phone
 * agents (design of 23 September 2026, §E.2/§F.9). Authentication, the body
 * cap, the rate limits, the audit row and the tool itself all live in
 * lib/voice/tools.ts; this file only names which tool the path is.
 */
export async function POST(request: Request, { params }: { params: Promise<{ clinicId: string }> }): Promise<Response> {
  const { clinicId } = await params;
  return handleVoiceTool(request, clinicId, "callback");
}
