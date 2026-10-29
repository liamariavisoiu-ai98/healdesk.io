import { CHANNELS, type Channel } from "@healdesk/catalog";

import { DIRECT_KIND_REGISTRY } from "@/lib/email/direct-kinds";
import { casesNotAskable } from "@/lib/engine/practice/cases";
import type { PracticeCaseId } from "@/lib/engine/practice/types";
import { NOTICE_KIND_REGISTRY } from "@/lib/email/kinds";
import { PENDING_TEMPLATES } from "@/lib/email/templates/registry";

/**
 * Gate B in code (plan, Gates table, "A channel goes live (Gate B)"): what
 * the gate asks that is a fact about the code rather than a person's word,
 * which platform_compliance holds (lib/compliance/subjects.ts). Each item
 * says whether it is built, read from the code where the code can say so,
 * and go-live names honestly what is not.
 *
 *   - **The practice questions**: go-live asks them per clinic and channel
 *     (app_channel_audit_ok), and they pass a channel on the cases they ask
 *     (lib/engine/practice). Built only once every case can be asked: the
 *     spec's "Pass means every case". Read off the case set
 *     (casesNotAskable), which is empty since 29 October 2026: the
 *     straightforward booking and the deposit booking, which could not be
 *     asked while the brain had no booking tools, are asked of the real tool
 *     layer over the practice engine, which writes nothing
 *     (lib/engine/practice/booking.ts), and checked per channel
 *     (checks.ts, bookingCaseChecks). The same commit bumped
 *     PRACTICE_CASES_VERSION, and a pass recorded while a case was not
 *     askable opens no channel: practiceQuestionsGate
 *     (store.ts, recordsAnUnaskedCase) and app_practice_gate_open
 *     (drizzle/0137) refuse a result that records one.
 *   - **The answer gate**: built (lib/billing/answering.ts), and called by
 *     each runtime that answers a patient: the Retell process
 *     (lib/voice/retell.ts), website chat (lib/chat/web-chat.ts) and the Meta
 *     webhook (app/api/webhooks/meta/route.ts, lib/meta/channels.ts);
 *     tests/go-live.test.ts reads each file for the call. A channel missing
 *     from ANSWER_GATE_CHANNELS could never meet Gate B.
 *   - **The routed/answered counter and its miss notice**: not built. The
 *     runtime's count of what was routed to AYA against what she answered,
 *     which L17, L18 and L21 wait on and no package builds yet
 *     (lib/email/templates/registry.ts, package `runtime`). Built once
 *     ROUTED_ANSWERED_COUNTER_BUILT says so and no template waits on the
 *     runtime.
 *   - **Annex X9's live set** (L1, L3, L4, L7 to L15, L17 to L21, L32, L34,
 *     E3 to E6): built once each of their kinds has a template; its kinds'
 *     own packages ship them.
 *
 * Gate B is fail-closed (the plan's Gates table), so whatever is not built
 * holds every clinic's go-live: `gateBNotBuilt()` is that list, go-live's
 * `gate_b_not_built` is its code, and the go-live view and /admin/compliance
 * name each item. Removing an item from the list is what opens go-live: the
 * runtime does it by building the counter and its templates, which sets
 * ROUTED_ANSWERED_COUNTER_BUILT and takes L17, L18 and L21 out of
 * PENDING_TEMPLATES, and in the same commit redefines
 * app_gate_b_code_built() (drizzle/0090), the database's copy of "the list
 * is empty", to true. tests/go-live.test.ts fails while the two disagree, so
 * neither opens without the other.
 */

/** The spec's own words for a case the runtime could not ask ("The pre-launch audit"), should one ever lose its check again. */
const CASE_WORDS: Partial<Record<PracticeCaseId, string>> = {
  booking: "a straightforward booking (the right slot held, the right booking written, the right confirmation said)",
  deposit_booking: "a booking for a deposit-required service (the clinic's deposit settings followed exactly)",
};

/** The runtimes that ask the answer gate before AYA answers. Every channel, today. */
export const ANSWER_GATE_CHANNELS: readonly Channel[] = ["web", "meta", "voice"];

/** Annex X9's live set, by catalogue id. */
export const LIVE_SET_ANNEX: readonly string[] = [
  "L1",
  "L3",
  "L4",
  "L7",
  "L8",
  "L9",
  "L10",
  "L11",
  "L12",
  "L13",
  "L14",
  "L15",
  "L17",
  "L18",
  "L19",
  "L20",
  "L21",
  "L32",
  "L34",
  "E3",
  "E4",
  "E5",
  "E6",
];

