import { cancelScheduledEmail, demoUnsubscribeUrl, sendSafely, type SendResult } from "@/lib/email";
import { canEmail, findLeadByEmail } from "@/lib/leads";
import { ENTITY } from "@/lib/legal";
import { site } from "@/lib/site";

import { postInternalAlert } from "./alert";
import {
  demoOfferEndsAt,
  demoSetupCredit,
  demoUrl,
  displayName,
  isDemoOfferOpen,
  updateDemoSession,
  type DemoSession,
} from "./sessions";

/**
 * The email that tells a prospect their demo's setup discount has just ended
 * (owner, 13 October 2026), with three ways on: write to the team, book a
 * call, or buy anyway.
 *
 * ## Sent at the moment, by Resend
 *
 * The offer ends `DEMO_SETUP_CREDIT_HOURS` after the demo was asked for
 * (demoOfferEndsAt), and the email should land then, not at the next cron:
 * this site's one cron runs daily, because the Hobby plan refuses anything
 * more often (api/cron/nurture says what that cost). So the email is handed
 * to Resend when the demo ships, scheduled for the offer's last moment, and
 * Resend sends it then. The row keeps Resend's id, and a purchase before that
 * moment calls it off (the Stripe webhook, `cancelOfferEndedEmail`), so a
 * clinic that bought is never told its discount expired.
 *
 * What is decided at scheduling is therefore decided early: whether the
 * address has opted out or bounced (the lead row, when there is one), and the
 * words. Nothing in the words can go stale in 48 hours: the name, the share
 * and the demo's own end date are fixed on the row.
 *
 * ## Who gets it
 *
 * The address the demo was asked for with, on a demo the audit cleared, that
 * nobody has bought, while its offer is still open. One per demo, ever: the
 * row's id and Resend's idempotency key both say so.
 */

const TAG = "demo-offer-ended";

