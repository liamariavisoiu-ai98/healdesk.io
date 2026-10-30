import { describe, expect, test } from "vitest";

import { SUPPORT_PORTAL_WORDS } from "@healdesk/catalog";

import {
  CHECK_IDS,
  CHECK_RULES,
  EMAIL_CHECK_ID,
  EMAIL_RUN_WORDS,
  factTokens,
  quotesEmail,
  failedCheckIds,
  runReplyChecks,
  sentenceSpans,
  type FactsUsed,
  type ReplyCheckInput,
  type ToolResult,
} from "@/lib/support/draft/checks";
import { SCREEN_TARGETS, SETTING_PLACES, SETTINGS_CARD_TITLES } from "@/lib/support/targets";

/**
 * The eight reply checks (design E5 §6; lane P7b), pure. Each check fails on
 * its own named violation and passes on a clean reply; "send" runs checks 2
 * to 8 only; and no result ever carries the reply's words.
 */

const CLINIC_ID = "4b0f3c1e-8d2a-4c55-9e61-0a7b3c2d1e0f";
const OTHER_CLINIC = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const REF = "7F3KQ";

const TOOLS: ToolResult[] = [
  {
    tool: "get_account_state",
    text: [
      "The account:",
      "- Practice: Lumen Aesthetics",
      "- Channel: Phone: ready on healdesk's side, waiting on the practice",
      "- Google Calendar: broken: bookings arrive as requests until it is reconnected",
      "- Package: AYA Voice + Web Chat",
      "- Used this period: Voice minutes: 120 of 500",
      "- Direct line: (512) 555-0142",
    ].join("\n"),
  },
  {
    tool: "get_case_history",
    text: "This case: HD-7F3KQ, opened Tuesday 27 October 2026; reply by Wednesday 28 October 2026 (2026-10-28).",
  },
  {
    tool: "get_clinic_signals",
    text: "Billing: 2026-10-20 past_due to active (invoice.paid)",
  },
];

const FACTS: FactsUsed[] = [
  { tool: "get_case_history", field: "reply_by", value: "Wednesday 28 October 2026" },
  { tool: "get_account_state", field: "package", value: "AYA Voice + Web Chat" },
  { tool: "get_account_state", field: "usage.voice_minutes", value: "120 of 500" },
];

const CLEAN =
  "Hi, your Google Calendar connection needs reconnecting, so since then every booking has come to you as a request and nothing is lost. Reconnect it in Settings → Calendar with one Google sign-in. Your AYA Voice + Web Chat package has used 120 of 500 voice minutes this period. If it won't connect, reply here and a person at healdesk will call you by Wednesday.";

function input(over: Partial<ReplyCheckInput> = {}): ReplyCheckInput {
  return {
    text: CLEAN,
    clinicName: "Lumen Aesthetics",
    facts: FACTS,
    toolResults: TOOLS,
    ownCaseRef: REF,
    mode: "draft",
    clinicId: CLINIC_ID,
    portalOrigin: "https://app.healdesk.io",
    allowNumbers: ["+15125550142"],
    ...over,
  };
}

function failed(over: Partial<ReplyCheckInput>): string[] {
  return failedCheckIds(runReplyChecks(input(over)));
}

