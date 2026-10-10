import { useEffect, useMemo, useRef, useState } from "react"

import type { PitchSample } from "@/domain/types"
import { MicrophoneError, requestMicrophone } from "@/services/microphone"
import { createPitchDetector } from "@/services/pitch"

type Syllable = {
  hangul: string
  roman: string
  start: number
  end: number
  pitch: number
}

type PracticeLine = {
  id: number
  hangul: string
  romanization: string
  syllables: Syllable[]
}

type Screen = "home" | "pick" | "sing" | "result"
type SingState = "ready" | "starting" | "counting" | "recording"
type ErrorKind = "blocked" | "no-device" | "unclear" | "generic" | null

const DURATION = 4
const COUNT_IN_BEATS = 3
const COUNT_IN_INTERVAL = 0.7
const COUNT_IN_SECONDS = COUNT_IN_BEATS * COUNT_IN_INTERVAL
// Treat a recording as "unclear" if fewer than this fraction of recorded frames
// passed the clarity threshold.
const MIN_CLARITY_FRAME_RATIO = 0.15
// Approximate frames-per-second produced by the rAF pitch loop; used to size
// the "expected frames" denominator for the unclear check.
const APPROX_FRAMES_PER_SECOND = 60
// Lane coordinate space: target bars live at pitch% 0..100 (bottom offset).
// Fold a MIDI note into this range by octaves so low/high voices stay visible.
const LANE_PITCH_MIN = 40
const LANE_PITCH_MAX = 84

function foldPitchForLane(midi: number): number {
  let value = midi
  while (value < LANE_PITCH_MIN) value += 12
  while (value > LANE_PITCH_MAX) value -= 12
  return value
}

const practiceLines: PracticeLine[] = [
  {
    id: 1,
    hangul: "안녕하세요",
    romanization: "an-nyeong-ha-se-yo",
    syllables: [
      { hangul: "안", roman: "an", start: 0, end: 0.58, pitch: 52 },
      { hangul: "녕", roman: "nyeong", start: 0.7, end: 1.48, pitch: 67 },
      { hangul: "하", roman: "ha", start: 1.6, end: 2.22, pitch: 59 },
      { hangul: "세", roman: "se", start: 2.36, end: 3.08, pitch: 74 },
      { hangul: "요", roman: "yo", start: 3.2, end: 4, pitch: 62 },
    ],
  },
  {
    id: 2,
    hangul: "사랑해요",
    romanization: "sa-rang-hae-yo",
    syllables: [
      { hangul: "사", roman: "sa", start: 0, end: 0.72, pitch: 48 },
      { hangul: "랑", roman: "rang", start: 0.86, end: 1.76, pitch: 63 },
      { hangul: "해", roman: "hae", start: 1.9, end: 2.92, pitch: 72 },
      { hangul: "요", roman: "yo", start: 3.08, end: 4, pitch: 59 },
    ],
  },
  {
    id: 3,
    hangul: "감사합니다",
    romanization: "gam-sa-ham-ni-da",
    syllables: [
      { hangul: "감", roman: "gam", start: 0, end: 0.63, pitch: 55 },
      { hangul: "사", roman: "sa", start: 0.75, end: 1.37, pitch: 67 },
      { hangul: "합", roman: "ham", start: 1.5, end: 2.26, pitch: 61 },
      { hangul: "니", roman: "ni", start: 2.4, end: 3.13, pitch: 76 },
      { hangul: "다", roman: "da", start: 3.26, end: 4, pitch: 64 },
    ],
  },
]

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0013 0M12 18v3M8.5 21h7" />
    </svg>
  )
}

function SpeakerIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M11 5L6.8 8.5H3.5v7h3.3L11 19V5zM15 9a4.2 4.2 0 010 6M17.5 6.5a7.6 7.6 0 010 11" />
    </svg>
  )
}

