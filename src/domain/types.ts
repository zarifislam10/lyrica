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

// Harmony. One entry per chord change in a line. `atBeat` is the beat
// offset from the start of the line; `root` is semitones from the song's
// tonic. The sing-along backing track sustains each chord until the next
// one begins (or the line ends).
export type ChordQuality = "major" | "minor" | "dominant7"
export type Chord = {
  atBeat: number
  root: number
  quality: ChordQuality
}

// One round. audioStart/audioEnd locate this line in the song's spoken
// "Hear it" clip; when unset, "Hear it" plays the whole clip. `chords` is
// optional — songs without it fall back to per-syllable harmony.
export type PracticeLine = {
  id: number
  text: string
  romanization?: string
  audioStart?: number
  audioEnd?: number
  syllables: Syllable[]
  chords?: Chord[]
}

export type Song = {
  id: string
  title: string
  language: Language
  // ElevenLabs TTS render of the line, served from /public/songs/<id>.mp3.
  audioUrl: string
  // Instrumental backing track that plays while the user sings. Optional:
  // Happy Birthday has no backing track and only uses the synth guide. For
  // generated songs (Suno/Udio), drop the instrumental in /public/songs/
  // and set this to the public path. Must be an instrumental with no lead
  // vocal, since the lead will bleed into the mic and corrupt scoring.
  backingTrackUrl?: string
  // Cover art shown in the song picker. Optional; songs without a coverUrl
  // fall back to a gradient tile with the song title overlaid.
  coverUrl?: string
  // Set until a native speaker confirms the syllable-to-note mapping.
  needsNativeSpeakerCheck: boolean
  // Three lines; a match sings the first ROUNDS_PER_MATCH of them.
  lines: PracticeLine[]
}
