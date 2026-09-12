/**
 * Specialty identifiers.
 *
 * Only the ids, display names and the regulatory regime live here — the shared
 * part. The rich demo content (greetings, pricing context, scripted
 * transcripts) stays in apps/web/src/lib/specialties.ts, because apps/app has
 * no use for it and shipping it into the product bundle would be noise.
 *
 * The ids must match between the two. That is the whole reason this file exists.
 *
 * Dermatology was its own id until it was folded into `med-spa`, which now
 * reads "Med Spas, Dermatology & Aesthetics". The two share a caller, a ticket
 * and a front desk, and splitting them made the buyer choose between two
 * descriptions of the same practice. Note that `dermatology` survives in
 * segments.ts, which is a different vocabulary: we still prospect derm clinics
 * by name, and the knowledge tree still holds a dermatology practice layer for
 * when a visitor says that is what they run. `SEGMENT_TO_SPECIALTY` in that
 * file is the bridge from one vocabulary to the other.
 *
 * ## Regulatory regime: which paperwork a specialty signs at checkout
 *
 * HIPAA protects individually identifiable health information of PERSONS. The
 * definitions at 45 CFR 160.103 say "individual" means the person who is the
 * subject of protected health information, so a veterinary record — the
 * patient is a dog — is outside HIPAA entirely, however sensitive the owner
 * feels it is. That does not make a veterinary clinic's data free of
 * obligations: the owner's name, phone, address and card are personal data
 * under state privacy law (CCPA and its cousins), and the AI takes all of it
 * over the phone. So a veterinary clinic signs a confidentiality and
 * data-processing addendum rather than a BAA. Sending them a BAA would be
 * worse than sending nothing — it names obligations neither side has, and a
 * vet who reads it learns we do not know the difference.
 *
 * The middle regime, `hipaa-if-covered`, exists because covered-entity status
 * turns on how the practice BILLS, not on what it treats. A chiropractor
 * usually is a covered entity because they bill insurance electronically; a
 * massage therapist usually is not, because they take cash and card and never
 * transmit a standard transaction. The combined `massage-chiro` specialty
 * therefore cannot be classified on its id alone, and neither can a med spa
 * (cash-pay aesthetics is not covered; a med spa under a dermatology practice
 * that bills insurance is) or a hair clinic (the same split). For these the
 * onboarding flow asks the covered-entity question and refines the answer;
 * until it has, `requiresBaa` says true, because offering a BAA to a practice
 * that turns out not to need one costs a signature, and withholding one from
 * a practice that does costs the deal and possibly a breach finding.
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

/**
 * `hipaa`            — a covered entity in practice; the BAA is not optional.
 * `hipaa-if-covered` — depends on whether the practice bills insurance
 *                      electronically; onboarding asks. BAA offered by default.
 * `non-hipaa`        — outside HIPAA by definition (the patient is not a
 *                      person); a confidentiality / data-processing addendum
 *                      covers the owner's personal data instead.
 */
export type RegulatoryRegime = "hipaa" | "hipaa-if-covered" | "non-hipaa";

export type Specialty = {
  id: SpecialtyId;
  name: string;
  regulatoryRegime: RegulatoryRegime;
};

export const specialties: readonly Specialty[] = [
  { id: "med-spa", name: "Med Spas, Dermatology & Aesthetics", regulatoryRegime: "hipaa-if-covered" },
  { id: "plastic-surgery", name: "Plastic & Cosmetic Surgery", regulatoryRegime: "hipaa" },
  { id: "fertility", name: "Fertility & IVF", regulatoryRegime: "hipaa" },
  { id: "dental", name: "Dental & Orthodontics", regulatoryRegime: "hipaa" },
  { id: "glp1", name: "Weight Loss & GLP-1", regulatoryRegime: "hipaa" },
  { id: "hair-restoration", name: "Hair Restoration", regulatoryRegime: "hipaa-if-covered" },
  { id: "veterinary", name: "Veterinary & Pet Spas", regulatoryRegime: "non-hipaa" },
  { id: "massage-chiro", name: "Massage & Chiropractic", regulatoryRegime: "hipaa-if-covered" },
] as const;

export function isSpecialtyId(id: unknown): id is SpecialtyId {
  return typeof id === "string" && specialties.some((s) => s.id === id);
}

export function regimeFor(id: SpecialtyId): RegulatoryRegime {
  const found = specialties.find((s) => s.id === id);
  // The type makes this unreachable; the throw is so a stale build with an id
  // the array does not know fails loudly rather than defaulting to a regime.
  if (!found) throw new Error(`unknown specialty: ${id}`);
  return found.regulatoryRegime;
}

/**
 * Whether checkout must put a BAA in front of the buyer. True for both HIPAA
 * regimes — the covered-entity determination at onboarding refines
 * `hipaa-if-covered`, and until it has, the safe default is to offer the BAA.
 * False only where HIPAA cannot apply at all.
 */
export function requiresBaa(id: SpecialtyId): boolean {
  return regimeFor(id) !== "non-hipaa";
}