function HalftoneSparkle({
  className = "",
  color = "#FF4FA3",
  accent,
}: {
  className?: string
  color?: string
  accent?: string
}) {
  const dots = []
  const spacing = 6.5

  for (let row = -14; row <= 14; row += 1) {
    for (let column = -14; column <= 14; column += 1) {
      const cloudDistance = Math.hypot(column / 14, row / 14)
      if (cloudDistance > 1) continue

      const sparkleDistance =
        Math.pow(Math.abs(column) / 6.5, 0.52) +
        Math.pow(Math.abs(row) / 10, 0.52)
      const insideSparkle = sparkleDistance <= 1
      const edgeScale = Math.pow(1 - cloudDistance, 0.45)
      const size = 0.35 + 3.15 * edgeScale + (insideSparkle ? 0.5 : 0)
      const fill = insideSparkle && accent ? accent : color

      dots.push(
        <ellipse
          cx={100 + column * spacing}
          cy={100 + row * spacing}
          fill={fill}
          key={`${row}-${column}`}
          rx={size}
          ry={size * 0.48}
          transform={`rotate(30 ${100 + column * spacing} ${100 + row * spacing})`}
        />,
      )
    }
  }

  return (
    <svg
      className={`halftone-sparkle ${className}`}
      viewBox="0 0 200 200"
      aria-hidden="true"
    >
      <g>{dots}</g>
    </svg>
  )
}

function DotStar({
  className = "",
  color = "#B8FFB0",
}: {
  className?: string
  color?: string
}) {
  const vertices = Array.from({ length: 10 }, (_, index) => {
    const radius = index % 2 === 0 ? 18 : 7
    const angle = -Math.PI / 2 + (index * Math.PI) / 5
    return [25 + Math.cos(angle) * radius, 25 + Math.sin(angle) * radius]
  })

  return (
    <svg
      className={`dot-star ${className}`}
      viewBox="0 0 50 50"
      aria-hidden="true"
    >
      {[...vertices, [25, 25]].map(([cx, cy], index) => (
        <ellipse
          cx={cx}
          cy={cy}
          fill={color}
          key={index}
          rx={index === 10 ? 1.8 : 1.2}
          ry={index === 10 ? 0.9 : 0.6}
          transform={`rotate(30 ${cx} ${cy})`}
        />
      ))}
    </svg>
  )
}

function CornerDots() {
  return (
    <div className="corner-dots" aria-hidden="true">
      <HalftoneSparkle
        className="corner-star-one"
        color="#9B3DFF"
        accent="#FF4FA3"
      />
      <HalftoneSparkle
        className="corner-star-two"
        color="#19B5FF"
        accent="#B8FFB0"
      />
    </div>
  )
}

function RecordDotRing() {
  return (
    <svg className="record-dot-ring" viewBox="0 0 120 120" aria-hidden="true">
      {Array.from({ length: 24 }, (_, index) => {
        const angle = (index / 24) * Math.PI * 2
        const cx = 60 + Math.cos(angle) * 53
        const cy = 60 + Math.sin(angle) * 53
        return (
          <ellipse
            className="record-dot"
            cx={cx}
            cy={cy}
            fill="#FF4FA3"
            key={index}
            rx="2.4"
            ry="1.2"
            style={{ animationDelay: `${index * -70}ms` }}
            transform={`rotate(30 ${cx} ${cy})`}
          />
        )
      })}
    </svg>
  )
}

function Brand({ onHome }: { onHome?: () => void }) {
  const wordmark = (
    <div className="brand" aria-label="Lyrica">
      <span aria-hidden="true">Lyr</span>
      <i aria-hidden="true" />
      <span aria-hidden="true">ca</span>
    </div>
  )

  if (!onHome) return wordmark

  return (
    <button
      className="brand-home-button"
      onClick={onHome}
      aria-label="Go to Lyrica home"
    >
      {wordmark}
    </button>
  )
}

function LyricSyllables({
  line,
  activeIndex = -1,
  result = false,
}: {
  line: PracticeLine
  activeIndex?: number
  result?: boolean
}) {
  return (
    <div className={`lyric-grid ${line.syllables.length === 4 ? "four" : ""}`}>
      {line.syllables.map((syllable, index) => {
        const missed = result && (index === 1 || index === 2)
        return (
          <div
            className={[
              "syllable",
              activeIndex === index ? "active" : "",
              result ? (missed ? "missed" : "matched") : "",
            ].join(" ")}
            key={`${line.id}-${syllable.hangul}`}
          >
            <span className="hangul">{syllable.hangul}</span>
            <span className="roman">{syllable.roman}</span>
          </div>
        )
      })}
    </div>
  )
}

function voicePath(line: PracticeLine) {
  const points: string[] = []
  const toX = (time: number) => 8 + (time / DURATION) * 304
  const toY = (pitch: number) => 116 - pitch

  line.syllables.forEach((syllable, index) => {
    const start = index === 1 ? syllable.start + 0.22 : syllable.start
    const pitch =
      index === 2 ? syllable.pitch - 20 : syllable.pitch + (index % 2 ? -2 : 2)
    const endPitch = index === 2 ? pitch - 12 : pitch + 1
    points.push(
      `${toX(start)},${toY(pitch)}`,
      `${toX((start + syllable.end) / 2)},${toY(pitch + 2)}`,
      `${toX(syllable.end)},${toY(endPitch)}`,
    )
  })

  return points.join(" ")
}

