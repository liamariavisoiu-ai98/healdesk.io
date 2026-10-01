import { site } from "@/lib/site";

/**
 * AYA as the demo meets her: one agent, no specialty picked in advance.
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
  /**
   * Opens by saying she is an AI assistant, as the product must on every
   * channel (docs/v1-product-spec.md, "Guardrails"). The demo models the
   * disclosure a clinic cannot switch off.
   */
  greeting:
    `Hi. I'm ${site.agent}, healdesk's AI assistant: the front desk healdesk runs for clinics. ` +
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
   *
   * It follows the spec's call flow ("How a call runs"): the agent opens by
   * saying it is an AI assistant and that the call is transcribed, offers two
   * times rather than a list, holds the slot before saying anything
   * confirming, reads the number back digit by digit, and leaves the
   * confirmation to the clinic's own system. Nothing is texted or sent: voice
   * cannot send a link in v1.
   */
  voice: [
    {
      agent: true,
      text: `Thanks for calling. I'm ${site.agent}, the clinic's AI assistant, and this call is transcribed. How can I help?`,
    },
    { agent: false, text: "Hi. I'm calling about a consultation. How much is it?" },
    {
      agent: true,
      text: "The consult is complimentary and takes about half an hour. I have Tuesday at 4:00 or Thursday at 10:00. Which suits you?",
    },
    { agent: false, text: "Tuesday's good." },
    {
      agent: true,
      text: "I'm holding Tuesday at 4:00. Can I take your name and the best number to reach you?",
    },
    { agent: false, text: "Sam Rivera, 512 555 0142." },
    {
      agent: true,
      text: "That's 5-1-2, 5-5-5, 0-1-4-2. You're booked for a consultation on Tuesday at 4:00, and the clinic's system will send your confirmation.",
    },
  ] as const,
} as const;

export type DemoVoiceLine = (typeof DEMO_AGENT.voice)[number];
