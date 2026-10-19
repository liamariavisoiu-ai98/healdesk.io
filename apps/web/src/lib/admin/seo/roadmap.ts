/**
 * The strategy's roadmap, as drawn in the strategy doc on 19 October 2026:
 * each row a span or a milestone. /admin/seo draws it to scale with a line at
 * today. Update it here when the doc's timeline moves.
 */

export type RoadmapRow = { id: string; label: string; start: string; end: string; accent?: boolean };

export const SEO_ROADMAP: readonly RoadmapRow[] = [
  { id: "today", label: "Day-one moves", start: "2026-10-14", end: "2026-10-14" },
  { id: "found", label: "Technical foundations", start: "2026-10-14", end: "2026-10-30" },
  { id: "baseline", label: "Panel baseline", start: "2026-10-14", end: "2026-10-30" },
  { id: "profiles", label: "Profiles and listings", start: "2026-10-14", end: "2026-10-23" },
  { id: "press", label: "Press, podcasts, journalists", start: "2026-10-14", end: "2027-04-16" },
  { id: "first", label: "Pieces 1 to 4, 11, glossary", start: "2026-10-19", end: "2026-11-13" },
  { id: "index", label: "Market index snapshot", start: "2026-10-26", end: "2026-11-20" },
  { id: "spec3", label: "Specialty pages 6 to 8", start: "2026-11-02", end: "2026-12-11" },
  { id: "census", label: "Access census", start: "2026-11-16", end: "2027-01-29" },
  { id: "caexp", label: "Piece 5 (disclosure) live", start: "2026-12-01", end: "2026-12-01" },
  { id: "guides", label: "Legal guides 9 and 10", start: "2026-12-07", end: "2027-02-05" },
  { id: "calaw", label: "California AI laws in force", start: "2027-01-01", end: "2027-01-01", accent: true },
  { id: "tracker", label: "State law tracker", start: "2027-01-11", end: "2027-02-12" },
  { id: "spec4", label: "Four more specialty pages", start: "2027-01-11", end: "2027-03-12" },
];

/** The span the timeline is drawn over, in days since the epoch. */
export function roadmapBounds(rows: readonly RoadmapRow[] = SEO_ROADMAP): { lo: number; hi: number } {
  const days = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
  return {
    lo: Math.min(...rows.map((row) => days(row.start))),
    hi: Math.max(...rows.map((row) => days(row.end))),
  };
}

/** A date's position across the timeline, from 0 to 1, clamped. */
export function roadmapPosition(iso: string, bounds = roadmapBounds()): number {
  const day = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / 86_400_000;
  if (bounds.hi === bounds.lo) return 0;
  return Math.min(1, Math.max(0, (day - bounds.lo) / (bounds.hi - bounds.lo)));
}
