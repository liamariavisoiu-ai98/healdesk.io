import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { SignInForm } from "@/components/admin/SignInForm";
import { Brand } from "@/components/Nav";
import {
  isAdminAccountConfigured,
  logAdminConfigProblems,
  missingAdminConfig,
  requireOperator,
} from "@/lib/admin/operator";

export const metadata: Metadata = {
  title: "Sign in",
  // A door has no business in search results, and neither does the fact that
  // there is a door here.
  robots: { index: false, follow: false },
};

/**
 * Rendered per request, always.
 *
 * Without this, the unconfigured branch below never touches `cookies()`, so Next
 * is free to prerender this page at build time, and a build that runs without
 * the admin environment would bake "Not configured." into a static page that
 * keeps saying it after the variables are set at runtime. The page would be
 * stating something it could not know, which is the one thing this codebase
 * refuses to do.
 */
export const dynamic = "force-dynamic";

/**
 * The admin door.
 *
 * A server component on purpose. Whether an admin account exists on this server,
 * and whether the visitor already holds a session, are both answered here and
 * neither answer is shipped to the browser. The only thing that becomes client
 * JavaScript is the form.
 *
 * ## There is no enrolment screen
 *
 * The authenticator is set up before this page can be used, by
 * `npm run admin:totp -w @healdesk/web` on the owner's own machine, which makes
 * the secret, has the phone prove it scanned, and prints the value for
 * `HEALDESK_ADMIN_TOTP_SECRET` in Vercel (owner, 14 October 2026). So this page
 * never shows a secret, never shows a QR code, and has no state in which the
 * password alone is enough. A lost authenticator is the same script again,
 * which the one line under the form says; the Vercel account it ends in has a
 * second factor of its own.
 *
 * Deliberately spare. No navigation, no marketing, no explanation of what is
 * behind it beyond one line. The one person who needs this page already knows
 * why they are here.
 */
export default async function AdminSignInPage() {
  const configured = isAdminAccountConfigured();

  // Already signed in: send them through rather than making them prove it twice.
  // `requireOperator()` fails closed when unconfigured, so guarding on
  // `configured` first only skips work, it does not change the answer.
  if (configured && (await requireOperator()) !== null) redirect("/admin");

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-line/60 border-b">
        <div className="mx-auto flex w-full max-w-[1240px] items-center px-5 py-4 sm:px-8 lg:px-14">
          <Brand />
          <a
            href="/"
            className="text-muted hover:text-ink ml-auto text-sm font-semibold transition-colors"
          >
            Back to site
          </a>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[460px] flex-1 flex-col justify-center px-5 py-16 sm:px-8">
        <h1 className="font-display text-[clamp(31.2px,4.32vw,40.8px)] leading-tight font-medium tracking-[-0.024em]">
          Admin.
        </h1>
        <p className="text-muted mt-3 text-[18px] font-medium">
          One account, one password, and a code from your authenticator app.
          Everything the console can reach lives in the other app and is asked
          for over a signed request.
        </p>

        {configured ? (
          <>
            <SignInForm />
            <p className="text-muted mt-2 text-[15.6px]">
              Lost the authenticator? Run the admin:totp script again and
              replace its secret in Vercel; nothing here can reset it.
            </p>
          </>
        ) : (
          <NotConfigured />
        )}
      </main>
    </div>
  );
}

/**
 * Shown when the admin account is not fully configured.
 *
 * Rendering the form anyway would render a guess as a fact: the form implies
 * there is a password to type, and there is not. So the page says what is true
 * instead.
 *
 * Which variables are missing is shown outside production only. Not because "no
 * admin account here" is dangerous on its own, since nothing is reachable while
 * it is true, but because the names of the variables a deployment lacks are
 * operator detail and the operator has a terminal. In development they are
 * exactly what the reader needs.
 */
function NotConfigured() {
  const showSetup = process.env.NODE_ENV !== "production";
  const missing = showSetup ? missingAdminConfig() : [];
  // Production names nothing on the page, so the log has to: which setting,
  // set or not, never its value.
  if (!showSetup) logAdminConfigProblems();

  return (
    <div className="border-line mt-8 rounded-md border bg-white p-5">
      <p className="text-[18px] font-semibold">Not configured.</p>
      <p className="text-muted mt-2 text-sm">
        There is no admin account set on this server and no key to sign a session
        with, so there is nothing to sign in to. The door stays shut rather than
        falling open.
      </p>
      {showSetup ? null : (
        <p className="text-muted mt-2 text-sm">
          This deployment&apos;s runtime log names the setting it could not read.
        </p>
      )}

      {showSetup ? (
        <div className="border-line/60 mt-4 border-t pt-4">
          <p className="text-muted text-sm">
            Set these in{" "}
            <code className="text-ink text-[15.6px]">apps/web/.env.local</code> and
            restart the dev server:
          </p>
          <dl className="mt-3 grid gap-3">
            {SETUP.filter((item) => missing.includes(item.name)).map((item) => (
              <div key={item.name}>
                <dt className="text-ink text-[15.6px] font-bold">
                  <code>{item.name}</code>
                </dt>
                <dd className="text-muted mt-0.5 text-[15.6px]">{item.note}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The four variables, and what each one is for.
 *
 * `HEALDESK_ADMIN_PASSWORD_HASH` is a hash and not a password, and the note says
 * so in the strongest terms available, because the single worst thing anybody
 * could do with this page open is paste a plaintext password into a `.env` file
 * that ends up in a commit. The plaintext is not in this repository and must
 * never be put into one.
 */
const SETUP = [
  {
    name: "HEALDESK_ADMIN_EMAIL",
    note: "The one account. This is the address that signs in and the address every sign-in alert is sent to.",
  },
  {
    name: "HEALDESK_ADMIN_PASSWORD_HASH",
    note: "A scrypt hash, in the form scrypt$N$r$p$salt$key. Never the password itself: the plaintext belongs in a password manager and must not be written into this repository.",
  },
  {
    name: "HEALDESK_ADMIN_SECRET",
    note: "Signs the session cookie. Generate with openssl rand -base64 32. Rotating it signs you out.",
  },
  {
    name: "HEALDESK_ADMIN_TOTP_SECRET",
    note: "The authenticator's secret, 32 base32 characters. Make it with npm run admin:totp -w @healdesk/web, which checks a code from your phone before printing it. Without it no sign-in succeeds, whatever the password.",
  },
] as const;