export type GateBCodeId =
  "practice_questions" | "answer_gate" | "routed_answered_counter" | "live_email_set";

export type GateBCodeItem = {
  id: GateBCodeId;
  label: string;
  built: boolean;
  /** Whether go-live asks it. Every item is asked: one not built holds go-live (`gate_b_not_built`). */
  checked: boolean;
  detail: string;
};

/** Each live-set kind whose template has not shipped, with its catalogue id and owning package. */
export function pendingLiveSet(): { kind: string; annex: string; package: string }[] {
  const pending = PENDING_TEMPLATES as Readonly<Record<string, { package: string }>>;
  const annexOf: Record<string, string> = {};
  for (const [kind, attrs] of Object.entries(NOTICE_KIND_REGISTRY)) annexOf[kind] = attrs.annex;
  for (const [kind, attrs] of Object.entries(DIRECT_KIND_REGISTRY)) annexOf[kind] = attrs.annex;
  return Object.entries(annexOf)
    .filter(([kind, annex]) => LIVE_SET_ANNEX.includes(annex) && pending[kind] !== undefined)
    .map(([kind, annex]) => ({ kind, annex, package: pending[kind]!.package }))
    .sort((a, b) => a.annex.localeCompare(b.annex, "en", { numeric: true }));
}

/**
 * The runtime's routed/answered counter exists: false until the commit that
 * builds it, which sets this beside its templates (see the header).
 */
export const ROUTED_ANSWERED_COUNTER_BUILT = false;

/** Whether the routed/answered counter exists: built, and no template still waits on the runtime for it. */
export function routedAnsweredCounterBuilt(): boolean {
  const pending = PENDING_TEMPLATES as Readonly<Record<string, { package: string }>>;
  return (
    ROUTED_ANSWERED_COUNTER_BUILT && !Object.values(pending).some((p) => p.package === "runtime")
  );
}

export function gateBInCode(): GateBCodeItem[] {
  const counter = routedAnsweredCounterBuilt();
  const live = pendingLiveSet();
  const gated = CHANNELS.every((c) => ANSWER_GATE_CHANNELS.includes(c));
  const unasked = casesNotAskable();
  return [
    {
      id: "practice_questions",
      label: "Practice questions passed",
      built: unasked.length === 0,
      checked: true,
      detail:
        unasked.length === 0
          ? "Every case is asked, the booking and deposit cases included, per clinic and channel: a channel goes live on the latest run's pass with nothing changed since, never on a pass from before every case could be asked."
          : `Not every case can be asked yet: ${unasked.map((id) => CASE_WORDS[id] ?? id).join("; and ")}. Every channel's cases include these, and pass means every case, so no clinic goes live on the practice questions until they can be asked.`,
    },
    {
      id: "answer_gate",
      label: "The answer gate",
      built: gated,
      checked: true,
      detail: gated
        ? "Called by phone, website chat and the Meta webhook before AYA answers anyone."
        : "A channel's runtime does not call it: that channel cannot go live.",
    },
    {
      id: "routed_answered_counter",
      label: "The routed/answered counter and its miss notice",
      built: counter,
      checked: true,
      detail: counter
        ? "Built, with its outage and miss notices."
        : "Not built: no package builds the runtime's count of what was routed to AYA against what she answered, which the outage notices and the guarantee's miss notice (L17, L18, L21) wait on. Gate B is fail-closed, so no clinic goes live until it is.",
    },
    {
      id: "live_email_set",
      label: "The live emails (Annex X9)",
      built: live.length === 0,
      checked: true,
      detail:
        live.length === 0
          ? "Every email of the live set has a template."
          : `Still without a template: ${live.map((p) => `${p.annex} (${p.kind}, ${p.package})`).join(", ")}. Gate B is fail-closed, so no clinic goes live until each has one.`,
    },
  ];
}

/**
 * What Gate B asks of the code and is not built, in the operator's words:
 * each line holds every clinic's go-live (`gate_b_not_built`) until it
 * leaves this list (see the header for how the runtime takes it off).
 */
export function gateBNotBuilt(): string[] {
  return gateBInCode()
    .filter((item) => !item.built)
    .map((item) => `${item.label}: ${item.detail}`);
}
