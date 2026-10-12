import type { Metadata } from "next";

import { Throttled } from "@/app/channels/shared";
import { connectRequestContext } from "@/app/connect/[token]/request-context";
import { withinConnectAttemptLimit } from "@/lib/connections/attempt-limit";
import { calendarLinkPage, CALENDAR_PAGE_NOTICES } from "@/lib/connections/calendar-links";
import { isGoogleConnectOutcome } from "@/lib/connections/google-oauth";

import { chooseCalendarAction, reissue, requestChangeLink, submitElection } from "./actions";
import { CalendarLinkView, type CalendarFormProblem, type CalendarPageQuery } from "./CalendarView";

/**
 * A location's Google Calendar page, reached from a calendar link (plan
 * §4.1): connect or reconnect the calendar, choose which one, ask the owner
 * for a change of account, record or confirm a calendar election.
 *
 * The token in the path is the whole of the authentication, as on the other
 * link pages (app/connect/[token]/page.tsx explains the rules at length):
 * the open is counted against the token and the address before the token is
 * examined; opening never spends it; every dead, unknown or malformed token
 * gets the same page. What it shows is the practice's own business data:
 * its name, the account it connected and the names of its own calendars.
 * The query is read only as words from closed sets, so a crafted URL cannot
 * put a sentence on this page.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  // Names no clinic: a title leaks into history, tab lists and screenshots.
  title: "Your Google Calendar",
  description: "Connect the Google Calendar your healdesk assistant books into.",
  robots: { index: false, follow: false },
};

const PROBLEMS: readonly CalendarFormProblem[] = [
  "name",
  "accepted",
  "bookingSystem",
  "calendarAccount",
  "calendar",
];

export default async function CalendarLinkPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  const query = await searchParams;
  const request = await connectRequestContext();
  if (!withinConnectAttemptLimit("open", token, request.ipAddress ?? null)) return <Throttled />;

  const model = await calendarLinkPage(token, request);
  return (
    <CalendarLinkView
      model={model}
      query={readQuery(query)}
      actions={{
        submitElection,
        requestChangeLink,
        chooseCalendar: chooseCalendarAction,
        reissue,
      }}
    />
  );
}

function readQuery(query: Record<string, string | string[] | undefined>): CalendarPageQuery {
  const one = (key: string) => (typeof query[key] === "string" ? (query[key] as string) : null);
  const outcome = one("outcome");
  const notice = one("done");
  const problem = one("problem");
  return {
    outcome:
      outcome === "election_changed" || isGoogleConnectOutcome(outcome)
        ? (outcome as CalendarPageQuery["outcome"])
        : null,
    notice: (CALENDAR_PAGE_NOTICES as readonly (string | null)[]).includes(notice)
      ? (notice as CalendarPageQuery["notice"])
      : null,
    problem: (PROBLEMS as readonly (string | null)[]).includes(problem)
      ? (problem as CalendarFormProblem)
      : null,
    elect: one("elect") === "1",
  };
}
