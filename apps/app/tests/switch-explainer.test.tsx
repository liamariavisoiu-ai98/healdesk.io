import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

import { switchRules, type SwitchFacts } from "@/lib/portal/switch-rules";

vi.mock("@/app/c/[slug]/feedback", () => ({ useAnnounce: () => () => {} }));
vi.mock("@/app/c/[slug]/settings/actions", () => ({ saveSettingAction: async () => ({ ok: true }) }));

import { ChoiceSetting, SwitchSetting } from "@/app/c/[slug]/settings/controls";
import {
  FullPaymentExplainer,
  TextLinkExplainer,
} from "@/app/c/[slug]/settings/payment-explainers";
import { SwitchExplainer, UnlockLink, type UnlockTargets } from "@/app/c/[slug]/settings/SwitchExplainer";
import { ToggleRow } from "@/app/c/[slug]/settings/ToggleRow";
import { TextChecklist } from "@/app/c/[slug]/settings/TextChecklist";

/** Fixtures only: the rules are the real ones; nothing here re-encodes them. */
const facts: SwitchFacts = {
  gatewayConnected: false,
  hasDepositAmount: false,
  calendarConnected: false,
  autoConfirm: false,
  hasVoice: true,
};
const targets: UnlockTargets = {
  connect_stripe: "/api/connect/stripe/start?clinic=x&from=settings",
  set_deposit: "/c/x/knowledge#prices",
  connect_calendar: "#calendar",
  turn_on_auto_confirm: "#auto-confirm",
};
const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

describe("SwitchExplainer", () => {
  test("shows the rule's reason verbatim, before the picture, with the unlock button", () => {
    const rules = switchRules(facts);
    // The text's own rule is locked with no unlock while no sender exists
    // (switch-rules.ts), so the deposits rule, which needs Stripe, drives the
    // explainer here.
    const html = renderToStaticMarkup(
      <TextLinkExplainer id="e" rule={rules.deposits} targets={targets} />,
    );
    expect(html).toContain(rules.deposits.reason);
    expect(html).toContain('href="/api/connect/stripe/start?clinic=x&amp;from=settings"');
    expect(html).toContain("Connect Stripe");
    // text first, picture last
    expect(html.indexOf('data-part="reason"')).toBeLessThan(html.indexOf("<svg"));
    expect(html.indexOf('data-part="off"')).toBeLessThan(html.indexOf("<svg"));
  });

  test("each unlock goes where its target says, and nowhere when there is none", () => {
    const rules = switchRules({ ...facts, gatewayConnected: true });
    expect(rules.full_payment.unlock).toBe("connect_calendar");
    expect(renderToStaticMarkup(<UnlockLink unlock="connect_calendar" targets={targets} />)).toContain('href="#calendar"');
    expect(renderToStaticMarkup(<UnlockLink unlock="turn_on_auto_confirm" targets={targets} />)).toContain('href="#auto-confirm"');
    expect(renderToStaticMarkup(<UnlockLink unlock="set_deposit" targets={targets} />)).toContain("/knowledge#prices");
    expect(renderToStaticMarkup(<UnlockLink unlock="connect_stripe" targets={{ ...targets, connect_stripe: null }} />)).toBe("");
    expect(renderToStaticMarkup(<UnlockLink unlock={null} targets={targets} />)).toBe("");
  });

  test("the picture is hidden from screen readers and carries no text of its own that is needed", () => {
    const html = renderToStaticMarkup(
      <SwitchExplainer id="e" reason="r" picture={{ mode: "needs", from: "Stripe", to: "Text link" }} />,
    );
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(html).toContain('focusable="false"');
    expect(html).not.toContain("<title");
  });

  test("an available full payment shows On and Off, the reset note and the resets picture", () => {
    const rules = switchRules({ ...facts, gatewayConnected: true, calendarConnected: true, autoConfirm: true });
    const html = renderToStaticMarkup(<FullPaymentExplainer id="e" rule={rules.full_payment} targets={targets} />);
    expect(html).not.toContain('data-part="reason"');
    expect(html).toContain("On:");
    expect(html).toContain("Off:");
    expect(html).toContain("goes back to Deposit only");
    expect(html).toContain('data-picture="resets"');
  });

  test("a locked full payment shows the auto-confirm reason and a needs picture", () => {
    const rules = switchRules({ ...facts, gatewayConnected: true, calendarConnected: true });
    const html = renderToStaticMarkup(<FullPaymentExplainer id="e" rule={rules.full_payment} targets={targets} />);
    expect(html).toContain("Turn on Auto-confirm bookings first");
    expect(html).toContain('data-picture="needs"');
    expect(html).toContain("Go to Auto-confirm");
  });
});

describe("motion", () => {
  test("every animation sits behind prefers-reduced-motion: no-preference; the still state needs no animation", () => {
    const outside = css.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}\n/, "");
    const sx = outside.slice(outside.indexOf(".sx-picture"));
    // keyframes are declared outside, but nothing outside applies one.
    expect(sx.replace(/@keyframes[\s\S]*$/, "")).not.toMatch(/animation\s*:/);
    expect(css).toMatch(/prefers-reduced-motion: no-preference\) \{[\s\S]*animation: sx-on/);
  });

  test("the picture has a fixed size, so nothing shifts", () => {
    expect(css).toMatch(/\.sx-picture \{[^}]*height: 2\.25rem/);
  });

  test("the markup carries the class hooks the stylesheet targets", () => {
    const html = renderToStaticMarkup(
      <SwitchExplainer id="e" picture={{ mode: "resets", from: "a", to: "b" }} />,
    );
    for (const hook of ["sx-picture", "sx-resets", "sx-glow", "sx-wire-lit", "sx-from", "sx-to"]) {
      expect(html).toContain(hook);
      expect(css).toContain(`.${hook}`);
    }
  });
});

