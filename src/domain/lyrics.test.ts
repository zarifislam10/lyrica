import { describe, expect, it } from "vitest"

import { songs } from "@/data/songs"
import { syllableDisplayTexts, syllableFill } from "@/domain/lyrics"
import type { PracticeLine, Syllable } from "@/domain/types"

const ZWJ = "\u200d"

function lineOf(text: string, syllables: string[]): PracticeLine {
  return {
    id: 1,
    text,
    syllables: syllables.map((s) => ({
      text: s,
      start: 0,
      end: 1,
      semitones: 0,
    })),
  }
}

describe("syllableDisplayTexts", () => {
  it("leaves Latin and Hangul syllables untouched", () => {
    for (const song of songs.filter((s) => s.language !== "ar")) {
      const line = song.lines[0]
      expect(syllableDisplayTexts(line)).toEqual(
        line.syllables.map((s) => s.text),
      )
    }
  })

  it("joins Arabic letters across syllable cuts inside a word", () => {
    const arabic = songs.find((s) => s.language === "ar")!
    expect(syllableDisplayTexts(arabic.lines[0])).toEqual([
      "عِيدْ", // word ends here: no joiner
      `مِي${ZWJ}`, // ي joins forward into ل
      `${ZWJ}لا`, // ا never joins forward
      "دٍ",
      `سَ${ZWJ}`,
      `${ZWJ}عِيدْ`,
    ])
  })

  it("never joins across a space", () => {
    expect(syllableDisplayTexts(lineOf("بِ سَ", ["بِ", "سَ"]))).toEqual(["بِ", "سَ"])
  })

  it("keeps the text unchanged once joiners are removed", () => {
    for (const song of songs) {
      for (const line of song.lines) {
        const shown = syllableDisplayTexts(line).map((t) =>
          t.split(ZWJ).join(""),
        )
        expect(shown).toEqual(line.syllables.map((s) => s.text))
      }
    }
  })
})

describe("syllableFill", () => {
  const syllables: Syllable[] = [
    { text: "Hap", start: 0, end: 1, semitones: 0 },
    { text: "py", start: 1, end: 3, semitones: 0 },
    { text: "birth", start: 3.5, end: 4, semitones: 0 },
  ]

  it("leaves every syllable dim before the line starts", () => {
    expect(syllableFill(syllables, 0)).toEqual([0, 0, 0])
  })

  it("keeps sung syllables full and fills the current one partway", () => {
    expect(syllableFill(syllables, 2)).toEqual([1, 0.5, 0])
  })

  it("leaves the next syllable dim during a gap", () => {
    expect(syllableFill(syllables, 3.2)).toEqual([1, 1, 0])
  })

  it("fills everything once the line is over", () => {
    expect(syllableFill(syllables, 10)).toEqual([1, 1, 1])
  })
})
