// "Hear how you'd sound" — stretch feature on the result screen.
//
// Flow:
//   idle    → prominent CTA. Click opens the consent step.
//   consent → short plain-text summary + single confirm button. The click
//             is the explicit opt-in (confirm-dialog pattern per AGENTS.md).
//   recording → 15 s hard cap with a visible countdown.
//   uploading → sample is streamed to the server; voice id stays server-side.
//   ready   → clicking plays the current line in the cloned voice. We
//             pre-fetch the audio right after the clone is created so the
//             first press is instant.
//
// Still labelled honestly ("AI copy, spoken") so a listener knows what
// they're hearing. On error we show a short message and let them retry.

import { useEffect, useRef, useState } from "react"

import type { PracticeLine } from "@/domain/types"
import { MicrophoneError, requestMicrophone } from "@/services/microphone"
import { cloneVoice, sayLine, VoiceCloneError } from "@/services/voiceClone"

// 30s is the sweet spot for ElevenLabs IVC: short enough that people will
// actually read it, long enough that the clone has real phonetic variety to
// generalize from. 15s samples came out too generic.
const RECORD_SECONDS = 30
// Phonetically varied prompts. The more different sounds the clone hears,
// the closer the playback will feel. The sentences are built to cover a
// wide range of vowels and consonants without being hard to read.
const PROMPT_EN =
  "I like learning new songs. It helps me say new words and sounds. The quick brown fox jumps over the lazy dog. I'm practicing my pronunciation, and every take feels a little better than the last."
const PROMPT_KO =
  "저는 새로운 노래를 배우는 것을 좋아합니다. 매일 조금씩 연습해요. 오늘도 제 목소리로 또박또박 읽어 봅니다."
