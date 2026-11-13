/**
 * Estimated pay for a post: views × the campaign's pay per 1,000 views, less the share the program
 * keeps (`feeShare`: Whop takes 0.1 of every payout), but nothing until the post reaches the
 * campaign's minimum views (clipping programs pay only past it).
 */
export function estimateEarnings(views: number | null, cpmRateUsd: number | null, minViews: number | null, feeShare = 0): number {
  if (!views || !cpmRateUsd) return 0;
  if (views < (minViews ?? 0)) return 0;
  return Math.round((views / 1000) * cpmRateUsd * (1 - feeShare) * 100) / 100;
}
