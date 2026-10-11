import type { Language, Song } from "@/domain/types"

export const LANGUAGE_NAMES: Record<Language, string> = {
  en: "English",
  ko: "Korean",
  ar: "Arabic",
}

export function SongTitle({ song }: { song: Song }) {
  return (
    <bdi className="song-tag-title" lang={song.language}>
      {song.title}
    </bdi>
  )
}

export default function SongTag({ song }: { song: Song }) {
  return (
    <p className="song-tag">
      <span>{LANGUAGE_NAMES[song.language]}</span>
      <SongTitle song={song} />
    </p>
  )
}
