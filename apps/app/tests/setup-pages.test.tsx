import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { WEB_CHAT_COUNTS_LINE } from "@/lib/setup/channels";
import { loadSetupState } from "@/lib/setup/state";
import { publicOrigin, publicUrl } from "@/lib/public-url";

import { axeViolations } from "./setup/axe";
import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant } from "./setup/factories";
import { provisionPortalClinic, type PortalClinic } from "./setup/portal-clinic";
import { brokenLinks } from "./setup/portal-links";
import { renderPage } from "./setup/render-page";

/**
 * The setup wizard's pages (plan Part E) as a clinic's browser receives
 * them, rendered from provisioned clinics with the sign-in stood in: every
 * screen renders, every link on it goes somewhere this build has, and axe
 * finds no WCAG A or AA failure on it. Then the two steps this package
 * finished:
 *
 *   - 2.4: a package with a chat channel may connect its Stripe account,
 *     with "Do it later in Settings → Payments" as the default, and Stripe's
 *     return opens the screen again saying how it went;
 *   - 4: bought channels only; the website line once website chat is open;
 *     the Meta login where Meta was bought; and nothing about forwarding, no
 *     number and no codes, until voice is ready for the clinic, then the
 *     steps, "Email these to my office manager" (O11) and the five-minute
 *     call, with equal weight.
 */

const portal = { userId: "", clinicId: "", clinicSlug: "" };
const steps = vi.hoisted(() => ({ sendStepsOn: vi.fn() }));

vi.mock("@/lib/portal/access", () => ({
  requirePortal: async () => portal,
  portalGrants: async () => [],
  currentSessionToken: async () => null,
}));
vi.mock("@/lib/portal/actor", () => ({
  portalActor: async () => ({ label: "the clinic's sign-in", steppedUp: false }),
  SIGN_IN_ACTOR_LABEL: "the clinic's sign-in",
}));
vi.mock("@/lib/notices/steps-sent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notices/steps-sent")>()),
  sendStepsOn: steps.sendStepsOn,
}));

const describeDb = hasTestDatabase ? describe : describe.skip;

/** Environment a test sets, put back after it. */
const ENV_KEYS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_CONNECT_CLIENT_ID",
  "META_APP_ID",
  "META_APP_SECRET",
  "META_LOGIN_CONFIG_ID",
  "HEALDESK_CALL_BOOKING_URL",
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

let voiceWeb: PortalClinic;
let everything: PortalClinic;
let voiceOnly: PortalClinic;

function as(clinic: PortalClinic) {
  Object.assign(portal, {
    userId: clinic.userId,
    clinicId: clinic.clinicId,
    clinicSlug: clinic.clinicSlug,
  });
}

async function wizard(search: Record<string, string>): Promise<string> {
  const { default: SetupPage } = await import("@/app/c/[slug]/setup/page");
  return renderPage(
    <SetupPage
      params={Promise.resolve({ slug: portal.clinicSlug })}
      searchParams={Promise.resolve(search)}
    />,
  );
}

