import type { Audience } from "@healdesk/catalog";

import type { ClinicProfile } from "./profile";

/**
 * What a personalised demo could not find about the clinic, from one fixed
 * list of what a front desk gets asked (owner, 29 October 2026: "there should
 * be a little note that says what it couldnt find publicly and let the owner
 * know when trying the demo, so he understands this is not the final
 * product").
 *
 * Worked out in code from the finished profile, never by a model, so the note
 * always matches what the demo actually knows: the page shows it, the chat
 * and the voice read it in the clinic information (profileToKnowledge), and
 * the audit is shown it to check against the website (lib/demo/audit.ts).
 *
 * It says what the demo could not find, never what the website lacks: the
 * reader can miss what a site has (a menu in an image, a page it did not
 * reach), and "your website has no prices" would then be false.
 */

export type DemoGap = "treatments" | "prices" | "some-prices" | "hours" | "address" | "phone" | "team" | "booking" | "policy";

/** In the order the note lists them. */
const ORDER: readonly DemoGap[] = ["treatments", "prices", "some-prices", "hours", "address", "phone", "team", "booking", "policy"];

/** A cancellation, deposit or no-show rule somewhere the demo can read it. */
const POLICY = /\b(cancel|cancell?ation|deposit|no[\s-]?show|late (?:arrival|fee)|reschedul)/i;

/** A price with a figure in it ("$450", "from $12/unit"), or a free one ("complimentary consultation"). */
function isPriced(price: string | null): boolean {
  return Boolean(price && (/\d/.test(price) || /\b(free|complimentary|no charge)\b/i.test(price)));
}

export function demoGaps(profile: ClinicProfile): DemoGap[] {
  const gaps = new Set<DemoGap>();
  if (profile.services.length === 0) gaps.add("treatments");
  else {
    const priced = profile.services.filter((s) => isPriced(s.price)).length;
    if (priced === 0) gaps.add("prices");
    else if (priced < profile.services.length) gaps.add("some-prices");
  }
  if (profile.hours.length === 0) gaps.add("hours");
  if (!profile.address) gaps.add("address");
  if (!profile.phone) gaps.add("phone");
  if (profile.providers.length === 0) gaps.add("team");
  if (!profile.booking) gaps.add("booking");
  const rules = [...profile.policies, ...profile.faqs.map((f) => `${f.question} ${f.answer}`)].join("\n");
  if (!POLICY.test(rules)) gaps.add("policy");
  return ORDER.filter((g) => gaps.has(g));
}

/** For the owner, on the demo page: "your prices", "how patients book". */
export function gapLabel(gap: DemoGap, audience: Audience = "patients"): string {
  const people = audience === "clients" ? "clients" : "patients";
  const offer = audience === "clients" ? "services" : "treatments";
  switch (gap) {
    case "treatments":
      return `your ${offer}`;
    case "prices":
      return "your prices";
    case "some-prices":
      return `prices for some ${offer}`;
    case "hours":
      return "your opening hours";
    case "address":
      return "your address";
    case "phone":
      return "your phone number";
    case "team":
      return "your team";
    case "booking":
      return `how ${people} book`;
    case "policy":
      return "your cancellation and deposit policy";
  }
}

/** For the assistant and the audit, in the clinic information: neutral words, no "your". */
export function gapTopic(gap: DemoGap): string {
  switch (gap) {
    case "treatments":
      return "the treatments or services offered";
    case "prices":
      return "prices";
    case "some-prices":
      return "prices for the services listed without one";
    case "hours":
      return "opening hours";
    case "address":
      return "the address";
    case "phone":
      return "the phone number";
    case "team":
      return "the team or providers";
    case "booking":
      return "how booking works";
    case "policy":
      return "a cancellation or deposit policy";
  }
}

/** "a, b and c", the way a sentence lists things. */
export function listInWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
