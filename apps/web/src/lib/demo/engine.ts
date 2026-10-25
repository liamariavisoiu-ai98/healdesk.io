import {
  DEMO_CALL_VARIABLE,
  parseDemoCallClinic,
  sealDemoCallContext,
  type DemoCallContext,
  type DemoCallMode,
} from "@healdesk/catalog";

import { appAnswers } from "@/lib/admin/ops-client";
import type { ClinicProfile } from "@/lib/demo/profile";

/**
 * Which engine a personalised demo call runs on (owner, 24 October 2026:
 * "the demo AYAs and the client AYA should be THE SAME, only difference
 * should be the start").
 *
 * ## Two engines, one choice
 *
 *   - AYA's own, in apps/app: the demo engine agent
 *     (RETELL_DEMO_ENGINE_AGENT_ID, scripts/retell-demo-engine-agent.ts), a
 *     Retell agent whose custom-LLM socket is apps/app's voice endpoint. The
 *     call starts with one dynamic variable, `demo_context`: the clinic's
 *     public profile and the visitor's first name, sealed with
 *     HEALDESK_PROVISION_SECRET (packages/catalog/src/demo-call.ts has the
 *     contract). apps/app answers from it with the turn pipeline a clinic's
 *     patients get, and keeps nothing.
 *   - The Retell-hosted clinic demo agent, as before, with the prompt and
 *     variables of lib/demo/clinic-prompts.ts.
 *
 * The engine is used only when the variable is set AND apps/app answers right
 * now (`appAnswers`, a cached signed read). While the AWS host is in standby,
 * or before the variable is set, this returns null and every caller does
 * exactly what it did before this file existed. A demo must never go quiet
 * because the better engine is off.
 *
 * ## What crosses
 *
 * Business data only: the clinic's own published website as the demo read it
 * (`parseDemoCallClinic` copies the fields the contract names and drops the
 * rest, such as where the opening hours came from), the demo's slug, the
 * first name the visitor typed about themselves, and, when the caller
 * computed one, the demo's own live setup-fee discount. Nothing a patient
 * said. apps/web still has no database and no new store.
 *
 * Server-side only: it reads HEALDESK_PROVISION_SECRET, and its import of the
 * ops client refuses to load in a browser.
 */

const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The demo engine agent's id, or null when it is not set (or not an id). */
export function demoEngineAgentId(): string | null {
  const id = process.env.RETELL_DEMO_ENGINE_AGENT_ID?.trim();
  return id && AGENT_ID.test(id) ? id : null;
}

/** What a call needs of the engine: the agent to start and the one variable to start it with. */
export type DemoEngineCall = { agentId: string; variables: Record<string, string> };

/**
 * The engine agent and its sealed context for one call, or null when the
 * call should run as it always has. Never throws: a context that cannot be
 * built or sealed (too large, no secret) is the same as an engine that is off.
 *
 * `firstName` must already be clean (`demoFirstName`); the context parser
 * cleans it again on the far side, so a caller that forgot cannot get a bad
 * one spoken.
 */
export async function demoEngineCall(input: {
  slug: string;
  profile: ClinicProfile;
  mode: DemoCallMode;
  firstName: string | null;
  /**
   * The demo's live setup-fee discount, already computed by the caller
   * (lib/demo/sessions.ts `demoOfferEndsAt`/`demoSetupCredit`) from its own
   * row: null when there is none or it has ended. Kept out of this file so
   * it stays decoupled from the session store; a caller that cannot compute
   * one (a minimal row in a test, a read that failed) passes null, same as
   * no discount at all.
   */
  offer?: { percentOfSetupFee: number; endsAt: Date } | null;
  /** A healdesk operator signed in to /admin started it: its transcript goes to hello@ (DemoCallContext.test). */
  test?: boolean;
}): Promise<DemoEngineCall | null> {
  const agentId = demoEngineAgentId();
  const secret = process.env.HEALDESK_PROVISION_SECRET;
  if (!agentId || !secret) return null;
  if (!(await appAnswers())) return null;

  const clinic = parseDemoCallClinic(input.profile);
  if (!clinic) return null;
  const context: DemoCallContext = {
    v: 1,
    slug: input.slug,
    mode: input.mode,
    firstName: input.firstName,
    issuedAt: Date.now(),
    clinic,
    offer: input.offer ? { percentOfSetupFee: input.offer.percentOfSetupFee, endsAt: input.offer.endsAt.getTime() } : null,
    test: input.test === true,
  };
  try {
    return { agentId, variables: { [DEMO_CALL_VARIABLE]: sealDemoCallContext(context, secret) } };
  } catch (error) {
    console.error("[healdesk] demo engine context not sealed; using the clinic demo agent", {
      slug: input.slug,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
