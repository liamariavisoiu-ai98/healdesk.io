"use server";

import { redirect } from "next/navigation";

import { connectRequestContext } from "@/app/connect/[token]/request-context";
import { withinConnectAttemptLimit } from "@/lib/connections/attempt-limit";
import {
  reissueCalendarLink,
  requestAccountChangeLink,
  submitCalendarElection,
} from "@/lib/connections/calendar-links";
import { chooseCalendar } from "@/lib/connections/google-calendar";
import { resolveConnectionLink } from "@/lib/connections/links";

/**
 * The calendar page's forms (plan §4.1). There is no session behind any of
 * them: the token in the form is the whole of the authentication, and each
 * action re-resolves it (or the library does) before reading a field, and
 * counts the attempt against the token and the address first. A hidden
 * clinic id would be an authorisation bug with a friendly name, so there is
 * none. Each ends in a redirect from outside any try/catch, to a URL whose
 * query carries only a word from a closed set.
 */

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

function tokenOf(form: FormData): string {
  const token = String(form.get("token") ?? "");
  return TOKEN.test(token) ? token : "";
}

function page(token: string, query: string): string {
  return token ? `/calendar/${token}${query}` : "/calendar/done?outcome=expired";
}

const PROBLEMS = new Set(["name", "accepted", "bookingSystem", "calendarAccount"]);

export async function submitElection(form: FormData): Promise<void> {
  const token = tokenOf(form);
  const request = await connectRequestContext();
  if (!token || !withinConnectAttemptLimit("submit", token, request.ipAddress ?? null)) {
    redirect(page(token, ""));
  }
  const outcome = await submitCalendarElection(
    token,
    {
      bookingSystem: form.get("bookingSystem"),
      calendarAccount: form.get("calendarAccount"),
      name: form.get("name"),
      title: form.get("title"),
      accepted: form.get("accepted") === "yes",
    },
    request,
  );
  switch (outcome.status) {
    case "recorded":
      redirect(outcome.next);
    case "owner_asked":
      redirect(page(token, "?done=owner_asked"));
    case "changed":
      redirect(page(token, "?outcome=election_changed"));
    case "invalid":
      redirect(page(token, PROBLEMS.has(outcome.field) ? `?problem=${outcome.field}` : ""));
    case "unavailable":
    case "expired":
      redirect(page(token, ""));
  }
}

export async function requestChangeLink(form: FormData): Promise<void> {
  const token = tokenOf(form);
  const request = await connectRequestContext();
  if (!token || !withinConnectAttemptLimit("submit", token, request.ipAddress ?? null)) {
    redirect(page(token, ""));
  }
  const sent = await requestAccountChangeLink(token, request);
  redirect(page(token, sent === "sent" ? "?done=change_link_sent" : ""));
}

export async function chooseCalendarAction(form: FormData): Promise<void> {
  const token = tokenOf(form);
  const request = await connectRequestContext();
  if (!token || !withinConnectAttemptLimit("submit", token, request.ipAddress ?? null)) {
    redirect(page(token, ""));
  }
  const link = await resolveConnectionLink(token, request, "calendar");
  if (!link) redirect(page(token, ""));
  const chosen = await chooseCalendar(link.clinicId, String(form.get("calendarId") ?? ""), {
    actor: { type: "service", serviceName: "calendar-link" },
    request,
  });
  redirect(page(token, chosen.status === "chosen" ? "?done=calendar_chosen" : "?problem=calendar"));
}

/**
 * "Email a new link": the same answer whatever the token was, so the page
 * says nothing about which tokens were ever real.
 */
export async function reissue(form: FormData): Promise<void> {
  const token = tokenOf(form);
  const request = await connectRequestContext();
  if (token && withinConnectAttemptLimit("submit", token, request.ipAddress ?? null)) {
    await reissueCalendarLink(token, request);
  }
  redirect("/calendar/done?outcome=reissued");
}
