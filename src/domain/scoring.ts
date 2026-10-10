import type { PitchSample, PracticeLine } from "@/domain/types"

// Error (in semitones) at which the per-syllable pitch score is full marks.
export const PITCH_FULL_SEMITONES = 1
// Error (in semitones) at which the per-syllable pitch score reaches 0.
export const PITCH_ZERO_SEMITONES = 5
// combined score below this => the syllable is counted as missed.
export const MISS_CUTOFF = 0.5

export type SyllableScore = {
  timing: number
  pitch: number
  combined: number
}

export type TurnScore = {
  score: number
  missed: number[]
  syllables: SyllableScore[]
}

/**
 * Weighted median. Items with non-positive weight are ignored.
 * Returns null when there are no positive-weight items.
 */
function weightedMedian(
  values: readonly number[],
  weights: readonly number[],
): number | null {
  const paired: Array<[number, number]> = []
  for (let i = 0; i < values.length; i += 1) {
    const w = weights[i] ?? 0
    if (w > 0) paired.push([values[i], w])
  }
  if (paired.length === 0) return null
  paired.sort((a, b) => a[0] - b[0])
  const total = paired.reduce((sum, [, w]) => sum + w, 0)
  const half = total / 2
  let running = 0
  for (const [value, w] of paired) {
    running += w
    if (running >= half) return value
  }
  return paired[paired.length - 1][0]
}

/**
 * Per-sample weight derived from the gaps between consecutive sample timestamps.
 * Each sample is weighted by half the gap to its previous sample plus half the
 * gap to its next sample (trapezoidal rule). Edges fall back to the median gap.
 * Samples are assumed to be in time order.
 */
function sampleWeights(samples: readonly PitchSample[]): number[] {
  if (samples.length === 0) return []
  if (samples.length === 1) return [1]

  const gaps: number[] = []
  for (let i = 1; i < samples.length; i += 1) {
    const gap = samples[i].timeMs - samples[i - 1].timeMs
    if (gap > 0) gaps.push(gap)
  }
  const sortedGaps = [...gaps].sort((a, b) => a - b)
  const medianGap =
    sortedGaps.length === 0 ? 1 : sortedGaps[Math.floor(sortedGaps.length / 2)]

  const weights: number[] = new Array(samples.length)
  for (let i = 0; i < samples.length; i += 1) {
    const prevGap =
      i === 0 ? medianGap : samples[i].timeMs - samples[i - 1].timeMs
    const nextGap =
      i === samples.length - 1
        ? medianGap
        : samples[i + 1].timeMs - samples[i].timeMs
    weights[i] = Math.max(0, prevGap / 2 + nextGap / 2)
  }
  return weights
}

/**
 * Time-weighted median of the pitch field across all samples. Null if no samples.
 */
export function timeWeightedMedianPitch(
  samples: readonly PitchSample[],
): number | null {
  if (samples.length === 0) return null
  const weights = sampleWeights(samples)
  return weightedMedian(
    samples.map((s) => s.pitch),
    weights,
  )
}

/**
 * Time-weighted median of a line's target semitones, weighted by each
 * syllable's duration. This is the reference the singer's whole-take
 * median is compared against; using the same weighting on both sides is
 * what lets a perfectly correct take score 100.
 */
function targetReference(line: PracticeLine): number {
  const values = line.syllables.map((s) => s.semitones)
  const weights = line.syllables.map((s) => Math.max(0, s.end - s.start))
  const result = weightedMedian(values, weights)
  return result ?? 0
}

function pitchScore(errorSemitones: number): number {
  const err = Math.abs(errorSemitones)
  if (err <= PITCH_FULL_SEMITONES) return 1
  if (err >= PITCH_ZERO_SEMITONES) return 0
  return (
    1 -
    (err - PITCH_FULL_SEMITONES) / (PITCH_ZERO_SEMITONES - PITCH_FULL_SEMITONES)
  )
}

export function scoreTurn(
  line: PracticeLine,
  samples: readonly PitchSample[],
): TurnScore {
  const singerMedian = timeWeightedMedianPitch(samples)
  const targetRef = targetReference(line)

  // Observed per-sample interval (ms). Used only for the timing coverage calc.
  const gaps: number[] = []
  for (let i = 1; i < samples.length; i += 1) {
    const gap = samples[i].timeMs - samples[i - 1].timeMs
    if (gap > 0) gaps.push(gap)
  }
  const sortedGaps = [...gaps].sort((a, b) => a - b)
  const observedDtMs =
    sortedGaps.length > 0 ? sortedGaps[Math.floor(sortedGaps.length / 2)] : 0

  const syllables: SyllableScore[] = line.syllables.map((syl) => {
    const windowMs = (syl.end - syl.start) * 1000
    if (windowMs <= 0) return { timing: 0, pitch: 0, combined: 0 }

    const inWindow: PitchSample[] = []
    for (const s of samples) {
      if (s.timeMs >= syl.start * 1000 && s.timeMs <= syl.end * 1000) {
        inWindow.push(s)
      }
    }

    if (inWindow.length === 0) {
      return { timing: 0, pitch: 0, combined: 0 }
    }

    const timing =
      observedDtMs > 0
        ? Math.min(1, (inWindow.length * observedDtMs) / windowMs)
        : 1 // one point and no gap info: treat the window as "covered"

    let pitch = 0
    if (singerMedian !== null) {
      const windowPitches = inWindow.map((s) => s.pitch).sort((a, b) => a - b)
      const windowMedian = windowPitches[Math.floor(windowPitches.length / 2)]
      const offset = windowMedian - singerMedian
      const targetOffset = syl.semitones - targetRef
      pitch = pitchScore(offset - targetOffset)
    }

    const combined = (timing + pitch) / 2
    return { timing, pitch, combined }
  })

  const missed: number[] = []
  syllables.forEach((s, i) => {
    if (s.combined < MISS_CUTOFF) missed.push(i)
  })

  const score =
    syllables.length === 0
      ? 0
      : Math.round(
          (syllables.reduce((sum, s) => sum + s.combined, 0) /
            syllables.length) *
            100,
        )

  return { score, missed, syllables }
}
