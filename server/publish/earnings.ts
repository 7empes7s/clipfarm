/**
 * Estimated pay for a post: views × the campaign's pay per 1,000 views, but nothing until the
 * post reaches the campaign's minimum views (clipping programs pay only past it).
 */
export function estimateEarnings(views: number | null, cpmRateUsd: number | null, minViews: number | null): number {
  if (!views || !cpmRateUsd) return 0;
  if (views < (minViews ?? 0)) return 0;
  return Math.round((views / 1000) * cpmRateUsd * 100) / 100;
}
