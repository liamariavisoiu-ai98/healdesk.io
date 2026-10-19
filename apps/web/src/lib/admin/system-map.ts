/**
 * The system map on /admin/map: every tool healdesk runs on, every bridge
 * between two of them, and the key each bridge rides on.
 *
 * ## What this file is, and what it is not
 *
 * It is the registry and the arithmetic. TOOLS are the things healdesk runs
 * on, sorted into GROUPS (the map's category cards); BRIDGES are every
 * connection between two tools (data travels `from` → `to`), each with a
 * THEME the map's lenses narrow by; KEYS are the secrets and ids those
 * bridges need, each written once with where it lives and how it is
 * rotated; STORIES are journeys the map can play one bridge at a time.
 * Where all of that is drawn is lib/admin/map-layout.ts.
 * `assess()` takes what was found live (lib/admin/system-map-live.ts) and
 * colours each key and each bridge. Nothing here reads the environment, the
 * network or a secret: the page hands in yes-or-no answers, so the result is
 * safe to give to the browser, and the whole of the colouring is testable.
 *
 * It is not a second copy of the product spec or the roadmap. A bridge's
 * `build` and `buildNote` say only what the code shows today (read out of it
 * on 14 October 2026: routes, Terraform, the design notes' "Not built"
 * lists), and system-map.test.ts holds each key to a name the code actually
 * reads, so a renamed variable fails a test instead of a map that quietly
 * goes green.
 *
 * ## Written for the owner, not an engineer
 *
 * Every title, example and rotation note is plain English with a real-life
 * case, because the point of the page is to see the whole system at one look
 * without knowing what an HMAC is. The variable's real name is always shown
 * beside the words, so the two can be matched when something has to change.
 * The examples use made-up people and no treatment names, like the rest of
 * the console.
 *
 * ## Rotation schedules are suggestions
 *
 * infra/aws/README.md ("Rotating secrets") says how to rotate each AWS key and
 * what breaks while it happens; no schedule has been adopted. The `every`
 * days below are this page's suggestion (90 days for keys that talk to an AI
 * vendor or Google's robot account, 180 for most API keys and signing
 * secrets, 365 for the slow-moving ones), labelled as suggestions on screen,
 * and changed here when a policy is set. The last rotation is whatever the
 * owner recorded with "I rotated it today" (lib/admin/key-rotations.ts); a
 * GitHub token's real expiry date, read live, beats both.
 */

// -----------------------------------------------------------------------------
// Tools and the categories they sit in
// -----------------------------------------------------------------------------

export type ToolKind =
  /** People: patients, the clinic, buyers, the operator. */
  | "people"
  /** Our two apps, the hubs everything else connects to. */
  | "ours"
  /** Inside our AWS account, under the AWS business associate agreement. */
  | "aws"
  /** Somebody else's service. */
  | "vendor";

/** The small picture beside a name. Drawn by app/admin/map/icons.tsx. */
export type IconName =
  | "user"
  | "users"
  | "building"
  | "megaphone"
  | "server"
  | "store"
  | "database"
  | "lock"
  | "mail"
  | "phone"
  | "sparkles"
  | "chat"
  | "calendar"
  | "card"
  | "link"
  | "code"
  | "cloud"
  | "table"
  | "clock"
  | "bell"
  | "search"
  | "chart"
  | "shield"
  | "inbox";

/**
 * The bands the map is drawn in, top to bottom: the patient side (our AWS
 * account, where patient data lives), what both sides share, and the shop
 * side (Vercel, where no patient data ever goes).
 */
export type Band = "patient" | "shared" | "shop";

export type GroupId =
  | "patient-people"
  | "front-doors"
  | "vault"
  | "brain"
  | "bookings"
  | "phase-two"
  | "payments"
  | "email"
  | "deploys"
  | "shop-people"
  | "selling"
  | "records";

export type GroupDef = {
  id: GroupId;
  name: string;
  /** One sentence, in the owner's words: what this category is for. */
  blurb: string;
  icon: IconName;
  band: Band;
};

/**
 * The categories, in reading order. Every tool but the two hubs sits in
 * exactly one, and the map draws one line per pair of categories rather
 * than one per bridge, so the picture stays readable; each bridge is one
 * click away.
 */
export const GROUPS: readonly GroupDef[] = [
  { id: "patient-people", name: "Patients & clinics", blurb: "The people the clinic engine serves: patients who get in touch, and the clinic team who use its portal.", icon: "users", band: "patient" },
  { id: "front-doors", name: "Front doors", blurb: "Where patients' calls and messages come in before they reach the engine.", icon: "inbox", band: "patient" },
  { id: "vault", name: "Inside our AWS", blurb: "Our own locked rooms: the engine's memory, the safe for clinics' logins, and the email that carries transcripts.", icon: "shield", band: "patient" },
  { id: "brain", name: "AYA's brain", blurb: "Writes every answer AYA gives a patient, under a business associate agreement.", icon: "sparkles", band: "patient" },
  { id: "bookings", name: "Bookings & deposits", blurb: "Where AYA's bookings land and where patients' deposits are paid: always the clinic's own accounts.", icon: "calendar", band: "patient" },
  { id: "phase-two", name: "Phase two", blurb: "Built or half built, and parked on purpose: v1 does not claim revenue.", icon: "link", band: "patient" },
  { id: "payments", name: "Payments", blurb: "Our own Stripe: the shop window sells, the engine keeps each subscription right.", icon: "card", band: "shared" },
  { id: "email", name: "Email", blurb: "Everyday email from hello@healdesk.io, for both apps. Never a patient's details.", icon: "mail", band: "shared" },
  { id: "deploys", name: "Code & addresses", blurb: "Where the code lives, what publishes it, and the web addresses that point at it.", icon: "code", band: "shared" },
  { id: "shop-people", name: "Buyers & you", blurb: "Clinic owners shopping on healdesk.io, and you running the business.", icon: "users", band: "shop" },
  { id: "selling", name: "Selling & demos", blurb: "Everything that finds clinic owners and shows them AYA before they buy.", icon: "megaphone", band: "shop" },
  { id: "records", name: "Records & alerts", blurb: "Where leads and signed agreements are kept, how you are told, and the daily timer.", icon: "table", band: "shop" },
];

export type ToolDef = {
  id: string;
  name: string;
  /** What it does for healdesk, in a few words. */
  role: string;
  kind: ToolKind;
  /** Its category; null for the two hubs, which are drawn on their own. */
  category: GroupId | null;
  icon: IconName;
  /** Which side of the patient-data line it sits on. */
  side: "patient" | "shop" | "both";
};

export const TOOLS: readonly ToolDef[] = [
  // The two hubs.
  { id: "app", name: "Clinic engine", role: "app.healdesk.io · AWS", kind: "ours", category: null, icon: "server", side: "patient" },
  { id: "web", name: "Shop window", role: "healdesk.io · Vercel", kind: "ours", category: null, icon: "store", side: "shop" },

  // The patient side.
  { id: "patients", name: "Patients", role: "Call, chat or message a clinic", kind: "people", category: "patient-people", icon: "user", side: "patient" },
  { id: "clinic", name: "Clinic team", role: "Portal, inbox, own calendar", kind: "people", category: "patient-people", icon: "building", side: "patient" },
  { id: "retell", name: "Retell", role: "Phone lines AYA answers", kind: "vendor", category: "front-doors", icon: "phone", side: "patient" },
  { id: "meta", name: "Meta", role: "Instagram, Messenger, WhatsApp", kind: "vendor", category: "front-doors", icon: "chat", side: "patient" },
  { id: "db", name: "Database", role: "Amazon RDS: the engine's memory", kind: "aws", category: "vault", icon: "database", side: "patient" },
  { id: "kms", name: "Key safe", role: "Amazon KMS: locks clinics' logins", kind: "aws", category: "vault", icon: "lock", side: "patient" },
  { id: "ses", name: "Amazon email", role: "SES: sends transcripts", kind: "aws", category: "vault", icon: "mail", side: "patient" },
  { id: "claude-baa", name: "Claude", role: "Anthropic, patient account, under a BAA", kind: "vendor", category: "brain", icon: "sparkles", side: "patient" },
  { id: "gcal", name: "Google Calendar", role: "Each clinic's own diary", kind: "vendor", category: "bookings", icon: "calendar", side: "patient" },
  { id: "clinic-stripe", name: "Clinic's Stripe", role: "Deposits paid to the clinic", kind: "vendor", category: "bookings", icon: "card", side: "patient" },
  { id: "connectors", name: "Booking systems", role: "Mindbody, Boulevard", kind: "vendor", category: "phase-two", icon: "link", side: "patient" },

  // Shared by both sides.
  { id: "stripe", name: "Stripe", role: "Our checkout and subscriptions", kind: "vendor", category: "payments", icon: "card", side: "both" },
  { id: "resend", name: "Resend", role: "Everyday email, hello@", kind: "vendor", category: "email", icon: "mail", side: "both" },
  { id: "github", name: "GitHub", role: "Code, deploys, AWS on/off switch", kind: "vendor", category: "deploys", icon: "code", side: "both" },
  { id: "cloudflare", name: "Cloudflare", role: "healdesk.io's web addresses", kind: "vendor", category: "deploys", icon: "cloud", side: "both" },

  // The shop side.
  { id: "prospects", name: "Clinic owners", role: "Shopping on healdesk.io", kind: "people", category: "shop-people", icon: "users", side: "shop" },
  { id: "you", name: "You", role: "Running healdesk from /admin", kind: "people", category: "shop-people", icon: "user", side: "shop" },
  { id: "claude-mkt", name: "Claude (demos)", role: "Anthropic, marketing account", kind: "vendor", category: "selling", icon: "sparkles", side: "shop" },
  { id: "retell-demo", name: "Retell demos", role: "The demo line: AYA rings owners", kind: "vendor", category: "selling", icon: "phone", side: "shop" },
  { id: "apify", name: "Apify", role: "Reads clinic websites", kind: "vendor", category: "selling", icon: "search", side: "shop" },
  { id: "outreach", name: "Cold email", role: "Instantly, InboxKit, GlockApps…", kind: "vendor", category: "selling", icon: "megaphone", side: "shop" },
  { id: "posthog", name: "PostHog", role: "Visitor analytics", kind: "vendor", category: "selling", icon: "chart", side: "shop" },
  { id: "indexnow", name: "Search engines", role: "IndexNow: Bing and others hear of new pages", kind: "vendor", category: "selling", icon: "search", side: "shop" },
  { id: "sheets", name: "Google Sheets", role: "Leads, requests, agreements", kind: "vendor", category: "records", icon: "table", side: "shop" },
  { id: "slack", name: "Slack", role: "Alerts for you", kind: "vendor", category: "records", icon: "bell", side: "shop" },
  { id: "vercel-cron", name: "Vercel timer", role: "Daily jobs", kind: "vendor", category: "records", icon: "clock", side: "shop" },
];

