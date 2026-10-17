import { useEffect, useRef, useState } from "react"

import type { PracticeLine, Song } from "@/domain/types"
import {
  loadSyllableClips,
  type SyllableClipLookup,
} from "@/services/syllableClips"

// Tiny pad so vowel tails and consonant releases aren't clipped mid-sound.
const SNIPPET_PAD_SEC = 0.08

// Minimum snippet duration so very short consonants still land audibly.
const MIN_SNIPPET_MS = 180

type Mode = "reference" | "take"

type ActivePlay = {
  index: number
  mode: Mode
}

// Per-syllable "hear it" row on the round result card. Highlights missed
// syllables and lets the user tap each one to replay just that sound.
//
// References are windowed into the song's existing audioUrl using the
// line's `audioStart` + each syllable's line-relative `start`/`end` from
// songs.ts. We do not render a per-syllable score number here. The Words
// probe in `/ml` is calibrated on line-length audio, not sub-second
// clips — showing a number per syllable would be fabricated.
export default function SyllableBreakdown({
  line,
  song,
  missed,
  wav,
  showTakePerSyllable,
  // True only when `wav` is a single-line recording whose timeline matches
  // the line's syllable start/end. Perform mode records one WAV across
  // many lines, so the math breaks there — caller passes false.
}: {
  line: PracticeLine
  song: Song
  missed: number[]
  wav: Blob | null
  showTakePerSyllable: boolean
}) {
  const [active, setActive] = useState<ActivePlay | null>(null)
  const refAudioRef = useRef<HTMLAudioElement | null>(null)
  const clipAudioRef = useRef<HTMLAudioElement | null>(null)
  const takeAudioRef = useRef<HTMLAudioElement | null>(null)
  const stopTimerRef = useRef<number | null>(null)
  const [takeUrl, setTakeUrl] = useState<string | null>(null)
  const [clipLookup, setClipLookup] = useState<SyllableClipLookup | null>(null)

  useEffect(() => {
    if (!wav) {
      setTakeUrl(null)
      return
    }
    const url = URL.createObjectURL(wav)
    setTakeUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [wav])

  useEffect(() => {
    let cancelled = false
    setClipLookup(null)
    void loadSyllableClips(song.id).then((lookup) => {
      if (cancelled) return
      // Wrap in a tuple-free setter: React treats a bare function as an
      // updater. Pass `() => lookup` so the function value itself is stored.
      setClipLookup(() => lookup)
    })
    return () => {
      cancelled = true
    }
  }, [song.id])

  const stop = () => {
    if (stopTimerRef.current != null) {
      window.clearTimeout(stopTimerRef.current)
      stopTimerRef.current = null
    }
    refAudioRef.current?.pause()
    clipAudioRef.current?.pause()
    takeAudioRef.current?.pause()
    setActive(null)
  }

  useEffect(() => stop, [])

  const missedSet = new Set(missed)
  const canWindowReference = line.audioStart !== undefined

  const scheduleStop = (durationMs: number, audio: HTMLAudioElement) => {
    stopTimerRef.current = window.setTimeout(
      () => {
        audio.pause()
        stopTimerRef.current = null
        setActive(null)
      },
      Math.max(MIN_SNIPPET_MS, durationMs),
    )
  }

  const playAt = (
    audio: HTMLAudioElement,
    start: number,
    end: number | undefined,
    onPlaying: () => void,
  ) => {
    const seekAndPlay = () => {
      try {
        audio.currentTime = start
      } catch {
        // Some browsers reject currentTime before duration is known; fall
        // through to play() and let the next tick settle it.
      }
      audio
        .play()
        .then(() => {
          onPlaying()
          if (end !== undefined) {
            scheduleStop((end - start) * 1000, audio)
          }
        })
        .catch(() => {
          setActive(null)
        })
    }
    if (audio.readyState >= 1) {
      seekAndPlay()
    } else {
      audio.addEventListener("loadedmetadata", seekAndPlay, { once: true })
      // Nudge the loader; preload="auto" usually handles this.
      try {
        audio.load()
      } catch {
        /* ignore */
      }
    }
  }

  const playReference = (index: number) => {
    if (active?.index === index && active.mode === "reference") {
      stop()
      return
    }
    stop()
    const s = line.syllables[index]
    // Prefer the ElevenLabs per-syllable TTS clip when the manifest supplies
    // one. These are clean renders (one syllable per file), so they skip the
    // windowing + stop-timer dance entirely — the audio ends naturally.
    const clipUrl = clipLookup?.(line.id, index) ?? null
    if (clipUrl) {
      const audio = clipAudioRef.current
      if (!audio) return
      audio.src = clipUrl
      audio.currentTime = 0
      audio
        .play()
        .then(() => setActive({ index, mode: "reference" }))
        .catch(() => setActive(null))
      return
    }
    const audio = refAudioRef.current
    if (!audio) return
    if (canWindowReference) {
      const start = (line.audioStart ?? 0) + s.start
      const end = (line.audioStart ?? 0) + s.end + SNIPPET_PAD_SEC
      playAt(audio, start, end, () => setActive({ index, mode: "reference" }))
    } else {
      // No per-line window on this song (e.g. Happy Birthday with no
      // syllable manifest yet): play the whole clip so the user still
      // hears a reference.
      playAt(audio, 0, undefined, () => setActive({ index, mode: "reference" }))
    }
  }

  const playTake = (index: number) => {
    if (active?.index === index && active.mode === "take") {
      stop()
      return
    }
    stop()
    const audio = takeAudioRef.current
    if (!audio || !takeUrl) return
    const s = line.syllables[index]
    const start = s.start
    const end = s.end + SNIPPET_PAD_SEC
    playAt(audio, start, end, () => setActive({ index, mode: "take" }))
  }

  const takeAvailable = Boolean(takeUrl && showTakePerSyllable)

  return (
    <div className="syllable-breakdown">
      <p className="syllable-breakdown-title">Break it down</p>
      <ul className="syllable-breakdown-tiles">
        {line.syllables.map((syl, i) => {
          const isMissed = missedSet.has(i)
          const isActive = active?.index === i
          const activeMode = isActive ? active?.mode : null
          const label = syl.romanization ?? syl.text
          return (
            <li
              key={`${syl.text}-${i}`}
              className={`syllable-tile ${isMissed ? "missed" : ""} ${
                isActive ? "active" : ""
              }`}
            >
              <div className="syllable-tile-glyphs">
                <span className="syllable-tile-text">{syl.text}</span>
                {syl.romanization && (
                  <span className="syllable-tile-roman">
                    {syl.romanization}
                  </span>
                )}
              </div>
              <div className="syllable-tile-buttons">
                <button
                  type="button"
                  className={`syllable-tile-button reference ${
                    activeMode === "reference" ? "playing" : ""
                  }`}
                  onClick={() => playReference(i)}
                  aria-label={`Hear ${label}`}
                >
                  {activeMode === "reference" ? "■" : "▶"} Hear
                </button>
                {takeAvailable && (
                  <button
                    type="button"
                    className={`syllable-tile-button take ${
                      activeMode === "take" ? "playing" : ""
                    }`}
                    onClick={() => playTake(i)}
                    aria-label={`Hear your ${label}`}
                  >
                    {activeMode === "take" ? "■" : "▶"} Yours
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
      <audio ref={refAudioRef} src={song.audioUrl} preload="auto" />
      <audio
        ref={clipAudioRef}
        preload="auto"
        onEnded={() => setActive(null)}
      />
      {takeUrl && <audio ref={takeAudioRef} src={takeUrl} preload="auto" />}
      <p className="syllable-breakdown-hint">
        {clipLookup
          ? "Tap a syllable to hear a clean reference."
          : canWindowReference
            ? "Tap a syllable to hear exactly how it should sound."
            : "Tap a syllable to replay the line reference."}
      </p>
    </div>
  )
}
