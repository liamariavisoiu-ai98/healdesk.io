import type { Metadata } from "next";

/**
 * Where every failed connect link ends up.
 *
 * Expired, already used, never issued, and malformed all arrive here, and this
 * page cannot tell them apart — because it is never told. `/connect/[token]`
 * redirects without passing a reason, so there is no query parameter to leak
 * one and nothing to render even if a caller tried.
 *
 * That is the whole design. "This link expired on Tuesday" confirms the token
 * was real; "we don't recognise that link" confirms the others weren't; naming
 * the clinic confirms who our customers are. An anonymous visitor holding a URL
 * they should not have learns exactly one thing here: it doesn't work any more,
 * and a human at healdesk can issue another. That is also everything the actual
 * clinic needs, which is why the honest version and the safe version are the
 * same page.
 *
 * Deliberately static, with no lookup of any kind. There is nothing to look up,
 * and a page that queried something would be a page that could be timed.
 */

export const metadata: Metadata = {
  title: "This link is no longer valid",
  // Overridden: the root layout describes this app as the clinic's portal. It
  // also says nothing about why the link failed — this page is never told, and
  // its metadata is not a back door for telling it. (Phase two: in v1 every
  // connect link lands here, because the read-back handover is fenced off.)
  description: "Ask us for a new setup link.",
  robots: { index: false, follow: false },
};

export default function ConnectInvalidPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-5 py-16 sm:px-6">
      <p className="text-xs font-bold tracking-[0.14em] text-[color:var(--color-muted)] uppercase">
        healdesk
      </p>

      <h1 className="mt-2 text-[26px] leading-tight font-semibold tracking-tight text-balance sm:text-3xl">
        This link is no longer valid
      </h1>

      <p className="mt-4 text-[15px] text-[color:var(--color-muted)]">
        Setup links are good for one use, so this one may simply have done its
        job already. Either way, nothing is wrong on your side and nothing is
        lost. We can send a new one straight away.
      </p>

      <p className="mt-6 text-[15px]">
        Reply to the email that brought you here, or write to{" "}
        <a
          href="mailto:hello@healdesk.io?subject=New%20setup%20link"
          className="font-semibold underline underline-offset-2"
        >
          hello@healdesk.io
        </a>{" "}
        and ask for a new setup link.
      </p>
    </main>
  );
}
