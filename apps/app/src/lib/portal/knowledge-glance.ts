import { DAY_KEYS, type DayKey } from "@/lib/clinic/opening-hours";

/** lib/website/store.ts's WEBSITE_ANCHOR, kept here so this file stays free of the database. */
const WEBSITE_ANCHOR = "website";

/**
 * The top of Knowledge (portal redesign, fifth slice, owner, 1 November
 * 2026): what AYA knows about the practice, in three tiles a clinic reads at
 * a glance, each a link down to the part it counts: treatments and how many
 * have a price, quick answers, and the hours. Counts only, from what the page
 * already holds. Pure, so the words are one table test.
 */

export type KnowledgeTile = {
  key: "prices" | "quick-answers" | "hours";
  label: string;
  value: string;
  hint: string;
  /** Something AYA cannot answer yet: drawn as a nudge. */
  needsYou: boolean;
};

export function knowledgeTiles(input: {
  /** Each treatment's price as stored: null when it has none. */
  services: readonly { price: number | null }[];
  quickAnswers: number;
  /** The weekly hours, or null when none are on file. */
  hours: Partial<Record<DayKey, readonly unknown[]>> | null;
}): KnowledgeTile[] {
  const total = input.services.length;
  const priced = input.services.filter((s) => s.price !== null).length;
  const prices: KnowledgeTile =
    total === 0
      ? {
          key: "prices",
          label: "Treatments",
          value: "None yet",
          hint: "Add your treatments and prices so AYA can quote them.",
          needsYou: true,
        }
      : {
          key: "prices",
          label: "Treatments",
          value: total.toLocaleString("en-US"),
          hint:
            priced === total
              ? "Every one has a price."
              : `${(total - priced).toLocaleString("en-US")} ${total - priced === 1 ? "has" : "have"} no price, so AYA offers a consultation instead.`,
          needsYou: priced < total,
        };

  const answers: KnowledgeTile = {
    key: "quick-answers",
    label: "Quick answers",
    value: input.quickAnswers.toLocaleString("en-US"),
    hint:
      input.quickAnswers === 0
        ? "Add answers for things like parking or the venue."
        : "Things AYA answers in your words.",
    needsYou: false,
  };

  const openDays = input.hours ? DAY_KEYS.filter((d) => (input.hours?.[d]?.length ?? 0) > 0).length : 0;
  const hours: KnowledgeTile =
    openDays === 0
      ? {
          key: "hours",
          label: "Hours",
          value: "Not set",
          hint: "Add your hours so AYA knows when you're open.",
          needsYou: true,
        }
      : {
          key: "hours",
          label: "Hours",
          value: `${openDays} ${openDays === 1 ? "day" : "days"} a week`,
          hint: "Closed days are set below too.",
          needsYou: false,
        };

  return [prices, answers, hours];
}

/** The shortcuts to Knowledge's sections, in the page's order. */
export function knowledgeSections(hasWebsiteChanges: boolean): { id: string; label: string }[] {
  return [
    ...(hasWebsiteChanges ? [{ id: WEBSITE_ANCHOR, label: "Website changes" }] : []),
    { id: "file", label: "Add from a file" },
    { id: "practice", label: "Contact details" },
    { id: "policies", label: "Policies" },
    { id: "prices", label: "Prices" },
    { id: "promotions", label: "Promotions" },
    { id: "quick-answers", label: "Quick answers" },
    { id: "never-say", label: "Never say" },
    { id: "hours", label: "Hours" },
  ];
}
