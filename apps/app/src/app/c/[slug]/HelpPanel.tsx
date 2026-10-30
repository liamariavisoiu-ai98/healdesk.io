import { formatPhone, helpContacts } from "@/lib/setup/help";
import { supportLines } from "@/lib/support/lines";

import { SupportChat } from "./SupportChat";

/**
 * Help, on every screen of the portal and the setup wizard (plan Part F7;
 * spec, "Help on every screen"): the voicemail line while the owner has set
 * one, hello@healdesk.io always, and the five-minute call while a scheduling
 * page is set. A line that is not set is left out rather than shown dead.
 *
 * The call goes through /help/call, this app's own page, which sends the
 * browser on to the scheduling page set now; an email links the same page.
 *
 * The support chat (Part H, SupportChat.tsx) opens from a button here and
 * from the Help bubble it keeps in the corner of every screen. Its fixed line
 * for when it can't be reached carries the same phone and email as the list.
 */
export function HelpPanel({ audience }: { audience: "patients" | "clients" }) {
  const help = helpContacts();
  return (
    <aside
      id="help"
      aria-labelledby="help-heading"
      className="border-line mt-12 scroll-mt-6 rounded-md border bg-white px-5 py-4 text-sm"
    >
      <h2 id="help-heading" className="font-semibold">
        Help
      </h2>
      <ul className="mt-2 grid gap-2">
        {help.phoneE164 ? (
          <li>
            Leave a message on{" "}
            <a href={`tel:${help.phoneE164}`} className="font-semibold underline">
              {formatPhone(help.phoneE164)}
            </a>
            ; we reply the next business day. Please don&rsquo;t include{" "}
            {audience === "clients" ? "client" : "patient"} details.
          </li>
        ) : null}
        <li>
          Email{" "}
          <a href={`mailto:${help.email}`} className="font-semibold underline">
            {help.email}
          </a>
          . Please leave out {audience === "clients" ? "client" : "patient"} details.
        </li>
        {help.callBookingUrl ? (
          <li>
            <a
              href="/help/call"
              className="font-semibold underline"
              rel="noopener noreferrer"
              target="_blank"
            >
              Book a five-minute call
              <span className="sr-only"> (opens in a new tab)</span>
            </a>{" "}
            and we&rsquo;ll set it up with you.
          </li>
        ) : null}
      </ul>
      <SupportChat audience={audience} failureLine={supportLines(help.phoneE164).failure} />
    </aside>
  );
}
