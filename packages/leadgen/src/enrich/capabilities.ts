import type { Segment } from "@healdesk/catalog";

/**
 * Which one thing healdesk should offer this clinic.
 *
 * The product does seven things. An email that lists seven is a brochure and
 * gets skimmed; an email that names the one thing this clinic is losing money
 * on gets a reply. So the pain point is derived from what the pipeline actually
 * knows — the unanswered gap, whether they can be booked online, and what they
 * sell — and exactly one capability is proposed.
 *
 * The segment mappings are not guesses. They come from the per-niche research
 * in apps/web/src/lib/knowledge/niches.ts, where each niche carries the thing
 * practitioners in it find genuinely hard. Matching the offer to that is the
 * difference between a vendor and someone who has worked in the field.
 */

export type Capability =
  | "around-the-clock"
  | "calendar-booking"
  | "deposits"
  | "lead-qualification"
  | "win-backs"
  | "aftercare-reviews"
  | "upselling";

export type CapabilityPitch = {
  capability: Capability;
  /** Why THIS clinic, in one clause. Sits after the observed pain. */
  because: string;
};

/**
 * The segment's own hard problem, and the capability that answers it.
 *
 * Each entry names a failure the practitioner already recognises — which is
 * what stops the offer reading as generic. A clinic owner knows their GLP-1
 * patients evaporate at month three; being told so is being understood.
 */
const BY_SEGMENT: Partial<Record<Segment, CapabilityPitch>> = {
  "weight-loss-glp1": {
    capability: "win-backs",
    because: "Most drop off around month three and nobody has time to chase them.",
  },
  "body-contouring": {
    capability: "deposits",
    because: "Free consults plus four-figure packages is how a diary fills with no-shows.",
  },
  "plastic-surgery": {
    capability: "lead-qualification",
    because: "Your best calls land while the surgeon is operating.",
  },
  injectables: {
    capability: "win-backs",
    because: "People are due back every few months and nobody notices when they stop.",
  },
  "laser-skin": {
    capability: "aftercare-reviews",
    because: "Packages get paid up front, then half of them never finish.",
  },
  "wellness-iv": {
    capability: "around-the-clock",
    because: "They want a slot today. If they get the machine they ring someone else.",
  },
  "hair-restoration": {
    capability: "lead-qualification",
    because: "These callers take months to work up to ringing. They don't leave messages.",
  },
  dental: {
    capability: "around-the-clock",
    because: "Someone in pain rings the next practice within a minute.",
  },
  dermatology: {
    capability: "lead-qualification",
    because: "Medical and cosmetic callers need different conversations on the same line.",
  },
  "other-medical": {
    capability: "lead-qualification",
    because: "When the desk is on a long call, the next person gets voicemail.",
  },
};

export type PainInput = {
  segment: Segment;
  /** Hours in the longest unanswered stretch, when known. */
  gapHours: number | null;
  hasOnlineBooking: boolean;
  closesEarly: boolean;
};

/**
 * Pick one capability, most specific pain first.
 *
 * Order matters and is deliberate. A measured gap outranks everything, because
 * it is the only pain here expressed as a number the clinic cannot argue with.
 * Below that, an absent booking path is a structural fact about every
 * appointment they take. Only when neither applies does the segment's own
 * problem decide — it is the most interesting answer but the least certain,
 * since it rests on the classifier rather than on an observation.
 */
export function selectCapability(pain: PainInput): CapabilityPitch {
  if (pain.gapHours !== null && pain.gapHours >= 24) {
    return {
      capability: "around-the-clock",
      because:
        "We pick up.",
    };
  }

  if (!pain.hasOnlineBooking) {
    return {
      capability: "calendar-booking",
      because:
        "Every booking you take starts with a phone call.",
    };
  }

  if (pain.closesEarly) {
    return {
      capability: "around-the-clock",
      because:
        "Most people ring after work, once they have finished.",
    };
  }

  return (
    BY_SEGMENT[pain.segment] ?? {
      capability: "lead-qualification",
      // The honest fallback: true of any clinic, claims nothing specific.
      because:
        "The calls you cannot get to are usually the ones ready to book.",
    }
  );
}

/** What each capability is called in an email. Plain, not product-marketing. */
export const CAPABILITY_LABEL: Record<Capability, string> = {
  "around-the-clock": "We answer the calls you cannot",
  "calendar-booking": "We answer and book them straight in",
  deposits: "We take the deposit on the call",
  "lead-qualification": "We screen every caller first",
  "win-backs": "We ring the ones who have gone quiet",
  "aftercare-reviews": "We follow up after treatment",
  upselling: "We offer the add-on while they are on the phone",
};
