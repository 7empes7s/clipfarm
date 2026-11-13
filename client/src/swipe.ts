// Review gestures on the clip, kept pure so they can be unit tested.

/** How far (px) a finger must travel before a drag counts as a swipe. */
export const SWIPE_MIN = 70;
/** Under this (px) on both axes, the touch was a tap. */
const TAP_MAX = 10;

export type SwipeIntent = "approve" | "reject" | "next" | "back" | "tap";

/** What a drag of (dx, dy) means: right approves, left rejects, up is the next clip, down the one before. */
export function swipeIntent(dx: number, dy: number): SwipeIntent | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < TAP_MAX && ay < TAP_MAX) return "tap";
  if (ax >= ay) return ax > SWIPE_MIN ? (dx > 0 ? "approve" : "reject") : null;
  return ay > SWIPE_MIN ? (dy < 0 ? "next" : "back") : null;
}

/** A short buzz on phones that have one; silent elsewhere. */
export function buzz(ms = 12): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    // Some browsers refuse without a tap first: the swipe still works.
  }
}
