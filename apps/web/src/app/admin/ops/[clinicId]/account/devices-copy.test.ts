import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import type { ClinicDevicesView, OpsResult } from "@/lib/admin/ops-client";

import { DevicesSection } from "./DevicesSection";

/**
 * What the account page says about a clinic's devices (wave 2, R4; plan Part
 * D3 and Annex X5's O3): the devices by name; the human route's link, sent
 * only with the call back and a fresh code, and once it is out, ended
 * instead of sent twice; and the removal, which says the reply to a device
 * email is never enough alone. Rendered to static markup and read as text,
 * as the other admin copy rules are.
 */

function text(node: React.ReactElement): string {
  return renderToStaticMarkup(node)
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&rsquo;/g, "’")
    .replace(/\s+/g, " ")
    .trim();
}

const NOT_IN_A_RENDER = async (): Promise<never> => {
  throw new Error("an action ran during a static render");
};
const ACTIONS = {
  issueRecovery: NOT_IN_A_RENDER,
  endRecovery: NOT_IN_A_RENDER,
  removeDevices: NOT_IN_A_RENDER,
};

const CLINIC = "0c1d2e3f-0000-4000-8000-000000000000";

function view(overrides: Partial<ClinicDevicesView> = {}): OpsResult<ClinicDevicesView> {
  return {
    ok: true,
    data: {
      clinicId: CLINIC,
      hasSignIn: true,
      devices: [],
      hasBackup: false,
      backupCodesLeft: 0,
      sessions: 1,
      patientDataMayExist: true,
      recoveries: [],
      ...overrides,
    },
  };
}

describe("the devices section", () => {
  test("a clinic with no device after go-live: the link, behind the call back and a fresh code", () => {
    const page = text(h(DevicesSection, { view: view(), actions: ACTIONS }));
    expect(page).toContain("No device can open patient details.");
    expect(page).toContain("Send a link to add a device (the clinic lost every device)");
    expect(page).toContain(
      "I called the practice back on its published number, and it asked for this.",
    );
    expect(page).toContain("Code from your authenticator");
    expect(page).toContain("once, within 24 hours");
    expect(page).not.toContain("End this link");
  });

  test("a link already out is ended, not sent twice", () => {
    const page = text(
      h(DevicesSection, {
        view: view({
          recoveries: [
            {
              id: "9b2e1c4d-1111-4c2a-9a8b-1f2e3d4c5b6a",
              state: "open",
              issuedBy: "ops@healdesk.test",
              createdAt: "2026-10-19T14:32:00.000Z",
              expiresAt: "2026-10-20T14:32:00.000Z",
              claimedAt: null,
              usedAt: null,
              revokedAt: null,
              revokedReason: null,
            },
          ],
        }),
        actions: ACTIONS,
      }),
    );
    expect(page).toContain("working until 2026-10-20 14:32 UTC");
    expect(page).toContain("End this link");
    expect(page).not.toContain("Send the link");
  });

  test("devices by name, and their removal, which the reply alone never starts", () => {
    const page = text(
      h(DevicesSection, {
        view: view({
          devices: [
            {
              id: "1b2e1c4d-1111-4c2a-9a8b-1f2e3d4c5b6a",
              label: "Unknown iPhone",
              addedAt: "2026-10-19T14:32:00.000Z",
              lastUsedAt: null,
            },
          ],
          hasBackup: true,
          backupCodesLeft: 10,
          sessions: 2,
        }),
        actions: ACTIONS,
      }),
    );
    expect(page).toContain("Unknown iPhone");
    expect(page).toContain(
      "Authenticator backup set, 10 backup codes left. Browsers signed in now: 2.",
    );
    expect(page).toContain(
      "Remove devices and sign everyone out (the clinic replied to a device email)",
    );
    expect(page).toContain("Never on the reply alone: call the practice back first.");
    expect(page).toContain(
      "The clinic replied, and I called it back on its published number to confirm.",
    );
  });

  test("before go-live, it says no link is needed", () => {
    const page = text(
      h(DevicesSection, { view: view({ patientDataMayExist: false }), actions: ACTIONS }),
    );
    expect(page).toContain("the clinic can add its first device from any signed-in browser");
  });
});
