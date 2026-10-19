import { describe, expect, test } from "vitest";

import {
  BACKUP_RETENTION_DAYS,
  BaaRenderError,
  getBaaTemplate,
  PAYMENTS_CLAUSE_BODY,
  prepareBaa,
  STATE_LAW_CLAUSE_HEADING,
  stateLawClauseBody,
  stateLawClauseBody140,
  stateLawClauseBody160,
  type BaaVariables,
} from "./baa";
import { buildBaaSelections } from "./baa-selections";
import { BOOKING_SYSTEMS } from "./booking-systems";
import { CALENDAR_ACCOUNTS, CALENDAR_CLAUSE_HEADING } from "./calendar-terms";

/**
 * BAA 1.3.0 as the pre-release audit of 6 October 2026 left it
 * (docs/counsel/agreement-changes.md §12.14), checked here on the catalog's
 * side: the shared state-law clause in both agreements' words, the render
 * guard, and every clause a document names resolving to one of its own
 * headings. apps/app/tests/baa-golden.test.ts freezes the bytes.
 */

const unwrap = (text: string) => text.replace(/\s+/g, " ").trim();

const SIGNER = {
  clinicLegalName: "Golden Clinic LLC",
  signatoryName: "Alex Chen",
  signatoryTitle: "Owner",
  signatoryEmail: "alex@golden.test",
  effectiveDate: "2026-10-06",
};

/** Every 1.3.0 document checkout can produce: each booking system, account kind and status answer. */
function everyDocument(): { label: string; variables: BaaVariables }[] {
  const template = getBaaTemplate("1.3.0")!;
  return BOOKING_SYSTEMS.flatMap((system) =>
    CALENDAR_ACCOUNTS.flatMap((calendarAccount) =>
      ([true, false, null] as const).map((isCoveredEntity) => ({
        label: `${system.id}/${calendarAccount}/${String(isCoveredEntity)}`,
        variables: {
          ...buildBaaSelections({
            specialtyId: "med-spa",
            attributionMode: "estimated",
            bookingSystem: system.id,
            isCoveredEntity,
            calendarAccount,
            template,
          }),
          ...SIGNER,
        },
      })),
    ),
  );
}

