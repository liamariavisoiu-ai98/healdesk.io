/**
 * Specialty identifiers.
 *
 * Only the ids and display names live here — the shared part. The rich demo
 * content (greetings, pricing context, scripted transcripts) stays in
 * apps/web/src/lib/specialties.ts, because apps/app has no use for it and
 * shipping it into the product bundle would be noise.
 *
 * The ids must match between the two. That is the whole reason this file exists.
 */

export type SpecialtyId =
  | "med-spa"
  | "plastic-surgery"
  | "fertility"
  | "dental"
  | "dermatology"
  | "glp1";

export const specialties: readonly { id: SpecialtyId; name: string }[] = [
  { id: "med-spa", name: "Med Spa & Aesthetics" },
  { id: "plastic-surgery", name: "Plastic & Cosmetic Surgery" },
  { id: "fertility", name: "Fertility & IVF" },
  { id: "dental", name: "Dental & Orthodontics" },
  { id: "dermatology", name: "Dermatology" },
  { id: "glp1", name: "Weight Loss & GLP-1" },
] as const;

export function isSpecialtyId(id: unknown): id is SpecialtyId {
  return typeof id === "string" && specialties.some((s) => s.id === id);
}
