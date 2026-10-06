import { describe, expect, test } from "vitest";

import { BAA_TEMPLATES, currentBaaTemplate, getBaaTemplate } from "./baa";
import {
  BAA_CLAUSE_EXPLAINERS,
  BAA_CLAUSE_EXPLAINERS_BY_VERSION,
  clauseExplainer,
  type BaaExplainerTerm,
} from "./baa-explainer";
import { CALENDAR_CLAUSE_IDS } from "./calendar-terms";
import { SUBPROCESSOR_NOTICE_HOURS } from "./subprocessor-notice";

/**
 * The notes the signing screen shows beside a clause. Each has to stay true
 * to the clause it sits beside, in the version it sits beside, so the ones a
 * clause depends on are pinned here as the clauses are pinned in apps/app's
 * golden test: changing one is a decision, not a refactor.
 */

/** Every note any version can show: the shared ones and each version's own. */
const EVERY_NOTE: [string, BaaExplainerTerm][] = [
  ...Object.entries(BAA_CLAUSE_EXPLAINERS),
  ...Object.entries(BAA_CLAUSE_EXPLAINERS_BY_VERSION).flatMap(([version, notes]) =>
    Object.entries(notes).map(([id, note]): [string, BaaExplainerTerm] => [
      `${version}/${id}`,
      note!,
    ]),
  ),
];

describe("the notes beside the calendar clauses", () => {
  test("every calendar clause 1.3.0 can render has one", () => {
    for (const id of Object.values(CALENDAR_CLAUSE_IDS)) {
      expect(clauseExplainer("1.3.0", id), id).toBeDefined();
    }
  });

  test("say what each clause says, in plain words", () => {
    // Plan §2.5's notes; the covered and uncovered ones also name the
    // calendar-list read, as their clauses do (agreement-changes.md §12.5).
    expect(BAA_CLAUSE_EXPLAINERS["google-calendar-covered"]).toEqual({
      plain:
        "You connect your own Google Calendar with a Google login, and you've told us your " +
        "Workspace administrator has accepted Google's business associate agreement — we can't " +
        "check that, so it is your statement. healdesk reads the names of your calendars, so you " +
        "can choose the one it books into, and when that calendar is free or busy; it adds each " +
        "booking (made by the assistant or confirmed by your staff) as a private event with a " +
        "first name, the service and the time — never a phone number, an email address or " +
        "anything clinical — and never touches anything it didn't create",
      citation: "164.502(b), 164.504(e)(2)(i)",
    });
    expect(BAA_CLAUSE_EXPLAINERS["google-calendar-uncovered"]).toEqual({
      plain:
        "Google's agreement doesn't cover this calendar (a personal Gmail account can't have " +
        "one). You are telling us to add bookings anyway — a first name, the service and the " +
        "time, as private events — and that disclosure to Google is yours to answer for. " +
        "healdesk reads the names of your calendars, so you can choose the one it books into, " +
        "and when that calendar is free or busy; it sends nothing else and stops adding " +
        "bookings as soon as you disconnect",
      citation: "164.502(a), 164.504(e)(2)(i)",
    });
    expect(BAA_CLAUSE_EXPLAINERS["google-calendar-not-used"]).toEqual({
      plain:
        "Your booking system doesn't read Google Calendar, or we haven't confirmed that it does, " +
        "so healdesk doesn't connect to your calendar at all. The assistant takes each booking " +
        "as a request and your staff confirm it in your own system. Switching later means " +
        "recording a short calendar election",
      citation: "164.502(b)",
    });
  });

  test("the not-used note claims no connection, and nothing read or added", () => {
    const { plain } = BAA_CLAUSE_EXPLAINERS["google-calendar-not-used"];
    expect(plain).toContain("healdesk doesn't connect to your calendar at all");
    expect(plain).not.toMatch(/Google login|reads|adds|private event|first name/);
  });
});