describe("the shared state-law clause", () => {
  test("is the BAA's clause 4, its calendar text following the booking sync", () => {
    const template = getBaaTemplate("1.3.0")!;
    for (const { label, variables } of everyDocument()) {
      const clause = template.clauses.find((c) => c.id === "state-law")!;
      expect(clause.heading).toBe(STATE_LAW_CLAUSE_HEADING);
      const sync =
        BOOKING_SYSTEMS.find((s) => s.id === variables.bookingSystem)!.readsGoogleCalendar === "yes"
          ? "live"
          : "manual";
      expect(clause.body(variables), label).toBe(
        stateLawClauseBody({ subject: "patient information", sync }),
      );
    }
  });

  test("defaults its kind from the subject, and names the calendar clause by its heading", () => {
    for (const sync of ["live", "manual"] as const) {
      expect(stateLawClauseBody({ subject: "patient information", sync })).toBe(
        stateLawClauseBody({ subject: "patient information", kind: "baa", sync }),
      );
      expect(stateLawClauseBody({ subject: "Client Information", sync })).toBe(
        stateLawClauseBody({ subject: "Client Information", kind: "dpa", sync }),
      );
    }
    const live = unwrap(stateLawClauseBody({ subject: "patient information", sync: "live" }));
    expect(live).toContain(`the clause headed "${CALENDAR_CLAUSE_HEADING}"`);
    const manual = unwrap(stateLawClauseBody({ subject: "patient information", sync: "manual" }));
    expect(manual).not.toContain(`the clause headed "${CALENDAR_CLAUSE_HEADING}"`);
    expect(manual).not.toContain("free and busy times on each calendar");
    expect(manual).toContain("where a calendar election for a location provides for it");
  });

  test("in the DPA's words names no PHI and no patient, and carries the CMIA sentence itself", () => {
    for (const sync of ["live", "manual"] as const) {
      const dpa = stateLawClauseBody({ subject: "Client Information", sync });
      const flat = unwrap(dpa);
      expect(flat, sync).not.toMatch(/\bPHI\b|patient|45 CFR|covered entity/i);
      expect(flat, sync).toContain(
        'the other booking details the clause headed "Minimum necessary, and who receives Client Information" lists',
      );
      expect(flat, sync).toContain(
        'as the clause headed "Reporting incidents and breaches" provides for a breach',
      );
      expect(flat, sync).toContain('handled as the clause headed "Clients\' requests" provides');
      expect(flat, sync).toContain("Cal. Civ. Code 56.10(c)(3)");
      // No own-use clause in a DPA, so no statistics purpose.
      expect(flat, sync).not.toMatch(/\bi\. de-identify|de-identified statistics/);
      expect(flat, sync).toContain("and meet healdesk's own legal obligations.");
      for (const line of dpa.split("\n")) expect(line.length, line).toBeLessThanOrEqual(78);
    }
  });

  test("in the BAA's words leaves the CMIA sentence to the permitted-uses clause, for every practice", () => {
    for (const sync of ["live", "manual"] as const) {
      const baa = unwrap(stateLawClauseBody({ subject: "patient information", sync }));
      expect(baa, sync).not.toContain("56.10(c)(3)");
      expect(baa, sync).toContain("i. de-identify it");
      expect(baa, sync).toContain(`within ${BACKUP_RETENTION_DAYS} days after that`);
    }
    const permitted = getBaaTemplate("1.3.0")!
      .clauses.find((c) => c.id === "permitted-uses")!
      .body({} as never);
    expect(unwrap(permitted)).toContain(
      "under Cal. Civ. Code 56.10(c)(3), whether or not Practice is a covered entity",
    );
  });

  test("in 1.4.0's words differs from 1.3.0's only where a transcript was kept", () => {
    // The owner's decision of 13 October 2026: a transcript is emailed to the
    // practice, not kept. Purpose e and the data involved say so; every other
    // sentence is the released 1.3.0 clause's, which stateLawClauseBody keeps.
    const template = getBaaTemplate("1.4.0")!;
    for (const { label, variables } of everyDocument()) {
      const clause = template.clauses.find((c) => c.id === "state-law")!;
      const sync =
        BOOKING_SYSTEMS.find((s) => s.id === variables.bookingSystem)!.readsGoogleCalendar === "yes"
          ? "live"
          : "manual";
      expect(clause.body(variables), label).toBe(
        stateLawClauseBody140({ subject: "patient information", sync }),
      );
    }
    for (const subject of ["patient information", "Client Information"] as const) {
      for (const sync of ["live", "manual"] as const) {
        const label = `${subject}/${sync}`;
        const kept = unwrap(stateLawClauseBody({ subject, sync }));
        const emailed = unwrap(stateLawClauseBody140({ subject, sync }));
        expect(kept, label).toContain(
          "e. keep transcripts and records of those conversations and bookings, show them to Practice's staff, and export, correct or delete them when Practice asks;",
        );
        expect(emailed, label).toContain(
          "e. email Practice the transcript of each call and website chat, keep records of those conversations, without what was said or written in them, and of bookings, show those records to Practice's staff, and export, correct or delete them when Practice asks;",
        );
        expect(kept, label).toContain(`The ${subject} involved is what people say or write, kept as transcripts with no call audio;`);
        expect(emailed, label).toMatch(
          new RegExp(
            `The ${subject} involved is what people say or write, which healdesk keeps no longer than the clause headed "Minimum necessary[^"]*" allows and, from a call or a website chat, emails to Practice as a transcript, with no call audio;`,
          ),
        );
        expect(emailed, label).not.toMatch(/keep transcripts|kept as transcripts/);
        // Everything else is the same text: take the two changed sentences
        // out of each, and what is left is identical.
        const strip = (text: string) =>
          text
            .replace(/e\. (keep transcripts|email Practice the transcript)[^;]*;/, "e.")
            .replace(/The \w+ information involved is what people say or write, [^;]*;/i, "");
        expect(strip(emailed), label).toBe(strip(kept));
        for (const line of stateLawClauseBody140({ subject, sync }).split("\n")) {
          expect(line.length, line).toBeLessThanOrEqual(78);
        }
      }
    }
  });

  test("states one combination rule, one sale-or-share promise and one backup period", () => {
    const flat = unwrap(stateLawClauseBody({ subject: "patient information", sync: "live" }));
    expect(flat.match(/will not combine/g)).toHaveLength(1);
    expect(flat.match(/sell or share/g)).toHaveLength(1);
    expect(flat).not.toMatch(/six months|return-or-destroy|the Own use clause|email addresses/);
    expect(flat).toContain(
      "except to keep the Services secure and to detect and prevent fraud and abuse",
    );
  });
});

describe("1.5.0's state-law clause", () => {
  test("is 1.4.0's own object: it promises nothing the delete-on-delivery decision changed", () => {
    // The owner's decision of 14 October 2026 changes only how long the
    // transcript's copy is held, which the state-law clause leaves to the
    // Minimum necessary clause.
    const clause = (version: string) => getBaaTemplate(version)!.clauses.find((c) => c.id === "state-law")!;
    expect(clause("1.5.0")).toBe(clause("1.4.0"));
    expect(unwrap(stateLawClauseBody140({ subject: "patient information", sync: "live" }))).not.toMatch(
      /seven days/,
    );
  });
});

describe("1.5.1's state-law clause", () => {
  test("is 1.5.0's own object: it names the booking details by the list, never by a channel", () => {
    // The owner's decision of 19 October 2026 changes only which channels
    // items (b) and (c) of the Minimum necessary clause name; the state-law
    // clause points at that list, so it says the same under either.
    const clause = (version: string) =>
      getBaaTemplate(version)!.clauses.find((c) => c.id === "state-law")!;
    expect(clause("1.5.1")).toBe(clause("1.5.0"));
    const text = unwrap(stateLawClauseBody140({ subject: "patient information", sync: "live" }));
    expect(text).toContain('the other booking details the clause headed "Minimum necessary" lists');
    expect(text).not.toMatch(/only on a call|on a call, where/);
  });
});

