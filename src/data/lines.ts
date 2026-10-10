import type { PracticeLine } from "@/domain/types"

export const practiceLines: PracticeLine[] = [
  {
    id: 1,
    text: "안녕하세요",
    romanization: "an-nyeong-ha-se-yo",
    syllables: [
      { text: "안", romanization: "an", start: 0, end: 0.58, semitones: -2 },
      {
        text: "녕",
        romanization: "nyeong",
        start: 0.7,
        end: 1.48,
        semitones: 0,
      },
      { text: "하", romanization: "ha", start: 1.6, end: 2.22, semitones: 2 },
      { text: "세", romanization: "se", start: 2.36, end: 3.08, semitones: 3 },
      { text: "요", romanization: "yo", start: 3.2, end: 4, semitones: 0 },
    ],
  },
  {
    id: 2,
    text: "사랑해요",
    romanization: "sa-rang-hae-yo",
    syllables: [
      { text: "사", romanization: "sa", start: 0, end: 0.72, semitones: -2 },
      {
        text: "랑",
        romanization: "rang",
        start: 0.86,
        end: 1.76,
        semitones: 0,
      },
      { text: "해", romanization: "hae", start: 1.9, end: 2.92, semitones: 3 },
      { text: "요", romanization: "yo", start: 3.08, end: 4, semitones: 0 },
    ],
  },
  {
    id: 3,
    text: "감사합니다",
    romanization: "gam-sa-ham-ni-da",
    syllables: [
      { text: "감", romanization: "gam", start: 0, end: 0.63, semitones: -3 },
      { text: "사", romanization: "sa", start: 0.75, end: 1.37, semitones: 0 },
      { text: "합", romanization: "ham", start: 1.5, end: 2.26, semitones: 2 },
      { text: "니", romanization: "ni", start: 2.4, end: 3.13, semitones: 4 },
      { text: "다", romanization: "da", start: 3.26, end: 4, semitones: 0 },
    ],
  },
]
