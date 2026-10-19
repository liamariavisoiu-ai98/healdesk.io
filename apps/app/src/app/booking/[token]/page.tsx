import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { connectRequestContext } from "@/app/connect/[token]/request-context";
import { withinConnectAttemptLimit } from "@/lib/connections/attempt-limit";
import { resolveBookingPointer } from "@/lib/meta/booking-requests";
import { currentUserId } from "@/lib/portal/access";
import { bookingRequestPath } from "@/lib/portal/bookings";

/**
 * Where the desk's emailed link lands: a pointer, and nothing more.
 *
 * The spec puts a passkey, and an access log naming the device, in front of
 * every booking (spec, "Account access and credentials"), and this link opens
 * with the token in its path alone. So it shows no patient field and takes no
 * decision: it finds which clinic and which request the token names, and
 * sends the browser to that request on the portal's Bookings screen, through
 * sign-in when there is no session, and then the passkey step-up
 * (requirePatientPage). A sign-in that does not open this clinic gets "not
 * found" there, as for any other clinic's page. Staff confirm, propose or
 * decline on Bookings.
 *
 * Unknown and malformed tokens are one redirect to /booking/invalid, so a
 * guessed URL learns nothing. The redirect carries the clinic's slug and the
 * request's id, never anything of the person, and the email that carried the
 * link named the clinic already.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Booking request",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function BookingPointerPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const request = await connectRequestContext();

  if (!withinConnectAttemptLimit("open", token, request.ipAddress ?? null)) {
    return (
      <main className="mx-auto w-full max-w-2xl px-5 py-10 sm:px-6 sm:py-14">
        <p className="text-xs font-bold tracking-[0.14em] text-[color:var(--color-muted)] uppercase">
          healdesk
        </p>
        <h1 className="mt-2 text-[26px] leading-tight font-semibold tracking-tight sm:text-3xl">
          Give it a few minutes
        </h1>
        <p className="mt-4 max-w-[58ch] text-[15px] text-[color:var(--color-muted)]">
          That link has been opened many times in a row. Wait ten minutes and open it again from the
          email.
        </p>
      </main>
    );
  }

  const pointer = await resolveBookingPointer(token, request);
  if (!pointer) redirect("/booking/invalid");
  const target = bookingRequestPath(pointer.slug, pointer.requestId);
  if (!(await currentUserId())) redirect(`/sign-in?next=${encodeURIComponent(target)}`);
  redirect(target);
}
