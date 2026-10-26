import { urgencyFor } from "../case-vocab";
import type { SupportCaseUrgency } from "../case-vocab";
import { ESCALATION_TOPICS, type EscalationTopic } from "../escalation-fields";

/**
 * Triage for an inbound email (lane P7g; design E5 §2.1, "Triage"): a
 * deterministic keyword classifier over the subject and the body, in memory.
 * No model reads the email (the owner's rule: facts only, and the drafter is
 * given the case's fields, never a clinic's words), so this is fixed lists
 * and nothing else, and the same mail always reads the same way.
 *
 * Each topic and symptom has a list of words and phrases; a topic scores one
 * point per phrase found (a phrase in the subject counts twice), the highest
 * score wins, and a tie goes to the topic earlier in TOPIC_ORDER, which puts
 * what costs the clinic calls first. No phrase at all is topic `other`. The
 * symptom is the first of the winning topic's symptoms whose phrases are
 * found, else `other`. Urgency is the chat's rule for the pair
 * (case-vocab.ts urgencyFor), raised to `now` for anything about security
 * (a hacked account, a stranger's sign-in, a lost or stolen device, a
 * suspected breach), which E5 lists with the urgent topics.
 *
 * Lines quoting an earlier email ("> ...", and everything after "On ... wrote:")
 * are left out, so our own words quoted back do not decide a clinic's topic.
 */

export type Classification = {
  topic: EscalationTopic;
  symptom: string;
  urgency: SupportCaseUrgency;
  /** Whether a security phrase raised it to `now`. */
  security: boolean;
};

type Phrases = readonly string[];

/** Most costly first: the tie-break order. */
export const TOPIC_ORDER: readonly EscalationTopic[] = [
  "forwarding",
  "channel",
  "calendar",
  "sign_in",
  "billing",
  "transcript",
  "plan",
  "other",
];

export const TOPIC_PHRASES: Readonly<Record<Exclude<EscalationTopic, "other">, Phrases>> = {
  forwarding: [
    "forwarding",
    "forward calls",
    "forwarded calls",
    "call forward",
    "calls ring",
    "ringing out",
    "rings out",
    "not answering",
    "isn't answering",
    "not picking up",
    "missed calls",
    "phone line",
    "carrier",
    "caller id",
    "voicemail",
    "aya isn't answering",
    "aya is not answering",
    "calls aren't",
    "calls are not",
    "nobody answers",
  ],
  channel: [
    "website chat",
    "web chat",
    "chat widget",
    "snippet",
    "instagram",
    "messenger",
    "facebook",
    "whatsapp",
    "not live",
    "go live",
    "answers wrong",
    "wrong answer",
    "said the wrong",
  ],
  calendar: [
    "calendar",
    "google calendar",
    "booking",
    "bookings",
    "appointment",
    "double booked",
    "double-booked",
    "availability",
  ],
  sign_in: [
    "sign in",
    "sign-in",
    "signin",
    "log in",
    "login",
    "passkey",
    "authenticator",
    "two-factor",
    "2fa",
    "locked out",
    "magic link",
    "sign-in link",
    "lost my phone",
    "lost phone",
    "stolen",
    "left the practice",
    "left the clinic",
    "signed in",
    "logged in",
    "hacked",
    "password",
  ],
  billing: [
    "invoice",
    "billing",
    "billed",
    "charge",
    "charged",
    "refund",
    "payment",
    "card",
    "receipt",
    "dispute",
    "overcharged",
  ],
  transcript: ["transcript", "transcripts", "call summary", "conversation summary"],
  plan: [
    "upgrade",
    "downgrade",
    "change plan",
    "change my plan",
    "our plan",
    "more minutes",
    "fewer minutes",
    "add a location",
    "another location",
    "add a channel",
    "cancel",
    "cancellation",
  ],
};