// -----------------------------------------------------------------------------
// Keys
// -----------------------------------------------------------------------------

/**
 * Where a key lives, which decides whether this page can see it:
 *
 *   vercel    the shop window's environment on Vercel. Read here, live.
 *   aws       the engine's environment on AWS (Parameter Store, or a public
 *             id Terraform sets). Read over the signed ops call, live, while
 *             the host is on; "can't check" while it is in standby.
 *   aws-ci    Parameter Store's shelf for GitHub's deploys only. No running
 *             task is given it, so nothing can report on it.
 *   computer  your own computer and password manager. Never checked.
 *   clinic    one per clinic, sealed in the database with the key safe, made
 *             when the clinic presses a login button. Shown per clinic on Ops.
 */
export type KeyHome = "vercel" | "aws" | "aws-ci" | "computer" | "clinic";

export const HOME_LABEL: Record<KeyHome, string> = {
  vercel: "Vercel (shop window)",
  aws: "AWS (clinic engine)",
  "aws-ci": "AWS, deploys only",
  computer: "Your computer",
  clinic: "Each clinic's own login",
};

/**
 * Whether a missing key is a problem.
 *
 *   required  the bridge does not work without it: missing means "add it".
 *   optional  the bridge works without it, with one feature off.
 *   later     left unset on purpose until `waitsFor` is done; the paste
 *             script holds these back too (put-external-secrets.sh).
 */
export type KeyNeed = "required" | "optional" | "later";

export type Rotation =
  /** Suggested every so many days (see the header). */
  | { kind: "every"; days: number; how: string; impact: string }
  /** Expires on its own date, which GitHub reports and this page reads. */
  | { kind: "expires"; how: string; impact: string }
  /** Never on a schedule: only if it leaks, or the thing it stands for changes. */
  | { kind: "only-if"; when: string; how: string }
  /** Never. Rotating it breaks something that cannot be repaired by rotating back. */
  | { kind: "never"; why: string }
  /** Not a secret: an address, an id or a public key. Nothing to rotate. */
  | { kind: "public" };

export type KeyDef = {
  /** `<home>.<variable>`, unique; a clinic key's variable is a word. */
  id: string;
  /** The environment variable's real name, or null for a per-clinic login. */
  env: string | null;
  home: KeyHome;
  /** What it is, in plain words. */
  label: string;
  need: KeyNeed;
  /** For `later`: what it waits on. */
  waitsFor?: string;
  rotation: Rotation;
  /** Another key that must hold the same value. */
  sameAs?: string;
  /** Another key that must never hold the same value. */
  neverSameAs?: string;
};

const VERCEL_HOW = "Change it in Vercel (healdesk project, Settings, Environment Variables, Production), then redeploy.";
const AWS_HOW = (name: string) =>
  `Roll it in the vendor's dashboard, then in AWS CloudShell run bash put-external-secrets.sh ${name} and restart (deploy-app.yml, restart_only).`;

