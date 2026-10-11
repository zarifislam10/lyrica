// "Hear it in my voice" — stretch feature.
//
// Shown per player on the round-result screen. Three states:
//   1. No session yet → consent screen with a checkbox and a Record button.
//      Explicit opt-in (checkbox) per AGENTS.md.
//   2. Recording → short visible countdown, hard stop at RECORD_SECONDS.
//   3. Session exists → a "Hear it in my voice" button that plays the
//      current line in the cloned voice. Each click after the first for
//      the same (song, line) hits the server cache, not credits.
//
// Honesty: labelled as "AI voice copy, spoken — not sung" so a listener
// knows what they're hearing. On any error we show a short message and
// disable the button; the standard "Hear it" on the sing screen remains
// as a fallback for anything the user needs to hear.

import { useEffect, useRef, useState } from "react"

import type { PracticeLine } from "@/domain/types"
import { MicrophoneError, requestMicrophone } from "@/services/microphone"
import { cloneVoice, sayLine, VoiceCloneError } from "@/services/voiceClone"

const RECORD_SECONDS = 15
// A short neutral prompt. Content doesn't matter for the clone — only the
// sound does — but a prompt stops the recorder from capturing silence.
const PROMPT_EN =
  "I like learning new songs. It helps me say new words and sounds."
const PROMPT_KO =
  "저는 새로운 노래를 배우는 것을 좋아합니다. 매일 조금씩 연습해요."
const PROMPT_AR = "أحبّ تعلم أغانٍ جديدة، وأتدرّب قليلاً كل يوم."

function promptFor(language: string): string {
  if (language.startsWith("ko")) return PROMPT_KO
  if (language.startsWith("ar")) return PROMPT_AR
  return PROMPT_EN
}

type Phase = "idle" | "consent" | "recording" | "uploading" | "ready" | "error"

