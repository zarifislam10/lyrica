import type { Language, PracticeLine, Song } from "@/domain/types"

export const LINES_PER_SONG = 3
// Seconds per beat. Slower than a party sing-along so learners have time to
// shape each syllable.
export const SECONDS_PER_BEAT = 0.6
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

function buildLine(lyric: Lyric, melody: Note[], id: number): PracticeLine {
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
  }
}

function buildSong(lyric: Lyric): Song {
  return {
    id: lyric.id,
    title: lyric.title,
    language: lyric.language,
    audioUrl: `/songs/${lyric.id}.mp3`,
    needsNativeSpeakerCheck: lyric.needsNativeSpeakerCheck,
    lines: MELODY.map((melody, i) => buildLine(lyric, melody, i + 1)),
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

export const songs: Song[] = lyrics.map(buildSong)
