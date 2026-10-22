/**
 * The four touches as Instantly templates: `{a|b|c}` is spintax, `{{name}}` is
 * a column of the lead file.
 *
 * The owner builds the sequence in Instantly from these and uploads the
 * spreadsheet. Nothing here is rendered by the pipeline; this module is the one
 * place the template text lives, so docs/outreach/sequences.md, the
 * spreadsheet's Templates tab and the copy guard's test all read the same
 * words.
 *
 * Rules the text follows:
 *  - Variables sit OUTSIDE spintax braces, so no tool has to resolve a variable
 *    inside a choice.
 *  - A variant never contains "|", "{" or "}".
 *  - Every column used is one the pipeline writes (TEMPLATE_COLUMNS), and the
 *    greeting name is a column (greeting_name) that is never empty, so no
 *    fallback syntax is needed.
 *  - No link and no image before a "yes".
 */

export type Template = {
  name: string;
  /** Days after touch 1. */
  day: number;
  /** "(same thread)" touches send with a blank subject so they thread. */
  subject: string;
  body: string;
};

/** Columns a template may use. A test fails on any other variable. */
export const TEMPLATE_COLUMNS = [
  "greeting", "greeting_name", "subject_line", "hook", "chat_surface", "closing_question",
  "scenario", "client_term", "company_short", "site_host", "top_offer",
] as const;

export const TEMPLATES: readonly Template[] = [
  {
    name: "Touch 1",
    day: 1,
    subject: "{{subject_line}}",
    body: `{{greeting}} {{greeting_name}},

{{hook}}

{So I built|So I put together|So I set up} a private preview of AYA, our AI assistant, trained on {{site_host}} and dressed in your branding. {One link: call her, then chat with her as she'd appear on|It's one link. Call her, then chat with her as she'd look on|One link lets you call her, then chat with her as she'd appear on} {{chat_surface}}.

{{closing_question}} {Reply "yes" and you'll have it in two minutes.|A "yes" gets it to you in two minutes.|Just reply "yes" and it's yours in two minutes.}`,
  },
  {
    name: "Touch 2",
    day: 3,
    subject: "(same thread, leave blank)",
    body: `{{greeting}} {{greeting_name}},

{{scenario}} {So your team starts the day with every inquiry handled, not a stack of voicemails.|So you can stay with the person in front of you while she handles it.|So the morning starts with inquiries handled, not voicemails to return.}

{In website chat she can also send your deposit link.|On your website chat she can send your deposit link too.|She can also send your deposit link in website chat.} {That's what your preview does, with your own services.|Your preview does exactly that, with your own services.|That's your preview, running on your own services.} {Want it?|Should I send it?|Want me to send it over?}`,
  },
  {
    name: "Touch 3",
    day: 6,
    subject: "(same thread, leave blank)",
    body: `{{greeting}} {{greeting_name}},

{Two quick things before you try her.|Two things worth knowing before you try her.|Before you try her, two quick things.} She never gives medical advice and only quotes the prices you set. And we sign a business associate agreement and handle {{client_term}}' data under it.

{Don't take my word for how natural she sounds. Call her yourself.|The best test is to call her and hear how natural she sounds.|Call her yourself and judge how natural she sounds.}

{If someone else at|If another person at|In case someone else at} {{company_short}} {looks after the phones, who should I send the preview to?|handles the phones, who's best to send the preview to?}`,
  },
  {
    name: "Touch 4",
    day: 10,
    subject: "(same thread, leave blank)",
    body: `{{greeting}} {{greeting_name}},

{I'm tidying up previews this week.|I'm clearing out old previews this week.|I'm closing out this week's previews.} {Should I archive the one for|Want me to archive the one for} {{company_short}}, {or send it over first?|or would you like it first?}`,
  },
];

/**
 * The one email for a clinic whose site would not load (the "Unreadable sites"
 * tab). It has no preview to offer, because the preview is built from the
 * site, and no follow-up: see the note at the top of unreadable.ts.
 */
export const UNREADABLE_TEMPLATE: Template = {
  name: "Unreadable sites (one email)",
  day: 1,
  subject: "{{subject_line}}",
  body: `{{greeting}} {{greeting_name}},

{{hook}}

{{top_offer}}

{{closing_question}}`,
};

const VARIABLE = /\{\{\s*([a-z_]+)\s*\}\}/g;
const SPIN = /\{([^{}]*\|[^{}]*)\}/g;

/** Every `{{variable}}` a template uses. */
export function variablesIn(text: string): string[] {
  return [...new Set([...text.matchAll(VARIABLE)].map((m) => m[1]!))];
}

/** Every spintax choice in a template, variables masked out first. */
export function spinGroups(text: string): string[][] {
  const masked = text.replace(VARIABLE, "\u0000");
  return [...masked.matchAll(SPIN)].map((m) => m[1]!.split("|"));
}

/** The fixed text of a template with variables and spintax markers removed, for the copy guard. */
export function fixedText(text: string): string {
  return text.replace(VARIABLE, "").replace(SPIN, (_, choices: string) => choices.split("|").join("\n"));
}
