/**
 * The steps of the search and AI-visibility strategy that only the owner can
 * take: their accounts, their identity or their judgement. The strategy doc's
 * "What only you can do" table is the source; this is the same list with a
 * link to where each step is done, so /admin/seo can be worked through from a
 * phone. Ticks live in the marketing Sheet (lib/admin/seo/store.ts).
 *
 * Pure data: client components import it.
 */

export const STRATEGY_DOC = "https://claude.ai/code/artifact/6a71b399-b0bc-4317-9a18-21aebd2e9aca";

export type StepWhen = "today" | "week" | "ongoing";

export type OwnerStep = {
  /** Stable: the Sheet's ticks are keyed by it. Never reuse an id. */
  id: string;
  when: StepWhen;
  text: string;
  /** Where the step is done, as a short label. */
  where: string;
  href: string;
  time: string;
};

export const WHEN_LABEL: Record<StepWhen, string> = {
  today: "Today",
  week: "This week",
  ongoing: "Ongoing",
};

export const OWNER_STEPS: readonly OwnerStep[] = [
  {
    id: "site-search",
    when: "today",
    text: "Search site:healdesk.io in Google and in Bing",
    where: "Google",
    href: "https://www.google.com/search?q=site%3Ahealdesk.io",
    time: "2 minutes",
  },
  {
    id: "search-console",
    when: "today",
    text: "Verify healdesk.io in Search Console (TXT record in Cloudflare), submit the sitemap, request indexing of the main pages",
    where: "Search Console",
    href: "https://search.google.com/search-console",
    time: "20 minutes",
  },
  {
    id: "bing",
    when: "today",
    text: "Import the site into Bing Webmaster Tools from Search Console",
    where: "Bing Webmaster Tools",
    href: "https://www.bing.com/webmasters",
    time: "5 minutes",
  },
  {
    id: "connectors",
    when: "today",
    text: "Sign in to the Ahrefs and Similarweb connectors",
    where: "claude.ai connectors",
    href: "https://claude.ai/settings/connectors",
    time: "5 minutes",
  },
  {
    id: "aws-key",
    when: "today",
    text: "Replace the AWS key in the Claude environment's settings with a least-privilege one, so a session can switch flags and read logs",
    where: "Claude environment settings",
    href: "https://claude.ai/code",
    time: "15 minutes",
  },
  {
    id: "linkedin",
    when: "today",
    text: "Create the LinkedIn company page with the one description",
    where: "LinkedIn",
    href: "https://www.linkedin.com/company/setup/new/",
    time: "20 minutes",
  },
  {
    id: "crunchbase",
    when: "today",
    text: "Create the Crunchbase profile with the one description",
    where: "Crunchbase",
    href: "https://www.crunchbase.com/",
    time: "20 minutes",
  },
  {
    id: "g2",
    when: "today",
    text: "Submit the free G2 listing",
    where: "G2",
    href: "https://sell.g2.com/",
    time: "15 minutes",
  },
  {
    id: "capterra",
    when: "today",
    text: "Submit the free Capterra listing",
    where: "Capterra",
    href: "https://vendors.capterra.com/",
    time: "15 minutes",
  },
  {
    id: "trademark",
    when: "today",
    text: "Run the knockout search for \"healdesk\" in classes 9, 42 and 44",
    where: "USPTO Trademark Search",
    href: "https://tmsearch.uspto.gov",
    time: "20 minutes",
  },
  {
    id: "posthog",
    when: "today",
    text: "Create the AI-referrals insight (filter in the doc's Drafts tab)",
    where: "PostHog",
    href: "https://us.posthog.com",
    time: "15 minutes",
  },
  {
    id: "baseline",
    when: "today",
    text: "Ask the ten baseline questions in the five engines, logged out, and log each answer below",
    where: "AI visibility, below",
    href: "#ai-visibility",
    time: "1 hour",
  },
  {
    id: "featured",
    when: "today",
    text: "Create a source profile on Featured",
    where: "Featured",
    href: "https://featured.com",
    time: "10 minutes",
  },
  {
    id: "qwoted",
    when: "today",
    text: "Create a source profile on Qwoted",
    where: "Qwoted",
    href: "https://www.qwoted.com",
    time: "10 minutes",
  },
  {
    id: "amspa",
    when: "today",
    text: "Send AmSpa the email asking for its call-for-presentations deadline (draft in the doc)",
    where: "Strategy doc, Drafts for you",
    href: STRATEGY_DOC,
    time: "5 minutes",
  },
  {
    id: "list-publishers",
    when: "today",
    text: "Send the notes to the publishers of third-party lists (drafts in the doc)",
    where: "Strategy doc, Drafts for you",
    href: STRATEGY_DOC,
    time: "30 minutes",
  },
  {
    id: "voice",
    when: "week",
    text: "Read the two voice specimens and mark any sentence to change; silence means approved",
    where: "Strategy doc, House style",
    href: STRATEGY_DOC,
    time: "20 minutes",
  },
  {
    id: "author",
    when: "week",
    text: "Give the author line: your name, a photo and a short, true biography",
    where: "Reply in the Claude session",
    href: STRATEGY_DOC,
    time: "15 minutes",
  },
  {
    id: "counsel",
    when: "week",
    text: "Engage counsel to review the live legal pages, the trademark clearance and California AB 1979",
    where: "Your counsel",
    href: STRATEGY_DOC,
    time: "1 hour to brief",
  },
  {
    id: "youtube",
    when: "week",
    text: "Record the staged demo call on a synthetic clinic and create the YouTube channel",
    where: "YouTube Studio",
    href: "https://studio.youtube.com",
    time: "1 hour",
  },
  {
    id: "specialty-conversations",
    when: "week",
    text: "Approve the sample conversations for the med spa, fertility and plastic surgery pages",
    where: "Strategy doc",
    href: STRATEGY_DOC,
    time: "30 minutes",
  },
  {
    id: "census-crawl",
    when: "week",
    text: "Run the leadgen crawl on a stratified sample for the access census",
    where: "packages/leadgen, your machine",
    href: STRATEGY_DOC,
    time: "2 hours",
  },
  {
    id: "reddit",
    when: "week",
    text: "Open a Reddit account under your name that says where you work",
    where: "Reddit",
    href: "https://www.reddit.com/register/",
    time: "10 minutes",
  },
  {
    id: "monthly-panel",
    when: "ongoing",
    text: "Run the 40-question panel monthly, or subscribe to a tracker once the questions that matter are known",
    where: "AI visibility, below",
    href: "#ai-visibility",
    time: "15 to 20 hours a month",
  },
  {
    id: "pitches",
    when: "ongoing",
    text: "Answer journalists' requests and send podcast and trade-press pitches under your name",
    where: "Featured, Qwoted, email",
    href: STRATEGY_DOC,
    time: "1 to 2 hours a week",
  },
  {
    id: "g2-reviews",
    when: "ongoing",
    text: "After launch, ask every live clinic for a G2 review, never only the satisfied ones",
    where: "G2",
    href: "https://sell.g2.com/",
    time: "10 minutes a clinic",
  },
  {
    id: "amspa-affiliate",
    when: "ongoing",
    text: "Decide on the AmSpa affiliate programme in January",
    where: "AmSpa",
    href: "https://www.americanmedspa.org/",
    time: "30 minutes",
  },
];
