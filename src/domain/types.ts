export type PitchSample = {
  timeMs: number
  pitch: number
  clarity: number
}

export type TurnRecording = {
  lineId: number
  durationMs: number
  samples: PitchSample[]
}

export type Syllable = {
  hangul: string
  roman: string
  start: number
  end: number
  semitones: number
}

export type PracticeLine = {
  id: number
  language: "ko"
  hangul: string
  romanization: string
  syllables: Syllable[]
}
