import { isProductUpdateCode, PRODUCT_UPDATES, type ProductUpdateCode } from "@healdesk/catalog";

import { publicUrl } from "@/lib/public-url";

import { compose, EmailCompositionError } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L33: what changed in healdesk (Annex X5), an operator broadcast from
 * /admin about a feature the practice already has. Transactional, never
 * promotional: no offer, no upgrade, no price. Optional, with its own switch
 * (`clinic_settings.product_updates`, on by default, lib/email/stop.ts): the
 * sender skips it while the switch is off, and carries the one-click stop
 * link in the footer and in List-Unsubscribe (lib/email/unsubscribe.ts),
 * because the kind names the switch in lib/email/kinds.ts.
 *
 * The words are the catalog's PRODUCT_UPDATES entry for the code, written
 * and reviewed with the change itself and linted with every other email:
 * nothing typed in /admin reaches a practice. The one link opens the screen
 * the update is about, at the practice's own portal.
 */

export type ProductUpdatePayload = {
  /** Which update, from PRODUCT_UPDATES. */
  code: ProductUpdateCode;
  /** publicUrl("/c/<slug>/<screen>"), the screen the update is about. */
  actionUrl: string;
};

export const renderProductUpdate: EmailTemplate<ProductUpdatePayload> = (payload, ctx) => {
  if (!isProductUpdateCode(payload.code)) {
    throw new EmailCompositionError(`Unknown product update "${String(payload.code)}".`);
  }
  const update = PRODUCT_UPDATES[payload.code];
  return compose(
    {
      subject: update.subject,
      preheader: "A change to a feature you already have. Nothing for you to do.",
      blocks: [
        ...update.paragraphs.map((text) => ({ type: "paragraph" as const, text })),
        { type: "action", label: update.action.label, url: payload.actionUrl },
        {
          type: "paragraph",
          text: "Nothing changes in what you pay. Questions? Reply to this email.",
        },
      ],
    },
    ctx,
  );
};

export const PRODUCT_UPDATE_ENTRY: TemplateEntry<ProductUpdatePayload> = {
  render: renderProductUpdate,
  get fixture(): ProductUpdatePayload {
    return {
      code: "transcripts_by_email",
      actionUrl: publicUrl("/c/radiance-med-spa/conversations"),
    };
  },
};