describe("every note", () => {
  test("promises no revocation at Google", () => {
    // The clauses promise deletion of the stored token, which the code always
    // does, and never a revocation, which it does only for an unused grant.
    for (const [id, note] of EVERY_NOTE) expect(note.plain, id).not.toMatch(/revok/i);
  });

  test("sits beside a clause the version it belongs to renders", () => {
    const registered = new Set(BAA_TEMPLATES.flatMap((t) => t.clauses.map((c) => c.id)));
    for (const id of Object.keys(BAA_CLAUSE_EXPLAINERS)) expect(registered.has(id), id).toBe(true);
    for (const [version, notes] of Object.entries(BAA_CLAUSE_EXPLAINERS_BY_VERSION)) {
      const ids = getBaaTemplate(version)?.clauses.map((c) => c.id) ?? [];
      for (const id of Object.keys(notes)) expect(ids, `${version}/${id}`).toContain(id);
    }
  });
});

describe("the subcontractors note", () => {
  /** The notice period one version's subcontractors clause states, e.g. "fifteen days". */
  const period = (version: string) => {
    const body = getBaaTemplate(version)!
      .clauses.find((c) => c.id === "subcontractors")!
      .body({} as never)
      .replace(/\s+/g, " ");
    return /at least ([\w ]+?)' notice/.exec(body)?.[1];
  };

  test("states the notice period of the version it sits beside", () => {
    expect(period("1.2.1")).toBe("fifteen days");
    expect(clauseExplainer("1.2.1", "subcontractors")!.plain).toContain(
      "You get fifteen days' notice before a new vendor handles patient information",
    );
    expect(period("1.3.0")).toBe(`${SUBPROCESSOR_NOTICE_HOURS} hours`);
    const note130 = clauseExplainer("1.3.0", "subcontractors")!.plain;
    expect(note130).toContain(
      "You're told by email at least 24 hours before a new vendor handles patient information",
    );
    // With a day's notice, when an objection must arrive is what matters.
    expect(note130).toContain(
      "may end the agreement without penalty if you object on reasonable grounds before the " +
        "change takes effect",
    );
    expect(note130).not.toMatch(/fifteen/);
  });

  test("is what the offered checkout has always shown, so drafting 1.3.0 changes nothing it shows", () => {
    // AgreementStep reads BAA_CLAUSE_EXPLAINERS directly, beside 1.2.1.
    expect(BAA_CLAUSE_EXPLAINERS.subcontractors).toEqual({
      plain:
        "Every vendor that handles patient information signs the same obligations with " +
        "healdesk before it does. The language model is Anthropic's: under its agreement with " +
        "healdesk it keeps conversation content for 30 days, for abuse detection and security, " +
        "then deletes it (content its safety systems flag, or the law requires it to keep, may " +
        "be held for up to two years), and never trains on it. You get fifteen days' notice " +
        "before a new vendor handles patient information, and may end the agreement if you " +
        "object on reasonable grounds",
      citation: "164.504(e)(2)(ii)(D), 164.308(b)(2)",
    });
    expect(clauseExplainer(currentBaaTemplate().version, "subcontractors")).toBe(
      BAA_CLAUSE_EXPLAINERS.subcontractors,
    );
  });
});

describe("looking a note up", () => {
  test("takes the version's own note first, then the shared one, and none for a clause without one", () => {
    expect(clauseExplainer("1.3.0", "subcontractors")).toBe(
      BAA_CLAUSE_EXPLAINERS_BY_VERSION["1.3.0"]!.subcontractors,
    );
    expect(clauseExplainer("1.3.0", "minimum-necessary")).toBe(
      BAA_CLAUSE_EXPLAINERS["minimum-necessary"],
    );
    expect(clauseExplainer("1.2.1", "google-calendar")).toBe(
      BAA_CLAUSE_EXPLAINERS["google-calendar"],
    );
    expect(clauseExplainer("1.3.0", "definitions")).toBeUndefined();
    expect(clauseExplainer("1.3.0", "toString")).toBeUndefined();
    expect(clauseExplainer("toString", "subcontractors")).toBe(
      BAA_CLAUSE_EXPLAINERS.subcontractors,
    );
  });
});
