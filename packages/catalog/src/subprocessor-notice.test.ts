import { describe, expect, test } from "vitest";

import { getBaaTemplate } from "./baa";
import {
  SUBPROCESSOR_NOTICE_HEADING,
  SUBPROCESSOR_NOTICE_HOURS,
  subprocessorNoticeClauseBody,
} from "./subprocessor-notice";

describe("notice before a new subcontractor", () => {
  test("is 24 hours by email, and keeps the right to object", () => {
    expect(SUBPROCESSOR_NOTICE_HOURS).toBe(24);
    expect(SUBPROCESSOR_NOTICE_HEADING.trim()).not.toBe("");
    const body = subprocessorNoticeClauseBody();
    expect(body).toContain("at least 24 hours' notice by email before adding one");
    expect(body).toContain("healdesk.io/subprocessors");
    // Where the notice goes and what it says (pre-release audit: SUB-01, PT-08, PT-15).
    expect(body).toContain(
      "The notice goes to Practice's address in the Notices clause and names the subcontractor, " +
        "what it will receive and why.",
    );
    expect(body).toContain(
      "If Practice objects on reasonable grounds before the change takes effect, Practice may " +
        "terminate this agreement without penalty.",
    );
  });

  test("is worded for any agreement that carries it, not only one about PHI", () => {
    // The funnel's data protection agreement carries the same sentence.
    expect(subprocessorNoticeClauseBody()).not.toMatch(
      /\bPHI\b|protected health information|Term clause/,
    );
  });

  test("1.3.0 carries it; 1.2.1 keeps its fifteen days", () => {
    const flat = (version: string) =>
      getBaaTemplate(version)!
        .clauses.find((c) => c.id === "subcontractors")!
        .body({} as never)
        .replace(/\s+/g, " ");
    expect(flat("1.3.0")).toContain(subprocessorNoticeClauseBody());
    expect(flat("1.3.0")).not.toContain("fifteen days");
    expect(flat("1.2.1")).toContain("at least fifteen days' notice");
  });
});
