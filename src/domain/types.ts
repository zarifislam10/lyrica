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

export type Language = "ko" | "es" | "en"

// One sung unit: a Hangul block, a Spanish syllable, or an English note
// (usually a word). Times are seconds from the start of the line, not the
// clip, so they line up with the recording timeline the scorer uses.
export type SongSyllable = {
  text: string
  // Only for Korean; English and Spanish show `text` alone.
  romanization?: string
  start: number
  end: number
  // Target pitch relative to the line's median. Derived offline from the
  // vocals stem, never hand-typed.
  semitones: number
}

// One round's worth of the clip. audioStart/audioEnd are seconds into the
// song's clip and drive the "Hear it" button.
export type SongLine = {
  id: number
  text: string
  romanization?: string
  audioStart: number
  audioEnd: number
  syllables: SongSyllable[]
}

export type Song = {
  id: string
  title: string
  language: Language
  // Full mix, played to singers. Served from /public/songs/<id>.mp3.
  audioUrl: string
  // Vocals-only stem, used for offline pitch extraction only.
  vocalsUrl: string
  clipSeconds: number
  // Exactly three: one per round.
  lines: SongLine[]
}

export type PracticeLine = {
  id: number
  language: "ko"
  hangul: string
  romanization: string
  syllables: Syllable[]
}
