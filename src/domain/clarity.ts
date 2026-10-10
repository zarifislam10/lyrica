// A take counts as unclear when fewer than this fraction of the frames that
// were actually analyzed passed the clarity threshold.
export const MIN_CLEAR_FRAME_RATIO = 0.15

/**
 * Judged against frames analyzed rather than an assumed frame rate, so a
 * throttled or slow display (projector, busy laptop) can't reject clear singing.
 */
export function isUnclearTake(
  clearFrames: number,
  framesAnalyzed: number,
): boolean {
  if (framesAnalyzed <= 0) return true
  return clearFrames / framesAnalyzed < MIN_CLEAR_FRAME_RATIO
}
