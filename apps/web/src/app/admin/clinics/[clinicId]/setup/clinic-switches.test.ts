import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

import type { ClinicSwitches as Read, ClinicSwitchView, OpsResult, SetClinicSwitchOutcome } from "@/lib/admin/ops-client";

import { ClinicSwitches, doneWords, offeredChanges } from "./ClinicSwitches";
import { setSwitchAction } from "./switch-action";
import { groupSwitches, valueWords } from "./switch-groups";

/**
 * The Clinic switches section against the contract's rows. The reasons are
 * apps/app's words and are printed as sent; availability is only ever the
 * row's own `enabled`.
 */

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

function row(over: Partial<ClinicSwitchView> & { key: string }): ClinicSwitchView {
  return { label: over.key, kind: "switch", value: false, enabled: true, reason: null, operatorMayChange: true, ...over };
}

const read: OpsResult<Read> = {
  ok: true,
  data: {
    switches: [
      row({ key: "channel_web", label: "Website chat", value: true }),
      row({ key: "text_payment_link", label: "Text the payment link", enabled: false, reason: "Connect Stripe first." }),
      row({
        key: "payment_ask",
        label: "What the assistant asks the patient to pay",
        kind: "choice",
        value: "deposit_only",
        options: [
          { id: "deposit_only", label: "Deposit only" },
          { id: "full_payment", label: "Full payment" },
        ],
      }),
      row({ key: "direct_line", label: "Direct line", operatorMayChange: false }),
      row({ key: "brand_new_switch", label: "Brand new" }),
    ],
  },
};

const noop = async (): Promise<OpsResult<SetClinicSwitchOutcome>> => ({ ok: true, data: { status: "set", toast: "Saved.", resets: [] } });

function html(r: OpsResult<Read>): string {
  return renderToStaticMarkup(h(ClinicSwitches, { read: r, onSet: noop }));
}

describe("the Clinic switches section", () => {
  test("groups the rows in the portal's cards, unknown keys last", () => {
    const titles = groupSwitches((read as { ok: true; data: Read }).data.switches).map((g) => g.title);
    expect(titles).toEqual(["Channels", "Payments", "Other"]);
  });

  test("puts every key apps/app sends in a card, none under Other", () => {
    const keys = [
      "channel_web", "channel_instagram", "channel_messenger", "channel_whatsapp", "channel_voice", "coverage_mode",
      "tone", "suggest_add_ons", "mention_promotions",
      "deposits_enabled", "book_voice_without_deposit", "book_chat_without_deposit", "deposit_uncollectable",
      "deposit_hold_minutes", "text_payment_link", "payment_ask",
      "daily_summary", "transfer_live_calls", "auto_confirm",
    ];
    const groups = groupSwitches(keys.map((key) => row({ key })));
    expect(groups.map((g) => g.title)).toEqual(["Channels", "How AYA talks", "Calendar", "Payments", "Alerts"]);
    expect(groups.flatMap((g) => g.rows.map((r) => r.key)).sort()).toEqual([...keys].sort());
  });

  test("a choice shows and offers the server's options, whatever the key", () => {
    const tone = row({
      key: "tone",
      kind: "choice",
      value: "warm",
      options: [
        { id: "warm", label: "Warm and welcoming" },
        { id: "clinical", label: "Clinical and professional" },
      ],
    });
    expect(valueWords(tone)).toBe("Warm and welcoming");
    expect(offeredChanges(tone)).toEqual([{ label: "Set to Clinical and professional", value: "clinical", turnsOn: true }]);
    // No options sent: shown as its value, nothing offered.
    expect(offeredChanges(row({ key: "mystery", kind: "choice", value: "x" }))).toEqual([]);
  });

  test("shows the current value and the server's reason verbatim, with the button off", () => {
    const page = html(read);
    expect(page).toContain("Website chat");
    expect(page).toContain("Connect Stripe first.");
    expect(page).toMatch(/<button[^>]*disabled=""[^>]*>Switch on<\/button>/);
    expect(page).toMatch(/<button type="button" class="[^"]*">Switch off<\/button>/);
  });

  test("a failing rule blocks only turning on: turning off, or back to the safe option, stays pressable", () => {
    const locked = (over: Partial<ClinicSwitchView> & { key: string }) =>
      html({ ok: true, data: { switches: [row({ enabled: false, reason: "Why not.", ...over })] } });
    const on = locked({ key: "text_payment_link", value: true });
    expect(on).toMatch(/<button type="button" class="[^"]*">Switch off<\/button>/);
    const full = locked({
      key: "payment_ask",
      kind: "choice",
      value: "full_payment",
      options: [
        { id: "deposit_only", label: "Deposit only" },
        { id: "full_payment", label: "Full payment" },
      ],
    });
    expect(full).toMatch(/<button type="button" class="[^"]*">Set to Deposit only<\/button>/);
    const toFull = locked({
      key: "payment_ask",
      kind: "choice",
      value: "deposit_only",
      options: [
        { id: "deposit_only", label: "Deposit only" },
        { id: "full_payment", label: "Full payment" },
      ],
    });
    expect(toFull).toMatch(/<button[^>]*disabled=""[^>]*>Set to Full payment<\/button>/);
  });

  test("a choice offers the other option; a switch the clinic alone changes offers nothing", () => {
    const rows = (read as { ok: true; data: Read }).data.switches as [ClinicSwitchView, ClinicSwitchView, ClinicSwitchView, ClinicSwitchView];
    expect(offeredChanges(rows[2]).map((c) => c.value)).toEqual(["full_payment"]);
    expect(offeredChanges(rows[3])).toEqual([]);
    expect(html(read)).toContain("Only the clinic changes this");
  });

  test("an unreachable host says standby; any other failure says what could not be read", () => {
    const down: OpsResult<Read> = { ok: false, code: "unreachable", message: "x" };
    expect(html(down)).toContain("in standby");
    const bad: OpsResult<Read> = { ok: false, code: "malformed", message: "Odd answer." };
    expect(html(bad)).toContain("Could not read the clinic&#x27;s switches: Odd answer.");
  });

  test("the toast and every reset notice are the one line after a change", () => {
    expect(doneWords({ status: "set", toast: "Saved.", resets: [{ switch: "payment_ask", notice: "Back to deposit only." }] })).toBe("Saved. Back to deposit only.");
  });
});

describe("the switch action", () => {
  test("refuses a malformed key or value without calling upstream", async () => {
    const up = vi.fn();
    expect(await setSwitchAction(up, CLINIC, "", true)).toMatchObject({ data: { status: "refused" } });
    expect(await setSwitchAction(up, CLINIC, "tone", { x: 1 })).toMatchObject({ data: { status: "refused" } });
    expect(up).not.toHaveBeenCalled();
  });

  test("passes the page's clinic and hands back an unavailable operation untouched", async () => {
    const refusedByServer: OpsResult<SetClinicSwitchOutcome> = { ok: true, data: { status: "refused", message: "Connect Stripe first." } };
    const up = vi.fn(async () => refusedByServer);
    expect(await setSwitchAction(up, CLINIC, "text_payment_link", true)).toBe(refusedByServer);
    expect(up).toHaveBeenCalledWith(CLINIC, "text_payment_link", true);
    const standby: OpsResult<SetClinicSwitchOutcome> = { ok: false, code: "unreachable", message: "down" };
    expect(await setSwitchAction(async () => standby, CLINIC, "tone", "warm")).toBe(standby);
  });
});
