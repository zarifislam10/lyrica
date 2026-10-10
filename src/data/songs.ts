import { generatedSongs } from "@/data/songs.generated"
import type { Language, Song, SongLine } from "@/domain/types"

export const CLIP_SECONDS = 10
export const LINES_PER_SONG = 3

function songUrls(id: string) {
  return {
    audioUrl: `/songs/${id}.mp3`,
    vocalsUrl: `/songs/${id}-vocals.mp3`,
  }
}

// Placeholder line ranges split the clip into thirds until real line breaks
// come from the lyrics. Syllables stay empty until the extraction script
// fills them from the vocals stem.
function pendingLines(): SongLine[] {
  const span = CLIP_SECONDS / LINES_PER_SONG
  return Array.from({ length: LINES_PER_SONG }, (_, i) => ({
    id: i + 1,
    text: "",
    audioStart: Number((i * span).toFixed(2)),
    audioEnd: Number(((i + 1) * span).toFixed(2)),
    syllables: [],
  }))
}

function pendingSong(id: string, title: string, language: Language): Song {
  return {
    id,
    title,
    language,
    ...songUrls(id),
    clipSeconds: CLIP_SECONDS,
    lines: pendingLines(),
  }
}

const slots = [
  pendingSong("en-1", "English song", "en"),
  pendingSong("ko-1", "Korean song", "ko"),
  pendingSong("es-1", "Spanish song", "es"),
]

// Each slot uses its generated song once backend/generate_songs.py has run
// for it, and stays a placeholder until then.
export const songs: Song[] = slots.map(
  (slot) => generatedSongs.find((song) => song.id === slot.id) ?? slot,
)