export const KEYS: readonly KeyDef[] = [
  // --- The console's own door (Vercel) ---------------------------------------
  { id: "vercel.HEALDESK_ADMIN_EMAIL", env: "HEALDESK_ADMIN_EMAIL", home: "vercel", label: "Your console username", need: "required", rotation: { kind: "public" }, sameAs: "aws.HEALDESK_ADMIN_EMAIL" },
  {
    id: "vercel.HEALDESK_ADMIN_PASSWORD_HASH",
    env: "HEALDESK_ADMIN_PASSWORD_HASH",
    home: "vercel",
    label: "Your console password (stored scrambled)",
    need: "required",
    rotation: { kind: "every", days: 365, how: `Run npx tsx apps/web/scripts/set-admin-password.ts and paste the hash. ${VERCEL_HOW}`, impact: "Nothing else changes. Do it at once if a sign-in alert was not you." },
  },
  {
    id: "vercel.HEALDESK_ADMIN_TOTP_SECRET",
    env: "HEALDESK_ADMIN_TOTP_SECRET",
    home: "vercel",
    label: "Your authenticator-app code",
    need: "required",
    rotation: { kind: "only-if", when: "your phone is lost or replaced", how: `Run npm run admin:totp -w @healdesk/web, scan the new code, paste the value. ${VERCEL_HOW}` },
  },
  {
    id: "vercel.HEALDESK_ADMIN_SECRET",
    env: "HEALDESK_ADMIN_SECRET",
    home: "vercel",
    label: "The stamp on your console session",
    need: "required",
    rotation: { kind: "every", days: 180, how: `openssl rand -base64 32. ${VERCEL_HOW}`, impact: "Signs you out everywhere, which is also how you end a session that was not you." },
  },

  // --- The sealed line between the two apps ----------------------------------
  {
    id: "vercel.HEALDESK_PROVISION_SECRET",
    env: "HEALDESK_PROVISION_SECRET",
    home: "vercel",
    label: "The wax seal between shop window and engine",
    need: "required",
    sameAs: "aws.HEALDESK_PROVISION_SECRET",
    rotation: {
      kind: "every",
      days: 180,
      how: "Make one new value, paste it on AWS (put-external-secrets.sh HEALDESK_PROVISION_SECRET) and on Vercel, then restart the engine and redeploy Vercel together.",
      impact: "Both copies must change at once, and only when no purchase is waiting on its first invoice: purchases sealed with the old value stop opening.",
    },
  },
  { id: "vercel.HEALDESK_APP_URL", env: "HEALDESK_APP_URL", home: "vercel", label: "The engine's private address", need: "required", rotation: { kind: "public" } },
  {
    id: "aws.HEALDESK_PROVISION_SECRET",
    env: "HEALDESK_PROVISION_SECRET",
    home: "aws",
    label: "The wax seal (the engine's copy)",
    need: "required",
    sameAs: "vercel.HEALDESK_PROVISION_SECRET",
    rotation: {
      kind: "every",
      days: 180,
      how: "Together with the Vercel copy: see the shop window's copy.",
      impact: "Signed calls fail in between: checkout shows an error and this console is briefly blind.",
    },
  },
  { id: "aws.HEALDESK_ADMIN_EMAIL", env: "HEALDESK_ADMIN_EMAIL", home: "aws", label: "Who the engine records as you", need: "required", rotation: { kind: "public" }, sameAs: "vercel.HEALDESK_ADMIN_EMAIL" },

  // --- Buying (Vercel) ---------------------------------------------------------
  {
    id: "vercel.HEALDESK_GATE_SECRET",
    env: "HEALDESK_GATE_SECRET",
    home: "vercel",
    label: "The stamp on visitors' passes",
    need: "required",
    rotation: { kind: "every", days: 365, how: `openssl rand -base64 32. ${VERCEL_HOW}`, impact: "Setup links and agreement downloads already sent stop working, so do it when none is out." },
  },
  {
    id: "vercel.STRIPE_SECRET_KEY",
    env: "STRIPE_SECRET_KEY",
    home: "vercel",
    label: "Stripe key (shop window)",
    need: "required",
    rotation: { kind: "every", days: 180, how: `Roll it in Stripe (Developers, API keys). ${VERCEL_HOW} Paste the same new key on AWS too.`, impact: "Same Stripe account and mode on both sides. Stripe keeps the old key alive for a while when it rolls; use that window." },
  },
  {
    id: "vercel.STRIPE_WEBHOOK_SECRET",
    env: "STRIPE_WEBHOOK_SECRET",
    home: "vercel",
    label: "Stripe's signature on \"paid\" messages",
    need: "required",
    rotation: { kind: "every", days: 365, how: `Roll the signing secret on the webhook endpoint in Stripe. ${VERCEL_HOW}`, impact: "Stripe retries what it could not deliver, so no sale is lost." },
  },
  {
    id: "vercel.GOOGLE_SERVICE_ACCOUNT_JSON",
    env: "GOOGLE_SERVICE_ACCOUNT_JSON",
    home: "vercel",
    label: "The Google robot account's key file",
    need: "required",
    rotation: { kind: "every", days: 90, how: `gcloud iam service-accounts keys create, paste the file. ${VERCEL_HOW} Then delete the old key id in Google Cloud.`, impact: "None if the new key is pasted before the old one is deleted." },
  },
  { id: "vercel.MARKETING_SHEET_ID", env: "MARKETING_SHEET_ID", home: "vercel", label: "Which Google Sheet to use", need: "required", rotation: { kind: "public" } },

  // --- Demos (Vercel) ----------------------------------------------------------
  {
    id: "vercel.ANTHROPIC_API_KEY",
    env: "ANTHROPIC_API_KEY",
    home: "vercel",
    label: "Claude key (marketing account)",
    need: "required",
    neverSameAs: "aws.ANTHROPIC_API_KEY",
    rotation: { kind: "every", days: 90, how: `Make a new key in the marketing organisation's Anthropic console. ${VERCEL_HOW} Then revoke the old one.`, impact: "The demo chat pauses for the minute of the redeploy." },
  },
  {
    id: "vercel.RETELL_API_KEY",
    env: "RETELL_API_KEY",
    home: "vercel",
    label: "Retell key (demo line)",
    need: "required",
    rotation: { kind: "every", days: 180, how: `Make a new key in Retell (Settings, API Keys). ${VERCEL_HOW}`, impact: "\"Have AYA call me\" pauses for the minute of the redeploy." },
  },
  { id: "vercel.RETELL_DEMO_AGENT_ID", env: "RETELL_DEMO_AGENT_ID", home: "vercel", label: "Which Retell agent is AYA's demo", need: "required", rotation: { kind: "public" } },
  { id: "vercel.RETELL_DEMO_FROM_NUMBER", env: "RETELL_DEMO_FROM_NUMBER", home: "vercel", label: "The demo line's phone number", need: "required", rotation: { kind: "public" } },
  { id: "vercel.RETELL_CLINIC_DEMO_AGENT_ID", env: "RETELL_CLINIC_DEMO_AGENT_ID", home: "vercel", label: "The personalised-demo agent", need: "optional", rotation: { kind: "public" } },
  { id: "vercel.RETELL_DEMO_INBOUND_AGENT_ID", env: "RETELL_DEMO_INBOUND_AGENT_ID", home: "vercel", label: "The homepage's \"Talk now\" agent", need: "optional", rotation: { kind: "public" } },
  {
    id: "vercel.RETELL_WEBHOOK_KEY",
    env: "RETELL_WEBHOOK_KEY",
    home: "vercel",
    label: "Retell's signature on demo messages",
    need: "optional",
    rotation: { kind: "every", days: 180, how: `The Retell key with the webhook badge. ${VERCEL_HOW}`, impact: "Without it AYA gives out the inbox address instead of taking a follow-up." },
  },

  // --- Email (Vercel) ----------------------------------------------------------
  {
    id: "vercel.RESEND_API_KEY",
    env: "RESEND_API_KEY",
    home: "vercel",
    label: "Resend key (shop window)",
    need: "required",
    rotation: { kind: "every", days: 180, how: `Make a sending-only key at resend.com/api-keys. ${VERCEL_HOW} Then delete the old one.`, impact: "Emails fail for the minute of the redeploy." },
  },
  { id: "vercel.HEALDESK_EMAIL_FROM", env: "HEALDESK_EMAIL_FROM", home: "vercel", label: "The sender address", need: "required", rotation: { kind: "public" } },
  {
    id: "vercel.RESEND_WEBHOOK_SECRET",
    env: "RESEND_WEBHOOK_SECRET",
    home: "vercel",
    label: "Resend's signature on bounce reports",
    need: "required",
    rotation: { kind: "every", days: 365, how: `Roll it on the webhook in Resend's dashboard. ${VERCEL_HOW}`, impact: "Bounces in between are retried by Resend." },
  },

  // --- Housekeeping (Vercel) -----------------------------------------------------
  {
    id: "vercel.CRON_SECRET",
    env: "CRON_SECRET",
    home: "vercel",
    label: "The timer's password",
    need: "required",
    rotation: { kind: "every", days: 365, how: `openssl rand -base64 32. ${VERCEL_HOW}`, impact: "None: the next run uses the new one." },
  },
  {
    id: "vercel.HEALDESK_GITHUB_ACTIONS_TOKEN",
    env: "HEALDESK_GITHUB_ACTIONS_TOKEN",
    home: "vercel",
    label: "GitHub token for the AWS on/off switch",
    need: "required",
    rotation: {
      kind: "expires",
      how: `Make a new fine-grained token of the owner (this repository only, Actions read and write). ${VERCEL_HOW} Then revoke the old one in GitHub.`,
      impact: "In between, Host's buttons and the first-invoice wake-up cannot switch the host; GitHub's own Run workflow button still can.",
    },
  },
  {
    id: "vercel.GITHUB_TOKEN",
    env: "GITHUB_TOKEN",
    home: "vercel",
    label: "GitHub token for the Changes feed",
    need: "optional",
    rotation: { kind: "expires", how: `A read-only token for this repository. ${VERCEL_HOW}`, impact: "The Changes tab goes empty until the new one is in." },
  },
  { id: "vercel.SLACK_WEBHOOK_URL", env: "SLACK_WEBHOOK_URL", home: "vercel", label: "The Slack alert address", need: "optional", rotation: { kind: "only-if", when: "the address leaks: anyone holding it can post in that channel", how: `Make a new incoming webhook in Slack. ${VERCEL_HOW}` } },
  {
    id: "vercel.APIFY_TOKEN",
    env: "APIFY_TOKEN",
    home: "vercel",
    label: "Apify key",
    need: "optional",
    rotation: { kind: "every", days: 365, how: `Apify console, Settings, Integrations. ${VERCEL_HOW}`, impact: "Demos read only plain HTML in between." },
  },
  {
    id: "vercel.DEMO_WEBHOOK_SECRET",
    env: "DEMO_WEBHOOK_SECRET",
    home: "vercel",
    label: "Password the cold-email automation uses",
    need: "optional",
    rotation: { kind: "every", days: 180, how: `openssl rand -base64 32, at least 24 characters. ${VERCEL_HOW} Update the automation (Instantly, Zapier) at the same time.`, impact: "Replies in between do not build a demo." },
  },
  { id: "vercel.NEXT_PUBLIC_POSTHOG_KEY", env: "NEXT_PUBLIC_POSTHOG_KEY", home: "vercel", label: "PostHog project key (public by design)", need: "optional", rotation: { kind: "public" } },

  // --- The engine's keys (AWS) -------------------------------------------------
  {
    id: "aws.STRIPE_SECRET_KEY",
    env: "STRIPE_SECRET_KEY",
    home: "aws",
    label: "Stripe key (engine)",
    need: "required",
    rotation: { kind: "every", days: 180, how: "Together with the shop window's copy: the same new key in both places.", impact: "Same account and mode as the shop window's." },
  },
  {
    id: "aws.STRIPE_CONNECT_CLIENT_ID",
    env: "STRIPE_CONNECT_CLIENT_ID",
    home: "aws",
    label: "Stripe Connect platform id (ca_…)",
    need: "required",
    rotation: { kind: "public" },
  },
  {
    id: "aws.STRIPE_CONNECT_WEBHOOK_SECRET",
    env: "STRIPE_CONNECT_WEBHOOK_SECRET",
    home: "aws",
    label: "Stripe's signature on deposit messages",
    need: "required",
    rotation: { kind: "every", days: 365, how: AWS_HOW("STRIPE_CONNECT_WEBHOOK_SECRET"), impact: "Stripe retries deposit messages it could not deliver." },
  },
  {
    id: "aws.RESEND_API_KEY",
    env: "RESEND_API_KEY",
    home: "aws",
    label: "Resend key (engine)",
    need: "required",
    rotation: { kind: "every", days: 180, how: AWS_HOW("RESEND_API_KEY"), impact: "Clinic emails wait in the outbox and go after the restart." },
  },
  { id: "aws.HEALDESK_EMAIL_FROM", env: "HEALDESK_EMAIL_FROM", home: "aws", label: "The sender address", need: "required", rotation: { kind: "public" } },
  {
    id: "aws.ANTHROPIC_API_KEY",
    env: "ANTHROPIC_API_KEY",
    home: "aws",
    label: "Claude key (patient-data account)",
    need: "later",
    waitsFor: "every business associate agreement in the chain is signed",
    neverSameAs: "vercel.ANTHROPIC_API_KEY",
    rotation: { kind: "every", days: 90, how: `${AWS_HOW("ANTHROPIC_API_KEY")} Always the HIPAA organisation's key, never the marketing one.`, impact: "AYA falls back to fixed hand-off lines during the restart." },
  },
  {
    id: "aws.HEALDESK_RETELL_LLM_SECRET",
    env: "HEALDESK_RETELL_LLM_SECRET",
    home: "aws",
    label: "The password in each clinic's Retell line address",
    need: "later",
    waitsFor: "voice is switched on (enable_voice) after a test call on a made-up clinic",
    rotation: {
      kind: "every",
      days: 180,
      how: "openssl rand -hex 32, then put-external-secrets.sh HEALDESK_RETELL_LLM_SECRET and a restart, and the same value into every clinic's Retell agent URL.",
      impact: "Calls are refused for any clinic whose Retell agent still has the old address: change them in the same quiet hour.",
    },
  },
  {
    id: "aws.META_APP_SECRET",
    env: "META_APP_SECRET",
    home: "aws",
    label: "Meta's signature on patients' messages",
    need: "later",
    waitsFor: "every business associate agreement in the chain is signed",
    rotation: { kind: "every", days: 365, how: AWS_HOW("META_APP_SECRET"), impact: "Messages in between are retried by Meta." },
  },
  {
    id: "aws.META_VERIFY_TOKEN",
    env: "META_VERIFY_TOKEN",
    home: "aws",
    label: "The one-time handshake with Meta",
    need: "later",
    waitsFor: "every business associate agreement in the chain is signed",
    rotation: { kind: "only-if", when: "the webhook is registered again in Meta's dashboard", how: AWS_HOW("META_VERIFY_TOKEN") },
  },
  { id: "aws.META_APP_ID", env: "META_APP_ID", home: "aws", label: "healdesk's Meta app id", need: "required", rotation: { kind: "public" } },
  { id: "aws.META_LOGIN_CONFIG_ID", env: "META_LOGIN_CONFIG_ID", home: "aws", label: "The Facebook login button's setup id", need: "required", rotation: { kind: "public" } },
  { id: "aws.META_WHATSAPP_CONFIG_ID", env: "META_WHATSAPP_CONFIG_ID", home: "aws", label: "The WhatsApp sign-up window's setup id", need: "required", rotation: { kind: "public" } },
  { id: "aws.GOOGLE_OAUTH_CLIENT_ID", env: "GOOGLE_OAUTH_CLIENT_ID", home: "aws", label: "healdesk's Google sign-in app id", need: "required", rotation: { kind: "public" } },
  {
    id: "aws.GOOGLE_OAUTH_CLIENT_SECRET",
    env: "GOOGLE_OAUTH_CLIENT_SECRET",
    home: "aws",
    label: "healdesk's Google sign-in app secret",
    need: "required",
    rotation: { kind: "every", days: 365, how: `Add a new secret to the OAuth client in Google Cloud. ${AWS_HOW("GOOGLE_OAUTH_CLIENT_SECRET")} Then disable the old secret.`, impact: "None while both secrets are enabled." },
  },
  {
    id: "aws.BETTER_AUTH_SECRET",
    env: "BETTER_AUTH_SECRET",
    home: "aws",
    label: "The stamp on clinic sign-ins",
    need: "required",
    rotation: { kind: "every", days: 365, how: "Set app/BETTER_AUTH_SECRET to __unset__, then at once deploy-app.yml with bootstrap_db, which makes a new one inside AWS.", impact: "Signs every clinic out and voids pending email stop links." },
  },
  { id: "aws.BETTER_AUTH_URL", env: "BETTER_AUTH_URL", home: "aws", label: "The portal's public address", need: "required", rotation: { kind: "public" } },
  {
    id: "aws.HEALDESK_IDENTIFIER_REF_KEY",
    env: "HEALDESK_IDENTIFIER_REF_KEY",
    home: "aws",
    label: "The phone-number scrambler",
    need: "required",
    rotation: { kind: "never", why: "Every stored conversation was filed under it. A new one would split every open conversation and count every caller twice. Only with a re-key plan." },
  },
  {
    id: "aws.DATABASE_URL",
    env: "DATABASE_URL",
    home: "aws",
    label: "The database's address and password",
    need: "required",
    rotation: {
      kind: "every",
      days: 180,
      how: "Set db/APP_PASSWORD and app/DATABASE_URL to __unset__, then at once deploy-app.yml with bootstrap_db (infra/aws/README.md, Rotating secrets).",
      impact: "New connections fail for a minute between the new password and the new tasks: do it in a quiet hour.",
    },
  },
  { id: "aws.HEALDESK_SES_CONFIGURATION_SET", env: "HEALDESK_SES_CONFIGURATION_SET", home: "aws", label: "Amazon email's \"encryption required\" setting", need: "required", rotation: { kind: "public" } },
  { id: "aws.HEALDESK_SES_EVENTS_TOPIC_ARN", env: "HEALDESK_SES_EVENTS_TOPIC_ARN", home: "aws", label: "Where Amazon reports deliveries", need: "required", rotation: { kind: "public" } },

  // --- Not visible to any running app -------------------------------------------
  {
    id: "aws-ci.MIGRATION_DATABASE_URL",
    env: "MIGRATION_DATABASE_URL",
    home: "aws-ci",
    label: "The database's owner password (migrations only)",
    need: "required",
    rotation: {
      kind: "every",
      days: 180,
      how: "Set db/MIGRATOR_PASSWORD and migrator/MIGRATION_DATABASE_URL to __unset__, then run deploy-app.yml with bootstrap_db and migrate (infra/aws/README.md, Rotating secrets).",
      impact: "None for patients or clinics: only a deploy's migration step uses it.",
    },
  },
  {
    id: "aws-ci.CLOUDFLARE_API_TOKEN",
    env: "CLOUDFLARE_API_TOKEN",
    home: "aws-ci",
    label: "Cloudflare token (DNS for healdesk.io)",
    need: "required",
    rotation: { kind: "every", days: 365, how: "Roll it in Cloudflare, then bash put-external-secrets.sh CLOUDFLARE_API_TOKEN in CloudShell.", impact: "None: only the next infra.yml or host.yml run reads it." },
  },
  { id: "computer.INSTANTLY_API_KEY", env: "INSTANTLY_API_KEY", home: "computer", label: "Instantly key (sending)", need: "required", rotation: { kind: "every", days: 180, how: "Make a new key in Instantly and replace it where your outreach scripts read it.", impact: "None between sends." } },
  { id: "computer.INBOXKIT_API_KEY", env: "INBOXKIT_API_KEY", home: "computer", label: "InboxKit key (mailboxes, warm-up)", need: "required", rotation: { kind: "every", days: 180, how: "app.inboxkit.com, Settings, API.", impact: "None between runs." } },
  { id: "computer.GLOCKAPPS_API_KEY", env: "GLOCKAPPS_API_KEY", home: "computer", label: "GlockApps key (inbox tests)", need: "optional", rotation: { kind: "every", days: 365, how: "GlockApps account settings.", impact: "None between tests." } },
  { id: "computer.MAILREACH_API_KEY", env: "MAILREACH_API_KEY", home: "computer", label: "MailReach key (inbox tests)", need: "optional", rotation: { kind: "every", days: 365, how: "MailReach account settings.", impact: "None between tests." } },
  { id: "computer.CLOUDFLARE_API_TOKEN", env: "CLOUDFLARE_API_TOKEN", home: "computer", label: "Cloudflare token (cold-email domains only)", need: "required", rotation: { kind: "every", days: 365, how: "Roll it in Cloudflare; scoped to the cold-sending zones, never the global key.", impact: "None between runs." } },

  // --- Per clinic --------------------------------------------------------------
  { id: "clinic.google", env: null, home: "clinic", label: "Each clinic's Google Calendar login", need: "required", rotation: { kind: "only-if", when: "a clinic disconnects or Google revokes it: the clinic presses Connect again", how: "From the clinic's portal, or a calendar link from Ops." } },
  { id: "clinic.meta", env: null, home: "clinic", label: "Each clinic's Instagram, Messenger or WhatsApp login", need: "required", rotation: { kind: "only-if", when: "a clinic disconnects or Meta revokes it", how: "The clinic presses Connect again in its portal." } },
  { id: "clinic.stripe", env: null, home: "clinic", label: "Each clinic's Stripe connection", need: "required", rotation: { kind: "only-if", when: "a clinic disconnects its Stripe", how: "The clinic connects again from its portal, or a link from Ops." } },
];

