// PHASE TWO: attribution (POS/EMR read-back, sync, reconciliation and the
// monthly revenue report). Not part of v1: kept, but fenced out of v1 flows,
// screens, emails and copy (HEALDESK_PHASE_TWO_ATTRIBUTION, lib/env.ts).
import type { MonthlyReport } from "@/lib/attribution/report";

/**
 * Rendering the monthly email.
 *
 * The whole delivery strategy rests on one property of this file: **the output
 * contains no PHI.** Counts and totals carry none of HIPAA's 18 identifiers, so
 * the email needs no login and is safe in a shared front-desk inbox — which is
 * exactly why the clinic gets to read it without learning a new tool.
 *
 * That property is only true as long as nobody adds a "top treatments" table or
 * a "patients you recovered" list. Both would be easy, useful, and a breach.
 * The per-appointment detail belongs inside the clinic's own software, where
 * staff are already authenticated.
 *
 * A test asserts no patient-identifying field can appear in what this produces.
 */

export type RenderedReport = {
  subject: string;
  text: string;
  html: string;
};

const usd = (value: number): string =>
  value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

export function renderMonthlyReport(report: MonthlyReport): RenderedReport {
  const { attribution: a, period } = report;

  const headlineFigure =
    a.revenueUsd === null ? "—" : usd(a.revenueUsd);

  // Never "$0 recovered" when the truth is "we couldn't work it out". Those are
  // different claims and only one of them is honest.
  const headline =
    a.revenueUsd === null
      ? `${report.clinicName}: ${a.recoveredBookings} recovered ${plural(a.recoveredBookings, "booking")} in ${period.label}`
      : `${report.clinicName}: ${headlineFigure} recovered in ${period.label}`;

  const trendLine = renderTrend(report);

  const lines: string[] = [
    headline,
    "",
    `Calls and messages handled: ${a.conversationsHandled.toLocaleString()}`,
    `Would otherwise have been missed: ${a.conversationsRecovered.toLocaleString()}`,
    `Of those, booked: ${a.recoveredBookings.toLocaleString()}`,
    "",
    a.revenueUsd === null
      ? "Revenue recovered: not available"
      : `Revenue recovered: ${headlineFigure}${
          a.mode === "estimated" ? " (estimated)" : ""
        }`,
    `How that's worked out: ${a.basis}`,
  ];

  if (trendLine) lines.push("", trendLine);

  if (report.partial) {
    lines.push(
      "",
      "This period is still in progress, so these figures will change.",
    );
  }

  if (a.caveats.length) {
    lines.push("", "Worth knowing:");
    for (const caveat of a.caveats) lines.push(`  • ${caveat}`);
  }

  lines.push(
    "",
    "—",
    "Figures cover calls and messages handled by your healdesk agent.",
    "Reply to this email if anything looks wrong; a person reads it.",
  );

  return {
    subject: headline,
    text: lines.join("\n"),
    html: renderHtml(report, headlineFigure, trendLine),
  };
}

function renderTrend(report: MonthlyReport): string | null {
  if (!report.trend) return null;
  const { deltaUsd, percent } = report.trend;

  if (deltaUsd === 0) return "Level with the month before.";

  const direction = deltaUsd > 0 ? "up" : "down";
  const magnitude = usd(Math.abs(deltaUsd));

  // No percentage when the previous month was zero — "up 100%" from nothing is
  // arithmetically true and communicates nothing.
  return percent === null
    ? `That's ${magnitude} ${direction} on the month before.`
    : `That's ${magnitude} ${direction} on the month before (${Math.abs(percent)}%).`;
}

function renderHtml(
  report: MonthlyReport,
  headlineFigure: string,
  trendLine: string | null,
): string {
  const { attribution: a, period } = report;

  // Inline styles and a table layout, because that is what survives Outlook.
  // No external stylesheet, no web fonts, no images — an email that needs the
  // network to be legible mostly isn't.
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#FBF4EA;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#24160F;">
  <table role="presentation" width="100%" style="max-width:560px;margin:0 auto;border-collapse:collapse;">
    <tr><td style="padding-bottom:8px;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#8B7A6C;">
      ${escapeHtml(period.label)}
    </td></tr>
    <tr><td style="padding-bottom:4px;font-size:18px;font-weight:600;">
      ${escapeHtml(report.clinicName)}
    </td></tr>
    <tr><td style="padding:12px 0 4px;font-size:40px;font-weight:700;line-height:1;">
      ${escapeHtml(headlineFigure)}
    </td></tr>
    <tr><td style="padding-bottom:16px;font-size:14px;color:#8B7A6C;">
      recovered${a.mode === "estimated" ? " (estimated)" : ""}${
        trendLine ? ` · ${escapeHtml(trendLine)}` : ""
      }
    </td></tr>

    <tr><td style="padding:16px 0;border-top:1px solid rgba(36,22,15,.12);">
      <table role="presentation" width="100%" style="border-collapse:collapse;font-size:14px;">
        ${row("Calls and messages handled", a.conversationsHandled.toLocaleString())}
        ${row("Would otherwise have been missed", a.conversationsRecovered.toLocaleString())}
        ${row("Of those, booked", a.recoveredBookings.toLocaleString())}
      </table>
    </td></tr>

    <tr><td style="padding:12px 0;font-size:13px;color:#8B7A6C;border-top:1px solid rgba(36,22,15,.12);">
      ${escapeHtml(a.basis)}
    </td></tr>

    ${
      report.partial
        ? `<tr><td style="padding:8px 0;font-size:13px;color:#8B7A6C;">This period is still in progress, so these figures will change.</td></tr>`
        : ""
    }

    ${
      a.caveats.length
        ? `<tr><td style="padding:12px 0;font-size:13px;color:#8B7A6C;">
             ${a.caveats.map((c) => `<div style="margin-bottom:6px;">• ${escapeHtml(c)}</div>`).join("")}
           </td></tr>`
        : ""
    }

    <tr><td style="padding-top:20px;font-size:12px;color:#8B7A6C;border-top:1px solid rgba(36,22,15,.12);">
      Figures cover calls and messages handled by your healdesk agent.<br>
      Reply to this email if anything looks wrong; a person reads it.
    </td></tr>
  </table>
</body></html>`;
}

function row(label: string, value: string): string {
  return `<tr>
    <td style="padding:6px 0;color:#8B7A6C;">${escapeHtml(label)}</td>
    <td style="padding:6px 0;text-align:right;font-weight:600;">${escapeHtml(value)}</td>
  </tr>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}
