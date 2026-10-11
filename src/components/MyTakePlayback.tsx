import { useEffect, useRef, useState } from "react"

// A tiny "hear your take" control for the round result card. Takes the WAV
// blob the recorder produced for this player's turn, builds an object URL,
// and plays it back on demand. The URL is torn down when the blob changes or
// the component unmounts, so a long demo session doesn't leak Blob handles.
export default function MyTakePlayback({ wav }: { wav: Blob | null }) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    if (!wav) {
      setUrl(null)
      return
    }
    const next = URL.createObjectURL(wav)
    setUrl(next)
    return () => {
      URL.revokeObjectURL(next)
    }
  }, [wav])

  const toggle = () => {
    const audio = audioRef.current
    if (!audio) return
    if (playing) {
      audio.pause()
      audio.currentTime = 0
      setPlaying(false)
      return
    }
    audio
      .play()
      .then(() => setPlaying(true))
      .catch(() => setPlaying(false))
  }

  if (!url) return null

  return (
    <div className="my-take-playback">
      <button
        type="button"
        className="my-take-playback-button"
        onClick={toggle}
        aria-pressed={playing}
      >
        {playing ? "Stop" : "Hear your take"}
      </button>
      <audio
        ref={audioRef}
        src={url}
        onEnded={() => setPlaying(false)}
        preload="auto"
      />
    </div>
  )
}
