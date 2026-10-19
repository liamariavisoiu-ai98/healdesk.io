import { CHANNELS, type Channel } from "@healdesk/catalog";

import { DIRECT_KIND_REGISTRY } from "@/lib/email/direct-kinds";
import { NOTICE_KIND_REGISTRY } from "@/lib/email/kinds";
import { PENDING_TEMPLATES } from "@/lib/email/templates/registry";

/**
 * Gate B in code (plan, Gates table, "A channel goes live (Gate B)"): what
 * the gate asks that is a fact about the code rather than a person's word,
 * which platform_compliance holds (lib/compliance/subjects.ts). Each item
 * says whether it is built, read from the code where the code can say so,
 * and go-live names honestly what is not.
 *
 *   - **The practice questions**: built (lib/engine/practice); go-live asks
 *     them per clinic and channel (app_channel_audit_ok).
 *   - **The answer gate**: built (lib/billing/answering.ts), and called by
 *     each runtime that answers a patient: the Retell process
 *     (lib/voice/retell.ts), website chat (lib/chat/web-chat.ts) and the Meta
 *     webhook (app/api/webhooks/meta/route.ts, lib/meta/channels.ts);
 *     tests/go-live.test.ts reads each file for the call. A channel missing
 *     from ANSWER_GATE_CHANNELS could never meet Gate B.
 *   - **The routed/answered counter and its miss notice**: not built. The
 *     runtime's count of what was routed to AYA against what she answered,
 *     which L17, L18 and L21 wait on and no package builds yet
 *     (lib/email/templates/registry.ts, package `runtime`). Go-live asks it
 *     "where it exists" (the WP2 brief): until it exists it is named, not
 *     asked. Built, by this reading, once no template waits on the runtime.
 *   - **Annex X9's live set** (L1, L3, L4, L7 to L15, L17 to L21, L32, L34,
 *     E3 to E6): built once each of their kinds has a template. Named while
 *     one waits; its kinds' own packages ship them.
 *
 * Neither of the last two holds go-live back: they are listed beside it, on
 * the operator's go-live view and /admin/compliance, so whoever attests the
 * platform sees what is not built before they do.
 */

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
  /** Whether go-live asks it: a built item that is checked, or one named only. */
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

/** Whether the routed/answered counter exists: no template still waits on the runtime for it. */
export function routedAnsweredCounterBuilt(): boolean {
  const pending = PENDING_TEMPLATES as Readonly<Record<string, { package: string }>>;
  return !Object.values(pending).some((p) => p.package === "runtime");
}

export function gateBInCode(): GateBCodeItem[] {
  const counter = routedAnsweredCounterBuilt();
  const live = pendingLiveSet();
  const gated = CHANNELS.every((c) => ANSWER_GATE_CHANNELS.includes(c));
  return [
    {
      id: "practice_questions",
      label: "Practice questions passed",
      built: true,
      checked: true,
      detail:
        "Asked per clinic and channel: the latest run passed with nothing changed since, or an operator attested the channel.",
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
      checked: false,
      detail: counter
        ? "Built. Go-live does not ask it yet: ask it in the commit that wires its count into go-live."
        : "Not built: no package builds the runtime's count of what was routed to AYA against what she answered, which the outage notices and the guarantee's miss notice (L17, L18, L21) wait on. Go-live asks it where it exists, so it does not hold a clinic back; a first-month guarantee claim is checked by hand until it does.",
    },
    {
      id: "live_email_set",
      label: "The live emails (Annex X9)",
      built: live.length === 0,
      checked: false,
      detail:
        live.length === 0
          ? "Every email of the live set has a template."
          : `Still without a template: ${live.map((p) => `${p.annex} (${p.kind}, ${p.package})`).join(", ")}. Each is queued and held until its template ships; go-live does not wait on it.`,
    },
  ];
}

/** The operator's lines for what Gate B names and does not ask: every item not built. */
export function gateBNotBuilt(): string[] {
  return gateBInCode()
    .filter((item) => !item.built)
    .map((item) => `${item.label}: ${item.detail}`);
}
