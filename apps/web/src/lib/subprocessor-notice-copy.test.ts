import {
  BAA_TEMPLATES,
  DPA_TEMPLATES,
  SUBPROCESSOR_NOTICE_HOURS,
  type BaaVariables,
  type DpaVariables,
} from "@healdesk/catalog";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import SubprocessorsPage from "@/app/subprocessors/page";
import TrustPage from "@/app/trust/page";
import { POLICY } from "@/lib/legal";
import { SUBPROCESSORS } from "@/lib/subprocessors";

/**
 * What /subprocessors and /trust promise about a new subprocessor, against
 * what the agreements say.
 *
 * BAA 1.3.0 and the data protection agreement give at least 24 hours' notice
 * by email, to the notice address, naming the vendor, what it will receive and
 * why (packages/catalog/src/subprocessor-notice.ts). Every earlier BAA gives
 * fifteen days, and a released clause never changes, so a clinic that signed
 * 1.2.1 keeps fifteen days until it accepts a later version. Until 12 October
 * 2026 both pages promised every customer fifteen days, sent to "billing and
 * clinical contacts" that v1 does not have (release gate 13,
 * docs/counsel/agreement-changes.md § 12.14).
 *
 * So the pages' two periods are checked here against each template's own
 * Subcontractors clause: a version from POLICY.subprocessorNoticeHoursFromBaaVersion
 * on must say the hours, and none before it may give less than the days.
 */

function pageText(element: React.ReactElement): string {
  return renderToStaticMarkup(element)
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** "1.2.1" and "1.1.0-draft" as numbers, so versions compare in order. */
function versionParts(version: string): number[] {
  return version
    .replace(/-.*$/, "")
    .split(".")
    .map((part) => Number(part));
}

function isBefore(version: string, other: string): boolean {
  const a = versionParts(version);
  const b = versionParts(other);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff < 0;
  }
  return false;
}

/** The notice paragraph of a template's Subcontractors clause, unwrapped. */
function subcontractorsText(
  clauses: readonly { id: string; body: (v: never) => string }[],
): string {
  const clause = clauses.find((c) => c.id === "subcontractors");
  expect(clause, "a template has no Subcontractors clause").toBeDefined();
  // The clause body reads no variable: it is the same for every practice.
  return clause!.body({} as never).replace(/\s+/g, " ");
}

const WORDS: Record<number, string> = { 15: "fifteen" };

