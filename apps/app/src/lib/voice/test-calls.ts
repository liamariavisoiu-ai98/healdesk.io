import { eq } from "drizzle-orm";

import { clinics } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { isDemoClinic } from "@/lib/booking/terms";
import { readSetupSettings } from "@/lib/setup/settings";
import { withTenant } from "@/lib/tenant";

import { usableLine } from "./fallback-line";

/**
 * Test calls before the business associate agreements are signed (owner,
 * 19 October 2026). The Retell line password, HEALDESK_RETELL_LLM_SECRET, may
 * be pasted before every agreement in the chain is in place, for a test call
 * on a made-up clinic and nothing else. This file is what makes that true in
 * code rather than in the runbook's words.
 *
 * Real calls need HEALDESK_VOICE_REAL_CALLS=1, which only Terraform's
 * voice_real_calls sets (infra/aws/locals.tf), and only once the whole chain
 * is signed. It sets it on two processes: the voice task, which screens every
 * call here, and the worker, whose voice backstop (lib/voice/backstop.ts)
 * reads the same switch, so in test mode the backstop records no call but
 * the demo clinic's either. Anything else, unset, "true" or a typo
 * included, is test mode: the voice endpoint takes a call only for a
 * clinic the database itself calls made up, and every other call is passed
 * to the clinic's direct line or politely refused before AYA says a word,
 * before the answer gate runs and with nothing recorded.
 *
 * The marker is app_clinic_is_demo() (drizzle/0057), the one that already
 * exists and that no purchase can reach: entitlements `demo`, which only
 * provisioning's internal option writes (scripts/demo-clinic.ts), no Stripe
 * customer or subscription, and data_classification still `synthetic`.
 * `synthetic` alone would not do: every clinic is created synthetic, a
 * paying practice included, until it is promoted under its BAA.
 */

const ACTOR: ActorContext = { type: "agent", serviceName: "retell-voice" };

// Pure, in its own module, so the portal's switch rules can read it without
// the database (lib/sms/config.ts, healdeskTextReady).
export { voiceRealCallsAllowed } from "./real-calls";

export type TestCallScreen = { madeUp: boolean; directLine: string | null };

/**
 * In test mode: is this clinic made up, and where does a call for one that is
 * not go? Only to a direct line that does not forward back to us (usableLine):
 * never the clinic's published number or its AYA number.
 */
export async function screenTestCall(clinicId: string): Promise<TestCallScreen> {
  return withTenant({ clinicId, actor: ACTOR }, async (tx) => {
    if (await isDemoClinic(tx)) return { madeUp: true, directLine: null };
    const [clinic] = await tx.db
      .select({ published: clinics.publishedPhoneE164, assistant: clinics.assistantNumberE164 })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    const line = (await readSetupSettings(tx.db, tx.clinicId)).directLineE164;
    return { madeUp: false, directLine: usableLine(line, [clinic?.published, clinic?.assistant]) };
  });
}
