import type { Chord, Language, PracticeLine, Song } from "@/domain/types"

export const LINES_PER_SONG = 3
// Seconds per beat. 80 BPM — close to a natural Happy Birthday pace, slow
// enough that learners have time to shape each syllable.
export const SECONDS_PER_BEAT = 0.75
// Silence left at the end of each note so syllables don't run together.
const ARTICULATION_GAP_SECONDS = 0.06

// [beats, semitones from the tonic]
type Note = [number, number]

// Happy Birthday (public domain) in C major, 3/4, with a pickup. Typed once
// and shared by every language. Rounds use lines 1, 2 and 4 of the song;
// line 3 carries a name, so it's skipped. The words repeat, but each round's
// melody climbs higher.
export const MELODY: Note[][] = [
  // G G | A G C | B
  [
    [0.75, -5],
    [0.25, -5],
    [1, -3],
    [1, -5],
    [1, 0],
    [2, -1],
  ],
  // G G | A G D | C
  [
    [0.75, -5],
    [0.25, -5],
    [1, -3],
    [1, -5],
    [1, 2],
    [2, 0],
  ],
  // F F | E C D | C
  [
    [0.75, 5],
    [0.25, 5],
    [1, 4],
    [1, 0],
    [1, 2],
    [2, 0],
  ],
]

// Chord changes per line, aligned to MELODY above. Classic 3-chord
// harmonization of Happy Birthday in C major (I = C, IV = F, V7 = G7):
//   Line 1 ("Happy birthday to you")       — C → G7
//   Line 2 ("Happy birthday to you")       — C → F
//   Line 3 ("Happy birthday to you" climb) — F → C
// Beat offsets split each 6-beat line in half, so the harmony changes
// mid-phrase like a real accompaniment.
export const CHORDS: Chord[][] = [
  [
    { atBeat: 0, root: 0, quality: "major" },
    { atBeat: 3, root: 7, quality: "dominant7" },
  ],
  [
    { atBeat: 0, root: 0, quality: "major" },
    { atBeat: 3, root: 5, quality: "major" },
  ],
  [
    { atBeat: 0, root: 5, quality: "major" },
    { atBeat: 3, root: 0, quality: "major" },
  ],
]

