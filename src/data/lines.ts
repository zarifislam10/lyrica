import type { PracticeLine } from "@/domain/types"

export const practiceLines: PracticeLine[] = [
  {
    id: 1,
    language: "ko",
    hangul: "안녕하세요",
    romanization: "an-nyeong-ha-se-yo",
    syllables: [
      { hangul: "안", roman: "an", start: 0, end: 0.58, semitones: -2 },
      { hangul: "녕", roman: "nyeong", start: 0.7, end: 1.48, semitones: 0 },
      { hangul: "하", roman: "ha", start: 1.6, end: 2.22, semitones: 2 },
      { hangul: "세", roman: "se", start: 2.36, end: 3.08, semitones: 3 },
      { hangul: "요", roman: "yo", start: 3.2, end: 4, semitones: 0 },
    ],
  },
  {
    id: 2,
    language: "ko",
    hangul: "사랑해요",
    romanization: "sa-rang-hae-yo",
    syllables: [
      { hangul: "사", roman: "sa", start: 0, end: 0.72, semitones: -2 },
      { hangul: "랑", roman: "rang", start: 0.86, end: 1.76, semitones: 0 },
      { hangul: "해", roman: "hae", start: 1.9, end: 2.92, semitones: 3 },
      { hangul: "요", roman: "yo", start: 3.08, end: 4, semitones: 0 },
    ],
  },
  {
    id: 3,
    language: "ko",
    hangul: "감사합니다",
    romanization: "gam-sa-ham-ni-da",
    syllables: [
      { hangul: "감", roman: "gam", start: 0, end: 0.63, semitones: -3 },
      { hangul: "사", roman: "sa", start: 0.75, end: 1.37, semitones: 0 },
      { hangul: "합", roman: "ham", start: 1.5, end: 2.26, semitones: 2 },
      { hangul: "니", roman: "ni", start: 2.4, end: 3.13, semitones: 4 },
      { hangul: "다", roman: "da", start: 3.26, end: 4, semitones: 0 },
    ],
  },
]
