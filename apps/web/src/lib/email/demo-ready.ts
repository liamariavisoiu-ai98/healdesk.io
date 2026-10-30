import {
  escapeEmailHtml,
  PACKAGES,
  packageSetupFeeUsd,
  setupAfterCreditUsd,
  shortClinicName,
} from "@healdesk/catalog";

import {
  demoAudience,
  demoOfferEndsAt,
  demoSetupCredit,
  demoUrl,
  displayName,
  type DemoSession,
} from "@/lib/demo/sessions";
import { ENTITY } from "@/lib/legal";

import { nameForSubject, SUBJECT_MAX } from "./setup-emails";

/**
 * The demo-ready email: the link to the private demo built for a clinic from
 * its own website, sent when its audit clears it (lib/demo/build.ts). It is
 * the confirmation a visitor gets after "See it in your own branding" on the
 * homepage, and what an operator's "send the link" sends.
 *
 * The owner's design, word for word (owner, 30 October 2026: "The html I
 * gave you needs to be applied in place of the current confirmation email"),
 * with the healdesk logo at the top, and his plain-text twin as the text
 * part. Only the placeholders are filled here, from the demo itself:
 *
 * - the setup row shows the package the demo page opens on, Voice + Web Chat,
 *   at the demo's own share off (`demoSetupCredit`: 50% from an operator's
 *   demo, 30% from a homepage one), rounded as checkout rounds it;
 * - while that offer holds (`demoOfferEndsAt`, 48 hours from the demo being
 *   ready). Once it has ended, an email an operator releases late drops the
 *   setup rows and the line under them, so it never promises a discount
 *   checkout would refuse;
 * - a vet's people are its clients (`demoAudience`), so its email says
 *   clients where his says patients.
 *
 * Commercial under CAN-SPAM, because it can carry the setup offer, so it
 * carries what Annex X1.9 and X1.10 ask of a commercial email: the one-click
 * opt-out (the footer's link, and List-Unsubscribe from the sender), why it
 * came, that replies reach a person and should leave out patient details, and
 * the sender's US mailing address. The logo is the email-sized PNG in
 * public/brand, on the public site, since email clients show no WebP.
 */

export type DemoEmail = { subject: string; text: string; html: string };

/** The package the demo page's calculator opens on (lib/demo/v2/template.ts). */
const DEMO_PAGE_PACKAGE = PACKAGES.find((p) => p.id === "voice-webchat")!;

const LOGO_URL = "https://healdesk.io/brand/healdesk-logo-email.png";

function expiryDate(session: DemoSession): string {
  return session.expiresAt.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "America/New_York",
  });
}

function usd(amount: number): string {
  return `$${amount.toLocaleString("en-US")}`;
}

/** The setup offer's figures and deadline while it holds, else null. */
function offer(session: DemoSession, now: number): { discounted: string; list: string; deadline: string } | null {
  const ends = demoOfferEndsAt(session, now);
  if (!ends) return null;
  const list = packageSetupFeeUsd(DEMO_PAGE_PACKAGE);
  return {
    discounted: usd(setupAfterCreditUsd({ setupFeeUsd: list }, demoSetupCredit(session))),
    list: usd(list),
    deadline: ends.toLocaleString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
      timeZoneName: "short",
    }),
  };
}

const SUBJECT_OPENING = "Aya for ";
const SUBJECT_CLOSING = " is ready";