describe("controls", () => {
  test("a blocked switch is a disabled switch button, described by its line and its explainer", () => {
    const html = renderToStaticMarkup(
      <SwitchSetting
        slug="x"
        settingKey="text_payment_link"
        label="Text the payment link after a call"
        line="A line."
        initial={false}
        blockedLine="Connect your Stripe account first."
        explainerId="ex"
        explainer={<SwitchExplainer id="ex" reason="Connect your Stripe account first." />}
      />,
    );
    expect(html).toMatch(/role="switch"[^>]*aria-checked="false"/);
    expect(html).toMatch(/aria-describedby="[^"]+ ex"/);
    expect(html).toMatch(/\sdisabled=/);
    // the reason is printed once: in the explainer, not also in the line
    expect(html.match(/Connect your Stripe account first\./g)).toHaveLength(1);
  });

  test("a switch that is on is never disabled by a rule, so it can be turned off", () => {
    const html = renderToStaticMarkup(
      <SwitchSetting slug="x" settingKey="k" label="L" line="l" initial={true} blockedLine="Why." />,
    );
    expect(html).not.toMatch(/<button[^>]*\sdisabled=/);
  });

  test("the choice disables only the unavailable option, and keeps the explainer in its fieldset", () => {
    const html = renderToStaticMarkup(
      <ChoiceSetting
        slug="x"
        settingKey="payment_ask"
        legend="What AYA asks the patient to pay"
        options={[
          { id: "deposit_only", label: "Deposit only" },
          { id: "full_payment", label: "Full payment", disabled: true },
        ]}
        initial="deposit_only"
        explainerId="ex"
        explainer={<SwitchExplainer id="ex" reason="Connect your calendar first." />}
      />,
    );
    expect(html).toMatch(/<fieldset[^>]*aria-describedby="ex"/);
    expect(html).toContain("<legend");
    const radios = html.match(/<input[^>]*>/g) ?? [];
    expect(radios).toHaveLength(2);
    expect(radios[0]).not.toContain("disabled");
    expect(radios[1]).toContain("disabled");
    expect(html).toContain("Connect your calendar first.");
  });

  test("the wizard's toggle row is the same switch button", () => {
    const html = renderToStaticMarkup(
      <ToggleRow label="L" line="l" checked={false} onChange={() => {}} locked explainerId="ex" explainer={<p id="ex">why</p>} />,
    );
    expect(html).toMatch(/<button[^>]*type="button"[^>]*role="switch"/);
    expect(html).toContain('aria-checked="false"');
    expect(html).toMatch(/aria-describedby="[^"]+ ex"/);
    expect(html).toMatch(/\sdisabled=/);
    expect(html).toContain("min-h-11");
  });
});

describe("copy", () => {
  test("the text switch says designed to, and no vendor words appear in any explainer", () => {
    const rules = switchRules(facts);
    const all = [
      renderToStaticMarkup(<TextLinkExplainer id="a" rule={rules.text_payment_link} targets={targets} />),
      renderToStaticMarkup(<FullPaymentExplainer id="b" rule={rules.full_payment} targets={targets} />),
    ].join(" ");
    expect(all).not.toMatch(/\b(sms|twilio|carrier|baa|webhook|registration|sender)\b/i);
    const source = readFileSync(new URL("../src/app/c/[slug]/settings/payment-explainers.tsx", import.meta.url), "utf8");
    expect(source).toContain("is designed to offer to text a payment link");
  });
});

describe("motion honesty", () => {
  test("a needs picture sits dark when still, and the loop runs a few cycles only", () => {
    expect(css).not.toMatch(/\.sx-needs \.sx-glow,\s*\.sx-needs \.sx-wire-lit \{\s*opacity: 1/);
    expect(css).not.toMatch(/animation:[^;]*infinite/);
  });
});

describe("TextChecklist", () => {
  const all = { gatewayConnected: true, hasDepositAmount: true, calendarConnected: true, autoConfirm: true, hasVoice: true, textPaymentLinkOn: true };
  const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  test("says 'Texting is ready' only when every check passes, the agreement and healdesk's side included", () => {
    const ready = switchRules({ ...all, agreementCoversText: true }, true).text_payment_link.checks;
    expect(words(renderToStaticMarkup(<TextChecklist id="t" checks={ready} targets={targets} />))).toContain("Texting is ready");
    for (const [f, senderReady] of [
      [{ ...all, agreementCoversText: false }, true],
      [{ ...all, agreementCoversText: true }, false],
    ] as const) {
      const checks = switchRules(f, senderReady).text_payment_link.checks;
      const html = words(renderToStaticMarkup(<TextChecklist id="t" checks={checks} targets={targets} />));
      expect(html).not.toContain("Texting is ready");
      expect(html).toMatch(/[34] of 5 steps done/);
    }
    const old = words(
      renderToStaticMarkup(
        <TextChecklist id="t" checks={switchRules({ ...all, agreementCoversText: false }, true).text_payment_link.checks} targets={targets} />,
      ),
    );
    expect(old).toContain("Your agreement covers texting · Not yet · You");
    expect(old).toContain("does not include texting callers");
    expect(old).not.toMatch(/BAA|DPA|\d\.\d|REAL_CALLS/);
  });
});