describe("each agreement gives the notice period the pages say it does", () => {
  const from = POLICY.subprocessorNoticeHoursFromBaaVersion;

  test("the version the pages name is a registered template", () => {
    expect(BAA_TEMPLATES.some((t) => t.version === from)).toBe(true);
  });

  test.each(BAA_TEMPLATES.map((t) => [t.version, t] as const))("BAA %s", (version, template) => {
    const text = subcontractorsText(
      template.clauses as readonly { id: string; body: (v: BaaVariables) => string }[],
    );
    if (isBefore(version, from)) {
      // 1.2.0 and 1.2.1 give fifteen days. 1.0.0 and the 0.1.0 draft give
      // notice "before adding one" with no period, which fifteen days meets.
      // None gives less, so the pages' fifteen days keeps every one of them.
      expect(text).not.toMatch(/hours' notice/);
      expect(text).toMatch(
        new RegExp(
          `at least ${WORDS[POLICY.earlierBaaSubprocessorNoticeDays]} days' notice by email|will give [^.]+ notice before adding one`,
        ),
      );
    } else {
      expect(text).toContain(`at least ${SUBPROCESSOR_NOTICE_HOURS} hours' notice by email`);
      expect(text).toContain("The notice goes to Practice's address in the Notices clause");
      expect(text).toContain("names the subcontractor, what it will receive and why");
    }
  });

  test.each(DPA_TEMPLATES.map((t) => [t.version, t] as const))("DPA %s", (_version, template) => {
    const text = subcontractorsText(
      template.clauses as readonly { id: string; body: (v: DpaVariables) => string }[],
    );
    expect(text).toContain(`at least ${SUBPROCESSOR_NOTICE_HOURS} hours' notice by email`);
  });
});

describe("/subprocessors and /trust state both periods, to the notice address", () => {
  const pages = {
    "/subprocessors": pageText(h(SubprocessorsPage)),
    "/trust": pageText(h(TrustPage)),
  } as const;

  test.each(Object.entries(pages))("%s", (_path, text) => {
    expect(text).toContain(
      `at least ${SUBPROCESSOR_NOTICE_HOURS} hours in advance, naming the vendor, what it will receive and why`,
    );
    expect(text).toMatch(
      new RegExp(
        `[Aa] clinic whose business associate agreement is a version earlier than ${POLICY.subprocessorNoticeHoursFromBaaVersion.replace(/\./g, "\\.")} gets at least ${POLICY.earlierBaaSubprocessorNoticeDays} days' notice instead\\.`,
      ),
    );
    expect(text).not.toContain("billing and clinical contacts");
    expect(text).not.toMatch(/tell every customer at least \d+ days/);
  });

  test("/subprocessors names the notice address the agreements name", () => {
    expect(pages["/subprocessors"]).toContain(
      "The email goes to the clinic's notice address: the email address on its account, which is also the one it signs in with and is billed at (before the account exists, the signatory's), unless it has given us another address for notices in writing.",
    );
    expect(pages["/subprocessors"]).toContain(
      "Its subscription and the service end on the day it terminates, no fees accrue for any time after that day, and we refund the prorated unused part of the subscription period it has paid for, as section 15 of our terms sets out.",
    );
  });
});

describe("Meta is a note beside the clinic's own services, not a register row", () => {
  // Release gate 13: Meta is not a subcontractor. The clinic's Instagram,
  // Messenger and WhatsApp accounts are its own services, which it connects
  // under its own accounts (BAA 1.3.0, the clause headed "Where Practice is
  // not a covered entity"), and Meta signs no business associate agreement
  // (the clause headed "What healdesk is not authorised to do").
  test("the register has no Meta row and only two kinds of row", () => {
    expect(SUBPROCESSORS.some((s) => /\bMeta\b/.test(s.name))).toBe(false);
    expect(new Set(SUBPROCESSORS.map((s) => s.handlesPhi))).toEqual(new Set([true, false]));
    expect(SUBPROCESSORS.every((s) => s.handlesPhi || s.baa.state === "not-needed")).toBe(true);
  });

  test("/subprocessors says why Meta has no row, and that the channels are scoped", () => {
    const text = pageText(h(SubprocessorsPage));
    expect(text).toContain("a row is one of two kinds");
    expect(text).not.toContain("Kept out by design");
    expect(text).toContain(
      "Instagram, Messenger and WhatsApp, where you connect them, are your own accounts with Meta, so Meta has no row here either.",
    );
    expect(text).toContain(
      "Meta signs no business associate agreement and keeps what passes through those channels, so they are scoped, not covered",
    );
  });

  test("/trust no longer counts Meta among the vendors", () => {
    const text = pageText(h(TrustPage));
    expect(text).not.toContain("with no agreement possible");
    expect(text).toContain(
      "Your Google Calendar, your payment processor and your Instagram, Messenger and WhatsApp accounts are in the patient's path too.",
    );
  });
});

describe("/trust gives the agreement's reporting clock", () => {
  // BAA 1.3.0's clause headed "Reporting breaches and security incidents",
  // and the DPA's: immediately following discovery and in any case within 24
  // hours, for a breach, a security incident and an impermissible use or
  // disclosure. apps/app's incident deadline is 24 hours for every clinic.
  const text = pageText(h(TrustPage));

  test("24 hours, for all three", () => {
    expect(text).toContain(
      "We tell the clinic, by email to its notice address, immediately after we discover a breach of unsecured patient information, a security incident, or a use or disclosure of patient information that the agreement does not permit, and in any case within 24 hours of discovery.",
    );
    expect(text).not.toContain("five calendar days");
    expect(text).not.toContain("five business days of any security incident");
  });
});
