import { describe, expect, test } from "vitest";

import { BAA_TEMPLATES, currentBaaTemplate, getBaaTemplate } from "./baa";
import {
  BAA_CLAUSE_EXPLAINERS,
  BAA_CLAUSE_EXPLAINERS_BY_VERSION,
  BAA_EXPLAINER,
  BAA_EXPLAINER_TERMS_BY_VERSION,
  baaExplainerFor,
  baaExplainerTerms,
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
    // Plan §2.5's notes, as the pre-release audit of 6 October 2026 left the
    // clauses: the calendar-list read and one calendar per provider; the
    // covered clause's organisation check; "we treat" for an account nobody
    // has confirmed Google's agreement covers; the first name the person
    // booking gave; and a move to a system that reads Google Calendar as the
    // only route to booking live (agreement-changes.md §12.14).
    expect(BAA_CLAUSE_EXPLAINERS["google-calendar-covered"]).toEqual({
      plain:
        "You connect your own Google account with a Google login, and you've told us your " +
        "Workspace administrator has accepted Google's business associate agreement — we can't " +
        "check that, so it is your statement. healdesk books only into calendars that belong to " +
        "your own Workspace organisation, and checks that before every booking. It reads the " +
        "names of your calendars, so you can choose the one it books into (or one per provider), " +
        "and when those calendars are free or busy; it adds each booking (made by the assistant " +
        "or confirmed by your staff) as a private event with the first name the person booking " +
        "gave, the service and the time — never a phone number, an email address or anything " +
        "clinical beyond the service's name — and never touches anything it didn't create",
      citation: "164.502(b), 164.504(e)(2)(i)",
    });
    expect(BAA_CLAUSE_EXPLAINERS["google-calendar-uncovered"]).toEqual({
      plain:
        "We treat this calendar as one Google's agreement doesn't cover (a personal Gmail " +
        "account can't have one). You are telling us to add bookings anyway — a first name, the " +
        "service and the time, as private events — and that disclosure to Google is yours to " +
        "answer for. healdesk reads the names of your calendars, so you can choose the one it " +
        "books into (or one per provider), and when those calendars are free or busy; it sends " +
        "nothing else and stops adding bookings as soon as you disconnect",
      citation: "164.502(a), 164.504(e)(2)(i)",
    });
    expect(BAA_CLAUSE_EXPLAINERS["google-calendar-not-used"]).toEqual({
      plain:
        "Your booking system doesn't read Google Calendar, or we haven't confirmed that it does, " +
        "so healdesk doesn't connect to your calendar at all. The assistant takes each booking " +
        "as a request and your staff confirm it in your own system. Moving to a booking system " +
        "that checks Google Calendar for conflicts means recording a short calendar election",
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
    // 1.2.2 keeps the fifteen days and changes only where the list is kept,
    // which the note does not mention, so it shows the same note.
    expect(period("1.2.2")).toBe("fifteen days");
    expect(clauseExplainer("1.2.2", "subcontractors")).toBe(BAA_CLAUSE_EXPLAINERS.subcontractors);
    expect(clauseExplainer("1.2.2", "subcontractors")!.plain).not.toMatch(/healdesk\.io|subprocessors/);
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
    // Anthropic's agreement in covenant form, as the 1.3.0 clause states it.
    expect(note130).toContain(
      "only under a business associate agreement with healdesk, signed before any patient's " +
        "information reaches it",
    );
  });

  test("is what the offered checkout has always shown, so drafting 1.3.0 changes nothing it shows", () => {
    // The signing screen shows 1.2.1's note, through clauseExplainer, for
    // 1.2.2 as it did for 1.2.1.
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
      BAA_CLAUSE_EXPLAINERS_BY_VERSION["1.3.0"]!["minimum-necessary"],
    );
    expect(clauseExplainer("1.2.1", "minimum-necessary")).toBe(
      BAA_CLAUSE_EXPLAINERS["minimum-necessary"],
    );
    expect(clauseExplainer("1.3.0", "google-calendar-covered")).toBe(
      BAA_CLAUSE_EXPLAINERS["google-calendar-covered"],
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

describe("the bullets above the agreement", () => {
  /** The bullet citing one subparagraph, in one version's list. */
  const citing = (terms: readonly BaaExplainerTerm[], citation: string) =>
    terms.find((t) => t.citation === citation)!.plain;

  test("1.2.1 and 1.2.2 keep their bullets word for word, because their clause still says use and materially breaches", () => {
    expect(baaExplainerTerms("1.2.1")).toBe(BAA_EXPLAINER.terms);
    expect(baaExplainerTerms("1.2.2")).toBe(BAA_EXPLAINER.terms);
    expect(baaExplainerTerms(currentBaaTemplate().version)).toBe(BAA_EXPLAINER.terms);
    expect(citing(BAA_EXPLAINER.terms, "164.504(e)(2)(ii)(J)")).toBe(
      "At the end of the agreement, return or destroy the patient data we hold and keep no copies " +
        "— and where that is not feasible, keep protecting it under the same terms and use it only " +
        "for whatever makes return or destruction infeasible",
    );
    expect(citing(BAA_EXPLAINER.terms, "164.504(e)(2)(iii)")).toBe(
      "Let you terminate the agreement if we materially breach it",
    );
  });

  test("1.3.0's say what its Term clause and the regulation say: use and disclosure, and a violation Practice determines", () => {
    // HRC-03 and HRC-07 widened the clause; a bullet narrower than the clause
    // beside it is a summary that mis-states the law it cites.
    const terms = baaExplainerTerms("1.3.0");
    expect(terms).toBe(BAA_EXPLAINER_TERMS_BY_VERSION["1.3.0"]);
    expect(terms.map((t) => t.citation)).toEqual(BAA_EXPLAINER.terms.map((t) => t.citation));
    expect(citing(terms, "164.504(e)(2)(ii)(J)")).toContain(
      "limit its use and disclosure to whatever makes return or destruction infeasible",
    );
    expect(citing(terms, "164.504(e)(2)(iii)")).toBe(
      "Let you terminate the agreement if you determine that we have violated a material term of it",
    );
    const term = getBaaTemplate("1.3.0")!
      .clauses.find((c) => c.id === "term")!
      .body({} as never)
      .replace(/\s+/g, " ");
    expect(term).toContain(
      "limit further uses and disclosures of it to those purposes that make its return or destruction infeasible",
    );
    expect(term).toContain(
      "if Practice determines that healdesk has violated a material term of it",
    );
    // Every other bullet is the shared one, unchanged.
    const changed = new Set(["164.504(e)(2)(ii)(J)", "164.504(e)(2)(iii)"]);
    terms.forEach((t, i) => {
      if (!changed.has(t.citation)) expect(t).toBe(BAA_EXPLAINER.terms[i]);
    });
  });

  test("an unknown version, or a key off the prototype, gets the shared bullets", () => {
    expect(baaExplainerTerms("9.9.9")).toBe(BAA_EXPLAINER.terms);
    expect(baaExplainerTerms("toString")).toBe(BAA_EXPLAINER.terms);
  });
});

describe("the explainer for one version (gate 11)", () => {
  test("1.2.2, the signed version, and 1.2.1 get BAA_EXPLAINER itself, so the screen does not move a byte", () => {
    expect(baaExplainerFor("1.2.2")).toBe(BAA_EXPLAINER);
    expect(baaExplainerFor("1.2.1")).toBe(BAA_EXPLAINER);
    expect(baaExplainerFor("1.2.1").terms).toBe(BAA_EXPLAINER.terms);
    expect(baaExplainerFor(currentBaaTemplate().version)).toBe(BAA_EXPLAINER);
    // Every released version that words no bullet differently, and anything unknown.
    for (const version of ["1.2.0", "1.0.0", "9.9.9", "toString", ""]) {
      expect(baaExplainerFor(version), version).toBe(BAA_EXPLAINER);
    }
  });

  test("1.3.0 gets its own bullets under the same heading, lead, objection and disclaimer", () => {
    const explainer = baaExplainerFor("1.3.0");
    expect(explainer.terms).toBe(baaExplainerTerms("1.3.0"));
    expect(explainer.terms).not.toBe(BAA_EXPLAINER.terms);
    const { terms: _shared, ...frame } = BAA_EXPLAINER;
    const { terms: _own, ...ownFrame } = explainer;
    expect(ownFrame).toEqual(frame);
    // The same object each time it is asked for.
    expect(baaExplainerFor("1.3.0")).toBe(explainer);
    const plain = explainer.terms.map((t) => t.plain).join("\n");
    expect(plain).toContain("limit its use and disclosure");
    expect(plain).toContain("if you determine that we have violated a material term of it");
    expect(plain).not.toContain("use it only");
    expect(plain).not.toContain("materially breach");
  });
});
