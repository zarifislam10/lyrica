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

export type Language = "en" | "ko" | "ar"

// One sung unit: an English syllable, a Hangul block, or an Arabic syllable.
// Times are seconds from the start of the line, so they line up with the
// recording timeline the scorer uses.
export type Syllable = {
  text: string
  // Korean and Arabic only; English shows `text` alone.
  romanization?: string
  start: number
  end: number
  // Target note, typed by hand from the melody. Semitones from the song's
  // tonic; the scorer recentres per line, so only the shape matters.
  semitones: number
}

// One round. audioStart/audioEnd locate this line in the song's spoken
// "Hear it" clip; when unset, "Hear it" plays the whole clip.
export type PracticeLine = {
  id: number
  text: string
  romanization?: string
  audioStart?: number
  audioEnd?: number
  syllables: Syllable[]
}

export type Song = {
  id: string
  title: string
  language: Language
  // ElevenLabs TTS render of the line, served from /public/songs/<id>.mp3.
  audioUrl: string
  // Set until a native speaker confirms the syllable-to-note mapping.
  needsNativeSpeakerCheck: boolean
  // Three lines; a match sings the first ROUNDS_PER_MATCH of them.
  lines: PracticeLine[]
}
