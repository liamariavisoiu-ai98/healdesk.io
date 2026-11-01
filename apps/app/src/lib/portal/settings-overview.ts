import type { MetaConnectView } from "@/lib/meta/reconnect";

import type { CalendarCardView } from "./settings-calendar";

/**
 * The top of Settings (portal redesign, second slice, owner, 1 November
 * 2026): every connection a clinic makes, in one card, each with where it
 * stands and one button; and a row of shortcuts to the cards below.
 *
 * The button never does the connecting itself. It goes to the card that
 * does (Calendar, Payments, Channels), which keeps Google's notice, the
 * payment checks and the Facebook login exactly where they were. Pure, so
 * the words are one table test, and in the clinic's own words (CLAUDE.md,
 * "Simplicity rule"): what the connection does for them, or one short reason
 * it is not available.
 */

export type ConnectionState = "connected" | "attention" | "not_connected" | "unavailable";

export type ConnectionRow = {
  key: "calendar" | "payments" | "facebook";
  name: string;
  state: ConnectionState;
  /** "Connected", "Needs reconnecting", "Not connected", "Not available yet". */
  stateLabel: string;
  line: string;
  action: { label: string; href: string } | null;
};

const STATE_LABEL: Readonly<Record<ConnectionState, string>> = {
  connected: "Connected",
  attention: "Needs reconnecting",
  not_connected: "Not connected",
  unavailable: "Not available yet",
};

function row(
  key: ConnectionRow["key"],
  name: string,
  state: ConnectionState,
  line: string,
  action: ConnectionRow["action"],
): ConnectionRow {
  return { key, name, state, stateLabel: STATE_LABEL[state], line, action };
}

export function connectionRows(input: {
  settingsPath: string;
  calendar: Pick<CalendarCardView, "canConnect" | "blockedLine" | "connection">;
  payments: { connectAvailable: boolean; isConnected: boolean };
  /** Null when Instagram, Messenger and WhatsApp were not bought. */
  meta: MetaConnectView | null;
}): ConnectionRow[] {
  const at = (anchor: string) => `${input.settingsPath}#${anchor}`;
  const rows: ConnectionRow[] = [];

  const c = input.calendar;
  if (c.connection && c.connection.health === "healthy") {
    rows.push(
      row("calendar", "Google Calendar", "connected", `AYA books into ${c.connection.calendar}.`, {
        label: "Manage",
        href: at("calendar"),
      }),
    );
  } else if (c.connection) {
    rows.push(
      row(
        "calendar",
        "Google Calendar",
        "attention",
        "Bookings arrive as requests your team confirms until you reconnect it.",
        { label: "Reconnect", href: at("calendar") },
      ),
    );
  } else if (c.canConnect) {
    rows.push(
      row("calendar", "Google Calendar", "not_connected", "Connect it and AYA books straight into it.", {
        label: "Connect",
        href: at("calendar"),
      }),
    );
  } else {
    rows.push(
      row(
        "calendar",
        "Google Calendar",
        "unavailable",
        c.blockedLine ?? "Bookings arrive as requests your team confirms.",
        null,
      ),
    );
  }

  const p = input.payments;
  if (p.isConnected) {
    rows.push(
      row("payments", "Stripe", "connected", "Deposits are paid to your own Stripe account.", {
        label: "Manage",
        href: at("payments"),
      }),
    );
  } else if (p.connectAvailable) {
    rows.push(
      row("payments", "Stripe", "not_connected", "Connect your Stripe account to take deposits.", {
        label: "Connect",
        href: at("payments"),
      }),
    );
  } else {
    rows.push(row("payments", "Stripe", "unavailable", "Taking deposits isn't available yet.", null));
  }

  const m = input.meta;
  if (m) {
    const name = "Instagram, Messenger & WhatsApp";
    const states = [m.facebook.state, m.whatsapp.state];
    if (states.includes("needs_reconnect")) {
      rows.push(
        row("facebook", name, "attention", "Log in with Facebook again so AYA keeps answering.", {
          label: "Reconnect",
          href: at("channels"),
        }),
      );
    } else if (states.includes("connected")) {
      const all = states.every((s) => s === "connected");
      rows.push(
        row(
          "facebook",
          name,
          "connected",
          all ? "AYA answers your messages." : "Connected. One more login adds the rest.",
          { label: all ? "Manage" : "Finish", href: at("channels") },
        ),
      );
    } else if (m.available.facebook || m.available.whatsapp) {
      rows.push(
        row("facebook", name, "not_connected", "Log in with Facebook and AYA answers your messages.", {
          label: "Connect",
          href: at("channels"),
        }),
      );
    } else {
      rows.push(row("facebook", name, "unavailable", "Connecting these isn't available yet.", null));
    }
  }
  return rows;
}

/** The shortcuts to Settings' cards, in the page's order; Locations only when the account has one. */
export function settingsSections(hasLocations: boolean): { id: string; label: string }[] {
  return [
    ...(hasLocations ? [{ id: "locations", label: "Locations" }] : []),
    { id: "channels", label: "Channels" },
    { id: "how-aya-talks", label: "How AYA talks" },
    { id: "calendar", label: "Calendar" },
    { id: "payments", label: "Payments" },
    { id: "safety-net", label: "Safety net" },
    { id: "alerts", label: "Alerts" },
    { id: "sign-in", label: "Sign-in" },
  ];
}