const PROMPT_AR =
  "أحبّ تعلم أغانٍ جديدة، وأتدرّب قليلاً كل يوم. أقرأ هذه الجملة بصوتٍ واضح وطبيعي حتى يسمعني الحاسوب جيداً."

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
  const [error, setError] = useState<string | null>(null)
  const [remaining, setRemaining] = useState(RECORD_SECONDS)
  const [playing, setPlaying] = useState(false)
  // "preparing" is the time between clone-created and audio-ready. During
  // that window the Play button shows a spinner instead of making the user
  // click once, wait, and then wait again on the server round-trip.
  const [preparing, setPreparing] = useState(false)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const stopTimerRef = useRef<number | null>(null)
  const tickTimerRef = useRef<number | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioUrlRef = useRef<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const prefetchRef = useRef<AbortController | null>(null)
  // Memoised blob keyed by lineId so switching rounds re-prefetches but
  // replays within a round reuse the same bytes.
  const preparedForLineRef = useRef<number | null>(null)

  useEffect(() => {
    if (sessionId && phase !== "ready" && phase !== "uploading") {
      setPhase("ready")
    }
  }, [sessionId, phase])

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      recorderRef.current?.state === "recording" && recorderRef.current.stop()
      recorderRef.current?.stream.getTracks().forEach((t) => t.stop())
      if (stopTimerRef.current) window.clearTimeout(stopTimerRef.current)
      if (tickTimerRef.current) window.clearInterval(tickTimerRef.current)
      abortRef.current?.abort()
      prefetchRef.current?.abort()
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

  // When we have a session and the current line changes (or the session
  // was just created), prefetch the audio so Play is instant.
  useEffect(() => {
    if (!sessionId || phase !== "ready") return
    if (preparedForLineRef.current === line.id) return
    prefetchRef.current?.abort()
    // Invalidate the previous line's blob BEFORE we start fetching. If the
    // user hits Play during the prefetch window, playInMyVoice must not
    // find a stale URL that points at a different line.
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current)
      audioUrlRef.current = null
    }
    preparedForLineRef.current = null
    const controller = new AbortController()
    prefetchRef.current = controller
    setPreparing(true)
    void (async () => {
      try {
        const audio = await sayLine({
          sessionId,
          songId,
          lineId: line.id,
          text: line.text,
          language,
          signal: controller.signal,
        })
        if (controller.signal.aborted) return
        audioUrlRef.current = URL.createObjectURL(audio)
        preparedForLineRef.current = line.id
      } catch (err) {
        if ((err as DOMException | null)?.name === "AbortError") return
        // Silent prefetch failure: Play will try again and surface the error.
      } finally {
        if (!controller.signal.aborted) setPreparing(false)
      }
    })()
    return () => controller.abort()
  }, [sessionId, phase, line.id, line.text, songId, language])

  const beginConsent = () => {
    setError(null)
    setPhase("consent")
  }

  const cancelConsent = () => {
    setPhase(sessionId ? "ready" : "idle")
  }

  const startRecording = async () => {
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
      // Reset the prefetch marker so the ready-effect kicks in with the
      // new session id.
      preparedForLineRef.current = null
      onSessionCreated(newId)
      setPhase("ready")
    } catch (err) {
      if ((err as DOMException | null)?.name === "AbortError") return
      const code = err instanceof VoiceCloneError ? err.code : "unknown"
      setError(
        code === "unsupported"
          ? "Voice cloning isn't available right now."
          : code === "too-large"
            ? "That sample was too long. Try a shorter take."
            : "Could not create the voice copy. Please try again.",
      )
      setPhase("error")
    }
  }

  const playInMyVoice = async () => {
    if (!sessionId) return
    setError(null)
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    setPlaying(true)
    try {
      // Fast path: prefetched blob already decoded into a URL.
      let url = audioUrlRef.current
      if (!url) {
        const audio = await sayLine({
          sessionId,
          songId,
          lineId: line.id,
          text: line.text,
          language,
        })
        url = URL.createObjectURL(audio)
        audioUrlRef.current = url
        preparedForLineRef.current = line.id
      }
      const el = new Audio(url)
      audioRef.current = el
      el.onended = () => {
        setPlaying(false)
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
      <div className="voice-clone-panel voice-clone-cta">
        <div className="voice-clone-badge">New</div>
        <h4 className="voice-clone-title">
          <span aria-hidden="true">✨</span> Hear how you'd sound
        </h4>
        <p className="voice-clone-tagline">
          Record a quick sample and we'll read this line back in your voice.
        </p>
        <button
          type="button"
          className="voice-clone-button primary big"
          onClick={beginConsent}
        >
          Try it
        </button>
      </div>
    )
  }

  if (phase === "consent") {
    return (
      <div className="voice-clone-panel voice-clone-cta">
        <h4 className="voice-clone-title">Before we record you</h4>
        <ul>
          <li>Deleted when the match ends.</li>
          <li>Only used to play lines back to you.</li>
          <li>Never shared with anyone else.</li>
        </ul>
        <div className="voice-clone-actions">
          <button
            type="button"
            className="voice-clone-button primary big"
            onClick={startRecording}
          >
            Yes, record my voice
          </button>
          <button
            type="button"
            className="voice-clone-button ghost"
            onClick={cancelConsent}
          >
            Not now
          </button>
        </div>
      </div>
    )
  }

  if (phase === "recording") {
    return (
      <div className="voice-clone-panel voice-clone-cta voice-clone-recording">
        <h4 className="voice-clone-title">Recording. Read this out loud</h4>
        <blockquote className="voice-clone-prompt">
          {promptFor(language)}
        </blockquote>
        <p className="voice-clone-countdown">{remaining}s left</p>
        <button
          type="button"
          className="voice-clone-button primary"
          onClick={stopRecording}
        >
          Stop and use this take
        </button>
      </div>
    )
  }

  if (phase === "uploading") {
    return (
      <div className="voice-clone-panel voice-clone-cta">
        <h4 className="voice-clone-title">Making your voice copy…</h4>
        <p className="voice-clone-tagline">This usually takes a few seconds.</p>
      </div>
    )
  }

  if (phase === "error") {
    return (
      <div className="voice-clone-panel voice-clone-cta voice-clone-error">
        <h4 className="voice-clone-title">Something went wrong</h4>
        <p>{error}</p>
        <button
          type="button"
          className="voice-clone-button primary"
          onClick={beginConsent}
        >
          Try again
        </button>
      </div>
    )
  }

  // phase === "ready"
  const buttonLabel = playing
    ? "Playing…"
    : preparing
      ? "Loading your voice…"
      : "Hear this line in your voice"
  return (
    <div className="voice-clone-panel voice-clone-cta voice-clone-ready">
      <h4 className="voice-clone-title">
        <span aria-hidden="true">✨</span> Your voice is ready
      </h4>
      <button
        type="button"
        className="voice-clone-button primary big"
        onClick={playInMyVoice}
        disabled={playing || preparing}
      >
        {buttonLabel}
      </button>
      <small className="voice-clone-note">
        AI copy of your voice, spoken not sung. Approximate.
      </small>
      {error && <p className="voice-clone-inline-error">{error}</p>}
    </div>
  )
}
