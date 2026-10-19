import { describe, expect, test } from "vitest";

import {
  GUARANTEE_FAILURES,
  GUARANTEE_OUTCOMES,
  INCIDENT_INFORMATION_TYPES,
  INCIDENT_MITIGATIONS,
  INCIDENT_PATIENT_STEPS,
  INCIDENT_RECOMMENDATIONS,
  INCIDENT_REPORT_EVENTS,
  isIncidentPatientStep,
  isIncidentRecommendation,
  isIncidentReportEvent,
  isProductUpdateCode,
  PHI_SUBCONTRACTORS,
  PRODUCT_UPDATE_SCREENS,
  PRODUCT_UPDATES,
  SUSPENSION_CAUSES,
  TERMS_CHANGE_TOPICS,
} from "./operator-notices";

/**
 * The operator notices' closed lists (WP7). Each code travels in an email
 * payload, which apps/app's allowlist accepts only as a bare token, so every
 * code has that shape; and the lookups refuse what is not a key, prototype
 * names included. The words themselves are linted with the emails in
 * apps/app (tests/operator-notice-templates.test.ts).
 */

const TABLES = {
  INCIDENT_REPORT_EVENTS,
  INCIDENT_INFORMATION_TYPES,
  INCIDENT_MITIGATIONS,
  INCIDENT_PATIENT_STEPS,
  INCIDENT_RECOMMENDATIONS,
  PHI_SUBCONTRACTORS,
  TERMS_CHANGE_TOPICS,
  SUSPENSION_CAUSES,
  GUARANTEE_OUTCOMES,
  GUARANTEE_FAILURES,
  PRODUCT_UPDATES,
};

describe("the operator notices' codes", () => {
  test("are bare tokens the payload allowlist accepts, and every list has at least one", () => {
    for (const [name, table] of Object.entries(TABLES)) {
      const codes = Object.keys(table);
      expect(codes.length, name).toBeGreaterThan(0);
      for (const code of codes) expect(code, `${name}.${code}`).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
    }
  });

  test("the lookups accept only the lists' own keys", () => {
    expect(isIncidentReportEvent("misdirected_email")).toBe(true);
    for (const value of ["constructor", "__proto__", "toString", "", 1, null, undefined]) {
      expect(isIncidentReportEvent(value)).toBe(false);
      expect(isProductUpdateCode(value)).toBe(false);
      expect(isIncidentPatientStep(value)).toBe(false);
      expect(isIncidentRecommendation(value)).toBe(false);
    }
  });

  test("every product update points at one of the portal's screens, with a subject short enough for an email", () => {
    for (const [code, update] of Object.entries(PRODUCT_UPDATES)) {
      expect(PRODUCT_UPDATE_SCREENS, code).toContain(update.action.screen);
      expect(update.subject.length, code).toBeLessThanOrEqual(70);
      expect(update.paragraphs.length, code).toBeGreaterThan(0);
    }
  });
});
