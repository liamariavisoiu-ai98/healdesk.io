import { NO_PLATFORM_ID, type ConnectionMethod } from "./platforms";

/**
 * The connection wizard, per platform.
 *
 * The clinic's job is to create a read-only account for us and paste one
 * credential. Ours is everything after that. So these steps are written for
 * someone who has never seen an API key, one action per step, in the platform's
 * own words — "Manage Users", not "the user management interface".
 *
 * Two rules that matter more than the wording:
 *
 *   1. **Never ask for the owner's own login.** It violates essentially every
 *      platform's terms, destroys the audit trail, and is the request that
 *      makes a careful clinic walk away. Always a separate named user for us.
 *   2. **Say what the credential can see.** A step that says "paste your API
 *      key" without saying what it grants is the step people abandon.
 *
 * `verified` marks steps confirmed against the platform's own documentation.
 * Unverified steps are shown with a "may differ" note rather than presented as
 * certain — being confidently wrong about someone's admin screen is worse than
 * admitting the screen may have moved.
 */

export type WizardStep = {
  /** One action. If it needs "and", it is two steps. */
  title: string;
  /** Detail, only where the title isn't enough. */
  detail?: string;
  /** Deep link into the platform's settings, where one exists. */
  link?: { label: string; url: string };
  /** Text the clinic copies — an email address, a role name. */
  copyable?: string;
};

export type CredentialField = {
  name: string;
  label: string;
  /** What it looks like, so they know they've got the right thing. */
  placeholder?: string;
  help?: string;
  secret: boolean;
};

export type ConnectionGuide = {
  platformId: string;
  method: ConnectionMethod;
  /** Realistic, and honest when it isn't instant. */
  estimatedMinutes: number;
  /** Set when the clinic must ask the vendor for something first. */
  vendorRequestNeeded?: string;
  steps: WizardStep[];
  fields: CredentialField[];
  /** What this connection lets us read. Shown before they start. */
  grants: string[];
  /** What it explicitly does not. Shown just as prominently. */
  doesNotGrant: string[];
  verified: boolean;
};

/** The address a clinic adds as our read-only user. */
export const CONNECT_EMAIL_TEMPLATE = "connect+{slug}@healdesk.io";

export function connectEmailFor(clinicSlug: string): string {
  return CONNECT_EMAIL_TEMPLATE.replace("{slug}", clinicSlug);
}

const COMMON_DOES_NOT_GRANT = [
  "Clinical notes or charts",
  "The ability to change anything in your system",
  "Payment card details",
];

