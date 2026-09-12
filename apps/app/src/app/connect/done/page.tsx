import type { Metadata } from "next";

/**
 * Where a finished setup ends up.
 *
 * ## Why success needs a URL of its own
 *
 * The form is progressively enhanced — React 19 serialises `$ACTION_REF_1` and
 * friends into the SSR'd markup, so a browser with JavaScript off does a real
 * POST to `/connect/<token>`. Next runs the action (credential sealed and
 * stored, link burned) and then renders the page again to build the HTML
 * response. That second render re-resolves a token the request it belongs to
 * has just spent: `resolveConnectionLink()` returns null, and `/connect/[token]`
 * does the only correct thing with a null link, which is redirect to
 * `/connect/invalid`. A clinic whose credential is safely in the vault gets told
 * their link is dead.
 *
 * The page cannot fix this itself. A post-action render is not distinguishable
 * from a plain GET inside the component — no method, no action header — and the
 * one thing that *would* separate them, softening the null-link redirect, is the
 * anti-oracle rule the whole route is built on. So success stops re-rendering
 * the spent URL and gets this one instead. `submitCredential()` redirects here
 * from outside its try/catch, which fixes the no-JS transport and the JS one
 * together, and takes a post-success refresh with it.
 *
 * ## Why it is static, and says so little
 *
 * There is nothing to look up. This URL is public, guessable and final — it is
 * where a redirect lands, so anyone can simply open it — and it therefore has to
 * be a page that is safe for a stranger to read. It names no clinic, no
 * platform and no token, and it makes no query, so there is nothing here to
 * time either. `/connect/invalid` is deliberately the same shape for the same
 * reason; the build output listing both as `○ (Static)` is the check that they
 * stayed that way.
 *
 * The cost is the personalised half of the old inline confirmation: the platform
 * name, and `verifyConnection()`'s per-platform `unverifiedReason`. The sentence
 * below is the generic form of that reason and has to keep saying the same true
 * thing — we have not called anyone's booking system yet — because the alternative
 * is a page that implies we checked.
 */

export const metadata: Metadata = {
  title: "Setup complete",
  // Overridden for the same reason as the wizard's and the invalid page's: the
  // root layout calls this app a "Clinic console", and a clinic reading this
  // has just been told, correctly, that there is nothing to sign into. Names no
  // clinic, for the same reason the page doesn't.
  description: "Your booking system is connected to healdesk.",
  robots: { index: false, follow: false },
};

export default function ConnectDonePage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-5 py-16 sm:px-6">
      <p className="text-xs font-bold tracking-[0.14em] text-[color:var(--color-muted)] uppercase">
        healdesk
      </p>

      <h1 className="mt-2 text-[26px] leading-tight font-semibold tracking-tight text-balance text-[color:var(--color-green)] sm:text-3xl">
        Your system is now connected!
      </h1>

      <p className="mt-4 text-[15px] text-[color:var(--color-muted)]">
        Your credential is encrypted and won&rsquo;t be shown again.
      </p>

      <p className="mt-4 text-[15px] text-[color:var(--color-muted)]">
        The one-time link has now expired. No account or login needed.
      </p>

      {/*
        The honest half. verifyConnection() makes no network call, so at this
        point we have stored a credential we have not tried. Saying only "you're
        done" would let a clinic read this page as proof it works, and the place
        that discovers otherwise is a month-end report with nothing in it.
      */}
      <p className="mt-8 border-t border-[color:var(--color-line)] pt-6 text-sm text-[color:var(--color-muted)]">
        We&rsquo;ll test it on the first sync and keep you in the loop on the
        process.
      </p>

      <p className="mt-4 text-sm text-[color:var(--color-muted)]">
        Something not right? Reply to the email that brought you here, or write
        to{" "}
        <a
          href="mailto:hello@healdesk.io"
          className="font-semibold text-[color:var(--color-ink)] underline underline-offset-2"
        >
          hello@healdesk.io
        </a>
        .
      </p>
    </main>
  );
}
