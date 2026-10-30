import { phoneText } from "@/lib/portal/conversation-words";
import { portalMoment } from "@/lib/portal/format";
import type { MissedContactView } from "@/lib/portal/missed-contacts";

import { calledBack } from "./actions";

/** One missed contact, as the list and its own page show it: short, plain text. */

const CHANNEL_WORDS: Record<MissedContactView["channel"], string> = {
  voice: "Phone call",
  web: "Website chat",
  meta: "Instagram, Messenger or WhatsApp",
};

const WHERE_WORDS: Record<MissedContactView["outcome"], string> = {
  direct_line: "Rang through to your direct line",
  contact_form: "Your website showed its contact form",
  nowhere: "Not passed on",
  unknown: "Not known",
};

export function MissedRow(props: {
  contact: MissedContactView;
  slug: string;
  timeZone: string;
  now: Date;
  /** Coming back to the contact's own page after the tick, rather than the list. */
  single?: boolean;
}) {
  const { contact, slug, timeZone, now } = props;
  return (
    <li id={`missed-${contact.id}`} className="border-line rounded-md border bg-white px-4 py-4">
      <p className="font-semibold">
        {CHANNEL_WORDS[contact.channel]} · {portalMoment(new Date(contact.missedAt), timeZone, now)}
      </p>
      <p className="text-muted mt-1 text-sm">{WHERE_WORDS[contact.outcome]}</p>
      <p className="mt-1 text-sm">{contact.callerPhone ? phoneText(contact.callerPhone) : "No number"}</p>
      {contact.closingNote ? <p className="mt-2 text-sm">From healdesk: {contact.closingNote}</p> : null}
      {contact.calledBackAt ? (
        <p className="mt-2 text-sm font-semibold">Called back {portalMoment(new Date(contact.calledBackAt), timeZone, now)}</p>
      ) : (
        <form action={calledBack.bind(null, slug, contact.id, Boolean(props.single))} className="mt-3">
          <button
            type="submit"
            className="bg-ink inline-flex min-h-11 items-center rounded-full px-6 text-sm font-bold text-white"
          >
            Called back
          </button>
        </form>
      )}
    </li>
  );
}