export const CONNECTION_GUIDES: Record<string, ConnectionGuide> = {
  acuity: {
    platformId: "acuity",
    method: "readonly_user",
    estimatedMinutes: 3,
    verified: true,
    steps: [
      {
        title: "Open Manage Users in Acuity",
        link: {
          label: "Acuity → Manage Users",
          url: "https://secure.acuityscheduling.com/admin/users.php",
        },
      },
      {
        title: "Click New User",
      },
      {
        title: "Enter this email address",
        detail: "We'll receive the invitation and finish the setup ourselves.",
        copyable: "{connectEmail}",
      },
      {
        title: 'Set Access level to "View only"',
        detail:
          "This is the important one — it means we can read your appointments but cannot change anything.",
      },
      {
        title: 'Tick "Allow export of clients and appointments"',
        detail: "Without this we can see appointments but not report on them.",
      },
      {
        title: "Save, then paste the User ID and API key below",
        detail:
          "Both are under Integrations → API in Acuity, once the new user exists.",
      },
    ],
    fields: [
      {
        name: "userId",
        label: "Acuity User ID",
        placeholder: "12345678",
        secret: false,
      },
      {
        name: "apiKey",
        label: "API key",
        placeholder: "abc123…",
        secret: true,
      },
    ],
    grants: [
      "Your appointments and their status",
      "Payments recorded against an appointment",
    ],
    doesNotGrant: [
      ...COMMON_DOES_NOT_GRANT,
      "Whether a patient actually arrived — Acuity has no arrival concept, so we infer attendance from payment timing and label it as inferred",
    ],
  },

  mindbody: {
    platformId: "mindbody",
    method: "readonly_user",
    estimatedMinutes: 6,
    verified: true,
    steps: [
      {
        title: "Open Staff → Manage Staff in Mindbody",
      },
      {
        title: "Create a permission group for reporting only",
        detail:
          "Clone an existing group and remove everything except the report permissions. Mindbody lets you set these individually.",
      },
      {
        title: "Add a new staff member with this email",
        copyable: "{connectEmail}",
      },
      {
        title: "Assign them the reporting-only group you just created",
      },
      {
        title: "Send the invitation, then tell us below",
        detail:
          "We'll accept it and configure the rest, including the scheduled export.",
      },
    ],
    fields: [
      {
        name: "siteId",
        label: "Mindbody Site ID",
        placeholder: "-99",
        help: "Shown in Mindbody under Business Information.",
        secret: false,
      },
    ],
    grants: ["Your sales and appointment reports"],
    doesNotGrant: [
      ...COMMON_DOES_NOT_GRANT,
      "Anything through Mindbody's developer API — we deliberately don't use it, because their terms prohibit what we do. This is a read-only account under your own Mindbody subscription instead.",
    ],
  },

  zenoti: {
    platformId: "zenoti",
    method: "readonly_user",
    estimatedMinutes: 5,
    vendorRequestNeeded:
      "Zenoti requires an API package on your subscription. Ask your Zenoti account manager to enable it — it usually takes a day or two.",
    verified: true,
    steps: [
      {
        title: "Ask your Zenoti account manager to enable the API package",
        detail:
          "This is a subscription setting, not something in the admin screens. We can't proceed until it's on.",
      },
      {
        title: "Open Admin → Setup → Apps in Zenoti",
      },
      {
        title: "Create a backend app and generate an API key",
      },
      {
        title: "Add this email as a user with report access",
        detail:
          "Zenoti only lets scheduled reports go to named users, not arbitrary addresses.",
        copyable: "{connectEmail}",
      },
      {
        title: "Paste the API key and your Centre ID below",
      },
    ],
    fields: [
      {
        name: "apiKey",
        label: "Zenoti API key",
        placeholder: "…",
        secret: true,
      },
      {
        name: "centerId",
        label: "Centre ID",
        placeholder: "00000000-0000-0000-0000-000000000000",
        secret: false,
      },
    ],
    grants: [
      "Appointments, including check-in and no-show status",
      "Invoices and collected payments",
    ],
    doesNotGrant: COMMON_DOES_NOT_GRANT,
  },

  vagaro: {
    platformId: "vagaro",
    method: "readonly_user",
    estimatedMinutes: 5,
    vendorRequestNeeded:
      "Vagaro reviews API requests manually and it can take up to seven business days. Start this first — the rest of your setup doesn't wait on it.",
    verified: true,
    steps: [
      {
        title: "Open Settings → Developers → APIs & Webhooks in Vagaro",
      },
      {
        title: "Request API access",
        detail:
          "Vagaro requires a paid account using their card processing. Approval takes up to seven business days.",
      },
      {
        title: "Once approved, copy the Client ID and Client Secret",
      },
      {
        title: "Paste them below",
      },
    ],
    fields: [
      {
        name: "clientId",
        label: "Client ID",
        secret: false,
      },
      {
        name: "clientSecret",
        label: "Client Secret",
        secret: true,
      },
    ],
    grants: [
      "Appointments and their status, including no-shows",
      "Sales, from the moment you connect onward",
    ],
    doesNotGrant: [
      ...COMMON_DOES_NOT_GRANT,
      "Sales history from before you connect — Vagaro sends us sales as they happen but won't let us ask for past ones, so verified revenue starts from your connection date",
    ],
  },

  patientnow: {
    platformId: "patientnow",
    method: "readonly_user",
    estimatedMinutes: 5,
    vendorRequestNeeded:
      "PatientNow issues API keys on request. Email their support asking for API access for a reporting integration.",
    verified: false,
    steps: [
      {
        title: "Ask PatientNow support for an API key",
        detail:
          "Tell them it's for a read-only reporting integration. They issue the key rather than you generating it.",
      },
      {
        title: "Create a user for us with reporting access",
        copyable: "{connectEmail}",
      },
      {
        title: "Paste the API key and that user's credentials below",
        detail:
          "PatientNow needs both — the key identifies the integration, the user identifies the permissions.",
      },
    ],
    fields: [
      { name: "apiKey", label: "API key", secret: true },
      { name: "username", label: "Username", secret: false },
      { name: "password", label: "Password", secret: true },
    ],
    grants: [
      "Appointments, including check-in status",
      "Orders with line items and payments",
    ],
    doesNotGrant: COMMON_DOES_NOT_GRANT,
  },
};

export function getConnectionGuide(
  platformId: string,
): ConnectionGuide | undefined {
  if (platformId === NO_PLATFORM_ID) return undefined;
  return CONNECTION_GUIDES[platformId];
}

/** Substitute per-clinic values into a guide's copyable fields. */
export function personaliseGuide(
  guide: ConnectionGuide,
  clinicSlug: string,
): ConnectionGuide {
  const email = connectEmailFor(clinicSlug);
  return {
    ...guide,
    steps: guide.steps.map((step) => ({
      ...step,
      copyable: step.copyable?.replace("{connectEmail}", email),
    })),
  };
}