describe("1.6.0's state-law clause", () => {
  test("differs from 1.4.0's (and 1.5.1's) only in its two exceptions to deletion, which name no purpose", () => {
    // 1.6.0's Subcontractors clause gives Anthropic's retention no purpose,
    // because Anthropic's documentation gives none for the models the product
    // calls (agreement-changes.md §17). 1.4.0's cross-references, which 1.5.0
    // and 1.5.1 carry, said "for abuse detection and security", and left the
    // standard retention outside the only exception; 1.6.0's except what that
    // clause says, for its periods.
    const template = getBaaTemplate("1.6.0")!;
    for (const { label, variables } of everyDocument()) {
      const clause = template.clauses.find((c) => c.id === "state-law")!;
      const sync =
        BOOKING_SYSTEMS.find((s) => s.id === variables.bookingSystem)!.readsGoogleCalendar === "yes"
          ? "live"
          : "manual";
      expect(clause.body(variables), label).toBe(
        stateLawClauseBody160({ subject: "patient information", sync }),
      );
    }
    for (const subject of ["patient information", "Client Information"] as const) {
      for (const sync of ["live", "manual"] as const) {
        const label = `${subject}/${sync}`;
        const was = unwrap(stateLawClauseBody140({ subject, sync }));
        const now = unwrap(stateLawClauseBody160({ subject, sync }));
        expect(now, label).not.toMatch(/abuse detection|purpose and period|used for nothing else\. healdesk keeps/);
        expect(now, label).toContain(
          'The only exception is what the clause headed "Subcontractors" says a subcontractor may keep, for the periods that clause states, and that is kept for those periods only. healdesk keeps only a record of the request',
        );
        expect(now, label).toContain(
          "The only exception to a subcontractor's duty to delete is what that clause says it may keep, for the periods that clause states.",
        );
        const strip = (text: string) =>
          text
            .replace(/says a subcontractor may keep[^;]*?(?= healdesk keeps only a record)/, "")
            .replace(/(duty to delete is what that clause) says it may keep[^.]*\./, "$1");
        expect(strip(now), label).toBe(strip(was));
        for (const line of stateLawClauseBody160({ subject, sync }).split("\n")) {
          expect(line.length, line).toBeLessThanOrEqual(78);
        }
      }
    }
  });
});

describe("the Payments clause", () => {
  test("names no patient, so the DPA shares it word for word", () => {
    expect(PAYMENTS_CLAUSE_BODY).not.toMatch(/patient|PHI/i);
    expect(PAYMENTS_CLAUSE_BODY).toContain("healdesk may send a payment link");
    expect(PAYMENTS_CLAUSE_BODY).toContain("On a call it sends none");
  });
});

describe.each(["1.3.0", "1.4.0", "1.5.0", "1.5.1", "1.6.0"])("%s's render guard", (version) => {
  test("refuses verified reporting, the phase-two read-back it does not describe", () => {
    const template = getBaaTemplate(version)!;
    expect(template.clauses.map((c) => c.id)).not.toContain("data-sources-verified");
    const verified = buildBaaSelections({
      specialtyId: "med-spa",
      attributionMode: "verified",
      bookingSystem: "boulevard",
      isCoveredEntity: true,
      calendarAccount: "workspace_baa",
      template,
    });
    expect(() => prepareBaa(template, { ...verified, ...SIGNER })).toThrow(BaaRenderError);
    expect(() => prepareBaa(template, { ...verified, ...SIGNER })).toThrow(
      new RegExp(`Version ${version.replaceAll(".", "\\.")} has no verified-reporting clause`),
    );
  });
});

describe.each(["1.3.0", "1.4.0", "1.5.0", "1.5.1", "1.6.0"])("every %s document", (version) => {
  test("names other clauses only by headings it has, and fits 78 columns", () => {
    const template = getBaaTemplate(version)!;
    for (const { label, variables } of everyDocument()) {
      const { text } = prepareBaa(template, variables);
      const headings = [...text.matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]!);
      const flat = unwrap(text);
      for (const [, heading] of flat.matchAll(/the clause headed "([^"]+)"/gi)) {
        expect(
          headings.filter((h) => h === heading!.toUpperCase()),
          `${label}: "${heading}"`,
        ).toHaveLength(1);
      }
      for (const [, words] of flat.matchAll(/\b[Tt]he ((?:[A-Z][\w']*,? ?)+?) clause\b/g)) {
        const opening = words!.trim().replace(/,$/, "").toUpperCase();
        expect(
          headings.filter(
            (h) => h === opening || h.startsWith(`${opening} `) || h.startsWith(`${opening},`),
          ),
          `${label}: "the ${words} clause"`,
        ).toHaveLength(1);
      }
      for (const line of text.split("\n"))
        expect(line.length, `${label}: ${line}`).toBeLessThanOrEqual(78);
      expect(text, label).not.toMatch(/revenue|\{\{|undefined|\[object/i);
    }
    // 72 documents and every reference in each: give a busy runner room.
  }, 30_000);
});