/** The demo's own last day, in the words of the email that sent its link (lib/demo/build.ts). */
function longDate(date: Date): string {
  return date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/New_York" });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Where each button goes. The first opens a blank email to the team, the subject filled in and the body left to them. */
export function offerEndedLinks(session: DemoSession): { write: string; meeting: string; buy: string } {
  return {
    write: `mailto:${site.email}?subject=${encodeURIComponent(`About the ${displayName(session)} demo`)}`,
    meeting: site.meeting.url,
    // Remembers the demo and opens the purchase with what the demo knows, after the offer as before it.
    buy: `${demoUrl(session.slug)}/onboard`,
  };
}

/** Subject, text and HTML, exported for the test and the console. */
export function offerEndedEmail(session: DemoSession): { subject: string; text: string; html: string } {
  const name = displayName(session);
  const percent = demoSetupCredit(session).percentOfSetupFee;
  const links = offerEndedLinks(session);
  const until = longDate(session.expiresAt);
  const unsubscribe = demoUnsubscribeUrl(session.id);
  const why = `You're getting this because you asked for a custom demo of ${site.agent}.`;
  const address = `${site.name}, ${ENTITY.postalAddress}`;

  const subject = `Your custom ${percent}% discount just expired — chat with our team`;

  const text = [
    "Hi,",
    "",
    `The ${percent}% off your setup fee that came with ${name}'s custom demo has just ended.`,
    "",
    `If the timing didn't work for you, tell us. Reply to this email or write to ${site.email}, and a person on our team will answer.`,
    "",
    `Chat with our team: ${site.email}`,
    `Book a demo: ${links.meeting}`,
    `Get ${site.agent} now: ${links.buy}`,
    "",
    `Your demo keeps working until ${until}: ${demoUrl(session.slug)}`,
    "",
    `The ${site.name} team`,
    "",
    "--",
    `${why} One click stops our emails: ${unsubscribe}`,
    address,
  ].join("\n");

  const font = "font-family:Helvetica,Arial,sans-serif;";
  const button = (href: string, label: string, tone: "primary" | "secondary" | "tertiary") => {
    const fill = tone === "primary" ? "#da191a" : tone === "secondary" ? "#172a3a" : "#ffffff";
    const ink = tone === "tertiary" ? "#172a3a" : "#ffffff";
    const border = tone === "tertiary" ? "#172a3a" : fill;
    return (
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px;"><tr>` +
      `<td style="border-radius:999px;background:${fill};border:2px solid ${border};">` +
      `<a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 26px;${font}font-size:16px;font-weight:700;line-height:1.2;color:${ink};text-decoration:none;border-radius:999px;">${escapeHtml(label)}</a>` +
      `</td></tr></table>`
    );
  };
  const p = (inner: string) => `<p style="margin:0 0 16px;">${inner}</p>`;

  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:#f7f3ef;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f7f3ef;"><tr><td align="center" style="padding:32px 16px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#fdfdfd;border-radius:12px;">` +
    `<tr><td style="padding:32px 28px;${font}font-size:16px;line-height:1.55;color:#172a3a;">` +
    `<p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#5c6e7e;">Demo offer ended</p>` +
    `<h1 style="margin:0 0 16px;font-size:24px;line-height:1.25;font-weight:700;">Your custom ${percent}% discount just expired</h1>` +
    p(`The ${percent}% off your setup fee that came with ${escapeHtml(name)}&rsquo;s custom demo has just ended.`) +
    p(`If the timing didn&rsquo;t work for you, tell us. A person on our team reads every message and will answer.`) +
    `<div style="margin:24px 0 28px;">` +
    button(links.write, "Chat with our team", "primary") +
    button(links.meeting, "Book a demo", "secondary") +
    button(links.buy, `Get ${site.agent} now`, "tertiary") +
    `</div>` +
    p(
      `Your demo keeps working until ${escapeHtml(until)}: <a href="${escapeHtml(demoUrl(session.slug))}" style="color:#172a3a;">open it</a>.`,
    ) +
    `<p style="margin:0;">The ${escapeHtml(site.name)} team</p>` +
    `</td></tr></table>` +
    `<p style="max-width:560px;margin:16px auto 0;${font}font-size:12.5px;line-height:1.5;color:#5c6e7e;">` +
    `${escapeHtml(why)} <a href="${escapeHtml(unsubscribe)}" style="color:#5c6e7e;">Unsubscribe</a> with one click.<br>${escapeHtml(address)}</p>` +
    `</td></tr></table></body></html>`;

  return { subject, text, html };
}

/**
 * Hand the email to Resend for the moment this demo's offer ends. Called when
 * a demo ships (lib/demo/build.ts), after the audit has cleared it; safe to
 * call again, which does nothing once the row holds an id.
 */
export async function scheduleOfferEndedEmail(session: DemoSession, now: Date = new Date()): Promise<SendResult> {
  if (session.offerEmailId || session.offerEmailCancelledAt) return { status: "skipped", reason: "already scheduled" };
  if (!session.leadEmail) return { status: "skipped", reason: "no prospect email on this demo" };
  if (session.claimed) return { status: "skipped", reason: "the demo was bought" };
  if (!isDemoOfferOpen(session, now.getTime())) return { status: "skipped", reason: "the offer has already ended" };

  // An address that opted out of our mail, or bounced, is left alone. A
  // lookup that fails leaves it alone too: better one email unsent than one
  // sent to somebody who asked us to stop.
  try {
    const lead = await findLeadByEmail(session.leadEmail);
    const permitted = lead ? canEmail(lead, "relationship") : { ok: true as const };
    if (!permitted.ok) return { status: "skipped", reason: permitted.reason };
  } catch (error) {
    console.error("[healdesk] offer-ended email not scheduled: the lead lookup failed", {
      slug: session.slug,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "skipped", reason: "the lead lookup failed" };
  }

  const { subject, text, html } = offerEndedEmail(session);
  const result = await sendSafely({
    to: session.leadEmail,
    subject,
    text,
    html,
    scheduledAt: demoOfferEndsAt(session),
    unsubscribeUrl: demoUnsubscribeUrl(session.id),
    tag: TAG,
    idempotencyKey: `${TAG}:${session.id}`,
  });
  if (result.status === "sent") {
    await updateDemoSession(session.slug, { offerEmailId: result.providerId ?? "unknown" }).catch((error: unknown) => {
      console.error("[healdesk] offer-ended email scheduled but not recorded on the demo", {
        slug: session.slug,
        providerId: result.providerId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } else if (result.status === "failed") {
    console.error("[healdesk] offer-ended email not scheduled", { slug: session.slug, reason: result.reason });
  }
  return result;
}

/**
 * Call the email off: the demo was bought before its offer ended. Never
 * throws, because the Stripe webhook calls it after the purchase is already
 * recorded. A cancel Resend refuses is put to the team, who can still cancel
 * it by hand in Resend before it goes.
 */
export async function cancelOfferEndedEmail(session: DemoSession, now: Date = new Date()): Promise<SendResult> {
  const id = session.offerEmailId;
  if (!id || id === "unknown" || session.offerEmailCancelledAt) return { status: "skipped", reason: "nothing scheduled" };
  if (demoOfferEndsAt(session).getTime() <= now.getTime()) return { status: "skipped", reason: "already sent" };
  try {
    const result = await cancelScheduledEmail(id);
    if (result.status === "sent") {
      await updateDemoSession(session.slug, { offerEmailCancelledAt: now });
    } else if (result.status === "failed") {
      console.error("[healdesk] offer-ended email not cancelled", { slug: session.slug, reason: result.reason });
      await postInternalAlert(
        `Could not cancel the "discount expired" email for ${displayName(session)}, who has bought: cancel ${id} in Resend before ${demoOfferEndsAt(session).toISOString()}. (${result.reason})`,
      );
    }
    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("[healdesk] offer-ended email cancel threw", { slug: session.slug, reason });
    return { status: "failed", reason };
  }
}