/**
 * Environment variables either app reads that are settings, not keys: a
 * number, a switch, a public address, or something the platform sets. They
 * are not on the map because nothing can leak through them and nothing is
 * rotated, and each says why.
 *
 * system-map.test.ts holds both apps to this: every variable their code
 * reads must be a key on the map or listed here, so a new secret cannot
 * arrive unseen. Add a new variable to KEYS if it guards a connection or
 * could do harm in the wrong hands; here only if it is plainly neither.
 */
export const NOT_KEYS: Readonly<Record<string, string>> = {
  // Set by the platform.
  NODE_ENV: "Set by Node: development or production.",
  NEXT_PHASE: "Set by Next while it builds.",
  VERCEL_ENV: "Set by Vercel: production or preview.",
  PORT: "Set by the AWS task: which port to listen on.",
  HOSTNAME: "Set by the AWS task: which address to listen on.",
  KEEP_ALIVE_TIMEOUT: "Set by the AWS task: how long an idle connection stays open.",
  AWS_REGION: "Which AWS region: us-east-1, the one under the BAA.",
  // Public addresses and names.
  NEXT_PUBLIC_SITE_URL: "healdesk.io's public address.",
  NEXT_PUBLIC_PORTAL_URL: "The clinic portal's public sign-in address.",
  HEALDESK_REPO: "Which GitHub repository the Changes tab reads: a name.",
  HEALDESK_APP_URL: "The engine's private address. The engine reads it only to refuse it in any email it sends.",
  HEALDESK_SUPPORT_PHONE: "Our public support number, shown in the portal's Help.",
  HEALDESK_CALL_BOOKING_URL: "The public page clinics book their set-up call on.",
  HEALDESK_OPS_EMAIL: "Where operator alerts are emailed: an address.",
  HEALDESK_TEST_NUMBERS: "Your own test phones, so a test call to a clinic is never billed.",
  // Settings and switches.
  CSP_REPORT_ONLY: "Whether the site's security policy only reports, while it is being rolled out.",
  CSP_REPORT_URI: "Where those security-policy reports go.",
  DEMO_DAILY_CHAT_CAP: "A daily limit on demo chats, to cap the bill.",
  DEMO_DAILY_CALL_CAP: "A daily limit on demo calls, to cap the bill.",
  DEMO_DAILY_WEBCALL_CAP: "A daily limit on personalised-demo browser calls.",
  VOICE_DEMO_DAILY_WEBCALL_CAP: "A daily limit on the homepage's browser calls.",
  OWN_DEMO_DAILY_CAP: "A daily limit on \"send me my own AI assistant\" demos.",
  STRIPE_AUTOMATIC_TAX: "Whether Stripe adds sales tax at checkout.",
  HEALDESK_EMAIL_TRANSPORT: "Which service carries the engine's email: a word.",
  HEALDESK_KMS_PROVIDER: "Which key safe the engine uses. The key itself never leaves AWS; the key-safe line checks it live.",
  HEALDESK_KMS_KEY_ID: "Names the key in the key safe; not the key.",
  HEALDESK_LOCAL_KEK: "Development only: production refuses it and uses the key safe.",
  HEALDESK_DIRECT_BOOKING_ENABLED: "Your switch for AYA booking by herself rather than asking the clinic.",
  // Read by name through MODEL_CONFIG in apps/app's lib/assistant/responder.ts.
  HEALDESK_CHAT_MODEL: "Which model answers website chat: one of PATIENT_MODEL_IDS (@healdesk/catalog model-retention.ts); any other value is ignored with a warning, because the agreements state the provider's retention for those models only.",
  HEALDESK_VOICE_MODEL: "Which model answers calls: one of PATIENT_MODEL_IDS (@healdesk/catalog model-retention.ts); any other value is ignored with a warning, because the agreements state the provider's retention for those models only.",
  HEALDESK_PHASE_TWO_ATTRIBUTION: "The phase-two switch, off in v1.",
};

// -----------------------------------------------------------------------------
// Bridges: the curved lines
// -----------------------------------------------------------------------------

/**
 * What the code shows today.
 *
 *   built      both ends exist.
 *   partial    one end exists; `buildNote` says which is missing.
 *   not-built  nothing yet.
 *   parked     built or half built, and fenced out of v1 on purpose (phase two).
 */
export type BuildState = "built" | "partial" | "not-built" | "parked";

/** A check this page can run that proves a bridge works, beyond its key being there. */
export type LiveProof = "ops" | "kms" | "sheet" | "github-actions" | "github-feed";

/**
 * What a bridge is for, which is how the map's lenses group them: serving
 * clinics and their patients (the product), selling healdesk, or running
 * the business behind both.
 */
export type Theme = "serving" | "selling" | "running";

export const THEMES: readonly { id: Theme; name: string; blurb: string }[] = [
  { id: "serving", name: "Serving patients", blurb: "What happens when a patient gets in touch, and everything the clinic engine needs to answer." },
  { id: "selling", name: "Selling healdesk", blurb: "How clinic owners find healdesk, try AYA, pay, and get set up." },
  { id: "running", name: "Running the business", blurb: "Your console, deploys, the on/off switch, alerts and timers." },
];

export type BridgeDef = {
  id: string;
  theme: Theme;
  /** Data travels from → to; `both` adds the arrow back. */
  from: string;
  to: string;
  both?: boolean;
  /** One line, as the owner would say it. */
  title: string;
  /** What travels along it. */
  carries: string;
  /** A real-life case. */
  example: string;
  /** Key ids; may be empty when `keyless` says why none is needed. */
  keys: readonly string[];
  keyless?: string;
  /** Carries something a patient said or did. */
  phi: boolean;
  build: BuildState;
  buildNote?: string;
  proof?: LiveProof;
  /**
   * Another bridge this one is useless without: AYA cannot answer on
   * Instagram before Meta can hand the engine a message. While that one is
   * not connected, this one shows as waiting on it rather than as connected.
   */
  dependsOn?: string;
};

