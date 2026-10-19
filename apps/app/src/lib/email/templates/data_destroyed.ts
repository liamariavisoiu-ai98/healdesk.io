import { BACKUP_RETENTION_DAYS } from "@healdesk/catalog";

import { dayLong, dayShort, person } from "./billing-copy";
import { compose } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * E6, "Your data has been destroyed" (Annex X5), once, when the destruction
 * job has destroyed the clinic's data, to the address captured in the
 * destruction's own transaction (lib/offboarding/after-cancellation.ts),
 * not to the clinic's address as it stands later.
 *
 * What was destroyed, and when; when the account closes, and what goes with
 * it; then what remains and why, in the words of the agreement the service
 * ended under (BAA 1.3.0's Term clause and its successors; the DPA's), so the
 * email promises nothing the agreement does not:
 *
 *   - the database backups, which expire within BACKUP_RETENTION_DAYS of the
 *     destruction and are used only to restore our systems;
 *   - what Anthropic keeps under its agreement with us, as Terms §9 says;
 *   - the signed agreement (six years), with the calendar terms recorded
 *     under it and the BAA's record of disclosures, which names records only
 *     by reference number (the DPA keeps no such record, so its clinics are
 *     not told of one);
 *   - the billing history, as tax law requires;
 *   - the records the agreement and the law need us to be able to show: the
 *     notices sent and where, the security incidents and their notices, the
 *     notice addresses the practice gave, and the log of how its data was
 *     handled; with the practice's name and published number, which they
 *     point at (lib/offboarding/account-closure.ts, KEPT_FOR_GOOD).
 *
 * Destruction takes the patient rows on the agreement's day; the sign-in and
 * the setup go when the account closes, once forwarded calls stop passing
 * through to the direct line the settings hold (`accountClosesAt`: the later
 * of the destruction and the pass-through's end). Until 19 October 2026 this
 * email said "your setup" had been destroyed with the data, when the
 * greeting, the services, the settings and the website reads were all kept
 * for good.
 *
 * It says "patient information" or "client information" by the practice's
 * audience, and nothing of any patient. It carries no link: the portal no
 * longer holds anything of theirs to open.
 */

export type DataDestroyedPayload = {
  /** clinics.destroyed_at: when the destruction committed. */
  destroyedAt: string;
  /** The day the last backup that could hold the data expires: destroyedAt plus BACKUP_RETENTION_DAYS. */
  backupsExpireOn: string;
  /** The service ended under a data protection agreement, which keeps no record of disclosures. */
  isDataProtectionAgreement: boolean;
  /**
   * When the account closes (lib/offboarding/account-closure.ts): the later
   * of destroyedAt and the end of the pass-through, so destroyedAt itself
   * when calls had already stopped passing through.
   */
  accountClosesAt: string;
};

export const renderDataDestroyed: EmailTemplate<DataDestroyedPayload> = (payload, ctx) => {
  const clinic = ctx.clinicName ?? "your practice";
  const who = person(ctx);
  return compose(
    {
      subject: "Your healdesk data has been destroyed",
      preheader: `We destroyed the ${who} information we held for ${clinic} on ${dayShort(payload.destroyedAt, ctx)}.`,
      blocks: [
        {
          type: "paragraph",
          text: `On ${dayLong(payload.destroyedAt, ctx)} we destroyed the ${who} information healdesk held for ${clinic}: every record of the people who called or messaged you, with their conversations, booking requests, appointments and deposits, and the credentials you connected through healdesk.`,
        },
        {
          type: "paragraph",
          text:
            Date.parse(payload.accountClosesAt) <= Date.parse(payload.destroyedAt)
              ? `We closed your healdesk account with it, deleting your sign-in and your setup: AYA's greeting, services, hours and prices, your settings, the addresses your email went to, and what we read from your website.`
              : `Your healdesk account closes on ${dayLong(payload.accountClosesAt, ctx)}, when calls still forwarded to us stop passing through to your direct line. Then we delete your sign-in and your setup: AYA's greeting, services, hours and prices, your settings, the addresses your email went to, and what we read from your website.`,
        },
        { type: "paragraph", text: "What remains, and why:" },
        {
          type: "list",
          items: [
            `Copies in our encrypted database backups, until ${dayLong(payload.backupsExpireOn, ctx)}, when the last of them expires (within ${BACKUP_RETENTION_DAYS} days of the destruction). We use them only to restore our systems, and destroy your data again in anything we restore.`,
            "What our language-model provider, Anthropic, keeps under its agreement with us, as our Terms describe: conversation content for 30 days, and up to two years for content its automated trust-and-safety systems flag or the law requires it to keep.",
            payload.isDataProtectionAgreement
              ? "The signed agreement, with any calendar terms you recorded under it, kept for at least six years, as it says."
              : `The signed agreement, with any calendar terms you recorded under it, and our record of disclosures, each kept for at least six years, as HIPAA requires. The record names records only by reference number, never a ${who}'s name or contact details.`,
            "Your billing history, as tax law requires.",
            `What we must be able to show we did under the agreement${payload.isDataProtectionAgreement ? "" : " and HIPAA"}: the notices we sent you and where, any security incident and its notice, the addresses you gave us for notices, and the log of how your data was handled, this destruction included. With them, ${clinic}'s name and published number, which they refer to. None of it names a ${who}.`,
          ],
        },
        {
          type: "paragraph",
          text: `No other ${who} information of ${clinic}'s is kept. There is nothing you need to do.`,
        },
      ],
    },
    ctx,
  );
};

export const DATA_DESTROYED_ENTRY: TemplateEntry<DataDestroyedPayload> = {
  render: renderDataDestroyed,
  fixture: {
    destroyedAt: "2026-12-05T15:02:00.000Z",
    backupsExpireOn: "2027-01-09",
    isDataProtectionAgreement: false,
    accountClosesAt: "2026-12-06T14:32:00.000Z",
  },
};