type Lyric = {
  id: string
  title: string
  language: Language
  needsNativeSpeakerCheck: boolean
  text: string
  romanization?: string
  // One space-separated entry per note. "+" puts two syllables on one note,
  // splitting its beats evenly.
  sung: string
  sungRomanization?: string
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

function notesOf(sung: string): string[][] {
  return sung.split(" ").map((note) => note.split("+"))
}

function buildLine(
  lyric: Lyric,
  melody: Note[],
  chords: Chord[],
  id: number,
): PracticeLine {
  const notes = notesOf(lyric.sung)
  const romans = lyric.sungRomanization
    ? notesOf(lyric.sungRomanization)
    : undefined
  if (notes.length !== melody.length) {
    throw new Error(
      `${lyric.id}: ${notes.length} sung notes for a ${melody.length}-note line`,
    )
  }
  if (
    romans &&
    (romans.length !== notes.length ||
      romans.some((group, i) => group.length !== notes[i].length))
  ) {
    throw new Error(
      `${lyric.id}: romanization doesn't match the sung syllables`,
    )
  }
  let beat = 0
  const syllables = melody.flatMap(([beats, semitones], noteIndex) =>
    notes[noteIndex].map((text, i) => {
      const start = beat * SECONDS_PER_BEAT
      beat += beats / notes[noteIndex].length
      const end = beat * SECONDS_PER_BEAT - ARTICULATION_GAP_SECONDS
      const romanization = romans?.[noteIndex][i]
      return {
        text,
        ...(romanization ? { romanization } : {}),
        start: round3(start),
        end: round3(end),
        semitones,
      }
    }),
  )
  return {
    id,
    text: lyric.text,
    ...(lyric.romanization ? { romanization: lyric.romanization } : {}),
    syllables,
    chords,
  }
}

function buildSong(lyric: Lyric): Song {
  return {
    id: lyric.id,
    title: lyric.title,
    language: lyric.language,
    audioUrl: `/songs/${lyric.id}.mp3`,
    needsNativeSpeakerCheck: lyric.needsNativeSpeakerCheck,
    lines: MELODY.map((melody, i) =>
      buildLine(lyric, melody, CHORDS[i], i + 1),
    ),
  }
}

const lyrics: Lyric[] = [
  {
    id: "happy-birthday-en",
    title: "Happy Birthday",
    language: "en",
    needsNativeSpeakerCheck: false,
    text: "Happy birthday to you",
    sung: "Hap py birth day to you",
  },
  {
    id: "happy-birthday-ko",
    title: "생일 축하합니다",
    language: "ko",
    // needs native speaker check: 합니 share the "to" note as two eighths.
    // Romanized as pronounced (축하 sounds like 추카), not as spelled.
    needsNativeSpeakerCheck: true,
    text: "생일 축하합니다",
    romanization: "saeng-il chu-ka-ham-ni-da",
    sung: "생 일 축 하 합+니 다",
    sungRomanization: "saeng il chu ka ham+ni da",
  },
  {
    id: "happy-birthday-ar",
    title: "عيد ميلاد سعيد",
    language: "ar",
    // needs native speaker check: Modern Standard Arabic, with the case
    // ending on عيد dropped so the line fits six notes.
    needsNativeSpeakerCheck: true,
    text: "عِيدْ مِيلادٍ سَعِيدْ",
    romanization: "ʿīd mī-lā-din sa-ʿīd",
    sung: "عِيدْ مِي لا دٍ سَ عِيدْ",
    sungRomanization: "ʿīd mī lā din sa ʿīd",
  },
]

// First Snow (Korean) — generated with Suno (K-pop ballad, 85 BPM, female
// lead). First-pass syllable-to-note mapping derived from a Basic Pitch
// MIDI export of the isolated vocal stem; all semitones are relative to
// the vocal's duration-weighted median (D4). Marked for native-speaker
// check because syllable romanization and timing both need an ear pass.
// audioStart/audioEnd point into the full-mix clip for "Hear it sung",
// and the sing-screen backing seeks to audioStart so the backing lines
// up with when the vocal actually enters at ~12.2 s.
const firstSnowKo: Song = {
  id: "first-snow-ko",
  title: "First Snow",
  language: "ko",
  audioUrl: "/songs/first-snow-ko-full.mp3",
  backingTrackUrl: "/songs/first-snow-ko-backing.mp3",
  // Wilson Bentley snowflake #13 (c. 1902), public domain via Wikimedia
  // Commons. Fetched via Special:FilePath/Bentley_Snowflake13.jpg.
  coverUrl: "/songs/first-snow-ko-cover.jpg",
  needsNativeSpeakerCheck: true,
  lines: [
    {
      id: 1,
      text: "첫눈이 내려와",
      romanization: "cheot-nu-ni nae-ryeo-wa",
      audioStart: 12.0,
      audioEnd: 17.2,
      syllables: [
        {
          text: "첫",
          romanization: "cheot",
          start: 0.0,
          end: 0.37,
          semitones: -2,
        },
        {
          text: "눈",
          romanization: "nun",
          start: 0.37,
          end: 0.86,
          semitones: -2,
        },
        { text: "이", romanization: "i", start: 0.86, end: 1.37, semitones: 0 },
        {
          text: "내",
          romanization: "nae",
          start: 1.37,
          end: 3.11,
          semitones: 0,
        },
        {
          text: "려",
          romanization: "ryeo",
          start: 3.37,
          end: 3.74,
          semitones: -4,
        },
        {
          text: "와",
          romanization: "wa",
          start: 3.74,
          end: 4.64,
          semitones: -5,
        },
      ],
    },
    {
      id: 2,
      text: "네 생각이 나",
      // Syllable-faithful romanization (매 syllable romanized standalone)
      // so the line text matches the per-syllable romanizations exactly.
      // Natural-speech liaison "saeng-ga-gi" is lost but readability stays.
      romanization: "ne saeng-gak i na",
      audioStart: 18.3,
      audioEnd: 23.5,
      syllables: [
        { text: "네", romanization: "ne", start: 0.0, end: 0.5, semitones: 0 },
        {
          text: "생",
          romanization: "saeng",
          start: 0.5,
          end: 1.0,
          semitones: 2,
        },
        { text: "각", romanization: "gak", start: 1.0, end: 2.5, semitones: 4 },
        { text: "이", romanization: "i", start: 2.5, end: 3.5, semitones: 5 },
        { text: "나", romanization: "na", start: 3.5, end: 4.8, semitones: 2 },
      ],
    },
    {
      id: 3,
      text: "보고 싶어 많이",
      romanization: "bo-go si-peo ma-ni",
      audioStart: 24.4,
      audioEnd: 27.5,
      syllables: [
        { text: "보", romanization: "bo", start: 0.0, end: 0.4, semitones: -2 },
        { text: "고", romanization: "go", start: 0.4, end: 0.9, semitones: 0 },
        { text: "싶", romanization: "sip", start: 0.9, end: 1.3, semitones: 0 },
        { text: "어", romanization: "eo", start: 1.3, end: 1.6, semitones: -2 },
        { text: "많", romanization: "man", start: 1.6, end: 2.1, semitones: 0 },
        { text: "이", romanization: "i", start: 2.1, end: 2.6, semitones: -2 },
      ],
    },
    {
      id: 4,
      text: "내 마음 알지",
      romanization: "nae ma-eum al-ji",
      audioStart: 28.1,
      audioEnd: 32.0,
      syllables: [
        {
          text: "내",
          romanization: "nae",
          start: 0.0,
          end: 0.5,
          semitones: -7,
        },
        { text: "마", romanization: "ma", start: 0.5, end: 1.0, semitones: -3 },
        {
          text: "음",
          romanization: "eum",
          start: 1.0,
          end: 1.5,
          semitones: -5,
        },
        { text: "알", romanization: "al", start: 1.5, end: 2.5, semitones: -5 },
        { text: "지", romanization: "ji", start: 2.5, end: 3.5, semitones: -7 },
      ],
    },
  ],
}

export const songs: Song[] = [...lyrics.map(buildSong), firstSnowKo]
