import { labelClinics, labelClinicsBatched } from "./src/enrich/label.ts";

/** One synthetic clinic, unambiguous on purpose — this tests auth, not judgement. */
const crawl = [{
  clinicId: "verify-1",
  domain: "example-medspa.com",
  text: "Radiance Med Spa. Botox and Dysport from $12 per unit. Juvederm lip filler $650 per syringe. Our master injector treats glabellar lines, crow's feet and lips. Book a free consultation today. We also offer laser hair removal and HydraFacial treatments in our Austin, Texas clinic. New patients welcome — call us to schedule.".repeat(2),
  pagesFetched: 1,
}];

const mode = process.argv[2] ?? "stream";
const fn = mode === "batch" ? labelClinicsBatched : labelClinics;

console.log(`[${mode}] no apiKey passed — the SDK must resolve the ant profile`);
const t0 = Date.now();
// apiKey deliberately omitted: this is the whole point of the check.
const [label] = await fn(crawl, { onProgress: () => {} } as never);
console.log(`[${mode}] ok in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`  segment:    ${label!.segment} (${label!.confidence})`);
console.log(`  evidence:   ${label!.evidence}`);
console.log(`  phone-dep:  ${!label!.offersOnlineBooking}`);
