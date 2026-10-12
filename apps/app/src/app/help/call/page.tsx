import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { formatPhone, helpContacts } from "@/lib/setup/help";

export const metadata: Metadata = { title: "Book a five-minute call", referrer: "no-referrer" };

export const dynamic = "force-dynamic";

/**
 * /help/call: where the setup emails' "Book a five-minute call" goes. It
 * sends the browser on to the scheduling page HEALDESK_CALL_BOOKING_URL
 * names, read now, so a link in an email from weeks ago reaches today's page
 * (lib/setup/help.ts). While none is set, it says how else to reach us
 * rather than leaving the link dead. No sign-in: it shows nothing of anyone's.
 */
export default function CallPage() {
  const help = helpContacts();
  if (help.callBookingUrl) redirect(help.callBookingUrl);
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <h1 className="text-2xl font-semibold">Talk to us</h1>
      <p className="text-muted mt-3">
        Email{" "}
        <a href={`mailto:${help.email}`} className="font-semibold underline">
          {help.email}
        </a>{" "}
        and we&rsquo;ll find a time with you
        {help.phoneE164 ? (
          <>
            , or leave a message on{" "}
            <a href={`tel:${help.phoneE164}`} className="font-semibold underline">
              {formatPhone(help.phoneE164)}
            </a>{" "}
            and we&rsquo;ll reply the next business day
          </>
        ) : null}
        .
      </p>
    </main>
  );
}
