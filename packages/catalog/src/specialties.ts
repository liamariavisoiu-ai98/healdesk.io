/**
 * Specialty identifiers.
 *
 * Only the ids and display names live here — the shared part. The rich demo
 * content (greetings, pricing context, scripted transcripts) stays in
 * apps/web/src/lib/specialties.ts, because apps/app has no use for it and
 * shipping it into the product bundle would be noise.
 *
 * The ids must match between the two. That is the whole reason this file exists.
 *
 * Dermatology was its own id until it was folded into `med-spa`, which now
 * reads "Med Spas, Dermatology & Aesthetics". The two share a caller, a ticket
 * and a front desk, and splitting them made the buyer choose between two
 * descriptions of the same practice. Note that `dermatology` survives in
 * segments.ts, which is a different vocabulary: we still prospect derm clinics
 * by name, and the knowledge tree still holds a dermatology practice layer for
 * when a visitor says that is what they run.
 */

export type SpecialtyId =
  | "med-spa"
  | "plastic-surgery"
  | "fertility"
  | "dental"
  | "glp1"
  | "hair-restoration"
  | "veterinary"
  | "massage-chiro";

export const specialties: readonly { id: SpecialtyId; name: string }[] = [
  { id: "med-spa", name: "Med Spas, Dermatology & Aesthetics" },
  { id: "plastic-surgery", name: "Plastic & Cosmetic Surgery" },
  { id: "fertility", name: "Fertility & IVF" },
  { id: "dental", name: "Dental & Orthodontics" },
  { id: "glp1", name: "Weight Loss & GLP-1" },
  { id: "hair-restoration", name: "Hair Restoration" },
  { id: "veterinary", name: "Veterinary & Pet Spas" },
  { id: "massage-chiro", name: "Massage & Chiropractic" },
] as const;

export function isSpecialtyId(id: unknown): id is SpecialtyId {
  return typeof id === "string" && specialties.some((s) => s.id === id);
}