/** Subject, text and HTML, for the sender and the tests. `unsubscribeUrl` is the lead's opt-out. */
export function demoEmail(session: DemoSession, now: number, opts: { unsubscribeUrl: string }): DemoEmail {
  const companyName = displayName(session);
  const companyShort = shortClinicName(companyName);
  const people = demoAudience(session);
  const link = demoUrl(session.slug);
  const expires = expiryDate(session);
  const setup = offer(session, now);
  const leaveOut = people === "clients" ? "client details" : "patient details";

  const subject = `${SUBJECT_OPENING}${nameForSubject(companyShort, SUBJECT_MAX - SUBJECT_OPENING.length - SUBJECT_CLOSING.length)}${SUBJECT_CLOSING}`;

  const text = [
    "Aya is ready.",
    "",
    "Hi there,",
    "",
    `We built Aya for ${companyShort} from your website. Try her here:`,
    link,
    "",
    `Call her first from your browser, then try the chat. She answers as ${companyShort} and knows your services, hours and listed prices. When she doesn't know something, she offers to book a consultation instead of guessing.`,
    "",
    "This is a preview. It isn't connected to your calendar yet, so it won't book real appointments. Once live, Aya books straight into your calendar.",
    "",
    `Preview open until: ${expires}`,
    ...(setup
      ? [`Setup: ${setup.discounted} instead of ${setup.list}, until ${setup.deadline}`, "The monthly price is the same either way."]
      : []),
    "",
    "Someone from our team will call you shortly to walk you through it. Or reply to this email with any question.",
    "",
    "Healdesk Team",
    "",
    "--",
    `Replies reach our team. Please don't include ${leaveOut}.`,
    `You're receiving this because a preview of Aya was requested for ${companyName} with this address.`,
    `Unsubscribe: ${opts.unsubscribeUrl}`,
    `Healdesk, ${ENTITY.postalAddress}`,
  ].join("\n");

  return {
    subject,
    text,
    html: demoEmailHtml({
      companyName: escapeEmailHtml(companyName),
      companyShort: escapeEmailHtml(companyShort),
      people: people === "clients" ? "clients" : "patients",
      leaveOut,
      link: escapeEmailHtml(link),
      expires: escapeEmailHtml(expires),
      setup: setup
        ? {
            discounted: escapeEmailHtml(setup.discounted),
            list: escapeEmailHtml(setup.list),
            deadline: escapeEmailHtml(setup.deadline),
          }
        : null,
      unsubscribeUrl: escapeEmailHtml(opts.unsubscribeUrl),
      address: postalAddressHtml(),
    }),
  };
}

/** The mailing address, with zero-width joiners so no client turns it into a maps link (the owner's markup). */
function postalAddressHtml(): string {
  return `Healdesk, ${escapeEmailHtml(ENTITY.postalAddress)}`
    .replace(/(King|Wilmington|DE 19801)/g, "$1&zwnj;")
    .replace(/(Suite \d+)-/, "$1&zwnj;-");
}

const SANS_TEXT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',Helvetica,Arial,sans-serif";
const SANS_DISPLAY = "-apple-system,BlinkMacSystemFont,'SF Pro Display','Helvetica Neue',Helvetica,Arial,sans-serif";

