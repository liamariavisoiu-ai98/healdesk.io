import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The extraction in two halves (lib/demo/structure.ts): the treatment list
 * and everything else, asked side by side, merged into one profile, and a
 * profile still made when one half fails.
 */

type Params = { output_config: { format: { schema: { required: string[] } } } };
const createBy = vi.fn<(client: unknown, params: Params, deadline: number) => Promise<unknown>>();
vi.mock("./fast", () => ({ createBy: (client: unknown, params: Params, deadline: number) => createBy(client, params, deadline) }));

const { structureProfile, StructureError } = await import("./structure");

const reply = (json: unknown) => ({ content: [{ type: "text", text: JSON.stringify(json) }], stop_reason: "end_turn" });
const isServices = (params: Params) => params.output_config.format.schema.required.join() === "services";
const PAGES = [{ url: "https://glow.com/", title: "Glow", text: "Glow" }];

describe("the extraction, in two halves", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    createBy.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("asks for the treatment list and everything else at once, by the same deadline, and merges them", async () => {
    createBy.mockImplementation(async (_c, params) =>
      isServices(params)
        ? reply({ services: [{ name: "Botox", description: "", price: "$12/unit", duration: "" }] })
        : reply({ clinic_name: "Glow Med Spa", summary: "", specialty: "med-spa", phone: "", address: "", hours: [{ days: "Mon", hours: "9-5" }], providers: [], faqs: [], policies: [], booking: "", highlights: [] }),
    );
    const deadline = Date.now() + 15_000;
    const profile = await structureProfile(PAGES, { clinicName: "Glow", niche: null, deadline });
    expect(createBy).toHaveBeenCalledTimes(2);
    expect(createBy.mock.calls.every(([, , d]) => d === deadline)).toBe(true);
    expect(profile.clinicName).toBe("Glow Med Spa");
    expect(profile.services.map((s) => s.name)).toEqual(["Botox"]);
    expect(profile.hours).toEqual([{ days: "Mon", hours: "9-5" }]);
  });

  it("builds from the half that came back when the other did not", async () => {
    createBy.mockImplementation(async (_c, params) => {
      if (isServices(params)) throw new Error("timed out");
      return reply({ clinic_name: "Glow Med Spa", hours: [{ days: "Mon", hours: "9-5" }] });
    });
    const profile = await structureProfile(PAGES, { clinicName: "Glow", niche: null });
    expect(profile.services).toEqual([]);
    expect(profile.hours).toHaveLength(1);
  });

  it("fails when neither half came back", async () => {
    createBy.mockImplementation(async () => {
      throw new Error("timed out");
    });
    await expect(structureProfile(PAGES, { clinicName: "Glow", niche: null })).rejects.toBeInstanceOf(StructureError);
  });
});
