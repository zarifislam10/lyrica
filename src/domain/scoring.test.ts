import { describe, expect, it } from "vitest"

import { practiceLines } from "@/data/lines"
import { MISS_CUTOFF, scoreTurn } from "@/domain/scoring"
import type { PitchSample, PracticeLine } from "@/domain/types"

const SAMPLE_RATE_HZ = 60
const SAMPLE_DT_MS = 1000 / SAMPLE_RATE_HZ

/**
 * Build a synthetic recording where, within each syllable's time window, the
 * sample pitch is exactly (anchorMidi + syllable.semitones). This is the
 * "perfect take": each window carries the intended semitone offset relative
 * to the same anchor pitch.
 */
function perfectSamples(line: PracticeLine, anchorMidi: number): PitchSample[] {
  const samples: PitchSample[] = []
  const totalMs = line.syllables[line.syllables.length - 1].end * 1000
  for (let t = 0; t <= totalMs; t += SAMPLE_DT_MS) {
    const seconds = t / 1000
    const syllable = line.syllables.find(
      (s) => seconds >= s.start && seconds <= s.end,
    )
    if (!syllable) continue
    samples.push({
      timeMs: t,
      pitch: anchorMidi + syllable.semitones,
      clarity: 1,
    })
  }
  return samples
}

describe("scoreTurn", () => {
  it("scores a perfect take as exactly 100", () => {
    for (const line of practiceLines) {
      const samples = perfectSamples(line, 60)
      const result = scoreTurn(line, samples)
      expect(result.score).toBe(100)
      expect(result.missed).toEqual([])
    }
  })

  it("scores an empty take as 0 and marks every syllable as missed", () => {
    const line = practiceLines[0]
    const result = scoreTurn(line, [])
    expect(result.score).toBe(0)
    expect(result.missed).toEqual(line.syllables.map((_, i) => i))
    for (const s of result.syllables) {
      expect(s.combined).toBeLessThan(MISS_CUTOFF)
    }
  })

  it("is octave-invariant: shifting a perfect take down an octave scores the same", () => {
    for (const line of practiceLines) {
      const baseline = scoreTurn(line, perfectSamples(line, 60))
      const shifted = scoreTurn(line, perfectSamples(line, 60 - 12))
      expect(shifted.score).toBe(baseline.score)
    }
  })

  it("scores a flat hum strictly less than a perfect take on a moving line", () => {
    const line = practiceLines[0] // -2, 0, +2, +3, 0 — moves
    const perfect = scoreTurn(line, perfectSamples(line, 60))

    const flat: PitchSample[] = []
    const totalMs = line.syllables[line.syllables.length - 1].end * 1000
    for (let t = 0; t <= totalMs; t += SAMPLE_DT_MS) {
      flat.push({ timeMs: t, pitch: 60, clarity: 1 })
    }
    const flatResult = scoreTurn(line, flat)

    expect(flatResult.score).toBeLessThan(perfect.score)
  })
})
