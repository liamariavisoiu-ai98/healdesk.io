import { site } from "@/lib/site";

/**
 * AVA as the demo meets her: one agent, no specialty picked in advance.
 *
 * ## Why the picker went away
 *
 * The demo used to make the visitor choose a specialty before either panel
 * would say anything, which contradicted the product it was demonstrating. The
 * knowledge tree's own design note says it plainly: a visitor does not arrive
 * pre-sorted, and the whole reason there is one agent with a deepening tree
 * rather than six separate bots is that "we mostly do weight loss now" has to
 * be a turn in the conversation instead of a dead end.
 *
 * A picker in front of the chat also demonstrated the wrong capability. It told
 * a clinic owner that healdesk is configured per vertical and that they were
 * about to see the vertical they clicked. What actually ships is an agent that
 * works out who it is talking to and goes deeper as it learns, so the demo now
 * starts where a real conversation starts, at the root of the tree.
 *
 * The specialty reel further down the page is unchanged in what it claims: it
 * is the list of phones this one agent knows, not six agents to choose from.
 */

export const DEMO_AGENT = {
  greeting:
    `Hi. I'm ${site.agent}, the front desk healdesk runs for clinics. ` +
    "Med spas, surgery, fertility, dental, derm, weight loss. I answer for " +
    "all of them, and I work out which one I'm on from the call. Ask me " +
    "anything a patient would ask, or anything you'd ask a supplier.",

  /**
   * Two operator questions and one compliance question.
   *
   * Deliberately NOT "how much is Botox?" any more. With no specialty selected
   * the interesting demonstration is not that she knows one price list, it is
   * that she picks up the specialty from what the visitor says, so the first
   * chip hands her one and lets her prove it.
   */
  chips: [
    "I run a med spa, what would you say to my callers?",
    "Can you book into my calendar?",
    // Deliberately "how do you handle patient data", not "are you HIPAA
    // compliant". No body certifies HIPAA compliance, so the second phrasing
    // invites an answer asserting a verification nobody performed, the theory
    // the FTC charged as a standalone deception count in SkyMed.
    "How do you handle patient data?",
  ] as const,

  /**
   * The scripted inbound call, written specialty-neutral.
   *
   * It has to read as a real call at any clinic on the reel below, so it turns
   * on the one thing every one of them shares: a stranger asking what the first
   * appointment costs, and leaving with it booked.
   */
  voice: [
    { agent: false, text: "Hi. I'm calling about a consultation. How much is it?" },
    {
      agent: true,
      text: "The consult is complimentary and runs about half an hour with one of our clinicians. I have Tuesday at 4:00 or Thursday morning, which suits you better?",
    },
    { agent: false, text: "Tuesday's good." },
    {
      agent: true,
      text: "Booked. Can I take your name and the best number to reach you? I'll text the intake form over so there's nothing to fill in when you arrive.",
    },
  ] as const,
} as const;

export type DemoVoiceLine = (typeof DEMO_AGENT.voice)[number];
