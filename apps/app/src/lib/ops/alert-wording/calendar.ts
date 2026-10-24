import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/** The "calendar" section of docs/on-call.md's alert runbook. */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // Raised once per breakage by markCalendarBroken, and once per run by the
  // calendar watch, counting the breakages it found or told; with exactly
  // one, its ids and code come too, and the watch's carry its run id
  // (`jobId`), which its log lines name each connection under. `code` is
  // Google's answer as the adapter names it: invalid_grant,
  // admin_policy_enforced and scope_lost mean the access itself was removed
  // and the stored credential has been erased; access_denied,
  // insufficient_permissions and calendar_not_found mean the calendar
  // refused it. The clinic is emailed once per breakage
  // (notifyCalendarState "stopped": bookings arrive as requests until it
  // reconnects from Settings).
  calendar_broken: {
    title: "A clinic's Google Calendar stopped working",
    headline: "Google refused our access[?count>1:  to {count:calendar}][?count<2:  to {clinicName}'s Google Calendar]",
    whatHappened:
      "Google refused healdesk's access to a clinic's Google Calendar[: {clinicName}][, {count:calendar} in all]. Either the clinic removed the access, or the calendar itself refused us. Each location affected now takes booking requests for its staff to confirm, and each clinic has been emailed to reconnect.",
    whyItMatters:
      "Until the calendar is reconnected, bookings are not written into it and AYA cannot read free times: staff confirm every request by hand. The clinic is not down, but every day like this costs it bookings.",
    steps: [
      "Open the Clinics page and read the Calendar column: each clinic shown as broken needs the steps below. With one clinic, this alert's link opens its Setup tab.",
      "Open the clinic's Setup tab and read the Calendar card: its status says whether access was removed or the calendar refused us, with Google's last error.",
      "Phone the clinic on its published number, shown under Phone line, and ask whether someone removed healdesk's access on purpose. If not, it reconnects from the email we sent or from its portal's Settings.",
      "Press Send calendar link on the Calendar card if the clinic cannot find the email: the link goes to the clinic's own address and lets it connect again.",
      "Check the Calendar card shows Active. You are done when it does: bookings go into the calendar again as the clinic's settings allow.",
    ],
  },
  // Raised once per run by the calendar watch, counting the connections
  // that moved to degraded in it; with exactly one, its ids and the last
  // transient code (timeout, network, rate_limited, a 5xx word) come too.
  // Each run's alert carries its run id (`jobId`), so a second wave, or a
  // connection that degrades again after recovering, is a new alert.
  calendar_degraded: {
    title: "Google Calendar checks are failing",
    headline: "[{clinicName}: ]Google Calendar failed 3 checks in a row[ for {count:connection}]",
    whatHappened:
      "[{clinicName}: ]Google Calendar failed 3 checks in a row[ for {count:connection}]. The five-minute calendar check could not complete three times in a row (Google did not answer, or we could not open the stored access), so those locations take booking requests for their staff to confirm until a check passes again.",
    whyItMatters:
      "A short Google outage needs nothing from you: the next passing check puts the location back by itself and sends the all-clear alert. One lasting over an hour means Google, or this deployment's network, is the problem.",
    steps: [
      "Open the Clinics page and read the Calendar column: degraded marks each clinic affected, and the Calendar card on its Setup tab says when it was last verified.",
      "Wait up to an hour: the check runs every five minutes, and one that passes clears this by itself. Nothing on the Calendar card needs pressing for an outage.",
      "Check Google Workspace's status page if it lasts over an hour, then the Jobs page under System for the calendar-watch row's last result: a run that fails every time points at our side, not Google's.",
      "Check the Clinics page again. You are done when the Calendar column shows healthy, or the all-clear alert about calendar checks passing arrives.",
    ],
  },
  // Raised once per run by the calendar watch, counting the degraded
  // connections whose check passed again (ids when there is one).
  calendar_recovered: {
    title: "Google Calendar checks are passing again",
    headline: "[{clinicName}'s ]Google Calendar answers checks again[ for {count:connection}]",
    whatHappened:
      "[{clinicName}'s ]Google Calendar answers checks again[ for {count:connection}]. Those locations book into their calendars as their settings allow, and no longer take booking requests only because of the check.",
    whyItMatters:
      "This is good news: it closes the earlier alert about failing checks. Nothing is owed to the clinic unless a booking request waited on its staff meanwhile.",
    steps: [
      "Open the Clinics page and check the Calendar column shows healthy for the clinic.",
      "Leave the Calendar card on the clinic's Setup tab as it is: nothing needs pressing. You are done.",
    ],
  },
  // Raised by a calendar watch run that stopped starting checks after four
  // minutes; `count` is how many connections it left unchecked, which go
  // first in the next run.
  calendar_watch_incomplete: {
    title: "The calendar check ran out of time",
    headline: "{count:connection} went unchecked: the calendar check ran out of time",
    whatHappened:
      "{count:connection} went unchecked: the calendar check ran out of time. A run of the five-minute check stopped starting new checks after four minutes, and those it left go first in the next run.",
    whyItMatters:
      "One slow run needs nothing. If this comes on most runs, Google is answering slowly or there are more calendars than one run can check, and a broken calendar could go unnoticed for longer than five minutes.",
    steps: [
      "Open the Jobs page under System and read the calendar-watch row's last result and note.",
      "Wait for the next few runs if this is the first such alert: the connections it missed are checked first next time, and the Jobs page shows each run's result.",
      "Ask whoever maintains the engine to let the check run more connections at once if the alert keeps coming; the Jobs page has no setting for it.",
      "Check the Jobs page shows runs completing. You are done when this alert stops.",
    ],
  },
  // Raised by a calendar watch run in which a step threw: a connection's
  // check or its alert, the terms check for a location, or the run itself.
  // `count` is how many; each is a log line with its ids.
  calendar_watch_failed: {
    title: "The calendar check hit errors",
    headline: "The calendar check could not finish {count:step} this run",
    whatHappened:
      "The calendar check could not finish {count:step} this run. A step is a calendar's check or its alert, or a location's calendar terms check. A location whose terms could not be checked is not checked with Google either, and stays as it was until a run gets through.",
    whyItMatters:
      "One failing step is usually a passing fault. A run that fails every time means the database or this deployment's configuration is the problem, and no calendar is being watched meanwhile.",
    steps: [
      "Open the Jobs page under System and read the calendar-watch row's last result and note.",
      "Wait for the next run if this is the first such alert: a passing fault clears itself, and the Jobs page shows the run passing.",
      "Ask whoever maintains the engine to read the worker's error lines for the calendar check if every run fails; the Jobs page shows only the result, not the error.",
      "Check the Jobs page shows runs passing. You are done when this alert stops coming.",
    ],
  },
  // The connection-health job (lib/scheduler/connection-health.ts), once
  // per connection: a stored connection other than Google Calendar whose
  // status is revoked or error. In v1 that is a Meta platform
  // (meta-messenger, meta-instagram, meta-whatsapp). Every finding is in
  // the 07:00 digest as well.
  connection_broken: {
    title: "A clinic's connection stopped working",
    headline: "{clinicName}'s[ {provider}] connection stopped working: AYA cannot reply there",
    whatHappened:
      "{clinicName}'s connected channel stopped working: AYA cannot reply there. The connection is now revoked or in error. For Instagram, Messenger or WhatsApp that means the platform no longer accepts our access, and AYA cannot reply to anyone there until the clinic connects it again.",
    whyItMatters:
      "Messages on that channel go unanswered, and Meta's 24-hour reply window closes on each one. The clinic keeps its other channels.",
    steps: [
      "Open the clinic's Setup tab and read the Meta front door card: each attached channel is listed with its status.",
      "Phone the clinic on its published number, shown under Phone line, and ask it to connect the channel again from its portal, with the Facebook login or WhatsApp sign-up button. Nothing is pasted by hand on either side.",
      "Check the Meta front door card shows the channel attached and active again. You are done when it does; the 07:00 digest lists it until then.",
    ],
  },
  // Google refused healdesk's own OAuth client, or apps/app has none set
  // (code oauth_client), or Google says the Calendar API is disabled in
  // healdesk's Google Cloud project (code api_disabled): from a clinic's
  // connect (with its id) or from the watch (with a count per code).
  google_oauth_client_rejected: {
    title: "Google refused healdesk's own calendar sign-in",
    headline: "No clinic can connect or keep a Google Calendar: Google refuses healdesk's own setup",
    whatHappened:
      "No clinic can connect or keep a Google Calendar: Google refuses healdesk's own setup. Google refused healdesk's own sign-in app, or says the Calendar service is switched off in our Google Cloud project[; the check found {count:connection} affected].[ The latest to hit it: {clinicName}, whose calendar connect failed.]",
    whyItMatters:
      "This is every clinic at once, not one: no clinic can connect a calendar or keep one working, and each calendar the check reaches moves to booking requests until it is fixed.",
    steps: [
      "Open the Map page under System and press Missing or broken: healdesk's Google sign-in app id and secret must both be in place.",
      "Check in the Google Cloud project that the Calendar service is enabled and that the sign-in app and its secret are the ones the Map page names. Fix it there, not in any clinic.",
      "Open the Clinics page afterwards and read the Calendar column: clinics moved to degraded recover at the next passing check, within five minutes.",
      "Press Send calendar link on the Setup tab of a clinic whose connect failed, so it can try again. You are done when the Calendar column shows healthy everywhere.",
    ],
  },
  // lib/ops/calendar-write-alerts.ts, hourly, once per write and state.
  calendar_write_stuck: {
    title: "A booking is missing from Google Calendar",
    headline: "A booking at {clinicName} may be missing from its Google Calendar[: {status}]",
    whatHappened:
      "A confirmed booking at {clinicName} is not in the clinic's Google Calendar.[ We tried {attemptCount:time}.] The clinic's staff were already told in their portal to add it by hand.",
    whyItMatters:
      "Until the booking is in the calendar, its slot looks free and someone else could be booked into it. Nothing will try again on its own.",
    steps: [
      "Open the clinic's Setup tab and find the booking under Calendar writes needing attention. Google's reason is shown beside it.",
      "Press Retry beside the booking if a Retry button shows there and the reason is timeout, network or unconfirmed. If no Retry button shows, the write never finished: phone the clinic, using the number under Phone line, and check its staff added the booking by hand.",
      "Do not press Retry if the reason says an event id is taken: our own event for this booking is already in the clinic's Google Calendar, at another time. Phone the clinic on its published number, shown under Phone line on its Setup tab, and ask its staff to find that event and move it to the booked time by hand.",
      "Press Send calendar link on the Setup tab if the reason mentions the target calendar or a calendar that is not connected. The clinic reconnects from that link.",
      "Check under Calendar writes needing attention that the booking now shows as written. If the reason says the clinic deleted it in its own calendar, there is nothing to do and you are done.",
    ],
  },
  // The same sweep, when one run finds more stuck writes than it alerts one
  // by one: `count` of them, each recorded as told.
  calendar_writes_stuck_many: {
    title: "Several bookings are missing from calendars",
    headline: "{count:booking} may be missing from their Google Calendars: none will retry by itself",
    whatHappened:
      "{count:booking} may be missing from their Google Calendars: none will retry by itself. The hourly check[ on {windowStart}] found them, each a Google Calendar write that failed or was given up on, more than it reports one by one. This one alert stands for all of them; none is sent separately. Each clinic's staff were already told in their portal to add the booking by hand.",
    whyItMatters:
      "Until each booking is in its calendar, its slot looks free and someone else could be booked into it. Nothing retries by itself, and a new failure after this is reported on its own again.",
    steps: [
      "Open the Clinics page: nothing in the console lists which clinics have a stuck write, and the Calendar column flags a broken calendar, not a stuck write, so open each clinic's Setup tab in turn.",
      "Read Calendar writes needing attention on each Setup tab: a stuck booking shows there with Google's reason beside it.",
      "Press Retry beside a booking whose reason is timeout, network or unconfirmed. Do not press Retry where the reason says an event id is taken: our own event for that booking is already in the clinic's Google Calendar at another time, so phone the clinic, using the number under Phone line, and ask its staff to find it and move it to the booked time by hand.",
      "Press Send calendar link on the Setup tab where the reason names the target calendar or a calendar that is not connected. The clinic reconnects from that link.",
      "Check under Calendar writes needing attention that each booking shows as written. You are done when none needs attention.",
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();