describe("runReplyChecks", () => {
  test("a clean reply passes all eight, in order, each with its fixed rule", () => {
    const checks = runReplyChecks(input());
    expect(checks.results.map((r) => r.id)).toEqual([...CHECK_IDS]);
    expect(checks.results.filter((r) => !r.ok)).toEqual([]);
    expect(checks.ok).toBe(true);
    for (const r of checks.results) expect(r.rule).toBe(CHECK_RULES[r.id]);
  });

  test('"send" runs checks 2 to 8 only: the facts are not held to a run', () => {
    const checks = runReplyChecks(input({ mode: "send", facts: [], toolResults: undefined }));
    expect(checks.results.map((r) => r.id)).toEqual(CHECK_IDS.filter((id) => id !== "facts"));
    expect(checks.ok).toBe(true);
    // The same text in draft mode, with no facts, fails check 1 only.
    expect(failed({ facts: [], toolResults: [] })).toEqual(["facts"]);
  });

  test("no result carries the reply's words, only the rule and offsets", () => {
    const secret = "Hi Dana, we'll refund the $123.45 on Friday 30 October! See https://evil.example.com and call 212 555 0199.";
    const checks = runReplyChecks(input({ text: secret }));
    const serialised = JSON.stringify(checks);
    for (const word of ["Dana", "123", "evil", "0199", "Friday", "October"]) {
      expect(serialised).not.toContain(word);
    }
    for (const r of checks.results) {
      expect(Object.keys(r).sort()).toEqual(r.spans ? ["id", "ok", "rule", "spans"] : ["id", "ok", "rule"]);
    }
  });

  describe("1. facts", () => {
    test("an invented date fails, and its sentence is marked", () => {
      const text = `${CLEAN} We will look at it on 3 November.`;
      const checks = runReplyChecks(input({ text }));
      const facts = checks.results.find((r) => r.id === "facts")!;
      expect(facts.ok).toBe(false);
      expect(facts.spans).toHaveLength(1);
      const span = facts.spans![0]!;
      expect(text.slice(span.start, span.end)).toBe("We will look at it on 3 November.");
    });

    test("an invented day name, amount, percent, count, package, phone number or link fails", () => {
      for (const extra of [
        "A person will call on Friday.",
        "The invoice was $259.",
        "That is 20% of the allowance.",
        "You have 3 steps left.",
        "Moving to AYA Meta Chat would help.",
        "Call us on (415) 555-0100.",
        "See https://app.healdesk.io/c/lumen/settings for it.",
        "We can talk at 3pm.",
        "It started in March.",
      ]) {
        expect(failed({ text: `${CLEAN.split(". ").slice(0, 2).join(". ")}. ${extra}` }), extra).toContain("facts");
      }
    });

    test("a fact the model claims but no tool returned fails, though the reply quotes it", () => {
      const facts = [...FACTS, { tool: "get_account_state", field: "setup_fee", value: "$697" }];
      expect(failed({ text: `${CLEAN.slice(0, -1)}; the setup fee was $697.`, facts })).toEqual(["facts"]);
    });

    test("a fact is held to its own tool's result, not another's", () => {
      const facts: FactsUsed[] = [{ tool: "get_account_state", field: "reply_by", value: "Wednesday 28 October 2026" }];
      expect(failed({ text: "A person will reply by Wednesday.", facts })).toEqual(["facts"]);
    });

    test("a date written another way than the fact still matches: weekday and day-month, from an ISO fact", () => {
      const facts: FactsUsed[] = [{ tool: "get_case_history", field: "reply_by", value: "2026-10-28" }];
      for (const text of ["A person will reply by Wednesday.", "A person will reply by 28 October.", "A person will reply by October 28th."]) {
        expect(failed({ text, facts }), text).toEqual([]);
      }
    });

    test("the case's own ref and a numbered step's marker are not facts", () => {
      const text = "Your request is HD-7F3KQ.\n1. Open Settings → Calendar.\n2. Reconnect with Google.";
      expect(failed({ text, facts: [] })).toEqual([]);
    });

    test("the tokens it reads, for the record", () => {
      expect(factTokens("By Wednesday 28 October, $1,500 and 20% of 3; call (512) 555-0142.").map((t) => t.key)).toEqual([
        "phone:5125550142",
        "date:10-28",
        "day:wednesday",
        "usd:150000",
        "pct:20",
        "num:3",
      ]);
      // "May" and "sat" are words, not dates.
      expect(factTokens("You may reconnect it; it sat idle.").map((t) => t.key)).toEqual([]);
    });
  });

  describe("2. screen", () => {
    test("a stranger's number fails; the practice's own number passes", () => {
      const facts = [...FACTS, { tool: "get_account_state", field: "direct_line", value: "(512) 555-0142" }];
      expect(failed({ text: "Calls go to your direct line (512) 555-0142.", facts })).toEqual([]);
      const stranger = [...FACTS, { tool: "get_account_state", field: "x", value: "(415) 555-0100" }];
      const tools = [...TOOLS, { tool: "get_account_state", text: "(415) 555-0100" }];
      expect(failed({ text: "Call (415) 555-0100.", facts: stranger, toolResults: tools })).toEqual(["screen"]);
    });

    test("a stranger's email address and a treatment name fail; healdesk's own address passes", () => {
      expect(failed({ text: "Write to dana@example.com about it." })).toContain("screen");
      expect(failed({ text: "Your Botox price is in Knowledge." })).toContain("screen");
      expect(failed({ text: "Write to hello@healdesk.io about it." })).toEqual([]);
    });

    test("the practice's own service names are hidden too", () => {
      expect(failed({ text: "Your Signature Glow Facial is listed.", serviceNames: ["Signature Glow Facial"] })).toContain("screen");
    });
  });

  describe("3. names", () => {
    test("an invented name fails, the greeting included", () => {
      expect(failed({ text: "Hi Dana, the calendar needs reconnecting." })).toEqual(["names"]);
      expect(failed({ text: "Our colleague Priya will look at it." })).toEqual(["names"]);
    });

    test("products, vendors, carriers, portal places, days, months, the practice and sentence starts pass", () => {
      const text =
        "Lumen Aesthetics is set up for Verizon and T-Mobile lines. AYA's codes are in Settings → Channels, and Instagram, Messenger and WhatsApp connect there. I'll check Knowledge → Hours. Stripe holds the card.";
      expect(failed({ text, facts: [] })).toEqual([]);
    });

    test("a name the caller allows passes", () => {
      expect(failed({ text: "Hi Dana, the calendar needs reconnecting.", allowNames: ["Dana"] })).toEqual([]);
    });

    test("every capitalised word of the portal's screens, cards and switches is in the allow list", () => {
      const allow = new Set(SUPPORT_PORTAL_WORDS.map((w) => w.toLowerCase()));
      const labels = [
        ...Object.values(SCREEN_TARGETS).map((t) => t.label),
        ...Object.values(SETTINGS_CARD_TITLES),
        ...Object.values(SETTING_PLACES).map((p) => p.label),
      ];
      // A label's first word is a sentence start wherever a reply quotes it.
      const words = labels.flatMap((l) => l.split(/[^\p{L}-]+/u).filter(Boolean).slice(1)).filter((w) => /^\p{Lu}/u.test(w));
      const known = new Set(["aya", "google", "calendar", "instagram", "messenger", "whatsapp", "phone", "website"]);
      const missing = [...new Set(words)].filter((w) => !allow.has(w.toLowerCase()) && !known.has(w.toLowerCase()));
      expect(missing).toEqual([]);
    });
  });

  describe("4. clinical", () => {
    test("clinical advice fails", () => {
      expect(failed({ text: "It is safe during pregnancy." })).toContain("clinical");
      expect(failed({ text: "Side effects are rare." })).toContain("clinical");
    });
  });

  describe("5. promises", () => {
    test("each promise fails without a billing record", () => {
      for (const text of [
        "We will refund the charge.",
        "We'll add a credit to your account.",
        "The next step is free.",
        "We guarantee it works.",
        "We'll waive the fee.",
        "You'll be live by then.",
        "Phone will be live on the day.",
        "A person replies within 24 hours.",
      ]) {
        expect(failed({ text, facts: [] }), text).toContain("promises");
      }
    });

    test("a refund the billing record shows may be told", () => {
      const facts: FactsUsed[] = [{ tool: "get_clinic_signals", field: "billing.transition", value: "refund issued" }];
      const tools: ToolResult[] = [{ tool: "get_clinic_signals", text: "Billing: refund issued" }];
      expect(failed({ text: "The refund is on its way back to your card.", facts, toolResults: tools })).toEqual([]);
    });

    test("go-live as a step, not a date, passes", () => {
      expect(failed({ text: "WhatsApp goes live once the payment method is added in Meta.", facts: [] })).toEqual([]);
    });
  });

  describe("6. claims", () => {
    test("the banned claims fail; deposits collected passes", () => {
      expect(failed({ text: "We handle that under HIPAA compliance rules." })).toContain("claims");
      expect(failed({ text: "AYA booked the calls that were recovered.", facts: [] })).toContain("claims");
      expect(failed({ text: "Payments were collected by AYA.", facts: [] })).toContain("claims");
      expect(failed({ text: "Deposits collected show in Bookings.", facts: [] })).toEqual([]);
    });

    test("a price the catalog does not have fails, even when a tool returned it", () => {
      const facts: FactsUsed[] = [{ tool: "get_account_state", field: "x", value: "$123.45" }];
      const tools: ToolResult[] = [{ tool: "get_account_state", text: "$123.45" }];
      expect(failed({ text: "The charge was $123.45.", facts, toolResults: tools })).toEqual(["claims"]);
      const fee: FactsUsed[] = [{ tool: "get_account_state", field: "x", value: "$259" }];
      expect(failed({ text: "The setup fee was $259.", facts: fee, toolResults: [{ tool: "get_account_state", text: "$259" }] })).toEqual([]);
    });

    test("the agreement is the one the practice signed", () => {
      expect(failed({ text: "Your data protection agreement covers it.", facts: [], agreementKind: null })).toEqual(["claims"]);
      expect(failed({ text: "Your business associate agreement covers it.", facts: [], agreementKind: "dpa" })).toEqual(["claims"]);
      expect(failed({ text: "Your business associate agreement covers it.", facts: [], agreementKind: "baa" })).toEqual([]);
    });
  });

  describe("7. shape", () => {
    test("an exclamation mark, an emoji or a banned phrase fails: the tone lint is reused", () => {
      expect(failed({ text: "The calendar is reconnected!", facts: [] })).toEqual(["shape"]);
      expect(failed({ text: "The calendar is reconnected 🙂", facts: [] })).toEqual(["shape"]);
      expect(failed({ text: "Unfortunately the calendar is off.", facts: [] })).toEqual(["shape"]);
    });

    test("seven sentences, over 900 characters or two questions fail", () => {
      const seven = Array.from({ length: 7 }, () => "The calendar is off.").join(" ");
      expect(failed({ text: seven, facts: [] })).toEqual(["shape"]);
      expect(failed({ text: `${"The calendar is off and ".repeat(40)}done.`, facts: [] })).toEqual(["shape"]);
      expect(failed({ text: "Is it off? Is it on?", facts: [] })).toEqual(["shape"]);
      expect(failed({ text: "Is the calendar off?", facts: [] })).toEqual([]);
    });

    test("one link to the portal passes; a second link, or one anywhere else, fails", () => {
      const portal = "https://app.healdesk.io/c/lumen/settings";
      const facts: FactsUsed[] = [{ tool: "get_account_state", field: "link", value: portal }];
      const tools: ToolResult[] = [{ tool: "get_account_state", text: portal }];
      expect(failed({ text: `Reconnect it at ${portal} today.`, facts, toolResults: tools })).toEqual([]);
      expect(failed({ text: `Reconnect it at ${portal} or ${portal}.`, facts, toolResults: tools })).toEqual(["shape"]);
      const other = "https://example.com/x";
      expect(
        failed({ text: `See ${other} today.`, facts: [{ tool: "t", field: "f", value: other }], toolResults: [{ tool: "t", text: other }] }),
      ).toEqual(["shape"]);
      expect(failed({ text: `Reconnect it at ${portal} today.`, facts, toolResults: tools, portalOrigin: null })).toEqual(["shape"]);
    });

    test("markdown fails; numbered steps pass", () => {
      expect(failed({ text: "**Reconnect** the calendar.", facts: [] })).toEqual(["shape"]);
      expect(failed({ text: "- Reconnect the calendar.", facts: [] })).toEqual(["shape"]);
      expect(failed({ text: "## Calendar\nReconnect it.", facts: [] })).toEqual(["shape"]);
      expect(failed({ text: "1. Open Settings.\n2. Reconnect.", facts: [] })).toEqual([]);
    });

    test("the sign-off our template adds is not counted, and an empty reply never passes", () => {
      expect(failed({ text: `${CLEAN}\n\nThe Healdesk Team` })).toEqual([]);
      expect(failed({ text: "   ", facts: [] })).toEqual(["shape"]);
    });
  });

  describe("8. other clinics", () => {
    test("another clinic's uuid, another case's ref or another clinic's name fails", () => {
      expect(failed({ text: `Your account ${CLINIC_ID} is fine.`, facts: [] })).toEqual([]);
      expect(failed({ text: `Your account ${OTHER_CLINIC} is fine.`, facts: [] })).toEqual(["other_clinics"]);
      expect(failed({ text: "This is about HD-9ZZZZ.", facts: [] })).toEqual(["other_clinics"]);
      expect(failed({ text: "This is about HD-7F3KQ.", facts: [] })).toEqual([]);
      expect(
        failed({ text: "Like at Harbor Dental, it reconnects.", facts: [], otherClinicNames: ["Harbor Dental"], allowNames: ["Harbor", "Dental"] }),
      ).toEqual(["other_clinics"]);
    });

    test("a case whose own ref begins with HD is still its own, given bare (the drafter) or printed (the send)", () => {
      for (const ownCaseRef of ["HD7F3", "HD-HD7F3"]) {
        expect(failed({ text: "This is about HD-HD7F3.", facts: [], ownCaseRef })).toEqual([]);
        expect(failed({ text: "This is about HD-9ZZZZ.", facts: [], ownCaseRef })).toEqual(["other_clinics"]);
      }
    });
  });
});