/** Text as a person reads it: tags out, entities back. */
function text(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** A clinic's channel row, inside its tenant (clinic_channels forces row-level security). */
async function setChannel(clinic: PortalClinic, channel: string, set: string) {
  await inTenant(clinic.clinicId, (c) =>
    c.query(`update clinic_channels set ${set} where clinic_id = $1 and channel = $2`, [
      clinic.clinicId,
      channel,
    ]),
  );
}

/** Voice ready for the clinic, as the channel events and the runtime leave it. */
async function voiceReady(clinic: PortalClinic, options: { directLine: boolean }) {
  await setChannel(clinic, "voice", `ready_at = now(), waiting_on = 'forwarding'`);
  await getMigratorPool().query(
    `update clinics set assistant_number_e164 = '+15125550142', carrier = 'att', phone_system_type = 'landline' where id = $1`,
    [clinic.clinicId],
  );
  await inTenant(clinic.clinicId, (c) =>
    c.query(`update clinic_settings set direct_line_e164 = $2 where clinic_id = $1`, [
      clinic.clinicId,
      options.directLine ? "+15125550199" : null,
    ]),
  );
}

describeDb("the setup wizard's pages", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    voiceWeb = await provisionPortalClinic("wizardpages", { plan: "voice-webchat-1000-1000" });
    everything = await provisionPortalClinic("wizardmeta", { plan: "voice-metachat-1000-1000" });
    voiceOnly = await provisionPortalClinic("wizardvoice", { plan: "voice-300" });
    // The page and its actions, imported once outside any test's clock.
    await import("@/app/c/[slug]/setup/page");
    await import("@/app/c/[slug]/steps-actions");
    await import("@/app/api/meta/login/route");
  }, 300_000);

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    steps.sendStepsOn.mockReset();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  afterAll(async () => {
    await closePools();
  });

  test("every screen renders, every link on it goes somewhere, and axe finds no WCAG A or AA failure", async () => {
    for (const clinic of [voiceWeb, everything, voiceOnly]) {
      as(clinic);
      const state = await loadSetupState({
        clinicId: clinic.clinicId,
        userId: clinic.userId,
        actor: { type: "system" },
      });
      expect(state!.screens.length).toBeGreaterThan(8);
      for (const screen of state!.screens) {
        const html = await wizard({ s: screen });
        expect(text(html), screen).toMatch(/Step [1-4] of 4|One last thing/);
        expect(brokenLinks(html, clinic.clinicSlug), screen).toEqual([]);
        expect(await axeViolations(html, "Set up AYA"), screen).toEqual([]);
      }
    }
  }, 60_000);

  describe("2.4: deposits and the payment account", () => {
    test("a chat package may connect Stripe; doing it later in Settings → Payments is the default", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_wizard";
      process.env.STRIPE_CONNECT_CLIENT_ID = "ca_wizard";
      as(voiceWeb);
      const html = await wizard({ s: "deposits" });
      const words = text(html);
      expect(words).toContain(
        "Until a payment account is connected, AYA books the appointment and flags the deposit for your team to collect.",
      );
      expect(words).toContain("Do it later in Settings → Payments");
      expect(html).toContain(
        `href="/api/connect/stripe/start?clinic=${voiceWeb.clinicSlug}&amp;from=setup"`,
      );
      expect(words).toContain("Connect Stripe");
      // Outside the screen's form, so leaving for Stripe loses nothing typed.
      const form = html.slice(html.indexOf("<form"), html.indexOf("</form>"));
      expect(form).not.toContain("/api/connect/stripe/start");
      expect(brokenLinks(html, voiceWeb.clinicSlug)).toEqual([]);
      expect(await axeViolations(html)).toEqual([]);
    });

    test("without Connect on this host, the button is not offered; voice alone is never offered it", async () => {
      delete process.env.STRIPE_CONNECT_CLIENT_ID;
      as(voiceWeb);
      const off = text(await wizard({ s: "deposits" }));
      expect(off).not.toContain("Connect Stripe");
      expect(off).toContain("Email hello@healdesk.io and we’ll connect it with you.");

      process.env.STRIPE_SECRET_KEY = "sk_test_wizard";
      process.env.STRIPE_CONNECT_CLIENT_ID = "ca_wizard";
      as(voiceOnly);
      const voice = await wizard({ s: "deposits" });
      expect(voice).not.toContain("/api/connect/stripe/start");
      expect(text(voice)).toContain(
        "On a call AYA can't take a card, so she books the appointment and flags the deposit for your team to collect.",
      );
    });

    test("Stripe's return opens the screen again saying how it went, and a connected account says so", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_wizard";
      process.env.STRIPE_CONNECT_CLIENT_ID = "ca_wizard";
      as(voiceWeb);
      const declined = text(await wizard({ connect: "declined" }));
      expect(declined).toContain("Do any treatments need a deposit?");
      expect(declined).toContain("Stripe wasn't connected: it was declined on Stripe's page.");

      await getMigratorPool().query(
        `update clinics set stripe_connect_account_id = 'acct_1Wizard', stripe_connect_connected_at = now() where id = $1`,
        [voiceWeb.clinicId],
      );
      try {
        const html = await wizard({ connect: "ok" });
        const words = text(html);
        expect(html).toMatch(/role="status"[^>]*>Your Stripe account is connected\.</);
        expect(words).toContain(
          "In chat AYA sends a secure link to pay the deposit into your Stripe account. On a call she can't take a card, so she books and flags it for your team.",
        );
        expect(html).not.toContain("/api/connect/stripe/start");
      } finally {
        await getMigratorPool().query(
          `update clinics set stripe_connect_account_id = null, stripe_connect_connected_at = null where id = $1`,
          [voiceWeb.clinicId],
        );
      }
    });
  });

  describe("4: your channels", () => {
    test("before anything is ready: bought channels only, no line to paste, no number and no codes", async () => {
      process.env.META_APP_ID = "1234";
      process.env.META_APP_SECRET = "meta-secret";
      process.env.META_LOGIN_CONFIG_ID = "5678";
      as(voiceWeb);
      const html = await wizard({ s: "channels" });
      const words = text(html);
      expect(words).toContain("Website chat");
      expect(words).toContain("Phone");
      expect(words).not.toContain("Instagram");
      expect(html).not.toContain("/api/meta/login");
      expect(words).not.toContain("<script");
      expect(words).not.toMatch(
        /\*7[23]|\*9[0-3]|Forward your main line|Email these to my office manager/,
      );
      expect(words).not.toContain("555-0142");
      expect(brokenLinks(html, voiceWeb.clinicSlug)).toEqual([]);
      expect(await axeViolations(html)).toEqual([]);
    });

    test("Meta bought: the Facebook login posts the clinic's own slug, or hello@ when it is not switched on", async () => {
      as(everything);
      process.env.META_APP_ID = "1234";
      process.env.META_APP_SECRET = "meta-secret";
      process.env.META_LOGIN_CONFIG_ID = "5678";
      const html = await wizard({ s: "channels" });
      expect(html).toMatch(
        /<form[^>]*action="\/api\/meta\/login"[^>]*method="post"|<form[^>]*method="post"[^>]*action="\/api\/meta\/login"/,
      );
      expect(html).toContain(
        `<input type="hidden" name="clinic" value="${everything.clinicSlug}"/>`,
      );
      expect(text(html)).toContain("Connect with Facebook");
      expect(text(html)).toContain("AYA is designed to reply only to people who message you");
      expect(await axeViolations(html)).toEqual([]);

      delete process.env.META_LOGIN_CONFIG_ID;
      const off = await wizard({ s: "channels" });
      expect(off).not.toContain("/api/meta/login");
      expect(text(off)).toContain("Email hello@healdesk.io and we’ll connect Facebook and Instagram with you.");

      // A login that could not start comes back here and says why.
      const back = text(await wizard({ s: "channels", meta: "not_configured" }));
      expect(back).toContain("Connecting Facebook and Instagram isn't switched on here.");
    });

    test("website chat open: the line to paste, naming the clinic on the public origin", async () => {
      as(voiceWeb);
      await setChannel(voiceWeb, "web", `ready_at = now(), waiting_on = 'snippet'`);
      try {
        const html = await wizard({ s: "channels" });
        const words = text(html);
        expect(words).toContain("Website chat Waiting on you Paste one line on your website.");
        expect(words).toContain("The line for your website");
        // Go-live is automatic: a chat on the live site is a real one (WP2).
        expect(words).toContain(WEB_CHAT_COUNTS_LINE);
        expect(words).toContain(
          `<script src="${publicUrl("/widget/v1.js")}" data-clinic="${voiceWeb.clinicSlug}" async></script>`,
        );
        expect(words).toContain("Copy the line");
        expect(words).not.toContain(process.env.HEALDESK_APP_URL ?? "app-internal");
        expect(await axeViolations(html)).toEqual([]);
      } finally {
        await setChannel(voiceWeb, "web", `ready_at = null, waiting_on = null`);
      }
    });

    test("phone ready but no direct line: no number yet, and the way to set the line", async () => {
      as(voiceWeb);
      await voiceReady(voiceWeb, { directLine: false });
      try {
        const html = await wizard({ s: "channels" });
        expect(text(html)).not.toContain("555-0142");
        expect(html).toContain(`href="/c/${voiceWeb.clinicSlug}/setup?s=direct_line"`);
        expect(brokenLinks(html, voiceWeb.clinicSlug)).toEqual([]);
      } finally {
        await setChannel(voiceWeb, "voice", `ready_at = null, waiting_on = null`);
      }
    });

    test("phone ready for the clinic: AYA's number, its carrier's codes, the undo, the email and the call, with equal weight", async () => {
      process.env.HEALDESK_CALL_BOOKING_URL = "https://cal.example.com/healdesk/five-minutes";
      as(voiceWeb);
      await voiceReady(voiceWeb, { directLine: true });
      try {
        const html = await wizard({ s: "channels" });
        const words = text(html);
        expect(words).toContain("Phone Waiting on you Set call forwarding on your main line.");
        expect(words).not.toContain("Don't change your call forwarding");
        expect(words).toContain("Forward your main line’s calls to AYA");
        expect(words).toContain("(512) 555-0142");
        // AT&T, overflow and after hours (the default): busy and no-answer
        // forwarding, which AT&T Phone ends with #, and its undo.
        expect(words).toContain("*905125550142#");
        expect(words).toContain("*925125550142#");
        expect(words).toContain("To undo it at any time");
        expect(words).toContain("*91#");
        expect(html).toMatch(/<option value="att" selected="">AT&amp;T<\/option>/);
        expect(words).toContain("Email these to my office manager");
        expect(html).toMatch(
          /<a href="\/help\/call"[^>]*>Book a five-minute call and we(’|&#x27;|&rsquo;)ll do it with you<\/a>/,
        );
        expect(brokenLinks(html, voiceWeb.clinicSlug)).toEqual([]);
        expect(await axeViolations(html)).toEqual([]);
      } finally {
        await setChannel(voiceWeb, "voice", `ready_at = null, waiting_on = null`);
      }
    });

    test("Email these to my office manager: the screen's form sends through Settings' own action, with the stored number", async () => {
      // The wizard's form calls the action Settings → Channels uses
      // (app/c/[slug]/steps-actions.ts), which reads AYA's number itself:
      // before phone is ready there is none to give, and sendStepsOn refuses.
      const source = await import("node:fs").then((fs) =>
        fs.readFileSync("src/app/c/[slug]/setup/screens/ChannelsScreen.tsx", "utf8"),
      );
      expect(source).toContain('from "../../steps-actions"');
      const { sendPhoneStepsAction } = await import("@/app/c/[slug]/steps-actions");
      as(voiceWeb);
      steps.sendStepsOn.mockResolvedValueOnce({
        status: "refused",
        message: "Phone isn't ready for call forwarding yet, so there are no steps to send.",
      });
      expect(await sendPhoneStepsAction(voiceWeb.clinicSlug, "maria@example.com")).toEqual({
        ok: false,
        message: "Phone isn't ready for call forwarding yet, so there are no steps to send.",
      });
      expect(steps.sendStepsOn).toHaveBeenLastCalledWith(
        expect.objectContaining({ channel: "voice", ayaNumberE164: null }),
      );

      await voiceReady(voiceWeb, { directLine: true });
      try {
        steps.sendStepsOn.mockResolvedValueOnce({ status: "sent", to: "maria@example.com" });
        expect(await sendPhoneStepsAction(voiceWeb.clinicSlug, "maria@example.com")).toEqual({
          ok: true,
          message: "Sent to maria@example.com.",
        });
        expect(steps.sendStepsOn).toHaveBeenLastCalledWith(
          expect.objectContaining({
            clinicId: voiceWeb.clinicId,
            channel: "voice",
            to: "maria@example.com",
            ayaNumberE164: "+15125550142",
          }),
        );
      } finally {
        await setChannel(voiceWeb, "voice", `ready_at = null, waiting_on = null`);
      }
    });
  });

  describe("the Meta login from the portal", () => {
    function post(fields: Record<string, string>): Request {
      return new Request("https://app.healdesk.test/api/meta/login", {
        method: "POST",
        body: new URLSearchParams(fields),
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "vitest", origin: publicOrigin() },
      });
    }

    test("the clinic's own session mints a one-day Meta link for it and sends the browser to Facebook", async () => {
      process.env.META_APP_ID = "1234";
      process.env.META_APP_SECRET = "meta-secret";
      process.env.META_LOGIN_CONFIG_ID = "5678";
      as(everything);
      const { POST } = await import("@/app/api/meta/login/route");
      const response = await POST(post({ clinic: everything.clinicSlug }));
      expect(response.status).toBe(303);
      const location = new URL(response.headers.get("location")!);
      expect(location.origin).toBe("https://www.facebook.com");
      expect(location.searchParams.get("config_id")).toBe("5678");
      expect(location.searchParams.get("redirect_uri")).toBe(publicUrl("/api/meta/callback"));
      // Only a nonce goes to Meta; the link token rides in the HttpOnly cookie.
      const cookie = response.headers.get("set-cookie")!;
      expect(cookie).toMatch(
        /^hd_meta_login=[A-Za-z0-9_-]+; Max-Age=900; Path=\/api\/meta; HttpOnly; Secure; SameSite=Lax$/,
      );
      expect(location.searchParams.get("state")).not.toBe("");
      const links = await inTenant(
        everything.clinicId,
        async (c) =>
          (
            await c.query<{ purpose: string; issued_by: string; hours: number }>(
              `select purpose, issued_by, extract(epoch from expires_at - created_at) / 3600 as hours
               from connection_links where clinic_id = $1`,
              [everything.clinicId],
            )
          ).rows,
      );
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({ purpose: "meta", issued_by: everything.userId });
      expect(Number(links[0]!.hours)).toBeLessThanOrEqual(24.01);
    });

    test("not switched on comes back to the channels screen; a malformed slug is not found", async () => {
      delete process.env.META_LOGIN_CONFIG_ID;
      as(everything);
      const { POST } = await import("@/app/api/meta/login/route");
      const off = await POST(post({ clinic: everything.clinicSlug }));
      expect(off.status).toBe(303);
      expect(off.headers.get("location")).toBe(
        publicUrl(`/c/${everything.clinicSlug}/setup?s=channels&meta=not_configured`),
      );
      expect(off.headers.get("set-cookie")).toBeNull();
      expect((await POST(post({ clinic: "../admin" }))).status).toBe(404);
    });

    test("from Settings it returns to Settings and the cookie remembers it; an unknown `from` means set-up; a foreign Origin is refused", async () => {
      process.env.META_APP_ID = "1234";
      process.env.META_APP_SECRET = "meta-secret";
      process.env.META_LOGIN_CONFIG_ID = "5678";
      as(everything);
      const { POST } = await import("@/app/api/meta/login/route");
      const { decodeLoginCookie } = await import("@/lib/meta/login-state");
      const fromSettings = await POST(post({ clinic: everything.clinicSlug, from: "settings" }));
      const raw = fromSettings.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;
      expect(decodeLoginCookie(raw)?.from).toBe("settings");
      const other = await POST(post({ clinic: everything.clinicSlug, from: "https://evil.example" }));
      expect(decodeLoginCookie(other.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!)?.from).toBe("setup");

      const foreign = new Request("https://app.healdesk.test/api/meta/login", {
        method: "POST",
        body: new URLSearchParams({ clinic: everything.clinicSlug }),
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      });
      expect((await POST(foreign)).status).toBe(404);
      const none = new Request("https://app.healdesk.test/api/meta/login", {
        method: "POST",
        body: new URLSearchParams({ clinic: everything.clinicSlug }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      expect((await POST(none)).status).toBe(404);

      delete process.env.META_LOGIN_CONFIG_ID;
      const off = await POST(post({ clinic: everything.clinicSlug, from: "settings" }));
      expect(off.headers.get("location")).toBe(
        publicUrl(`/c/${everything.clinicSlug}/settings?meta=not_configured#channels`),
      );
    });
  });
});
