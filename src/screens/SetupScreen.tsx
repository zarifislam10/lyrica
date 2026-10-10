import { useEffect, useRef, useState } from "react"

import {
  MAX_NAME_LENGTH,
  PLAYER_COLORS,
  type PlayerIndex,
} from "@/domain/match"
import { MicrophoneError, requestMicrophone } from "@/services/microphone"
import {
  createAudioContext,
  midiToHz,
  sessionFromMic,
  unlockAudio,
  type AudioSession,
} from "@/services/audioSession"
import { createPitchDetector } from "@/services/pitch"

type MicStatus = "idle" | "ready" | "blocked" | "no-device" | "generic"

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function Brand() {
  return (
    <div className="brand" aria-label="Lyrica">
      <span aria-hidden="true">Lyr</span>
      <i aria-hidden="true" />
      <span aria-hidden="true">ca</span>
    </div>
  )
}

export default function SetupScreen({
  names,
  onNameChange,
  onMicReady,
  onStart,
}: {
  names: [string, string]
  onNameChange: (player: PlayerIndex, name: string) => void
  onMicReady: (session: AudioSession) => void
  onStart: () => void
}) {
  const [micStatus, setMicStatus] = useState<MicStatus>("idle")
  const [liveHz, setLiveHz] = useState<number | null>(null)
  const sessionRef = useRef<AudioSession | null>(null)
  const detectorRef = useRef<ReturnType<typeof createPitchDetector> | null>(
    null,
  )
  const pitchesRef = useRef<number[]>([])

  useEffect(() => {
    return () => {
      detectorRef.current?.stop()
      detectorRef.current = null
    }
  }, [])

  const testMic = async () => {
    detectorRef.current?.stop()
    detectorRef.current = null

    const ctx = sessionRef.current?.ctx ?? createAudioContext()
    if (!ctx) {
      setMicStatus("generic")
      return
    }
    unlockAudio(ctx)

    try {
      const handle = await requestMicrophone()
      sessionRef.current?.stop()
      const session = sessionFromMic(ctx, handle)
      sessionRef.current = session
      onMicReady(session)

      pitchesRef.current = []
      const detector = createPitchDetector({
        ctx,
        stream: session.stream,
        onSample: (sample) => {
          const recent = [...pitchesRef.current, sample.pitch].slice(-5)
          pitchesRef.current = recent
          setLiveHz(midiToHz(median(recent)))
        },
      })
      detector.start(ctx.currentTime)
      detectorRef.current = detector
      setMicStatus("ready")
    } catch (err) {
      setLiveHz(null)
      if (err instanceof MicrophoneError) {
        setMicStatus(err.kind)
      } else {
        setMicStatus("generic")
      }
    }
  }

  const startBattle = () => {
    detectorRef.current?.stop()
    detectorRef.current = null
    if (sessionRef.current) {
      unlockAudio(sessionRef.current.ctx)
    }
    onStart()
  }

  const micMessage: Record<MicStatus, string> = {
    idle: "Test the mic before you start. We'll keep it on for the whole match.",
    ready: "Mic is live. You're good to start.",
    blocked:
      "Microphone access is off. Allow it in browser settings, then test again.",
    "no-device": "No microphone found. Connect one, then test again.",
    generic: "The microphone couldn't start. Try again.",
  }

  return (
    <main className="screen setup-screen">
      <header className="screen-header">
        <Brand />
        <p>Two players · one device</p>
      </header>

      <section className="setup-content">
        <h1>Name the singers</h1>
        <p className="setup-copy">
          Take turns on this device. Best of three lines.
        </p>

        <div className="name-fields">
          {([0, 1] as const).map((player) => (
            <label className="name-field" key={player}>
              <span>
                <i
                  className="player-swatch"
                  style={{ background: PLAYER_COLORS[player] }}
                />
                Player {player + 1}
              </span>
              <input
                value={names[player]}
                maxLength={MAX_NAME_LENGTH}
                placeholder={`Player ${player + 1}`}
                autoComplete="off"
                onChange={(event) => onNameChange(player, event.target.value)}
              />
            </label>
          ))}
        </div>

        <div className="mic-test">
          <div className="mic-test-row">
            <strong>Microphone</strong>
            <button className="test-mic-button" type="button" onClick={testMic}>
              Test mic
            </button>
          </div>
          {liveHz != null && micStatus === "ready" && (
            <div className="mic-pitch">
              {Math.round(liveHz)}
              <small>Hz live</small>
            </div>
          )}
          <p className="setup-copy">{micMessage[micStatus]}</p>
        </div>

        <button
          className="start-battle-button"
          type="button"
          onClick={startBattle}
          disabled={micStatus !== "ready"}
        >
          Start battle
        </button>
      </section>
    </main>
  )
}