export const BRIDGES: readonly BridgeDef[] = [
  // --- The two apps and you ----------------------------------------------------
  {
    id: "you-console",
    theme: "running",
    from: "you",
    to: "web",
    title: "You sign in to this console",
    carries: "Your password and the 6-digit code, then a stamped pass for your browser",
    example: "Like a door with two locks: the password is one key and the code on your phone is the other. Once you are in, your browser carries a stamped pass until you sign out.",
    keys: ["vercel.HEALDESK_ADMIN_EMAIL", "vercel.HEALDESK_ADMIN_PASSWORD_HASH", "vercel.HEALDESK_ADMIN_TOTP_SECRET", "vercel.HEALDESK_ADMIN_SECRET"],
    phi: false,
    build: "built",
  },
  {
    id: "web-app",
    theme: "selling",
    from: "web",
    to: "app",
    title: "The shop window hands work to the engine",
    carries: "Paid purchases to set up, and every read and button on Ops and Host",
    example: "A clinic's first invoice is paid. The shop window posts its signed agreement to the engine in an envelope sealed with a stamp only the two of them own; the engine checks the seal and opens the clinic's account.",
    keys: ["vercel.HEALDESK_PROVISION_SECRET", "aws.HEALDESK_PROVISION_SECRET", "vercel.HEALDESK_APP_URL", "aws.HEALDESK_ADMIN_EMAIL"],
    phi: false,
    build: "built",
    proof: "ops",
  },

  // --- The shop side -------------------------------------------------------------
  {
    id: "prospects-web",
    theme: "selling",
    from: "prospects",
    to: "web",
    title: "Clinic owners look around, try AYA, sign and pay",
    carries: "Their work email, their clinic's website, the agreement they sign",
    example: "The owner of a med spa in Austin unlocks the demo with a work email. The site stamps that browser with a pass, so the demo is still unlocked when they come back tomorrow.",
    keys: ["vercel.HEALDESK_GATE_SECRET"],
    phi: false,
    build: "built",
  },
  {
    id: "prospects-posthog",
    theme: "selling",
    from: "prospects",
    to: "posthog",
    title: "Visitor counts, after cookie consent",
    carries: "Which pages were seen and which buttons pressed",
    example: "Shows how many owners reached the pricing page and how many pressed Pay. Nothing loads until the visitor accepts cookies.",
    keys: ["vercel.NEXT_PUBLIC_POSTHOG_KEY"],
    phi: false,
    build: "built",
  },
  {
    id: "web-indexnow",
    theme: "selling",
    from: "web",
    to: "indexnow",
    title: "We tell the search engines a page changed",
    carries: "The public addresses in the sitemap, and nothing else",
    example: "A new guide goes live. After the deploy, GitHub (or the Ping IndexNow button on the SEO tab) sends its address to IndexNow, and Bing and the other engines that share it come to read it within hours instead of weeks.",
    keys: [],
    keyless: "The IndexNow key is a public file on healdesk.io by design: it proves the site owns the pings, and grants nothing else.",
    phi: false,
    build: "built",
  },
  {
    id: "web-stripe",
    theme: "selling",
    from: "web",
    to: "stripe",
    title: "We open a checkout for a buyer",
    carries: "The package, the setup fee and the buyer's email",
    example: "The owner presses Pay. We ask Stripe to show its card page for the setup fee and the monthly plan; we never see the card number.",
    keys: ["vercel.STRIPE_SECRET_KEY"],
    phi: false,
    build: "built",
  },
  {
    id: "stripe-web",
    theme: "selling",
    from: "stripe",
    to: "web",
    title: "Stripe tells us an invoice was paid",
    carries: "\"Invoice paid\", \"checkout expired\" and similar messages",
    example: "Like a courier showing ID at the door: Stripe signs every \"paid\" message, and the shop window opens only for a message with the right signature. A paid first invoice is what sets a clinic up.",
    keys: ["vercel.STRIPE_WEBHOOK_SECRET"],
    phi: false,
    build: "built",
  },
  {
    id: "web-sheets",
    theme: "selling",
    from: "web",
    to: "sheets",
    both: true,
    title: "Leads and setup requests are kept in the Sheet",
    carries: "Demo leads, setup requests, signed agreements until the first invoice, rotation dates, the SEO tab's ticks and AI-answer log",
    example: "A dentist fills in \"Tell us about your clinic\" and a new row appears in the company's Google Sheet; the agreement that clinic signs waits there until its first invoice is paid.",
    keys: ["vercel.GOOGLE_SERVICE_ACCOUNT_JSON", "vercel.MARKETING_SHEET_ID"],
    phi: false,
    build: "built",
    proof: "sheet",
  },
  {
    id: "web-claude",
    theme: "selling",
    from: "web",
    to: "claude-mkt",
    title: "Claude runs the demo chat and reads clinic websites",
    carries: "Owners' questions to the demo, and clinics' public web pages",
    example: "An owner asks the demo \"what do you charge for a consultation?\" and Claude answers as AYA, from a made-up clinic or from the owner's own public website.",
    keys: ["vercel.ANTHROPIC_API_KEY"],
    phi: false,
    build: "built",
  },
  {
    id: "web-retell-demo",
    theme: "selling",
    from: "web",
    to: "retell-demo",
    title: "We ask Retell to ring a clinic owner",
    carries: "The owner's number and which demo to play, or a browser call",
    example: "An owner types a mobile number and presses \"Have AYA call me\"; seconds later that phone rings from our demo number. Or they press \"Talk now\" and speak to AYA in the browser.",
    keys: ["vercel.RETELL_API_KEY", "vercel.RETELL_DEMO_AGENT_ID", "vercel.RETELL_DEMO_FROM_NUMBER", "vercel.RETELL_CLINIC_DEMO_AGENT_ID", "vercel.RETELL_DEMO_INBOUND_AGENT_ID"],
    phi: false,
    build: "built",
  },
  {
    id: "retell-demo-web",
    theme: "selling",
    from: "retell-demo",
    to: "web",
    title: "Retell passes on demo follow-ups",
    carries: "\"Please email me\" requests and calls to the demo line",
    example: "On the demo call the owner says \"have someone email me\". Retell sends that request to us, signed, and we email them.",
    keys: ["vercel.RETELL_WEBHOOK_KEY"],
    phi: false,
    build: "built",
  },
  {
    id: "web-resend",
    theme: "selling",
    from: "web",
    to: "resend",
    title: "Shop-window email goes out",
    carries: "Setup links, nurture emails, the contact form, your sign-in alerts",
    example: "You send a clinic its setup link from Setup; Resend delivers it from hello@healdesk.io, and every reply comes to that inbox.",
    keys: ["vercel.RESEND_API_KEY", "vercel.HEALDESK_EMAIL_FROM"],
    phi: false,
    build: "built",
  },
  {
    id: "resend-web",
    theme: "selling",
    from: "resend",
    to: "web",
    title: "Resend reports bounces and spam complaints",
    carries: "\"Bounced\" and \"marked as spam\", for both apps' email",
    example: "A clinic's old address no longer exists. Resend tells us, and we stop writing to it, which keeps our emails out of spam folders.",
    keys: ["vercel.RESEND_WEBHOOK_SECRET"],
    phi: false,
    build: "built",
  },
  {
    id: "cron-web",
    theme: "running",
    from: "vercel-cron",
    to: "web",
    title: "A daily timer wakes the site",
    carries: "\"Time to tidy up\" and \"time to send today's emails\"",
    example: "At 04:17 every morning a timer knocks with a password and the site deletes stale leads; at 14:07 it sends the day's nurture emails.",
    keys: ["vercel.CRON_SECRET"],
    phi: false,
    build: "built",
  },
  {
    id: "web-github",
    theme: "running",
    from: "web",
    to: "github",
    title: "The AWS on/off switch",
    carries: "\"Turn the host on\" or \"put it in standby\"",
    example: "You press Turn on in Host, and the shop window asks GitHub to run the switch that rebuilds the AWS host from its snapshot. A clinic's first paid invoice presses it for you.",
    keys: ["vercel.HEALDESK_GITHUB_ACTIONS_TOKEN"],
    phi: false,
    build: "built",
    proof: "github-actions",
  },
  {
    id: "github-web-feed",
    theme: "running",
    from: "github",
    to: "web",
    title: "The Changes tab reads the code's history",
    carries: "Recent commits: what changed, and when",
    example: "Opening /admin shows what was built this week, read from GitHub.",
    keys: ["vercel.GITHUB_TOKEN"],
    phi: false,
    build: "built",
    proof: "github-feed",
  },
  {
    id: "github-web-deploy",
    theme: "running",
    from: "github",
    to: "web",
    title: "Every change to main is published",
    carries: "The new version of healdesk.io",
    example: "A change is merged; Vercel sees it on GitHub and publishes the new site a minute later.",
    keys: [],
    keyless: "Vercel's own GitHub app does this; no key of ours is involved.",
    phi: false,
    build: "built",
  },
  {
    id: "web-slack",
    theme: "running",
    from: "web",
    to: "slack",
    title: "Alerts to your Slack",
    carries: "\"Demo claimed\", \"demo held for review\"",
    example: "When a clinic owner opens the personalised demo you built for them, your phone buzzes: \"Demo claimed: Radiance Aesthetics\".",
    keys: ["vercel.SLACK_WEBHOOK_URL"],
    phi: false,
    build: "built",
  },
  {
    id: "web-apify",
    theme: "selling",
    from: "web",
    to: "apify",
    title: "Apify reads websites built in the browser",
    carries: "A clinic's public website address",
    example: "A clinic's site is built on Wix and shows nothing until it loads in a browser; Apify opens it in a real one so the demo can read its prices.",
    keys: ["vercel.APIFY_TOKEN"],
    phi: false,
    build: "built",
  },
  {
    id: "outreach-web",
    theme: "selling",
    from: "outreach",
    to: "web",
    title: "A cold-email reply asks for a demo",
    carries: "The prospect's clinic and website",
    example: "A prospect replies \"sure, show me\" to a cold email; Instantly's reply rule asks the site to build their personalised demo.",
    keys: ["vercel.DEMO_WEBHOOK_SECRET"],
    phi: false,
    build: "built",
  },
  {
    id: "you-outreach",
    theme: "selling",
    from: "you",
    to: "outreach",
    title: "Your cold-email toolkit",
    carries: "Mailboxes, warm-up, inbox tests and sequences",
    example: "Mailboxes are made and warmed in InboxKit, tested with GlockApps and MailReach, and the sequences run in Instantly, all from your own computer.",
    keys: ["computer.INSTANTLY_API_KEY", "computer.INBOXKIT_API_KEY", "computer.GLOCKAPPS_API_KEY", "computer.MAILREACH_API_KEY", "computer.CLOUDFLARE_API_TOKEN"],
    phi: false,
    build: "built",
  },

  // --- The patient side ------------------------------------------------------------
  {
    id: "patients-retell",
    theme: "serving",
    from: "patients",
    to: "retell",
    title: "A patient rings the clinic",
    carries: "The call, forwarded from the clinic's own number",
    example: "Maria calls the clinic at 8pm. The clinic's own number forwards the call to its Retell line, so Maria still dialled the number printed on the clinic's website.",
    keys: [],
    keyless: "The forwarding needs no key: the clinic sets it on its own line (a carrier code, a phone setting or a phone-system rule).",
    dependsOn: "retell-app",
    phi: true,
    build: "built",
    buildNote: "Each clinic's Retell agent and number are set up by hand in Retell's dashboard.",
  },
  {
    id: "retell-app",
    theme: "serving",
    from: "retell",
    to: "app",
    title: "Retell lets the engine run the call",
    carries: "What the caller says, as it is said",
    example: "While Maria talks, Retell streams each sentence to the engine over a private line whose address carries a password; the engine decides every word AYA says back and books the consultation for Thursday at 3pm.",
    keys: ["aws.HEALDESK_RETELL_LLM_SECRET"],
    phi: true,
    build: "built",
    buildNote: "Switched off in AWS (enable_voice) until a test call on a made-up clinic checks Retell's fields.",
  },
  {
    id: "patients-widget",
    theme: "serving",
    from: "patients",
    to: "app",
    title: "A patient chats on the clinic's website",
    carries: "The patient's messages, straight to the engine",
    example: "James opens the chat bubble on the clinic's website at midnight, asks what a first visit costs, and books Friday 10am.",
    keys: [],
    keyless: "Public by design: the bubble names the clinic, and the engine decides whether to answer.",
    phi: true,
    build: "partial",
    buildNote: "The engine's chat is built; the bubble clinics paste on their website is not.",
  },
  {
    id: "app-claude",
    theme: "serving",
    from: "app",
    to: "claude-baa",
    title: "Claude writes AYA's replies to patients",
    carries: "The conversation so far and the clinic's settings; and the portal's support chat, screened first",
    example: "A patient asks \"anything Saturday morning?\". The engine asks Claude, under the business associate agreement, to write AYA's answer, then checks it against the clinic's rules before it is said. The clinic's own support chat in the portal uses the same key, and answers with a fixed line and our support number until it is added.",
    keys: ["aws.ANTHROPIC_API_KEY"],
    phi: true,
    build: "built",
  },
  {
    id: "meta-app",
    theme: "serving",
    from: "meta",
    to: "app",
    title: "Meta passes on patients' messages",
    carries: "Instagram, Messenger and WhatsApp messages to the clinic",
    example: "A patient sends the clinic's Instagram \"how much is a consultation?\". Meta forwards it to the engine, signed with our app secret; anything clinical is caught at the door and never stored.",
    keys: ["aws.META_APP_SECRET", "aws.META_VERIFY_TOKEN"],
    phi: true,
    build: "built",
  },
  {
    id: "app-meta",
    theme: "serving",
    from: "app",
    to: "meta",
    title: "AYA answers in Instagram and Messenger",
    carries: "AYA's reply, inside Meta's 24-hour window only",
    example: "The clinic presses Connect Instagram in its portal and logs in to Facebook; from then on AYA's answer appears in the same chat thread.",
    keys: ["aws.META_APP_ID", "aws.META_LOGIN_CONFIG_ID", "clinic.meta"],
    dependsOn: "meta-app",
    phi: true,
    build: "built",
  },
  {
    id: "app-whatsapp",
    theme: "serving",
    from: "app",
    to: "meta",
    title: "AYA answers on WhatsApp",
    carries: "AYA's reply, inside Meta's 24-hour window only",
    example: "The clinic connects its WhatsApp number through Meta's sign-up window; it goes live once that WhatsApp account has a payment method.",
    keys: ["aws.META_APP_ID", "aws.META_WHATSAPP_CONFIG_ID", "clinic.meta"],
    dependsOn: "meta-app",
    phi: true,
    build: "built",
  },
  {
    id: "app-gcal",
    theme: "serving",
    from: "app",
    to: "gcal",
    both: true,
    title: "AYA checks free times and books into the clinic's calendar",
    carries: "Free and busy times one way, the booking the other",
    example: "AYA sees Thursday 3pm is free, holds it for 60 seconds while she confirms with Maria, and writes the consultation into the clinic's own Google Calendar.",
    keys: ["aws.GOOGLE_OAUTH_CLIENT_ID", "aws.GOOGLE_OAUTH_CLIENT_SECRET", "clinic.google"],
    phi: true,
    build: "built",
  },
  {
    id: "app-stripe",
    theme: "serving",
    from: "app",
    to: "stripe",
    title: "The engine runs each clinic's subscription",
    carries: "Price changes, refunds and extra-usage invoices",
    example: "The day AYA first answers a patient for a clinic, the engine swaps that clinic's $0 placeholder for its real monthly price.",
    keys: ["aws.STRIPE_SECRET_KEY"],
    phi: false,
    build: "built",
  },
  {
    id: "app-clinic-stripe",
    theme: "serving",
    from: "app",
    to: "clinic-stripe",
    title: "AYA sends a deposit link that pays the clinic",
    carries: "An amount and an anonymous reference, never a treatment",
    example: "In web chat a patient books and AYA sends a link to pay the deposit; the money lands in the clinic's own Stripe account, never ours.",
    keys: ["aws.STRIPE_CONNECT_CLIENT_ID", "clinic.stripe"],
    phi: false,
    build: "built",
  },
  {
    id: "clinic-stripe-app",
    theme: "serving",
    from: "clinic-stripe",
    to: "app",
    title: "Stripe tells us a deposit was paid",
    carries: "\"Deposit paid\", and a clinic disconnecting its Stripe",
    example: "The patient pays the deposit by phone; Stripe tells the engine, signed, and the booking shows the deposit as paid.",
    keys: ["aws.STRIPE_CONNECT_WEBHOOK_SECRET"],
    phi: false,
    build: "built",
  },
  {
    id: "app-resend",
    theme: "serving",
    from: "app",
    to: "resend",
    title: "Everyday clinic email goes out",
    carries: "Welcome, sign-in links, and the alerts: an urgent message (sent at once), someone asking for a person, a new booking request, a deposit to collect, a booking to check in the calendar",
    example: "\"Urgent: AYA heard something urgent on a call. Open in healdesk.\" A pointer only, never a patient's name, number, time or words.",
    keys: ["aws.RESEND_API_KEY", "aws.HEALDESK_EMAIL_FROM"],
    phi: false,
    build: "built",
  },
  {
    id: "app-ses",
    theme: "serving",
    from: "app",
    to: "ses",
    title: "Transcripts are emailed to the clinic",
    carries: "The words of a finished call or chat",
    example: "When Maria hangs up, the transcript goes to the clinic through Amazon's email with encryption required, and our copy is deleted once Amazon confirms it arrived.",
    keys: ["aws.HEALDESK_SES_CONFIGURATION_SET"],
    keyless: "No password: AWS lets the engine send because of the role it runs as.",
    phi: true,
    build: "built",
  },
  {
    id: "ses-app",
    theme: "serving",
    from: "ses",
    to: "app",
    title: "Amazon confirms delivery",
    carries: "\"Delivered\" or \"bounced\", with no words",
    example: "Amazon reports the transcript reached the clinic's inbox, and the engine deletes its copy, keeping only a receipt.",
    keys: ["aws.HEALDESK_SES_EVENTS_TOPIC_ARN"],
    keyless: "Amazon signs each report and the engine checks it against Amazon's certificate.",
    phi: false,
    build: "built",
  },
  {
    id: "app-db",
    theme: "serving",
    from: "app",
    to: "db",
    both: true,
    title: "The engine's memory",
    carries: "Clinics, bookings, conversations, settings",
    example: "Bookings and conversations live in the database. A caller's phone number is stored only as a scrambled fingerprint, never as the number itself.",
    keys: ["aws.DATABASE_URL", "aws.HEALDESK_IDENTIFIER_REF_KEY", "aws-ci.MIGRATION_DATABASE_URL"],
    phi: true,
    build: "built",
  },
  {
    id: "app-kms",
    theme: "serving",
    from: "app",
    to: "kms",
    title: "Clinic logins are locked in the key safe",
    carries: "Each clinic's Google, Meta and Stripe logins, to lock and unlock",
    example: "When a clinic connects Google Calendar, its login is locked in a box whose key never leaves Amazon's safe, and every opening is logged.",
    keys: [],
    keyless: "No password: AWS lets the engine use the key safe because of the role it runs as.",
    phi: false,
    build: "built",
    proof: "kms",
  },
  {
    id: "clinic-app",
    theme: "serving",
    from: "clinic",
    to: "app",
    title: "The clinic signs in to its portal",
    carries: "Sign-in links, settings, bookings and conversations",
    example: "The receptionist clicks the sign-in link in the clinic's inbox and confirms with a passkey on the front-desk laptop, then changes the greeting in Settings.",
    keys: ["aws.BETTER_AUTH_SECRET", "aws.BETTER_AUTH_URL"],
    phi: true,
    build: "partial",
    buildNote: "Home, Settings, Knowledge, Billing, the set-up wizard, the support chat and Conversations (opened only behind a passkey) are built; the Bookings screen is not yet.",
  },
  {
    id: "connectors-app",
    theme: "serving",
    from: "connectors",
    to: "app",
    title: "Booking systems report who came in",
    carries: "Appointments and visits from the clinic's own system",
    example: "Phase two: Mindbody would tell us which booked patients actually came. Parked on purpose, because v1 does not claim revenue.",
    keys: [],
    keyless: "Each clinic's own connection, phase two.",
    phi: true,
    build: "parked",
    buildNote: "Phase two: kept in the code, fenced out of v1.",
  },

  // --- Deploys -------------------------------------------------------------------
  {
    id: "github-app",
    theme: "running",
    from: "github",
    to: "app",
    title: "GitHub deploys the engine and switches it on and off",
    carries: "The new version, and \"turn on\" or \"standby\"",
    example: "A change is merged; GitHub builds the new version, and AWS lets it in only because GitHub's signed badge says \"the owner's run, main branch\".",
    keys: [],
    keyless: "No password stored: GitHub shows AWS a signed badge (OIDC) for your runs of main, good for two hours.",
    phi: false,
    build: "built",
  },
  {
    id: "github-cloudflare",
    theme: "running",
    from: "github",
    to: "cloudflare",
    title: "GitHub points app.healdesk.io at the host",
    carries: "The host's new address when it is switched on",
    example: "When the host comes back from standby it has a new load balancer; GitHub updates app.healdesk.io in Cloudflare so the address leads there.",
    keys: ["aws-ci.CLOUDFLARE_API_TOKEN"],
    phi: false,
    build: "built",
  },
];

