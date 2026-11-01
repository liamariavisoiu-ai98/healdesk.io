import type { DemoCallClinic } from "@healdesk/catalog";

import { SPOKEN_END } from "@/lib/assistant/prompt";

/**
 * The made-up clinic the demo's tests call about, and how a scripted model
 * answers on a call: business data only, never a patient's.
 */
export const DEMO_CASE_CLINIC: DemoCallClinic = {
  clinicName: "Lumen Aesthetics",
  summary: "A boutique med spa in downtown Austin.",
  specialty: "med-spa",
  phone: "+15125550100",
  address: "200 Congress Ave, Austin, TX 78701",
  hours: [{ days: "Mon-Fri", hours: "9am-6pm" }],
  services: [
    { name: "Botox", description: null, price: "$12/unit", duration: "30 min" },
    { name: "HydraFacial", description: null, price: "$199", duration: "1 hour" },
    { name: "Lip Filler", description: null, price: "from $650", duration: null },
  ],
  providers: [{ name: "Dr. Maya Chen", title: "Medical Director" }],
  faqs: [],
  policies: ["24-hour cancellation policy."],
  booking: "Book online or by phone.",
  highlights: ["Voted best med spa in Austin"],
};

/** What the model writes on a call: the words, the delimiter, then the details with her state (the booking so far). */
export function modelSays(
  words: string,
  state: { booking?: { service?: string; day?: string; time?: string; name?: string; phone?: string; status?: "requested" | "rescheduled" | "cancelled" }; end?: boolean } | null = {},
): string {
  const details: Record<string, unknown> = { handoff: false, end: state?.end === true };
  if (state?.booking) details.state = { booking: state.booking };
  return `${words}\n${SPOKEN_END}\n${JSON.stringify(details)}`;
}
