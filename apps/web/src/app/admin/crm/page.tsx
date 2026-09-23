import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireOperator } from "@/lib/admin/operator";
import { marketingSheetId } from "@/lib/sheets/client";

/**
 * /admin/crm, the lead register on a phone.
 *
 * ## What this is
 *
 * The marketing site's leads, funnel events and demo-call consents live in
 * a Google Sheet (src/lib/sheets). This page is that Sheet, framed, under the
 * admin header, filling whatever is left of the viewport. It builds no table
 * of its own on purpose: the Sheet already has filters, sorting, search and
 * an editor the owner knows, and a second view of the same rows would drift
 * from the first the day somebody added a column.
 *
 * ## Who can see it, twice over
 *
 * `requireOperator()` guards the page, like every page under /admin, and the
 * layout above is not a security boundary (see its note). The frame then
 * asks Google, which shows the Sheet only to an account it has been shared
 * with: the viewer has to be signed in to the company Google account in this
 * browser. Signed out, Google renders its own "request access" page inside
 * the frame, which is the correct outcome and not one this page can improve
 * on; the note above the frame says so, and the link opens the Sheet in a tab
 * where signing in works without any frame in the way.
 *
 * ## The frame, and the CSP that allows it
 *
 * Every other page on the site carries `frame-src 'none'`. next.config.ts
 * gives `/admin/:path*` a variant whose frame-src is docs.google.com and
 * nothing else (`GOOGLE_DOCS_ORIGIN`); the test in security-headers.test.ts
 * holds both halves of that. `rm=minimal` strips Google's menu bar and
 * toolbar so the grid gets the screen. The sandbox keeps the frame from
 * navigating this page while letting Google's editor run, submit its own
 * forms and open the pop-ups its sign-in and sharing flows use.
 *
 * ## Empty state
 *
 * With no MARKETING_SHEET_ID there is nothing to frame. The page says which
 * variable is missing rather than framing an error from Google, because the
 * person reading it is the one who sets the variable.
 */

export const metadata: Metadata = {
  title: "CRM",
};

/**
 * Never cached, at any layer. `requireOperator()` reads cookies and would force
 * this dynamic anyway; saying so out loud means the guarantee does not depend
 * on noticing that side effect.
 */
export const dynamic = "force-dynamic";

export default async function CrmPage() {
  if (!(await requireOperator())) redirect("/admin/sign-in");

  const sheetId = marketingSheetId();
  if (!sheetId) {
    return (
      <main className="mx-auto w-full max-w-[1240px] px-4 py-10 sm:px-8 lg:px-14">
        <h1 className="font-display text-[28px] leading-tight font-semibold tracking-[-0.02em]">CRM</h1>
        <p className="text-muted mt-3 max-w-[60ch] text-[15.6px]">
          No lead register is configured. Set <code className="font-mono">MARKETING_SHEET_ID</code> (and{" "}
          <code className="font-mono">GOOGLE_SERVICE_ACCOUNT_JSON</code>, so the site can write to it) and
          this page will show the Sheet. See .env.example.
        </p>
      </main>
    );
  }

  const base = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/edit`;

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <p className="text-muted border-line/60 border-b px-4 py-2 text-[13.5px] leading-snug sm:px-8 lg:px-14">
        The live lead register. Viewers must be signed in to the company Google account.{" "}
        <a href={base} target="_blank" rel="noreferrer" className="text-ink underline underline-offset-2">
          Open in Sheets
        </a>
      </p>
      <iframe
        src={`${base}?rm=minimal`}
        title="Marketing lead register"
        className="min-h-0 w-full flex-1 border-0 bg-white"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
        allow="clipboard-write"
      />
    </main>
  );
}