// -----------------------------------------------------------------------------
// Stories: journeys the map can play, one bridge at a time
// -----------------------------------------------------------------------------

export type StoryDef = {
  id: string;
  title: string;
  /** Each step lights one bridge, in the order the journey uses them. */
  steps: readonly { bridge: string; text: string }[];
};

/**
 * Played on the map with a moving light along each bridge in turn. A step
 * whose bridge is not connected yet says so, which is the point: the story
 * shows where a real journey would stop today.
 */
export const STORIES: readonly StoryDef[] = [
  {
    id: "patient-call",
    title: "A patient calls at 8pm",
    steps: [
      { bridge: "patients-retell", text: "Maria calls the clinic at 8pm. The clinic's own number forwards the call to its Retell line." },
      { bridge: "retell-app", text: "Retell streams what Maria says to the clinic engine, over a private line with a password in its address." },
      { bridge: "app-claude", text: "The engine asks Claude, under a business associate agreement, how AYA should answer." },
      { bridge: "app-gcal", text: "AYA finds Thursday 3pm free in the clinic's Google Calendar, holds it, and books it." },
      { bridge: "app-db", text: "The booking and the conversation are kept in the engine's database." },
      { bridge: "app-ses", text: "When Maria hangs up, the transcript is emailed to the clinic through Amazon, encrypted on the way." },
      { bridge: "ses-app", text: "Amazon confirms it arrived, and the engine deletes its copy." },
    ],
  },
  {
    id: "clinic-buys",
    title: "A clinic buys healdesk",
    steps: [
      { bridge: "prospects-web", text: "A clinic owner finds healdesk.io and unlocks the demo." },
      { bridge: "web-claude", text: "Claude plays AYA in the demo chat, using the owner's own website." },
      { bridge: "web-sheets", text: "The owner asks to be set up; the request is kept in the company's Google Sheet." },
      { bridge: "web-stripe", text: "The owner signs and presses Pay; Stripe shows its card page." },
      { bridge: "stripe-web", text: "Stripe tells the shop window, signed, that the first invoice is paid." },
      { bridge: "web-app", text: "The shop window hands the signed agreement to the clinic engine in a sealed envelope." },
      { bridge: "app-resend", text: "The engine emails the clinic its welcome and its sign-in link." },
    ],
  },
  {
    id: "host-on",
    title: "You switch the AWS host on",
    steps: [
      { bridge: "you-console", text: "You sign in to this console with your password and the code on your phone." },
      { bridge: "web-github", text: "You press Turn on in Host, and the shop window asks GitHub to run the switch." },
      { bridge: "github-app", text: "GitHub rebuilds the engine on AWS; AWS lets it in because of GitHub's signed badge." },
      { bridge: "github-cloudflare", text: "GitHub points app.healdesk.io at the engine's new address." },
    ],
  },
];

