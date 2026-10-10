import type { Song, SongLine } from "@/domain/types"

export const LINES_PER_SONG = 3
// Seconds per beat. Slower than a party sing-along so learners have time to
// shape each syllable.
export const SECONDS_PER_BEAT = 0.6
// Silence left at the end of each note so syllables don't run together.
const ARTICULATION_GAP_SECONDS = 0.06

// [syllable, romanization, beats, semitones from the tonic]
type Note = [string, string | undefined, number, number]

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

function line(
  id: number,
  text: string,
  romanization: string | undefined,
  notes: Note[],
): SongLine {
  let beat = 0
  const syllables = notes.map(([syllable, roman, beats, semitones]) => {
    const start = beat * SECONDS_PER_BEAT
    beat += beats
    const end = beat * SECONDS_PER_BEAT - ARTICULATION_GAP_SECONDS
    return {
      text: syllable,
      ...(roman ? { romanization: roman } : {}),
      start: round3(start),
      end: round3(end),
      semitones,
    }
  })
  return { id, text, ...(romanization ? { romanization } : {}), syllables }
}

// Happy Birthday (public domain) in C major, 3/4, with a pickup. Rounds use
// lines 1, 2 and 4 of the song; line 3 carries a name, so it's skipped. The
// words repeat, but each round's melody climbs higher:
//   line 1: G G | A G C | B      ("...to you")
//   line 2: G G | A G D | C      ("...to you", ends a step higher)
//   line 4: F F | E C D | C      ("Happy birthday to you", from the top)
// Rhythm per line: pickup 3/4 + 1/4 beat, three quarter notes, a half note.

export const songs: Song[] = [
  {
    id: "happy-birthday-en",
    title: "Happy Birthday",
    language: "en",
    audioUrl: "/songs/happy-birthday-en.mp3",
    needsNativeSpeakerCheck: false,
    lines: [
      line(1, "Happy birthday to you", undefined, [
        ["Hap", undefined, 0.75, -5],
        ["py", undefined, 0.25, -5],
        ["birth", undefined, 1, -3],
        ["day", undefined, 1, -5],
        ["to", undefined, 1, 0],
        ["you", undefined, 2, -1],
      ]),
      line(2, "Happy birthday to you", undefined, [
        ["Hap", undefined, 0.75, -5],
        ["py", undefined, 0.25, -5],
        ["birth", undefined, 1, -3],
        ["day", undefined, 1, -5],
        ["to", undefined, 1, 2],
        ["you", undefined, 2, 0],
      ]),
      line(3, "Happy birthday to you", undefined, [
        ["Hap", undefined, 0.75, 5],
        ["py", undefined, 0.25, 5],
        ["birth", undefined, 1, 4],
        ["day", undefined, 1, 0],
        ["to", undefined, 1, 2],
        ["you", undefined, 2, 0],
      ]),
    ],
  },
  {
    id: "happy-birthday-ko",
    title: "생일 축하합니다",
    language: "ko",
    audioUrl: "/songs/happy-birthday-ko.mp3",
    // needs native speaker check: 합니 share the "to" note as two eighths.
    needsNativeSpeakerCheck: true,
    lines: [
      line(1, "생일 축하합니다", "saeng-il chuk-ha-ham-ni-da", [
        ["생", "saeng", 0.75, -5],
        ["일", "il", 0.25, -5],
        ["축", "chuk", 1, -3],
        ["하", "ha", 1, -5],
        ["합", "ham", 0.5, 0],
        ["니", "ni", 0.5, 0],
        ["다", "da", 2, -1],
      ]),
      line(2, "생일 축하합니다", "saeng-il chuk-ha-ham-ni-da", [
        ["생", "saeng", 0.75, -5],
        ["일", "il", 0.25, -5],
        ["축", "chuk", 1, -3],
        ["하", "ha", 1, -5],
        ["합", "ham", 0.5, 2],
        ["니", "ni", 0.5, 2],
        ["다", "da", 2, 0],
      ]),
      line(3, "생일 축하합니다", "saeng-il chuk-ha-ham-ni-da", [
        ["생", "saeng", 0.75, 5],
        ["일", "il", 0.25, 5],
        ["축", "chuk", 1, 4],
        ["하", "ha", 1, 0],
        ["합", "ham", 0.5, 2],
        ["니", "ni", 0.5, 2],
        ["다", "da", 2, 0],
      ]),
    ],
  },
  {
    id: "happy-birthday-ar",
    title: "عيد ميلاد سعيد",
    language: "ar",
    audioUrl: "/songs/happy-birthday-ar.mp3",
    // needs native speaker check: Modern Standard Arabic, with the case
    // ending on عيد dropped so the line fits six notes.
    needsNativeSpeakerCheck: true,
    lines: [
      line(1, "عِيدْ مِيلادٍ سَعِيدْ", "ʿīd mī-lā-din sa-ʿīd", [
        ["عِيدْ", "ʿīd", 0.75, -5],
        ["مِي", "mī", 0.25, -5],
        ["لا", "lā", 1, -3],
        ["دٍ", "din", 1, -5],
        ["سَ", "sa", 1, 0],
        ["عِيدْ", "ʿīd", 2, -1],
      ]),
      line(2, "عِيدْ مِيلادٍ سَعِيدْ", "ʿīd mī-lā-din sa-ʿīd", [
        ["عِيدْ", "ʿīd", 0.75, -5],
        ["مِي", "mī", 0.25, -5],
        ["لا", "lā", 1, -3],
        ["دٍ", "din", 1, -5],
        ["سَ", "sa", 1, 2],
        ["عِيدْ", "ʿīd", 2, 0],
      ]),
      line(3, "عِيدْ مِيلادٍ سَعِيدْ", "ʿīd mī-lā-din sa-ʿīd", [
        ["عِيدْ", "ʿīd", 0.75, 5],
        ["مِي", "mī", 0.25, 5],
        ["لا", "lā", 1, 4],
        ["دٍ", "din", 1, 0],
        ["سَ", "sa", 1, 2],
        ["عِيدْ", "ʿīd", 2, 0],
      ]),
    ],
  },
]
