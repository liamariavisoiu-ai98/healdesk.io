/**
 * Single source of truth for brand identity and site-wide copy.
 *
 * The domain lives here rather than being inlined so switching it is one edit.
 */

export const site = {
  name: "healdesk",
  domain: "healdesk.io",
  url: process.env.NEXT_PUBLIC_SITE_URL ?? "https://healdesk.io",

  tagline: "An AI front desk for six specialties.",
  subtitle: "Answers calls and messages, books the visit, follows up.",

  description:
    "healdesk answers every call, text, and DM for high-ticket elective clinics — " +
    "then shows you which recovered call became collected revenue.",

  cta: {
    primary: { label: "Make It Yours", href: "/get-started" },
    secondary: { label: "Find Out More", href: "#how-it-works" },
  },

  nav: [
    { label: "Specialties", href: "#specialties" },
    { label: "Live demo", href: "#demo" },
    { label: "What it costs you", href: "#leak" },
    // "Attribution" reads as ad attribution, which is the one thing this
    // section is not. The anchor stays #attribution so existing links survive.
    { label: "Revenue reporting", href: "#attribution" },
  ],
} as const;
