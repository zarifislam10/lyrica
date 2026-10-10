import { describe, expect, it } from "vitest"

import { LINES_PER_SONG, songs } from "@/data/songs"

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

      it("keeps any Hear it range inside the clip order", () => {
        let previousEnd = 0
        for (const line of song.lines) {
          if (line.audioStart === undefined || line.audioEnd === undefined) {
            continue
          }
          expect(line.audioStart).toBeGreaterThanOrEqual(previousEnd)
          expect(line.audioEnd).toBeGreaterThan(line.audioStart)
          previousEnd = line.audioEnd
        }
      })
    })
  }
})
