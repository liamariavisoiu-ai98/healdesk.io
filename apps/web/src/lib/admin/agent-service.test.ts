import { describe, expect, test } from "vitest";

import { readAgentService } from "./ops-client";

/**
 * The console's view of one service. The setup wizard and Knowledge store how
 * a price is stated, a per-unit price's unit and the deposit beside the four
 * fields the console edits; the parser used to drop them, so the form sent
 * every service back without them and a greeting edit erased them.
 */

describe("a service as the console reads it", () => {
  test("keeps the price kind, the unit, the deposit and the cents", () => {
    expect(
      readAgentService({
        name: "Laser session",
        priceKind: "per_unit",
        priceFromUsd: 14.5,
        priceToUsd: null,
        unit: "pulse",
        durationMinutes: 30,
        depositUsd: 50,
      }),
    ).toEqual({
      name: "Laser session",
      priceKind: "per_unit",
      priceFromUsd: 14.5,
      priceToUsd: null,
      unit: "pulse",
      durationMinutes: 30,
      depositUsd: 50,
    });
  });

  test("leaves out what was never there, or is malformed, for apps/app to keep", () => {
    expect(
      readAgentService({
        name: "Facial",
        priceFromUsd: 120,
        priceToUsd: 120,
        durationMinutes: 60,
        priceKind: "per_hour",
        depositUsd: "fifty",
      }),
    ).toEqual({ name: "Facial", priceFromUsd: 120, priceToUsd: 120, durationMinutes: 60 });
  });
});
