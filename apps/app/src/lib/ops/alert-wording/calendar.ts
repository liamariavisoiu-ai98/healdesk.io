import type { OpsEvent } from "@/lib/ops/notify";

import { legacy, type AlertWording } from "./types";

/** The "calendar" section of docs/on-call.md's alert runbook. */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // Raised once per breakage by markCalendarBroken, and once per run by the
  // calendar watch, counting the breakages it found or told; with exactly
  // one, its ids and code come too, and the watch's carry its run id
  // (`jobId`), which its log lines name each connection under. `code` is
  // Google's answer as the adapter names it: invalid_grant,
  // admin_policy_enforced and scope_lost mean the access itself was removed
  // and the stored token has been erased; access_denied,
  // insufficient_permissions and calendar_not_found mean the calendar
  // refused it.
  calendar_broken: legacy(
    "A clinic's Google Calendar stopped working",
    "Google refused healdesk's access to a clinic's calendar, or to each of the calendars counted below, so each location affected now takes booking requests for its staff to confirm. Ask the clinic whether it removed the access on purpose; if not, it reconnects its calendar. Look the clinic up in the console.",
  ),
  // Raised once per run by the calendar watch, counting the connections
  // that moved to degraded in it; with exactly one, its ids and the last
  // transient code (timeout, network, rate_limited, a 5xx word) come too.
  // Each run's alert carries its run id (`jobId`), so a second wave, or a
  // connection that degrades again after recovering, is a new alert.
  calendar_degraded: legacy(
    "Google Calendar checks are failing",
    "The calendar watch could not get an answer from Google for the connections counted below three times in a row, so those locations take booking requests for their staff to confirm until a check passes. A short Google outage needs nothing from you. If it lasts over an hour, check Google Workspace's status page and this deployment's outbound network, then look the connections up in the console.",
  ),
  // Raised once per run by the calendar watch, counting the degraded
  // connections whose check passed again (ids when there is one).
  calendar_recovered: legacy(
    "Google Calendar checks are passing again",
    "Connections the calendar watch had moved to booking requests answered a check again, so those locations book into their calendars as their settings allow. Nothing to do: this closes the alert about failing checks.",
  ),
  // Raised by a calendar watch run that stopped starting checks after four
  // minutes; `count` is how many connections it left unchecked, which go
  // first in the next run.
  calendar_watch_incomplete: legacy(
    "The calendar watch ran out of time",
    "A run of the five-minute calendar watch stopped starting checks after four minutes and left the connections counted below unchecked; they go first in the next run. If this happens on most runs, Google is answering slowly or there are more connections than one run can check, and the watch needs more checks at once: raise it with whoever maintains apps/app.",
  ),
  // Raised by a calendar watch run in which a step threw: a connection's
  // check or its alert, the terms check for a location, or the run itself.
  // `count` is how many; each is a log line with its ids.
  calendar_watch_failed: legacy(
    "The calendar watch hit errors",
    "A run of the five-minute calendar watch could not finish the steps counted below. A location whose terms could not be checked is not checked with Google either, and stays as it was until a run gets through. Read the worker's error lines for the calendar watch, and the job's note in the console's job list; if every run fails, the database or this deployment's configuration is the likely cause.",
  ),
  connection_broken: legacy(
    "A clinic's connection stopped working",
    "A clinic's stored connection below is revoked or in error. For a Meta platform (provider meta-messenger, meta-instagram or meta-whatsapp) that channel cannot reply to anyone until the clinic connects it again from Facebook login: call the clinic. Every connection finding is in the 07:00 digest as well.",
  ),
  google_oauth_client_rejected: legacy(
    "Google refused healdesk's OAuth client",
    "Google refused healdesk's own OAuth client, or apps/app has none set (code oauth_client), or Google says the Calendar API is disabled in healdesk's Google Cloud project (code api_disabled). Until it is fixed no clinic can connect a calendar or keep one working, and the calendar watch moves each connection it checks to booking requests. Check the Calendar OAuth client and that the Google Calendar API is enabled in the Google Cloud project, and GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in the apps/app secret store; a clinic whose connect failed can then try again.",
  ),
  // lib/ops/calendar-write-alerts.ts, hourly, once per write and state.
  calendar_write_stuck: {
    title: "A booking is missing from a clinic's Google Calendar",
    whatHappened:
      "A confirmed booking at {clinicName} is not in the clinic's Google Calendar.[ We tried {attemptCount:time}.] The clinic's staff were already told to add it by hand.",
    whyItMatters:
      "Until the booking is in the calendar, its slot looks free and someone else could be booked into it. Nothing will try again on its own.",
    steps: [
      "Open the clinic's Setup tab and find the booking under Calendar writes needing attention. Google's reason is shown beside it.",
      "Press Retry beside the booking if the reason is timeout, network or unconfirmed.",
      "Do not press Retry if the reason says an event id is taken. Phone the clinic on its published number, shown under Phone line on its Setup tab, and ask them to look for a duplicate in their calendar.",
      "Press Send calendar link on the Setup tab if the reason mentions the target calendar or a calendar that is not connected. The clinic reconnects from that link.",
      "Check under Calendar writes needing attention that the booking now shows as written. If the reason says the clinic deleted it in its own calendar, there is nothing to do and you are done.",
    ],
  },
  // The same sweep, when one run finds more stuck writes than it alerts one
  // by one: `count` of them, each recorded as told.
  calendar_writes_stuck_many: legacy(
    "Several bookings could not be written to calendars",
    "The hourly check found the number of bookings below whose Google Calendar write failed or was given up on, more than it reports one by one, so this one alert stands for all of them and none will be sent separately. Each clinic's desk was already told to add its booking by hand. Open the clinics in the console and look at each one's calendar writes on its onboarding page; a new failure after this is reported on its own again.",
  ),
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>([
  "calendar_broken",
  "calendar_degraded",
  "calendar_recovered",
  "calendar_watch_incomplete",
  "calendar_watch_failed",
  "connection_broken",
  "google_oauth_client_rejected",
  "calendar_writes_stuck_many",
]);