/** The owner's HTML. Every value passed in is already escaped. */
function demoEmailHtml(v: {
  companyName: string;
  companyShort: string;
  people: string;
  leaveOut: string;
  link: string;
  expires: string;
  setup: { discounted: string; list: string; deadline: string } | null;
  unsubscribeUrl: string;
  address: string;
}): string {
  const cell = `font-family:${SANS_TEXT};font-size:15px;line-height:20px;`;
  const lastBorder = "border-bottom:1px solid #D2D2D7;";
  const dates = v.setup
    ? `
        <tr>
          <td class="rule mute" style="padding:14px 0;border-top:1px solid #D2D2D7;${cell}color:#6E6E73;">Preview open until</td>
          <td align="right" class="rule ink nolink" style="padding:14px 0;border-top:1px solid #D2D2D7;${cell}font-weight:500;color:#1D1D1F;">${v.expires}</td>
        </tr>
        <tr>
          <td class="rule mute" style="padding:14px 0;border-top:1px solid #D2D2D7;${cell}color:#6E6E73;">Setup</td>
          <td align="right" class="rule ink" style="padding:14px 0;border-top:1px solid #D2D2D7;${cell}font-weight:500;color:#1D1D1F;">${v.setup.discounted} <span class="mute" style="font-weight:400;color:#6E6E73;">instead of ${v.setup.list}</span></td>
        </tr>
        <tr>
          <td class="rule mute" style="padding:14px 0;border-top:1px solid #D2D2D7;${lastBorder}${cell}color:#6E6E73;">Setup price holds until</td>
          <td align="right" class="rule ink nolink" style="padding:14px 0;border-top:1px solid #D2D2D7;${lastBorder}${cell}font-weight:500;color:#1D1D1F;">${v.setup.deadline}</td>
        </tr>`
    : `
        <tr>
          <td class="rule mute" style="padding:14px 0;border-top:1px solid #D2D2D7;${lastBorder}${cell}color:#6E6E73;">Preview open until</td>
          <td align="right" class="rule ink nolink" style="padding:14px 0;border-top:1px solid #D2D2D7;${lastBorder}${cell}font-weight:500;color:#1D1D1F;">${v.expires}</td>
        </tr>`;
  const sameEitherWay = v.setup
    ? `
      <p class="mute" style="margin:12px 0 0 0;font-family:${SANS_TEXT};font-size:13px;line-height:18px;color:#6E6E73;">The monthly price is the same either way.</p>`
    : "";
  const body = `font-family:${SANS_TEXT};font-size:17px;line-height:26px;color:#1D1D1F;`;
  const foot = `font-family:${SANS_TEXT};font-size:12px;line-height:18px;color:#6E6E73;`;
  const shy = "&#847;&zwnj;&nbsp;".repeat(18);

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no, url=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>Aya for ${v.companyShort} is ready</title>
<!--[if mso]>
<noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<style>td,th,div,p,a,h1,span{font-family:Helvetica,Arial,sans-serif !important;}</style>
<![endif]-->
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  body { margin:0; padding:0; width:100% !important; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  table { border-collapse:collapse; mso-table-lspace:0; mso-table-rspace:0; }
  img { border:0; line-height:100%; outline:none; text-decoration:none; }
  a[x-apple-data-detectors], .nolink a { color:inherit !important; text-decoration:none !important; font:inherit !important; }
  u + #body a { color:inherit; text-decoration:none; font:inherit; }
  #MessageViewBody a { color:inherit; text-decoration:none; font:inherit; }
  .btn a:hover { opacity:.88; }

  @media (max-width:620px) {
    .wrap { width:100% !important; }
    .px { padding-left:24px !important; padding-right:24px !important; }
    .h1 { font-size:30px !important; line-height:36px !important; }
  }

  @media (prefers-color-scheme: dark) {
    .bg-page { background:#000000 !important; }
    .bg-card { background:#000000 !important; }
    .bg-soft { background:#1C1C1E !important; }
    .bg-foot { background:#000000 !important; }
    .ink { color:#F5F5F7 !important; }
    .mute { color:#A1A1A6 !important; }
    .rule { border-color:#38383A !important; }
    .btn-bg { background:#F5F5F7 !important; }
    .btn-tx { color:#1D1D1F !important; }
  }
  [data-ogsc] .ink { color:#F5F5F7 !important; }
  [data-ogsc] .mute { color:#A1A1A6 !important; }
  [data-ogsb] .bg-page, [data-ogsb] .bg-card, [data-ogsb] .bg-foot { background:#000000 !important; }
  [data-ogsb] .bg-soft { background:#1C1C1E !important; }
</style>
</head>
<body id="body" class="bg-page" style="margin:0;padding:0;background:#FFFFFF;">

<!-- Preheader: the line inboxes show next to the subject -->
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#FFFFFF;opacity:0;">
  Call her from your browser, then try the chat. She answers as ${v.companyShort}.
  ${shy}
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg-page" style="background:#FFFFFF;">
<tr><td align="center" style="padding:0;">

  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="wrap bg-card" style="width:600px;max-width:600px;background:#FFFFFF;">

    <!-- Logo: colour artwork on a transparent PNG, readable on the light and dark backgrounds -->
    <tr><td align="center" class="px" style="padding:48px 48px 0 48px;">
      <a href="https://healdesk.io" style="text-decoration:none;">
        <img src="${LOGO_URL}" width="176" height="32" alt="healdesk" style="display:block;width:176px;height:32px;border:0;outline:none;text-decoration:none;font-family:${SANS_DISPLAY};font-size:20px;line-height:32px;font-weight:600;color:#1D1D1F;">
      </a>
    </td></tr>

    <!-- Eyebrow + headline -->
    <tr><td align="center" class="px" style="padding:56px 48px 0 48px;">
      <p class="mute" style="margin:0 0 12px 0;font-family:${SANS_TEXT};font-size:14px;line-height:20px;font-weight:500;letter-spacing:0.2px;color:#6E6E73;">Built for ${v.companyName}</p>
      <h1 class="h1 ink" style="margin:0;font-family:${SANS_DISPLAY};font-size:40px;line-height:44px;font-weight:700;letter-spacing:-1px;color:#1D1D1F;">Aya is ready.</h1>
    </td></tr>

    <!-- Lede -->
    <tr><td align="center" class="px" style="padding:20px 64px 0 64px;">
      <p class="mute" style="margin:0;font-family:${SANS_TEXT};font-size:19px;line-height:28px;font-weight:400;letter-spacing:-0.2px;color:#6E6E73;">Your front desk, by phone and chat, built from your website.</p>
    </td></tr>

    <!-- Button -->
    <tr><td align="center" class="px btn" style="padding:36px 48px 0 48px;">
      <!--[if mso]>
      <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${v.link}" style="height:48px;v-text-anchor:middle;width:200px;" arcsize="50%" stroke="f" fillcolor="#1D1D1F">
        <w:anchorlock/><center style="color:#FFFFFF;font-family:Helvetica,Arial,sans-serif;font-size:17px;font-weight:600;">Try Aya</center>
      </v:roundrect>
      <![endif]-->
      <!--[if !mso]><!-->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td class="btn-bg" style="background:#1D1D1F;border-radius:980px;">
          <a href="${v.link}" class="btn-tx" style="display:inline-block;padding:14px 40px;font-family:${SANS_TEXT};font-size:17px;line-height:20px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:980px;">Try Aya</a>
        </td>
      </tr></table>
      <!--<![endif]-->
    </td></tr>

    <!-- Body -->
    <tr><td class="px" style="padding:48px 48px 0 48px;">
      <p class="ink" style="margin:0 0 18px 0;${body}">Hi there,</p>
      <p class="ink" style="margin:0 0 18px 0;${body}">Call her first from your browser, then try the chat. She answers as ${v.companyShort} and knows your services, hours and listed prices. When she doesn't know something, she offers to book a consultation instead of guessing.</p>
      <p class="ink" style="margin:0;${body}">Ask her what your ${v.people} ask: a price, your hours, a consultation.</p>
    </td></tr>

    <!-- Preview note -->
    <tr><td class="px" style="padding:32px 48px 0 48px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg-soft" style="background:#F5F5F7;border-radius:14px;">
        <tr><td style="padding:20px 24px;">
          <p class="mute" style="margin:0;font-family:${SANS_TEXT};font-size:15px;line-height:22px;color:#6E6E73;"><span class="ink" style="color:#1D1D1F;font-weight:600;">This is a preview.</span> It isn't connected to your calendar yet, so it won't book real appointments. Once live, Aya books straight into your calendar.</p>
        </td></tr>
      </table>
    </td></tr>

    <!-- Key dates -->
    <tr><td class="px" style="padding:32px 48px 0 48px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${dates}
      </table>${sameEitherWay}
    </td></tr>

    <!-- Close -->
    <tr><td class="px" style="padding:40px 48px 0 48px;">
      <p class="ink" style="margin:0 0 18px 0;${body}">Someone from our team will call you shortly to walk you through it. Or reply to this email with any question.</p>
      <p class="ink" style="margin:0;${body}">Healdesk Team</p>
    </td></tr>

    <!-- Footer -->
    <tr><td class="px" style="padding:64px 48px 48px 48px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td class="rule" style="border-top:1px solid #D2D2D7;padding-top:24px;">
          <p class="mute" style="margin:0 0 10px 0;${foot}">Replies reach our team. Please don't include ${v.leaveOut}.</p>
          <p class="mute" style="margin:0 0 10px 0;${foot}">You're receiving this because a preview of Aya was requested for ${v.companyName} with this address. <a href="${v.unsubscribeUrl}" class="mute" style="color:#6E6E73;text-decoration:underline;">Unsubscribe</a></p>
          <p class="mute nolink" style="margin:0;${foot}">${v.address}</p>
        </td></tr>
      </table>
    </td></tr>

  </table>

</td></tr>
</table>
</body>
</html>
`;
}