// -----------------------------------------------------------------------------
// What was found live
// -----------------------------------------------------------------------------

export type HostReach =
  /** The engine answered the signed call. */
  | { state: "answered"; present: Record<string, boolean>; stripeMode: "test" | "live" | null }
  /** The shop window is missing the seal or the address, so nothing was sent. */
  | { state: "unconfigured" }
  /** No usable answer: the host is in standby, switching, or down. */
  | { state: "silent"; message: string }
  /** It answered and refused: the two seals differ, or the admin address does. */
  | { state: "refused"; message: string };

export type ProofResult = { ok: boolean; detail: string };

export type LiveInputs = {
  now: Date;
  /** For each Vercel key's variable: whether it holds a usable value here. */
  vercel: Record<string, boolean>;
  vercelStripeMode: "test" | "live" | null;
  host: HostReach;
  proofs: Partial<Record<LiveProof, ProofResult>>;
  /** A key id → when that GitHub token expires, as GitHub reports it. */
  expiresAt: Record<string, Date>;
  /** A key id → when the owner last recorded rotating it. */
  rotatedAt: Record<string, Date>;
  /** Whether the rotation log could be read at all. */
  rotationLog: "read" | "unavailable";
};

// -----------------------------------------------------------------------------
// What the page draws
// -----------------------------------------------------------------------------

export type KeyState =
  /** It is there. */
  | "in-place"
  /** Required and not there. */
  | "missing"
  /** Not there on purpose, until something else is done. */
  | "waiting"
  /** Optional and not there: one feature is off. */
  | "optional-off"
  /** Lives on the AWS host and the host did not answer. */
  | "unknown"
  /** A live check says it does not work. */
  | "broken"
  /** Lives where no app can see it. */
  | "not-checked"
  /** One per clinic. */
  | "per-clinic";

export type RotationState = "ok" | "due-soon" | "overdue" | "unrecorded" | "never" | "only-if" | "public" | "not-yet";

export type RotationView = {
  state: RotationState;
  /** One sentence for the owner. */
  text: string;
  /** YYYY-MM-DD, when known. */
  lastOn: string | null;
  dueOn: string | null;
  /** How to do it and what happens meanwhile, when there is anything to do. */
  how: string | null;
  impact: string | null;
  /** Whether "I rotated it today" makes sense for this key. */
  recordable: boolean;
};

export type KeyView = {
  id: string;
  env: string | null;
  home: KeyHome;
  homeLabel: string;
  label: string;
  need: KeyNeed;
  state: KeyState;
  /** One sentence: why it is in this state. */
  stateText: string;
  rotation: RotationView;
  /** Bridge ids that use it. */
  bridges: string[];
};

export type BridgeStatus = "working" | "needs-key" | "off" | "broken" | "unknown" | "to-build" | "parked" | "not-checked";

export type BridgeView = Omit<BridgeDef, "proof"> & {
  n: number;
  status: BridgeStatus;
  /** One sentence: why it is this colour. */
  statusText: string;
  /** Whether a live check ran and passed, beyond keys being present. */
  proven: boolean;
  /** Whether Stripe is on test keys here, which matters to a buyer. */
  testMode: boolean;
};

/** What each colour is called on screen. */
export const STATUS_WORDS: Record<BridgeStatus, string> = {
  working: "Connected",
  "needs-key": "Needs a key",
  off: "Off on purpose",
  broken: "Broken",
  unknown: "Can't check now",
  "to-build": "Still to build",
  parked: "Parked (phase two)",
  "not-checked": "Not checked from here",
};

export type TodoKind = "fix" | "add-key" | "rotate" | "build" | "waiting" | "check";

export type Todo = {
  kind: TodoKind;
  text: string;
  /** The bridge it is about, to jump to. */
  bridge: string | null;
  key: string | null;
};

export type MapView = {
  tools: readonly ToolDef[];
  bridges: BridgeView[];
  keys: KeyView[];
  todos: Todo[];
  counts: Record<BridgeStatus, number>;
  rotationsDue: number;
  host: { state: HostReach["state"]; text: string };
  rotationLog: LiveInputs["rotationLog"];
  checkedAt: string;
};

/** A token this close to its expiry, or a rotation this close to due, is called out. */
export const SOON_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY_MS);
}

/** "in 12 days", "today", "3 days ago". */
export function relativeDays(from: Date, to: Date): string {
  const n = daysBetween(from, to);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n === -1) return "yesterday";
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}

const ADD_HOW: Record<KeyHome, string> = {
  vercel: "Add it in Vercel (healdesk project, Settings, Environment Variables, Production) and redeploy.",
  aws: "Paste it from AWS CloudShell with bash put-external-secrets.sh, then restart the engine.",
  "aws-ci": "Paste it from AWS CloudShell with bash put-external-secrets.sh.",
  computer: "Keep it in your password manager.",
  clinic: "Each clinic makes its own with a login button.",
};

/** Public ids and settings on AWS are Terraform's, not the paste script's. */
const AWS_PUBLIC_HOW = "Set it in infra/aws/production.tfvars and apply (infra.yml).";
const AWS_GENERATED = new Set(["aws.BETTER_AUTH_SECRET", "aws.HEALDESK_IDENTIFIER_REF_KEY", "aws.DATABASE_URL"]);
const AWS_TERRAFORM = new Set([
  "aws.BETTER_AUTH_URL",
  "aws.HEALDESK_ADMIN_EMAIL",
  "aws.HEALDESK_EMAIL_FROM",
  "aws.HEALDESK_SES_CONFIGURATION_SET",
  "aws.HEALDESK_SES_EVENTS_TOPIC_ARN",
  "aws.META_APP_ID",
  "aws.META_LOGIN_CONFIG_ID",
  "aws.META_WHATSAPP_CONFIG_ID",
  "aws.STRIPE_CONNECT_CLIENT_ID",
]);

function addHow(key: KeyDef): string {
  if (AWS_GENERATED.has(key.id)) return "Made inside AWS: run deploy-app.yml with bootstrap_db.";
  if (AWS_TERRAFORM.has(key.id)) return AWS_PUBLIC_HOW;
  if (key.home === "aws" && key.env) return `Paste it from AWS CloudShell with bash put-external-secrets.sh ${key.env}, then restart the engine.`;
  return ADD_HOW[key.home];
}

function keyState(key: KeyDef, live: LiveInputs): { state: KeyState; text: string } {
  const absent = (): { state: KeyState; text: string } => {
    if (key.need === "later") return { state: "waiting", text: `Not added yet, on purpose: it waits until ${key.waitsFor}.` };
    if (key.need === "optional") return { state: "optional-off", text: "Not added. Optional: one feature is off without it." };
    return { state: "missing", text: `Not added yet. ${addHow(key)}` };
  };

  switch (key.home) {
    case "computer":
      return { state: "not-checked", text: "Lives on your computer, where this page cannot look." };
    case "aws-ci":
      return { state: "not-checked", text: "Only a deploy run from GitHub reads it, and no running service is given it, so this page cannot check it." };
    case "clinic":
      return { state: "per-clinic", text: "One per clinic, made when the clinic presses its login button. Ops shows each clinic's." };
    case "vercel": {
      if (!key.env || !live.vercel[key.env]) return absent();
      const expires = live.expiresAt[key.id];
      if (expires && expires.getTime() <= live.now.getTime()) {
        return { state: "broken", text: `Expired ${relativeDays(live.now, expires)}. Make a new one.` };
      }
      return { state: "in-place", text: "In place on Vercel." };
    }
    case "aws": {
      if (live.host.state !== "answered") {
        return { state: "unknown", text: "Can't check right now: the AWS host could not be read." };
      }
      const present = key.env ? live.host.present[key.env] : undefined;
      if (present === undefined) return { state: "unknown", text: "The engine did not report on this one." };
      return present ? { state: "in-place", text: "In place on the AWS host." } : absent();
    }
  }
}

