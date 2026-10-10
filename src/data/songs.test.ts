import { describe, expect, it } from "vitest"

import { CLIP_SECONDS, LINES_PER_SONG, songs } from "@/data/songs"

describe("songs catalog", () => {
  it("has one song per language", () => {
    expect(songs.map((s) => s.language).sort()).toEqual(["en", "es", "ko"])
  })

  it("has unique ids", () => {
    expect(new Set(songs.map((s) => s.id)).size).toBe(songs.length)
  })

  for (const song of songs) {
    describe(song.id, () => {
      it("points at /songs/<id>.mp3 and /songs/<id>-vocals.mp3", () => {
        expect(song.audioUrl).toBe(`/songs/${song.id}.mp3`)
        expect(song.vocalsUrl).toBe(`/songs/${song.id}-vocals.mp3`)
      })

      it("has one line per round, in order, inside the clip", () => {
        expect(song.clipSeconds).toBeLessThanOrEqual(CLIP_SECONDS)
        expect(song.lines).toHaveLength(LINES_PER_SONG)
        let previousEnd = 0
        for (const line of song.lines) {
          expect(line.audioStart).toBeGreaterThanOrEqual(previousEnd)
          expect(line.audioEnd).toBeGreaterThan(line.audioStart)
          expect(line.audioEnd).toBeLessThanOrEqual(song.clipSeconds)
          previousEnd = line.audioEnd
        }
      })

      it("keeps syllables ordered and inside their line", () => {
        for (const line of song.lines) {
          const length = line.audioEnd - line.audioStart
          let previousEnd = 0
          for (const syl of line.syllables) {
            expect(syl.text).not.toBe("")
            expect(syl.start).toBeGreaterThanOrEqual(previousEnd)
            expect(syl.end).toBeGreaterThan(syl.start)
            expect(syl.end).toBeLessThanOrEqual(length + 1e-6)
            previousEnd = syl.end
          }
        }
      })

      it("only uses romanization for Korean", () => {
        if (song.language === "ko") return
        for (const line of song.lines) {
          expect(line.romanization).toBeUndefined()
          for (const syl of line.syllables) {
            expect(syl.romanization).toBeUndefined()
          }
        }
      })
    })
  }
})
