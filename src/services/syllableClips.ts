// Loads the per-syllable TTS manifest written by backend/generate_syllables.py
// and returns a lookup from (lineId, syllableIndex) to a clip URL.
//
// The manifest lives at /songs/syllables/<song-id>/manifest.json. When it's
// missing (song hasn't been rendered yet) or any clip entry is absent, the
// lookup returns null and the UI falls back to windowing the full-mix clip.
//
// Results are cached per song.id as a Promise so a result-screen remount
// doesn't refetch, and so React Strict Mode's double-mount doesn't double-hit
// the network.

type ManifestClip = {
  file: string
  text: string
  romanization: string | null
  duration_hint_sec: number
}

type Manifest = {
  song_id: string
  language: string
  voice_id?: string
  model_id?: string
  speaking_speed?: number
  clips: Record<string, ManifestClip>
}

export type SyllableClipLookup = (
  lineId: number,
  index: number,
) => string | null

const cache = new Map<string, Promise<SyllableClipLookup | null>>()

export function loadSyllableClips(
  songId: string,
): Promise<SyllableClipLookup | null> {
  const existing = cache.get(songId)
  if (existing) return existing
  const basePath = `/songs/syllables/${songId}`
  const promise = fetch(`${basePath}/manifest.json`, { cache: "force-cache" })
    .then(async (res) => {
      if (!res.ok) return null
      const data = (await res.json()) as Manifest
      if (!data || typeof data !== "object" || !data.clips) return null
      return (lineId: number, index: number) => {
        const key = `${lineId}-${index}`
        const clip = data.clips[key]
        if (!clip) return null
        return `${basePath}/${clip.file}`
      }
    })
    .catch(() => null)
  cache.set(songId, promise)
  return promise
}