/** Each topic's symptoms in the order they are tried; `other` is the fallback and has none. */
export const SYMPTOM_PHRASES: Readonly<Record<EscalationTopic, Readonly<Record<string, Phrases>>>> = {
  forwarding: {
    calls_ring_out: ["ring out", "rings out", "ringing out", "ring and ring", "nobody answers", "no one answers"],
    calls_not_reaching_aya: ["not answering", "isn't answering", "not reaching", "aren't reaching", "not picking up", "calls aren't", "calls are not"],
    staff_not_getting_calls: ["staff aren't getting", "staff are not getting", "front desk isn't getting", "we don't get the calls"],
    caller_id_shows_own_number: ["caller id", "our own number", "shows our number"],
    codes_not_working: ["code", "codes", "*72", "*73", "star code"],
    undo_forwarding: ["undo", "turn off forwarding", "stop forwarding", "remove forwarding"],
  },
  calendar: {
    wont_connect: ["won't connect", "will not connect", "can't connect", "cannot connect"],
    disconnected: ["disconnected", "disconnect"],
    bookings_missing: ["missing", "not showing", "don't show", "doesn't show", "not appearing"],
    wrong_calendar: ["wrong calendar"],
  },
  channel: {
    website_line_not_working: ["website chat", "web chat", "chat widget", "snippet"],
    meta_wont_connect: ["instagram", "messenger", "facebook"],
    whatsapp_payment_method: ["whatsapp"],
    answers_wrong: ["answers wrong", "wrong answer", "said the wrong", "told a patient", "told a client"],
    not_live_yet: ["not live", "go live", "isn't live"],
  },
  plan: {
    cancel: ["cancel", "cancellation"],
    move_up_a_step: ["upgrade", "more minutes", "more conversations", "move up"],
    move_down_a_step: ["downgrade", "fewer minutes", "fewer conversations", "move down"],
    add_a_channel: ["add a channel", "add instagram", "add whatsapp", "add web chat", "add voice"],
    add_a_location: ["add a location", "another location", "second location"],
  },
  billing: {
    payment_failed: ["payment failed", "declined", "failed payment", "couldn't pay"],
    refund_question: ["refund"],
    card_change: ["change card", "new card", "update card", "card change", "change the card"],
    invoice_question: ["invoice", "charge", "charged", "billed", "dispute", "overcharged", "receipt"],
  },
  transcript: {
    send_again_failed: ["send again", "resend", "re-send"],
    not_received: ["didn't get", "did not get", "didn't receive", "not received", "never arrived", "missing"],
  },
  sign_in: {
    lost_device: ["lost my phone", "lost phone", "lost device", "stolen", "left the practice", "left the clinic", "no longer works here"],
    passkey_problem: ["passkey"],
    authenticator_problem: ["authenticator", "two-factor", "2fa"],
    sign_in_link_not_arriving: ["link", "magic link", "didn't get the email", "no email"],
  },
  other: {},
};

/** Anything about security: `now`, whatever the topic (E5 §2.1). */
export const SECURITY_PHRASES: Phrases = [
  "hacked",
  "hack",
  "breach",
  "phishing",
  "compromised",
  "suspicious",
  "unauthorized",
  "unauthorised",
  "someone else signed in",
  "someone logged in",
  "stolen",
  "lost my phone",
  "lost phone",
  "lost device",
  "security",
];

/** A charge in question is `now` too (E5 §2.1), whatever symptom the lists found. */
export const DISPUTE_PHRASES: Phrases = ["dispute", "disputed", "chargeback", "charged twice", "double charged", "overcharged", "unauthorized charge"];

/** The body without the lines that quote an earlier email. */
export function ownLines(body: string): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*On .{0,200} wrote:\s*$/i.test(line) || /^-{2,}\s*(original|forwarded) message\s*-{2,}/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n");
}

function normalise(text: string): string {
  return ` ${text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9*'\-]+/g, " ")} `;
}

function has(text: string, phrase: string): boolean {
  return text.includes(` ${normalise(phrase).trim()} `);
}

function count(text: string, phrases: Phrases): number {
  return phrases.reduce((n, p) => n + (has(text, p) ? 1 : 0), 0);
}

/** Classify one email by its subject and body. Pure. */
export function classifyEmail(subject: string, body: string): Classification {
  const s = normalise(subject);
  const b = normalise(ownLines(body));
  let topic: EscalationTopic = "other";
  let best = 0;
  for (const t of TOPIC_ORDER) {
    if (t === "other") continue;
    const score = 2 * count(s, TOPIC_PHRASES[t]) + count(b, TOPIC_PHRASES[t]);
    if (score > best) {
      best = score;
      topic = t;
    }
  }
  let symptom = "other";
  for (const [id, phrases] of Object.entries(SYMPTOM_PHRASES[topic])) {
    if (!(id in ESCALATION_TOPICS[topic].symptoms)) continue;
    if (count(s, phrases) + count(b, phrases) > 0) {
      symptom = id;
      break;
    }
  }
  const security = count(s, SECURITY_PHRASES) + count(b, SECURITY_PHRASES) > 0;
  const dispute = count(s, DISPUTE_PHRASES) + count(b, DISPUTE_PHRASES) > 0;
  const urgency: SupportCaseUrgency = security || dispute ? "now" : urgencyFor(topic, symptom);
  return { topic, symptom, urgency, security };
}