function rotationView(key: KeyDef, state: KeyState, live: LiveInputs): RotationView {
  const none = { how: null, impact: null, lastOn: null, dueOn: null, recordable: false };
  const r = key.rotation;
  switch (r.kind) {
    case "public":
      return { ...none, state: "public", text: "Not a secret: nothing to rotate." };
    case "never":
      return { ...none, state: "never", text: `Never rotate. ${r.why}` };
    case "only-if":
      return { ...none, state: "only-if", text: `Only if ${r.when}.`, how: r.how };
    case "expires": {
      const expires = live.expiresAt[key.id];
      if (state !== "in-place" && state !== "broken") {
        return { ...none, state: "not-yet", text: "Nothing to rotate until it is added.", how: r.how, impact: r.impact };
      }
      if (!expires) {
        return {
          ...none,
          state: "ok",
          text: "GitHub did not report an expiry date: either it never expires, or it could not be asked.",
          how: r.how,
          impact: r.impact,
        };
      }
      const left = daysBetween(live.now, expires);
      return {
        state: left < 0 ? "overdue" : left <= SOON_DAYS ? "due-soon" : "ok",
        text: left < 0 ? `Expired ${relativeDays(live.now, expires)}.` : `Expires on ${day(expires)}, ${relativeDays(live.now, expires)}. Make the new one before then.`,
        lastOn: null,
        dueOn: day(expires),
        how: r.how,
        impact: r.impact,
        recordable: false,
      };
    }
    case "every": {
      const base = { how: r.how, impact: r.impact };
      if (state !== "in-place" && state !== "not-checked" && state !== "unknown") {
        return { ...none, ...base, state: "not-yet", text: "Nothing to rotate until it is added." };
      }
      const last = live.rotatedAt[key.id];
      if (!last) {
        return {
          ...none,
          ...base,
          recordable: true,
          state: "unrecorded",
          text: `Suggested every ${r.days} days. No rotation recorded yet: press "I rotated it today" the next time you do.`,
        };
      }
      const due = new Date(last.getTime() + r.days * DAY_MS);
      const left = daysBetween(live.now, due);
      return {
        ...base,
        recordable: true,
        state: left < 0 ? "overdue" : left <= SOON_DAYS ? "due-soon" : "ok",
        lastOn: day(last),
        dueOn: day(due),
        text:
          left < 0
            ? `Overdue: last rotated ${day(last)}, due ${relativeDays(live.now, due)} (every ${r.days} days, suggested).`
            : `Last rotated ${day(last)}; next ${relativeDays(live.now, due)}, on ${day(due)} (every ${r.days} days, suggested).`,
      };
    }
  }
}

const KEY_BY_ID = new Map(KEYS.map((key) => [key.id, key]));

function proofFailure(bridge: BridgeDef, live: LiveInputs): string | null {
  if (bridge.proof === "ops") {
    if (live.host.state === "refused") return live.host.message;
    return null;
  }
  const result = bridge.proof ? live.proofs[bridge.proof] : undefined;
  return result && !result.ok ? result.detail : null;
}

function proofPassed(bridge: BridgeDef, live: LiveInputs): boolean {
  if (bridge.proof === "ops") return live.host.state === "answered";
  const result = bridge.proof ? live.proofs[bridge.proof] : undefined;
  return Boolean(result?.ok);
}

function bridgeStatus(bridge: BridgeDef, keys: KeyView[], live: LiveInputs): { status: BridgeStatus; text: string } {
  if (bridge.build === "parked") return { status: "parked", text: bridge.buildNote ?? "Parked on purpose." };
  if (bridge.build === "not-built") return { status: "to-build", text: bridge.buildNote ?? "Not built yet." };

  if (bridge.proof === "kms" && live.host.state !== "answered") {
    return { status: "unknown", text: "Can't check right now: the AWS host could not be read, and only it can reach the key safe." };
  }

  const failure = proofFailure(bridge, live);
  if (failure) return { status: "broken", text: failure };
  const broken = keys.find((key) => key.state === "broken");
  if (broken) return { status: "broken", text: `${broken.label}: ${broken.stateText}` };

  // The two copies of one key must match; a Stripe mode that differs between
  // the apps means a buyer pays on one account and the engine looks on another.
  if (bridge.id === "app-stripe" || bridge.id === "web-stripe") {
    const aws = live.host.state === "answered" ? live.host.stripeMode : null;
    if (aws && live.vercelStripeMode && aws !== live.vercelStripeMode) {
      return {
        status: "broken",
        text: `The shop window is on Stripe's ${live.vercelStripeMode} keys and the engine on its ${aws} keys. Both must be the same.`,
      };
    }
  }

  if (bridge.id === "web-app" && live.host.state === "unconfigured") {
    return { status: "needs-key", text: "The shop window is missing the seal or the engine's address, so it cannot reach the engine." };
  }

  const missing = keys.filter((key) => key.state === "missing");
  if (missing.length > 0) {
    return { status: "needs-key", text: `Built, waiting for ${missing.length === 1 ? "a key" : `${missing.length} keys`}: ${missing.map((key) => key.label).join("; ")}.` };
  }

  if (keys.some((key) => key.state === "unknown") || (bridge.id === "web-app" && live.host.state === "silent")) {
    return { status: "unknown", text: "Can't check right now: the AWS host could not be read. It may be in standby (see Host)." };
  }

  const waiting = keys.find((key) => key.state === "waiting");
  if (waiting) return { status: "off", text: `Off on purpose: ${midSentence(waiting.label)} waits until ${KEY_BY_ID.get(waiting.id)?.waitsFor}.` };

  if (bridge.build === "partial") return { status: "to-build", text: bridge.buildNote ?? "Half built." };

  if (keys.length > 0 && keys.every((key) => key.state === "not-checked" || key.state === "per-clinic")) {
    if (keys.every((key) => key.state === "per-clinic")) {
      return { status: "working", text: "Ready: each clinic connects its own with a login button." };
    }
    return { status: "not-checked", text: "Its keys live where this page cannot look." };
  }

  if (proofPassed(bridge, live)) return { status: "working", text: "Connected, and checked live just now." };
  if (bridge.keys.length === 0) return { status: "working", text: bridge.keyless ?? "No key needed." };
  return { status: "working", text: "Connected: every key it needs is in place." };
}

/** Brand names keep their capital mid-sentence; every other label is lower-cased after "Add". */
const PROPER = /^(Stripe|Google|Claude|Resend|Retell|Meta|GitHub|Apify|PostHog|Slack|Cloudflare|Instantly|InboxKit|GlockApps|MailReach|Amazon|AWS)\b/;

function midSentence(label: string): string {
  return PROPER.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1);
}

const TODO_ORDER: Record<TodoKind, number> = { fix: 0, "add-key": 1, rotate: 2, build: 3, check: 4, waiting: 5 };

export function assess(live: LiveInputs): MapView {
  const usedBy = new Map<string, string[]>();
  for (const bridge of BRIDGES) {
    for (const id of bridge.keys) usedBy.set(id, [...(usedBy.get(id) ?? []), bridge.id]);
  }

  const keys: KeyView[] = KEYS.map((key) => {
    const { state, text } = keyState(key, live);
    return {
      id: key.id,
      env: key.env,
      home: key.home,
      homeLabel: HOME_LABEL[key.home],
      label: key.label,
      need: key.need,
      state,
      stateText: text,
      rotation: rotationView(key, state, live),
      bridges: usedBy.get(key.id) ?? [],
    };
  });
  const keyView = new Map(keys.map((key) => [key.id, key]));

  const own = new Map(BRIDGES.map((bridge) => [bridge.id, bridgeStatus(bridge, bridge.keys.map((id) => keyView.get(id)!), live)]));

  const bridges: BridgeView[] = BRIDGES.map((bridge, index) => {
    let { status, text } = own.get(bridge.id)!;
    const dependency = bridge.dependsOn ? BRIDGES.find((other) => other.id === bridge.dependsOn) : undefined;
    const upstream = dependency ? own.get(dependency.id) : undefined;
    if (dependency && upstream && status === "working" && upstream.status !== "working") {
      status = upstream.status === "unknown" ? "unknown" : "off";
      text = `Waits on bridge ${BRIDGES.indexOf(dependency) + 1}, "${dependency.title}". ${upstream.text}`;
    }
    const stripeMode =
      bridge.id === "web-stripe" || bridge.id === "stripe-web"
        ? live.vercelStripeMode
        : bridge.id === "app-stripe" && live.host.state === "answered"
          ? live.host.stripeMode
          : null;
    const { proof: _proof, ...rest } = bridge;
    void _proof;
    return {
      ...rest,
      n: index + 1,
      status,
      statusText: text,
      proven: status === "working" && proofPassed(bridge, live),
      testMode: stripeMode === "test",
    };
  });

  const todos: Todo[] = [];
  for (const bridge of bridges) {
    if (bridge.status === "broken") todos.push({ kind: "fix", text: `${bridge.title}: ${bridge.statusText}`, bridge: bridge.id, key: null });
    if (bridge.status === "to-build") todos.push({ kind: "build", text: `${bridge.title}: ${bridge.statusText}`, bridge: bridge.id, key: null });
  }
  const seenMissing = new Set<string>();
  for (const bridge of bridges) {
    for (const id of bridge.keys) {
      const key = keyView.get(id)!;
      if (key.state === "missing" && !seenMissing.has(id)) {
        seenMissing.add(id);
        todos.push({ kind: "add-key", text: `Add ${midSentence(key.label)}${key.env ? ` (${key.env})` : ""} on ${key.homeLabel}, for "${bridge.title}". ${addHow(KEY_BY_ID.get(id)!)}`, bridge: bridge.id, key: id });
      }
    }
  }
  for (const key of keys) {
    if (key.rotation.state === "overdue" || key.rotation.state === "due-soon") {
      todos.push({ kind: "rotate", text: `Rotate ${midSentence(key.label)}${key.env ? ` (${key.env})` : ""}: ${key.rotation.text}`, bridge: key.bridges[0] ?? null, key: key.id });
    }
  }
  if (live.host.state === "silent") {
    todos.push({ kind: "check", text: "The AWS host could not be read, so its keys could not be checked. If it is in standby, turn it on from Host to see them.", bridge: "web-app", key: null });
  }
  const waitingSeen = new Set<string>();
  for (const key of keys) {
    if (key.state === "waiting" && !waitingSeen.has(key.id)) {
      waitingSeen.add(key.id);
      todos.push({ kind: "waiting", text: `${key.label}${key.env ? ` (${key.env})` : ""}: ${key.stateText}`, bridge: key.bridges[0] ?? null, key: key.id });
    }
  }
  todos.sort((a, b) => TODO_ORDER[a.kind] - TODO_ORDER[b.kind]);

  const counts: Record<BridgeStatus, number> = {
    working: 0,
    "needs-key": 0,
    off: 0,
    broken: 0,
    unknown: 0,
    "to-build": 0,
    parked: 0,
    "not-checked": 0,
  };
  for (const bridge of bridges) counts[bridge.status] += 1;

  return {
    tools: TOOLS,
    bridges,
    keys,
    todos,
    counts,
    rotationsDue: keys.filter((key) => key.rotation.state === "overdue" || key.rotation.state === "due-soon").length,
    host: { state: live.host.state, text: hostText(live.host) },
    rotationLog: live.rotationLog,
    checkedAt: live.now.toISOString(),
  };
}

function hostText(host: HostReach): string {
  switch (host.state) {
    case "answered":
      return "The AWS host answered, so its keys below are read live.";
    case "unconfigured":
      return "This deployment is missing the seal or the engine's address, so the AWS host was not asked.";
    case "silent":
      return `The AWS host could not be read (${host.message}), so its keys show as "can't check". It may be in standby: see Host.`;
    case "refused":
      return `The AWS host refused the signed call: ${host.message}`;
  }
}
