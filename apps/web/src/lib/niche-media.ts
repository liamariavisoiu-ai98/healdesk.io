/**
 * Card artwork per niche.
 *
 * Kept out of lib/specialties.ts on purpose: that file is domain knowledge the
 * chat agent and the calculator both read, and it should not gain a dependency
 * on which images happen to have been exported yet. A niche with no entry here
 * simply does not appear in the stack.
 *
 * Every still is the first frame of its own clip at the same crop, so the
 * cross-fade from poster to footage reveals nothing. `video` is the path
 * WITHOUT an extension; the card offers .webm then .mp4.
 */
export type NicheMedia = { still: string; video?: string };

export const NICHE_MEDIA: Record<string, NicheMedia> = {
  "med-spa": { still: "/niches/med-spa.webp", video: "/niches/med-spa" },
  "plastic-surgery": {
    still: "/niches/plastic-surgery.webp",
    video: "/niches/plastic-surgery",
  },
  fertility: { still: "/niches/fertility.webp", video: "/niches/fertility" },
  dental: { still: "/niches/dental.webp", video: "/niches/dental" },
  glp1: { still: "/niches/glp1.webp", video: "/niches/glp1" },
  "hair-restoration": {
    still: "/niches/hair-restoration.webp",
    video: "/niches/hair-restoration",
  },
  veterinary: { still: "/niches/veterinary.webp", video: "/niches/veterinary" },
  "massage-chiro": {
    still: "/niches/massage-chiro.webp",
    video: "/niches/massage-chiro",
  },
};