function samplesPath(samples: PitchSample[], durationMs: number) {
  if (samples.length === 0) return ""
  const points: string[] = []
  for (const sample of samples) {
    const t = Math.max(0, Math.min(1, sample.timeMs / durationMs))
    const folded = foldPitchForLane(sample.pitch)
    const x = 8 + t * 304
    const y = 116 - folded
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`)
  }
  return points.join(" ")
}

function PitchLane({
  line,
  progress = 0,
  showVoice = false,
  result = false,
  samples,
  durationMs = DURATION * 1000,
}: {
  line: PracticeLine
  progress?: number
  showVoice?: boolean
  result?: boolean
  samples?: PitchSample[]
  durationMs?: number
}) {
  const clipWidth = Math.max(0, Math.min(1, progress)) * 320
  const hasRealSamples = samples !== undefined
  const voicePoints = hasRealSamples
    ? samplesPath(samples, durationMs)
    : voicePath(line)

  return (
    <div className="pitch-lane" aria-label="Target pitch lane">
      <svg className="lane-grid" aria-hidden="true">
        <defs>
          <pattern
            id={`lane-dots-${line.id}`}
            width="18"
            height="18"
            patternUnits="userSpaceOnUse"
          >
            <ellipse
              cx="2"
              cy="2"
              fill="#635969"
              rx="1"
              ry="0.5"
              transform="rotate(30 2 2)"
            />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill={`url(#lane-dots-${line.id})`} />
      </svg>
      {line.syllables.map((syllable, index) => {
        const left = (syllable.start / DURATION) * 100
        const width = ((syllable.end - syllable.start) / DURATION) * 100
        return (
          <div key={`${syllable.hangul}-pitch`}>
            <div
              className={`target-bar ${
                result && (index === 1 || index === 2) ? "missed" : ""
              }`}
              style={{
                left: `${left}%`,
                width: `${width}%`,
                bottom: `${syllable.pitch}%`,
              }}
            />
            <span
              className="bar-label"
              style={{
                left: `${left}%`,
                width: `${width}%`,
              }}
            >
              {syllable.roman}
            </span>
          </div>
        )
      })}
      {showVoice && voicePoints && (
        <svg
          className="voice-line"
          viewBox="0 0 320 132"
          preserveAspectRatio="none"
        >
          <defs>
            <clipPath id={`voice-clip-${line.id}`}>
              <rect x="0" y="0" width={result ? 320 : clipWidth} height="132" />
            </clipPath>
          </defs>
          <polyline
            points={voicePoints}
            clipPath={`url(#voice-clip-${line.id})`}
          />
        </svg>
      )}
      {!result && progress > 0 && progress < 1 && (
        <div className="playhead" style={{ left: `${progress * 100}%` }}>
          <span />
        </div>
      )}
      <div className="lane-time">
        <span>0:00</span>
        <span>0:04</span>
      </div>
    </div>
  )
}

function PickScreen({
  onPick,
  onHome,
}: {
  onPick: (line: PracticeLine) => void
  onHome: () => void
}) {
  return (
    <main className="screen pick-screen">
      <CornerDots />
      <header className="pick-header">
        <Brand onHome={onHome} />
        <p>Practice Song</p>
      </header>

      <section className="line-list" aria-labelledby="pick-title">
        <div className="section-kicker">TODAY’S PRACTICE</div>
        <h1 id="pick-title">Pick a line</h1>
        <p className="section-copy">Take it one phrase at a time.</p>

        <div className="line-cards">
          {practiceLines.map((line, index) => (
            <button
              className="line-card"
              key={line.id}
              onClick={() => onPick(line)}
            >
              <span className="line-number">0{index + 1}</span>
              <span className="line-text">
                <strong>{line.hangul}</strong>
                <small>{line.romanization}</small>
              </span>
              <span className="line-arrow">→</span>
            </button>
          ))}
        </div>
      </section>

      <p className="pick-note">
        <span />
        Pitch practice · about 1 min
      </p>
    </main>
  )
}

function ScreenHeader({
  line,
  onHome,
}: {
  line: PracticeLine
  onHome: () => void
}) {
  return (
    <header className="screen-header">
      <Brand onHome={onHome} />
      <div className="line-progress">
        <span>
          Line {line.id} <i>of</i> 3
        </span>
        <div className="progress-dots" aria-label={`Line ${line.id} of 3`}>
          {practiceLines.map((item) => (
            <i className={item.id === line.id ? "active" : ""} key={item.id} />
          ))}
        </div>
      </div>
    </header>
  )
}

function HomeScreen({ onStart }: { onStart: () => void }) {
  return (
    <main className="screen home-screen">
      <div className="home-dot-art" aria-hidden="true">
        <HalftoneSparkle
          className="home-star star-pink"
          color="#FF4FA3"
          accent="#19B5FF"
        />
        <HalftoneSparkle
          className="home-star star-cyan"
          color="#19B5FF"
          accent="#FF9A3D"
        />
        <HalftoneSparkle
          className="home-star star-violet"
          color="#9B3DFF"
          accent="#B8FFB0"
        />
        <HalftoneSparkle
          className="home-star star-orange"
          color="#FF9A3D"
          accent="#FF4FA3"
        />
        <DotStar className="tiny-star-one" color="#FF9A3D" />
        <DotStar className="tiny-star-two" color="#B8FFB0" />
      </div>
      <section className="home-content">
        <p className="home-eyebrow">YOUR VOICE · YOUR STAGE</p>
        <h1 aria-label="Lyrica">
          <span aria-hidden="true">Lyr</span>
          <i aria-hidden="true" />
          <span aria-hidden="true">ca</span>
        </h1>
        <p>Sing it like you mean it. In any language.</p>
        <button onClick={onStart}>Start singing</button>
      </section>
    </main>
  )
}

function SingScreen({
  line,
  onHome,
  onComplete,
}: {
  line: PracticeLine
  onHome: () => void
  onComplete: (samples: PitchSample[]) => void
}) {
  const [singState, setSingState] = useState<SingState>("ready")
  const [count, setCount] = useState(COUNT_IN_BEATS)
  const [progress, setProgress] = useState(0)
  const [liveSamples, setLiveSamples] = useState<PitchSample[]>([])
  const [error, setError] = useState<ErrorKind>(null)
  const [referencePlaying, setReferencePlaying] = useState(false)

  const audioCtxRef = useRef<AudioContext | null>(null)
  const micStopRef = useRef<(() => void) | null>(null)
  const detectorRef = useRef<ReturnType<typeof createPitchDetector> | null>(
    null,
  )
  const samplesRef = useRef<PitchSample[]>([])
  const rafRef = useRef(0)
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  const cleanup = () => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = 0
    detectorRef.current?.stop()
    detectorRef.current = null
    micStopRef.current?.()
    micStopRef.current = null
    const ctx = audioCtxRef.current
    audioCtxRef.current = null
    if (ctx && ctx.state !== "closed") {
      void ctx.close().catch(() => {})
    }
  }

  // Cleanup if the screen unmounts mid-count-in or mid-recording.
  useEffect(() => cleanup, [])

  const startRecording = async () => {
    if (singState !== "ready") return
    setError(null)
    setProgress(0)
    setLiveSamples([])
    samplesRef.current = []

    // iOS Safari requires the AudioContext to be created AND resumed
    // synchronously inside the user gesture, before any await.
    const AudioCtor: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext!
    if (!AudioCtor) {
      setError("generic")
      return
    }
    const ctx = new AudioCtor()
    audioCtxRef.current = ctx
    void ctx.resume().catch(() => {})

    setSingState("starting")

    let handle: Awaited<ReturnType<typeof requestMicrophone>>
    try {
      handle = await requestMicrophone()
    } catch (err) {
      cleanup()
      setSingState("ready")
      if (err instanceof MicrophoneError) {
        setError(err.kind)
      } else {
        setError("generic")
      }
      return
    }
    micStopRef.current = handle.stop

    const detector = createPitchDetector({
      ctx,
      stream: handle.stream,
      onSample: (sample) => {
        samplesRef.current = [...samplesRef.current, sample]
        setLiveSamples(samplesRef.current)
      },
    })
    detectorRef.current = detector

    const countStart = ctx.currentTime
    const recordStart = countStart + COUNT_IN_SECONDS
    const recordEnd = recordStart + DURATION

    setCount(COUNT_IN_BEATS)
    setSingState("counting")

    let hasStartedRecording = false

    const loop = () => {
      const ctxNow = audioCtxRef.current
      if (!ctxNow || ctxNow.state === "closed") return
      const now = ctxNow.currentTime
      if (now < recordStart) {
        const remaining = recordStart - now
        const nextCount = Math.max(1, Math.ceil(remaining / COUNT_IN_INTERVAL))
        setCount(nextCount)
      } else {
        if (!hasStartedRecording) {
          hasStartedRecording = true
          setSingState("recording")
          detector.start(recordStart)
        }
        const elapsed = now - recordStart
        const nextProgress = Math.min(elapsed / DURATION, 1)
        setProgress(nextProgress)
        if (now >= recordEnd) {
          const finalSamples = samplesRef.current
          const expectedFrames = Math.max(
            1,
            Math.floor(DURATION * APPROX_FRAMES_PER_SECOND),
          )
          const clarityRatio = finalSamples.length / expectedFrames
          cleanup()
          if (clarityRatio < MIN_CLARITY_FRAME_RATIO) {
            setSingState("ready")
            setError("unclear")
          } else {
            onCompleteRef.current(finalSamples)
          }
          return
        }
      }
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
  }

  const activeIndex = useMemo(() => {
    if (singState !== "recording") return -1
    const time = progress * DURATION
    return line.syllables.findIndex(
      (syllable) => time >= syllable.start && time <= syllable.end,
    )
  }, [line, progress, singState])

  const errorTitle: Record<Exclude<ErrorKind, null>, string> = {
    blocked: "Mic access needed",
    "no-device": "No microphone found",
    unclear: "No clear voice",
    generic: "Something went wrong",
  }
  const errorBody: Record<Exclude<ErrorKind, null>, string> = {
    blocked:
      "Microphone access is off. Allow it in your browser settings, then try again.",
    "no-device": "We couldn't find a microphone. Connect one and try again.",
    unclear: "We couldn't hear a clear pitch. Try again somewhere quieter.",
    generic: "The microphone couldn't start. Please try again.",
  }
  const errorAction: Record<Exclude<ErrorKind, null>, string> = {
    blocked: "Retry",
    "no-device": "Retry",
    unclear: "Redo",
    generic: "Retry",
  }

  const headerLabel =
    singState === "recording"
      ? "SING NOW"
      : singState === "starting"
        ? "GETTING READY"
        : "YOUR LINE"
  const headerTitle =
    singState === "recording"
      ? "Stay with the guide"
      : singState === "starting"
        ? "Starting microphone…"
        : "Listen, then sing"
  const recordHint =
    singState === "ready"
      ? "Tap when you’re ready"
      : singState === "starting"
        ? "Allow microphone access"
        : singState === "counting"
          ? "Get ready"
          : "Keep going"
  const statusVisible = singState === "recording" || singState === "starting"

  return (
    <main className="screen sing-screen">
      <CornerDots />
      <ScreenHeader line={line} onHome={onHome} />

      <section className="sing-content">
        <div className="instruction-row">
          <div className="instruction">
            <span>{headerLabel}</span>
            <h1>{headerTitle}</h1>
          </div>
          <button
            className={`hear-button ${referencePlaying ? "playing" : ""}`}
            onClick={() => setReferencePlaying((playing) => !playing)}
            aria-label={
              referencePlaying ? "Pause reference line" : "Hear reference line"
            }
          >
            <SpeakerIcon />
            <span>{referencePlaying ? "Playing" : "Hear it"}</span>
          </button>
        </div>

        <LyricSyllables line={line} activeIndex={activeIndex} />

        <PitchLane
          line={line}
          progress={progress}
          showVoice={singState === "recording"}
          samples={liveSamples}
        />

        <div className={`listen-status ${statusVisible ? "visible" : ""}`}>
          <span className="listening-dot" />
          <MicIcon />
          {singState === "starting" ? "Starting microphone…" : "Listening…"}
        </div>

        {error && (
          <div className="inline-error" role="alert">
            <strong>{errorTitle[error]}</strong>
            <p>{errorBody[error]}</p>
            <button onClick={startRecording} disabled={singState !== "ready"}>
              {errorAction[error]}
            </button>
          </div>
        )}
      </section>

      <div className="record-area">
        <p>{recordHint}</p>
        <button
          className={`record-button ${
            singState === "recording" ? "active" : ""
          }`}
          onClick={startRecording}
          disabled={singState !== "ready"}
          aria-label="Start recording"
        >
          <RecordDotRing />
          <span>
            <MicIcon />
          </span>
        </button>
      </div>

      {import.meta.env.DEV && (
        <details className="state-preview">
          <summary>Preview states</summary>
          <div>
            <button
              onClick={() => {
                setError(null)
                setSingState("ready")
              }}
            >
              Default
            </button>
            <button
              onClick={() => {
                setSingState("ready")
                setError("blocked")
              }}
            >
              Mic blocked
            </button>
            <button
              onClick={() => {
                setSingState("ready")
                setError("no-device")
              }}
            >
              No device
            </button>
            <button
              onClick={() => {
                setSingState("ready")
                setError("unclear")
              }}
            >
              No clear voice
            </button>
            <button
              onClick={() => {
                setSingState("ready")
                setError("generic")
              }}
            >
              Generic error
            </button>
            <button
              onClick={() => {
                setError(null)
                setSingState("starting")
              }}
            >
              Starting state
            </button>
          </div>
        </details>
      )}

      {singState === "counting" && (
        <div className="count-overlay" aria-live="assertive">
          <span key={count}>{count}</span>
          <small>Get ready</small>
        </div>
      )}
    </main>
  )
}

function ResultScreen({
  line,
  samples,
  onHome,
  onRetry,
  onNext,
}: {
  line: PracticeLine
  samples: PitchSample[]
  onHome: () => void
  onRetry: () => void
  onNext: () => void
}) {
  const [tipPlaying, setTipPlaying] = useState(false)

  return (
    <main className="screen result-screen">
      <CornerDots />
      <ScreenHeader line={line} onHome={onHome} />

      <section className="result-content">
        <div className="score">
          <HalftoneSparkle
            className="score-star"
            color="#FF4FA3"
            accent="#19B5FF"
          />
          <p>Nice work</p>
          <div>
            <strong>62</strong>
            <span>match</span>
          </div>
        </div>

        <LyricSyllables line={line} result />
        <PitchLane
          line={line}
          progress={1}
          showVoice
          result
          samples={samples}
        />

        <div className="legend">
          <span>
            <i className="target-key" /> Target
          </span>
          <span>
            <i className="voice-key" /> Your voice
          </span>
        </div>

        <article className={`coach-card ${tipPlaying ? "playing" : ""}`}>
          <div className="coach-heading">
            <div>
              <span>COACH TIP</span>
              <h2>Keep the note lifted</h2>
            </div>
            <button
              onClick={() => setTipPlaying((playing) => !playing)}
              aria-label={tipPlaying ? "Pause coach tip" : "Play coach tip"}
            >
              <SpeakerIcon />
            </button>
          </div>
          <p>
            You came in late on the second syllable and let the third one drop.
            Hold it high for the whole bar.
          </p>
          {tipPlaying && (
            <div className="audio-waves" aria-label="Playing tip">
              {[9, 18, 12, 22, 15, 8, 18, 11, 20, 9, 15, 7].map(
                (height, index) => (
                  <i key={index} style={{ height }} />
                ),
              )}
            </div>
          )}
        </article>
      </section>

      <div className="result-actions">
        <button className="secondary-button" onClick={onRetry}>
          Try again
        </button>
        <button className="primary-button" onClick={onNext}>
          Next line <span>→</span>
        </button>
      </div>
    </main>
  )
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("home")
  const [selectedLine, setSelectedLine] = useState(practiceLines[0])
  const [recordedSamples, setRecordedSamples] = useState<PitchSample[]>([])

  const pickLine = (line: PracticeLine) => {
    setSelectedLine(line)
    setRecordedSamples([])
    setScreen("sing")
  }

  const nextLine = () => {
    const nextIndex = selectedLine.id % practiceLines.length
    setSelectedLine(practiceLines[nextIndex])
    setRecordedSamples([])
    setScreen("sing")
  }

  const handleRecorded = (samples: PitchSample[]) => {
    setRecordedSamples(samples)
    setScreen("result")
  }

  return (
    <div className="app-shell">
      <div className="site-frame">
        {screen === "home" && <HomeScreen onStart={() => setScreen("pick")} />}
        {screen === "pick" && (
          <PickScreen onPick={pickLine} onHome={() => setScreen("home")} />
        )}
        {screen === "sing" && (
          <SingScreen
            key={`sing-${selectedLine.id}`}
            line={selectedLine}
            onHome={() => setScreen("home")}
            onComplete={handleRecorded}
          />
        )}
        {screen === "result" && (
          <ResultScreen
            line={selectedLine}
            samples={recordedSamples}
            onHome={() => setScreen("home")}
            onRetry={() => {
              setRecordedSamples([])
              setScreen("sing")
            }}
            onNext={nextLine}
          />
        )}
      </div>
    </div>
  )
}
