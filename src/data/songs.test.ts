import { describe, expect, it } from "vitest"

import { LINES_PER_SONG, MELODY, SECONDS_PER_BEAT, songs } from "@/data/songs"
import { TURN_SECONDS } from "@/domain/match"

const strip = (text: string) => text.replace(/[\s-]/g, "")

describe("songs catalog", () => {
  it("has one song per language", () => {
    expect(songs.map((s) => s.language).sort()).toEqual(["ar", "en", "ko"])
  })

  it("has unique ids", () => {
    expect(new Set(songs.map((s) => s.id)).size).toBe(songs.length)
  })

  for (const song of songs) {
    describe(song.id, () => {
      it("points at /songs/<id>.mp3", () => {
        expect(song.audioUrl).toBe(`/songs/${song.id}.mp3`)
      })

      it("has one line per round", () => {
        expect(song.lines).toHaveLength(LINES_PER_SONG)
        expect(song.lines.map((l) => l.id)).toEqual([1, 2, 3])
      })

      it("keeps syllables ordered with room to breathe", () => {
        for (const line of song.lines) {
          expect(line.syllables.length).toBeGreaterThan(0)
          let previousEnd = 0
          for (const syl of line.syllables) {
            expect(syl.start).toBeGreaterThanOrEqual(previousEnd)
            expect(syl.end).toBeGreaterThan(syl.start)
            expect(Number.isFinite(syl.semitones)).toBe(true)
            previousEnd = syl.end
          }
        }
      })

      it("spells each line out of its syllables", () => {
        for (const line of song.lines) {
          const joined = line.syllables.map((s) => s.text).join("")
          expect(joined).toBe(strip(line.text))
        }
      })

      it("romanizes Korean and Arabic syllable by syllable, English not at all", () => {
        for (const line of song.lines) {
          if (song.language === "en") {
            expect(line.romanization).toBeUndefined()
            for (const syl of line.syllables) {
              expect(syl.romanization).toBeUndefined()
            }
            continue
          }
          const parts = line.syllables.map((s) => s.romanization)
          expect(parts.every(Boolean)).toBe(true)
          expect(strip(parts.join(""))).toBe(strip(line.romanization ?? ""))
        }
      })

      it("sets each Hear it range as a pair, in clip order", () => {
        let previousEnd = 0
        for (const line of song.lines) {
          expect(line.audioStart === undefined).toBe(
            line.audioEnd === undefined,
          )
          if (line.audioStart === undefined || line.audioEnd === undefined) {
            continue
          }
          expect(line.audioStart).toBeGreaterThanOrEqual(previousEnd)
          expect(line.audioEnd).toBeGreaterThan(line.audioStart)
          previousEnd = line.audioEnd
        }
      })

      it("finishes every line inside one recorded turn", () => {
        for (const line of song.lines) {
          const last = line.syllables[line.syllables.length - 1]
          expect(last.end).toBeLessThanOrEqual(TURN_SECONDS)
        }
      })

      it("sings every note of the shared melody at its pitch", () => {
        song.lines.forEach((line, i) => {
          let beat = 0
          const notes = MELODY[i].map(([beats, semitones]) => {
            const start = beat * SECONDS_PER_BEAT
            beat += beats
            return { start, end: beat * SECONDS_PER_BEAT, semitones }
          })
          for (const note of notes) {
            const sung = line.syllables.filter(
              (s) => s.start >= note.start - 1e-6 && s.start < note.end - 1e-6,
            )
            expect(sung.length).toBeGreaterThan(0)
            expect(sung[0].start).toBeCloseTo(note.start, 3)
            for (const s of sung) expect(s.semitones).toBe(note.semitones)
          }
        })
      })
    })
  }
})