export default function VoiceClonePanel({
  line,
  songId,
  language,
  sessionId,
  onSessionCreated,
}: {
  line: PracticeLine
  songId: string
  language: string
  sessionId: string | null
  onSessionCreated: (sessionId: string) => void
}) {
  const [phase, setPhase] = useState<Phase>(sessionId ? "ready" : "idle")
  const [consent, setConsent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [remaining, setRemaining] = useState(RECORD_SECONDS)
  const [playing, setPlaying] = useState(false)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const stopTimerRef = useRef<number | null>(null)
  const tickTimerRef = useRef<number | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioUrlRef = useRef<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // If the parent provides a sessionId (e.g. the player cloned on a
  // previous round in this same match), stay in the "ready" state.
  useEffect(() => {
    if (sessionId && phase !== "ready" && phase !== "uploading") {
      setPhase("ready")
    }
  }, [sessionId, phase])

  // Cleanup on unmount: stop any live recording and release the audio URL.
  useEffect(() => {
    return () => {
      recorderRef.current?.state === "recording" && recorderRef.current.stop()
      recorderRef.current?.stream.getTracks().forEach((t) => t.stop())
      if (stopTimerRef.current) window.clearTimeout(stopTimerRef.current)
      if (tickTimerRef.current) window.clearInterval(tickTimerRef.current)
      abortRef.current?.abort()
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current = null
      }
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current)
        audioUrlRef.current = null
      }
    }
  }, [])

  const beginConsent = () => {
    setError(null)
    setConsent(false)
    setPhase("consent")
  }

  const cancelConsent = () => {
    setPhase(sessionId ? "ready" : "idle")
  }

  const startRecording = async () => {
    if (!consent) return
    setError(null)
    let mic
    try {
      mic = await requestMicrophone()
    } catch (err) {
      const message =
        err instanceof MicrophoneError && err.kind === "blocked"
          ? "Microphone permission is needed to record a sample."
          : "Could not start the microphone."
      setError(message)
      setPhase("error")
      return
    }

    if (typeof MediaRecorder === "undefined") {
      mic.stop()
      setError("This browser can't record a voice sample.")
      setPhase("error")
      return
    }

    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(mic.stream)
    } catch {
      mic.stop()
      setError("This browser can't record a voice sample.")
      setPhase("error")
      return
    }
    recorderRef.current = recorder
    chunksRef.current = []

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunksRef.current.push(event.data)
    }
    recorder.onstop = async () => {
      // Tear the mic down the instant recording ends. We never need it
      // again for the clone, and holding it keeps the OS indicator on.
      mic.stop()
      if (stopTimerRef.current) {
        window.clearTimeout(stopTimerRef.current)
        stopTimerRef.current = null
      }
      if (tickTimerRef.current) {
        window.clearInterval(tickTimerRef.current)
        tickTimerRef.current = null
      }
      const blob = new Blob(chunksRef.current, {
        type: recorder.mimeType || "audio/webm",
      })
      chunksRef.current = []
      await uploadSample(blob)
    }

    recorder.start()
    setPhase("recording")
    setRemaining(RECORD_SECONDS)
    const startedAt = Date.now()
    tickTimerRef.current = window.setInterval(() => {
      const left = Math.max(
        0,
        RECORD_SECONDS - Math.floor((Date.now() - startedAt) / 1000),
      )
      setRemaining(left)
    }, 250)
    stopTimerRef.current = window.setTimeout(() => {
      if (recorder.state === "recording") recorder.stop()
    }, RECORD_SECONDS * 1000)
  }

  const stopRecording = () => {
    const recorder = recorderRef.current
    if (recorder && recorder.state === "recording") recorder.stop()
  }

  const uploadSample = async (blob: Blob) => {
    setPhase("uploading")
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const newId = await cloneVoice(blob, { signal: controller.signal })
      onSessionCreated(newId)
      setPhase("ready")
    } catch (err) {
      if ((err as DOMException | null)?.name === "AbortError") return
      const code = err instanceof VoiceCloneError ? err.code : "unknown"
      setError(
        code === "unsupported"
          ? "Voice cloning isn't available right now."
          : code === "too-large"
            ? "That sample was too long — try a shorter take."
            : "Could not create the voice copy. Please try again.",
      )
      setPhase("error")
    }
  }

  const playInMyVoice = async () => {
    if (!sessionId) return
    setError(null)
    // Pause any previous playback.
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current)
      audioUrlRef.current = null
    }
    setPlaying(true)
    try {
      const audio = await sayLine({
        sessionId,
        songId,
        lineId: line.id,
        text: line.text,
        language,
      })
      const url = URL.createObjectURL(audio)
      audioUrlRef.current = url
      const el = new Audio(url)
      audioRef.current = el
      el.onended = () => {
        setPlaying(false)
        if (audioUrlRef.current) {
          URL.revokeObjectURL(audioUrlRef.current)
          audioUrlRef.current = null
        }
      }
      el.onerror = () => {
        setPlaying(false)
        setError("Could not play the voice copy.")
      }
      await el.play().catch(() => {
        setPlaying(false)
        setError("Tap play again to hear the voice copy.")
      })
    } catch (err) {
      setPlaying(false)
      const code = err instanceof VoiceCloneError ? err.code : "unknown"
      setError(
        code === "expired"
          ? "The voice copy expired. Use the regular Hear it on the sing screen."
          : "Could not play the voice copy.",
      )
    }
  }

  if (phase === "idle") {
    return (
      <div className="voice-clone-panel">
        <button
          type="button"
          className="voice-clone-button"
          onClick={beginConsent}
        >
          Hear it in my voice
        </button>
        <small className="voice-clone-note">
          AI voice copy, spoken — not sung.
        </small>
      </div>
    )
  }

  if (phase === "consent") {
    return (
      <div className="voice-clone-panel voice-clone-consent">
        <p>
          Record a short sample so Lyrica can play this line back in a voice
          that sounds like yours. The copy is temporary.
        </p>
        <ul>
          <li>Deleted when the match ends.</li>
          <li>Only used to play lines back to you.</li>
          <li>Never shared with the other player.</li>
        </ul>
        <label className="voice-clone-consent-check">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
          />{" "}
          I agree to record a {RECORD_SECONDS}-second voice sample.
        </label>
        <div className="voice-clone-actions">
          <button
            type="button"
            className="voice-clone-button primary"
            onClick={startRecording}
            disabled={!consent}
          >
            Record sample
          </button>
          <button
            type="button"
            className="voice-clone-button ghost"
            onClick={cancelConsent}
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  if (phase === "recording") {
    return (
      <div className="voice-clone-panel voice-clone-recording">
        <p>Recording — read this out loud:</p>
        <blockquote className="voice-clone-prompt">
          {promptFor(language)}
        </blockquote>
        <p className="voice-clone-countdown">{remaining}s left</p>
        <button
          type="button"
          className="voice-clone-button"
          onClick={stopRecording}
        >
          Stop and use this take
        </button>
      </div>
    )
  }

  if (phase === "uploading") {
    return (
      <div className="voice-clone-panel">
        <p>Making your voice copy…</p>
      </div>
    )
  }

  if (phase === "error") {
    return (
      <div className="voice-clone-panel voice-clone-error">
        <p>{error}</p>
        <button
          type="button"
          className="voice-clone-button"
          onClick={beginConsent}
        >
          Try again
        </button>
      </div>
    )
  }

  // phase === "ready"
  return (
    <div className="voice-clone-panel">
      <button
        type="button"
        className="voice-clone-button primary"
        onClick={playInMyVoice}
        disabled={playing}
      >
        {playing ? "Playing…" : "Hear it in my voice"}
      </button>
      <small className="voice-clone-note">
        AI voice copy, spoken — not sung.
      </small>
      {error && <p className="voice-clone-inline-error">{error}</p>}
    </div>
  )
}
