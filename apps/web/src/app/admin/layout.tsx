import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AdminChrome } from "@/components/admin/AdminDashboard";
import {
  OPERATOR_COOKIE,
  operatorCookieOptions,
  requireOperator,
} from "@/lib/admin/operator";

/**
 * The chrome around the admin area: one header, its sections, one sign-out.
 *
 * ## Why this is not the marketing `Nav`
 *
 * `components/Nav.tsx` is a sales surface: pricing, how-it-works, and a "get
 * started" button. Every one of those links is an invitation to buy something,
 * and the only person who can reach this layout already owns it. Reusing that
 * header would put five dead ends in front of the controls that matter.
 *
 * ## Why the header is gated on the SEGMENT and not on the session
 *
 * A layout wraps every route beneath it, and one of them is the door at
 * /admin/sign-in. The door draws its own spare header and has nothing to sign
 * out of, so this header must not appear on it, or that page gets two headers
 * and an offer to end a session that does not exist.
 *
 * The tempting way to decide that is "no session, no header". It is wrong, and
 * subtly enough to be worth writing down. A layout is a SHARED segment, so the
 * router is entitled to keep the copy it already has when you move between its
 * children. Sign in and the dashboard can inherit the layout rendered while you
 * were signed out, which is a console with no way to sign out of it; sign out
 * and the door can inherit the one rendered while you were signed in, which is
 * the double header again on the page where it is most confusing.
 * `router.refresh()` on both sides probably papers over it, and "probably" is
 * not good enough for a header that can be wrong about whether you are signed
 * in. `useSelectedLayoutSegment()` answers "which route is below me" from the
 * client router, correctly, on every navigation. That is what `AdminChrome`
 * wraps, and it is the only client JavaScript this file adds.
 *
 * The email inside the header still comes from the session, and can therefore
 * be a render behind in the one case above. That is cosmetic and self-corrects;
 * a header that appears on the wrong route is not.
 *
 * ## Why the section links are plain anchors with no "you are here" highlight
 *
 * A layout cannot know which of its children is rendering. `params` does not
 * say, no request header carries the path, and anything computed on the server
 * goes stale the moment the router keeps this layout across a navigation, so a
 * highlight here would eventually point at the page you just left. Marking the
 * current section from the page below it (a hidden marker plus a CSS `:has()`
 * rule) does work and was rejected: it buys a visual nicety at the price of
 * three files having to agree, it cannot set `aria-current`, and every page
 * already opens with an h1 that names the section.
 *
 * Full navigations rather than `<Link>`, deliberately. Every page under here is
 * `force-dynamic` and re-runs `requireOperator()` on the server, so there is no
 * prefetched copy worth keeping and a hard navigation means the header, the
 * session and the page are always the same age.
 *
 * ## This file is not a security boundary and must not be read as one
 *
 * Layouts do not re-run on client navigation and never run for route handlers.
 * Every page under /admin calls `requireOperator()` itself and redirects, and
 * every route handler under /api/admin does its own check. What this decides is
 * whether a header is drawn.
 */

/**
 * The root layout says `index: true`. Nothing under /admin belongs in a search
 * index, not the console and not the fact that a door exists, and putting it
 * here rather than on each page means a future route under /admin is private by
 * default instead of private if somebody remembers.
 *
 * `manifest` and `appleWebApp` make /admin installable on a phone's home
 * screen: public/admin.webmanifest scopes the app to /admin, opens it
 * standalone (no browser chrome) and reuses the site's icons. A layout-level
 * manifest applies to every route beneath it, which is exactly the set of
 * pages the installed app may show; the marketing site has no manifest and
 * gains none from this.
 *
 * The title is deliberately NOT here. A plain string `title` in a layout clears
 * the closest parent's `title.template` for everything beneath it, so
 * `title: "Admin"` on this file quietly turned the sign-in page's tab from
 * "Sign in, healdesk" into "Sign in". Verified against a build, not assumed.
 * Titles live on the pages, where they resolve through the root template and
 * take nothing else with them.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  manifest: "/admin.webmanifest",
  appleWebApp: { capable: true, title: "healdesk ops", statusBarStyle: "default" },
};

/**
 * The surfaces this console has, in the order somebody uses them: what
 * changed, what is running, the practice questions waiting for review, the
 * incidents to decide, the platform's attestations automatic go-live reads,
 * and the notices we send practices by hand, how every
 * tool links up and which keys are in place, whether the AWS host is on, who
 * asked to be set up, whose website could not be read at checkout, who is in
 * the funnel, the personalised demos built for them, and what has been signed.
 */