describe("sentenceSpans", () => {
  test("ends at . ? ! and a line break; a domain, a price or a step's number is not an end", () => {
    const text = "Write to hello@healdesk.io today. It is $1.50? Yes\n1. Open it.";
    expect(sentenceSpans(text).map((s) => text.slice(s.start, s.end))).toEqual([
      "Write to hello@healdesk.io today.",
      "It is $1.50?",
      "Yes",
      "1. Open it.",
    ]);
  });
});

describe("the email check (lane P7h): a draft written from an email quotes no long run of it", () => {
  const EMAIL = "Since this morning our calls ring out and nobody answers the phone at the front desk. Can you check the forwarding?";

  test("five words in a row from the email fail it; four do not; case, accents and punctuation do not hide a quote", () => {
    expect(EMAIL_RUN_WORDS).toBe(5);
    expect(quotesEmail("You wrote that since this morning our calls ring out.", EMAIL)).toBe(true);
    expect(quotesEmail("SINCE this morning, our -- calls.", EMAIL)).toBe(true);
    expect(quotesEmail("Since this morning our team checked the forwarding.", EMAIL)).toBe(false);
    expect(quotesEmail("Hi, a person at healdesk will reply with the next step by Wednesday.", EMAIL)).toBe(false);
  });

  test("a draft from an email: a name the email used mid-sentence fails the names check at a sentence's start too, and a fact's field must be a label its tool printed", () => {
    const email = "Our patient Maria Lopez says the calls ring out.";
    const base: ReplyCheckInput = { text: "Maria will hear from us by Wednesday.", clinicName: "Lumen Aesthetics", facts: [], ownCaseRef: REF, mode: "send" };
    // Without the email, a sentence's first word is let through, as before.
    expect(runReplyChecks(base).results.find((r) => r.id === "names")!.ok).toBe(true);
    expect(runReplyChecks({ ...base, mode: "draft", emailText: email }).results.find((r) => r.id === "names")!.ok).toBe(false);
    // A sentence-start word the email used only to start a sentence is still fine.
    expect(runReplyChecks({ ...base, text: "Our team will check the forwarding.", mode: "draft", emailText: email }).results.find((r) => r.id === "names")!.ok).toBe(true);

    const tools: ToolResult[] = [{ tool: "get_case_history", text: "- A person replies by: Wednesday 28 October 2026" }];
    const fact = { tool: "get_case_history", field: "A person replies by", value: "Wednesday 28 October 2026" };
    const reply = { ...base, text: "A person replies by Wednesday.", mode: "draft" as const, toolResults: tools, emailText: email };
    expect(runReplyChecks({ ...reply, facts: [fact] }).results.find((r) => r.id === "facts")!.ok).toBe(true);
    expect(runReplyChecks({ ...reply, facts: [{ ...fact, field: "Maria Lopez bruising" }] }).results.find((r) => r.id === "facts")!.ok).toBe(false);
    // Without an email the field is free, as before.
    expect(runReplyChecks({ ...reply, emailText: null, facts: [{ ...fact, field: "anything" }] }).results.find((r) => r.id === "facts")!.ok).toBe(true);
  });

  test("it runs only on a draft given the email, after the eight, and its result names the rule, never the words", () => {
    const base: ReplyCheckInput = { text: "Since this morning our calls ring out and nobody answers, we know.", clinicName: "Lumen Aesthetics", facts: [], ownCaseRef: REF, mode: "draft" };
    expect(runReplyChecks(base).results.map((r) => r.id)).toEqual([...CHECK_IDS]);
    const withEmail = runReplyChecks({ ...base, emailText: EMAIL });
    expect(withEmail.results.map((r) => r.id)).toEqual([...CHECK_IDS, EMAIL_CHECK_ID]);
    const result = withEmail.results.find((r) => r.id === EMAIL_CHECK_ID)!;
    expect(result).toEqual({ id: EMAIL_CHECK_ID, ok: false, rule: CHECK_RULES[EMAIL_CHECK_ID] });
    expect(failedCheckIds(withEmail)).toContain(EMAIL_CHECK_ID);
    // Send never has the email: the check is not run there.
    expect(runReplyChecks({ ...base, mode: "send", emailText: EMAIL }).results.map((r) => r.id)).not.toContain(EMAIL_CHECK_ID);
  });
});