const SECTIONS = [
  { href: "/admin", label: "Changes" },
  { href: "/admin/ops", label: "Ops" },
  { href: "/admin/reviews", label: "Reviews" },
  { href: "/admin/incidents", label: "Incidents" },
  { href: "/admin/compliance", label: "Compliance" },
  { href: "/admin/notices", label: "Notices" },
  { href: "/admin/map", label: "Map" },
  { href: "/admin/host", label: "Host" },
  { href: "/admin/setup", label: "Setup" },
  { href: "/admin/site-reads", label: "Site reads" },
  { href: "/admin/support", label: "Support" },
  { href: "/admin/recordings", label: "Recordings" },
  { href: "/admin/crm", label: "CRM" },
  { href: "/admin/demos", label: "Demos" },
  { href: "/admin/agreements", label: "Agreements" },
  { href: "/admin/seo", label: "SEO" },
] as const;

/**
 * End every credential this browser holds for the admin area, then leave.
 *
 * A server action rather than a fetch, because it works with no JavaScript,
 * which a `DELETE` from a click handler cannot.
 *
 * The session cookie, which is the same list `DELETE /api/admin/session`
 * clears: the two places that end a session should end the same things. Until
 * 14 October 2026 both also cleared `hd_operator_enrol`, the ten-minute
 * first-run token; enrolment is now a script on the owner's machine, nothing
 * mints or reads that cookie, and a stale one expires on its own. The step
 * cookie (`hd_operator_step`) is left on purpose: it can only refuse a code,
 * and signing out then offering the same code again is what it refuses.
 *
 * This used to clear `hd_admin` as well, the older shared-password gate that
 * guarded the changes view beside the console session. That gate is gone,
 * `lib/admin/auth.ts` with it, and nothing reads `hd_admin` any more, so a
 * stale one in an old browser grants nothing and is left to expire rather than
 * being cleared by a line that would have to import a module that no longer
 * exists.
 *
 * The flags come from the same helper that set the cookie. A browser only
 * replaces a cookie when name, path and domain all match, so a hand-written
 * `delete` with a different path would leave the cookie exactly where it was.
 *
 * Sign-out is the one action worth having no confirmation and no CSRF anxiety:
 * the cookie is `sameSite: "strict"` so a cross-site post does not carry it,
 * Next checks the origin of every server action, and the worst a forged one
 * could do is sign the administrator out.
 */
async function signOut(): Promise<void> {
  "use server";

  const store = await cookies();
  store.set(OPERATOR_COOKIE, "", { ...operatorCookieOptions(), maxAge: 0 });

  redirect("/admin/sign-in");
}

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const operator = await requireOperator();

  return (
    <div className="flex min-h-dvh flex-col">
      <AdminChrome>
        <header className="border-line/60 bg-paper/85 sticky top-0 z-50 border-b backdrop-blur-md">
          {/* Wraps on a phone: brand and sign-out on the first line, the
              section links on the next. Every control is at least 44px tall,
              the size a thumb can hit; the nav is deliberately not a menu
              behind a button, because five links fit and a menu hides the
              one you want. */}
          <div className="mx-auto flex w-full max-w-[1240px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-8 sm:py-4 lg:px-14">
            {/* The gradient utility rather than the marketing `Brand`'s two
                coloured spans: `Brand` links to `#top`, which is an anchor on
                the landing page and a no-op here. */}
            <a
              href="/admin"
              aria-label="healdesk admin"
              className="font-display flex min-h-11 shrink-0 items-center text-[27px] leading-none font-semibold tracking-[-0.02em] sm:text-[33.6px]"
            >
              <span className="text-brand-gradient">healdesk</span>
              <span className="text-muted text-[0.6em] font-medium">.io</span>
            </a>

            <nav aria-label="Admin sections" className="order-last flex w-full flex-wrap gap-1 sm:order-none sm:w-auto">
              {SECTIONS.map((section) => (
                <a
                  key={section.href}
                  href={section.href}
                  className="text-muted hover:text-ink hover:bg-paper-2 inline-flex min-h-11 items-center rounded-full px-3.5 py-2 text-[15.6px] font-semibold transition-colors"
                >
                  {section.label}
                </a>
              ))}
            </nav>

            <div className="ml-auto flex min-w-0 items-center gap-3">
              {operator ? (
                /* The address, not a greeting. It is the account every action
                   below is attributed to, so seeing which one is signed in is
                   the point rather than a pleasantry. */
                <span className="text-muted hidden max-w-[220px] truncate text-[15.6px] font-medium sm:inline">
                  {operator}
                </span>
              ) : null}

              <form action={signOut}>
                <button
                  type="submit"
                  className="border-line hover:border-line-strong text-muted hover:text-ink inline-flex min-h-11 shrink-0 items-center rounded-full border px-4 py-2 text-[15.6px] font-semibold transition-colors"
                >
                  Sign out
                </button>
              </form>
            </div>
          </div>
        </header>
      </AdminChrome>

      {children}
    </div>
  );
}
