import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
} from "react"

import { songs } from "@/data/songs"
import {
  PLAYER_COLORS,
  TURN_SECONDS,
  createMatchState,
  displayName,
  fallbackCommentary,
  isMatchOver,
  lineForRound,
  loadStoredNames,
  matchReducer,
  type GameMode,
  type MatchState,
  type PlayerIndex,
} from "@/domain/match"
import { PLAYER_IDS, buildRoundResultPayload } from "@/domain/announcer"
import { syllableDisplayTexts } from "@/domain/lyrics"
import { isUnclearTake } from "@/domain/clarity"
import { scoreTurn, timeWeightedMedianPitch } from "@/domain/scoring"
import type { Language, PitchSample, PracticeLine } from "@/domain/types"
import SetupScreen from "@/screens/SetupScreen"
import HandoverScreen from "@/screens/HandoverScreen"
import FinalScreen from "@/screens/FinalScreen"
import { LANGUAGE_NAMES } from "@/screens/SongTag"
import WordsComingSoon from "@/screens/WordsComingSoon"
import {
  createAudioContext,
  sessionFromMic,
  unlockAudio,
  type AudioSession,
} from "@/services/audioSession"
import {
  fetchAnnouncement,
  isFallbackForced,
  setFallbackForced,
} from "@/services/announcer"
import { MicrophoneError, requestMicrophone } from "@/services/microphone"
import { createPitchDetector } from "@/services/pitch"

type SingState = "ready" | "starting" | "counting" | "recording"
type ErrorKind = "blocked" | "no-device" | "unclear" | "interrupted" | "generic" | null

const DURATION = TURN_SECONDS
const COUNT_IN_BEATS = 3
const COUNT_IN_INTERVAL = 0.7
const COUNT_IN_SECONDS = COUNT_IN_BEATS * COUNT_IN_INTERVAL
// Shared lane scale: 50% is the line's reference pitch, every semitone away
// from it moves this many percent of lane height.
const LANE_PERCENT_PER_SEMITONE = 6
const LANE_MIN_PERCENT = 0
const LANE_MAX_PERCENT = 100

function laneBottomPercent(semitones: number): number {
  const raw = 50 + semitones * LANE_PERCENT_PER_SEMITONE
  return Math.max(LANE_MIN_PERCENT, Math.min(LANE_MAX_PERCENT, raw))
}

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

function LogoMic() {
  return (
    <svg className="logo-mic" viewBox="0 0 38 100" aria-hidden="true">
      <rect x="11" y="37" width="24" height="62" rx="12" fill="#19B5FF" />
      <rect x="7" y="35" width="24" height="62" rx="12" fill="#FF4FA3" />
      <rect x="11.5" y="43" width="4" height="22" rx="2" fill="#FFB3D6" />
      <rect x="19" y="52" width="7" height="12" rx="2.5" fill="#1A0F22" />
      <rect x="4" y="4" width="34" height="32" rx="16" fill="#19B5FF" />
      <rect x="1" y="1" width="34" height="32" rx="16" fill="#FFF8FF" />
      <rect x="8" y="9.5" width="20" height="4" rx="2" fill="#1A0F22" />
      <rect x="8" y="16" width="20" height="4" rx="2" fill="#1A0F22" />
      <rect x="8" y="22.5" width="20" height="4" rx="2" fill="#1A0F22" />
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
  language,
  activeIndex = -1,
  result = false,
  missed = [],
}: {
  line: PracticeLine
  language: Language
  activeIndex?: number
  result?: boolean
  missed?: number[]
}) {
  const texts = syllableDisplayTexts(line)
  return (
    <div
      className="lyric-grid"
      lang={language}
      // Arabic reads right to left here; the pitch lane stays left to right
      // as a timeline. Agreed with the team, not an oversight.
      dir={language === "ar" ? "rtl" : "ltr"}
      style={{ "--syllable-count": line.syllables.length } as CSSProperties}
    >
      {line.syllables.map((syllable, index) => {
        const isMissed = missed.includes(index)
        return (
          <div
            className={[
              "syllable",
              activeIndex === index ? "active" : "",
              result ? (isMissed ? "missed" : "matched") : "",
            ].join(" ")}
            key={`${line.id}-${index}`}
          >
            <span className="hangul">{texts[index]}</span>
            {syllable.romanization && (
              <span className="roman">{syllable.romanization}</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// Maps a semitone offset (bar) or a sample's pitch-relative-to-the-singer's-
// median (voice) to the SVG y coordinate used by `.voice-line`.
function laneYFromSemitones(semitones: number): number {
  const percent = Math.max(
    LANE_MIN_PERCENT,
    Math.min(LANE_MAX_PERCENT, 50 + semitones * LANE_PERCENT_PER_SEMITONE),
  )
  return 116 - percent
}

function samplesPath(
  samples: PitchSample[],
  durationMs: number,
  singerMedian: number,
): string {
  if (samples.length === 0) return ""
  const points: string[] = []
  for (const sample of samples) {
    const t = Math.max(0, Math.min(1, sample.timeMs / durationMs))
    const semitones = sample.pitch - singerMedian
    const x = 8 + t * 304
    const y = laneYFromSemitones(semitones)
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
  missed = [],
}: {
  line: PracticeLine
  progress?: number
  showVoice?: boolean
  result?: boolean
  samples?: PitchSample[]
  durationMs?: number
  missed?: number[]
}) {
  const clipWidth = Math.max(0, Math.min(1, progress)) * 320
  const singerMedian =
    samples && samples.length > 0 ? timeWeightedMedianPitch(samples) : null
  const voicePoints =
    samples && singerMedian !== null
      ? samplesPath(samples, durationMs, singerMedian)
      : ""

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
          <div key={`${line.id}-${index}-pitch`}>
            <div
              className={`target-bar ${
                result && missed.includes(index) ? "missed" : ""
              }`}
              style={{
                left: `${left}%`,
                width: `${width}%`,
                bottom: `${laneBottomPercent(syllable.semitones)}%`,
              }}
            />
            <span
              className="bar-label"
              style={{
                left: `${left}%`,
                width: `${width}%`,
              }}
            >
              {syllable.romanization ?? syllable.text}
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
        <span>0:{String(DURATION).padStart(2, "0")}</span>
      </div>
    </div>
  )
}

function ScreenHeader({
  round,
  playerLabel,
  playerColor,
  onHome,
}: {
  round: 1 | 2 | 3
  playerLabel?: string
  playerColor?: string
  onHome: () => void
}) {
  return (
    <header className="screen-header">
      <Brand onHome={onHome} />
      <div className="line-progress">
        <span>
          Round {round} <i>of</i> 3
          {playerLabel ? (
            <>
              {" "}
              ·{" "}
              <b style={{ color: playerColor, fontWeight: 800 }}>
                {playerLabel}
              </b>
            </>
          ) : null}
        </span>
        <div className="progress-dots" aria-label={`Round ${round} of 3`}>
          {[1, 2, 3].map((item) => (
            <i className={item === round ? "active" : ""} key={item} />
          ))}
        </div>
      </div>
    </header>
  )
}

type ModeOption = {
  mode: GameMode
  title: string
  body: string
}

const MODE_OPTIONS: ModeOption[] = [
  {
    mode: "solo",
    title: "Solo",
    body: "Sing three lines on your own. Get a Tune score and the syllables to fix after each one.",
  },
  {
    mode: "battle",
    title: "Battle",
    body: "Two players, one device. Take turns singing each line. Best of three wins.",
  },
]

function ModeScreen({
  onChoose,
  onHome,
}: {
  onChoose: (mode: GameMode) => void
  onHome: () => void
}) {
  return (
    <main className="screen setup-screen">
      <CornerDots />
      <header className="screen-header">
        <Brand onHome={onHome} />
      </header>
      <section className="setup-content">
        <h1>How do you want to play?</h1>
        <div className="mode-options">
          {MODE_OPTIONS.map((option) => (
            <button
              className="mode-card"
              type="button"
              key={option.mode}
              onClick={() => onChoose(option.mode)}
            >
              <strong>{option.title}</strong>
              <span>{option.body}</span>
            </button>
          ))}
        </div>
      </section>
    </main>
  )
}

function SongScreen({
  onChoose,
  onHome,
}: {
  onChoose: (songId: string) => void
  onHome: () => void
}) {
  return (
    <main className="screen setup-screen">
      <CornerDots />
      <header className="screen-header">
        <Brand onHome={onHome} />
      </header>
      <section className="setup-content">
        <h1>Pick a language to sing in</h1>
        <div className="mode-options">
          {songs.map((song) => (
            <button
              className="mode-card"
              type="button"
              key={song.id}
              onClick={() => onChoose(song.id)}
            >
              <strong>{LANGUAGE_NAMES[song.language]}</strong>
              <span
                className="song-title"
                lang={song.language}
                dir={song.language === "ar" ? "rtl" : "ltr"}
              >
                {song.lines[0].text}
              </span>
              {song.lines[0].romanization && (
                <span>{song.lines[0].romanization}</span>
              )}
            </button>
          ))}
        </div>
      </section>
    </main>
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
          <i aria-hidden="true">
            <LogoMic />
          </i>
          <span aria-hidden="true">ca</span>
        </h1>
        <p>Learn a language by singing it.</p>
        <p className="home-subline">Sing it. Say it right. Win the round.</p>
        <button onClick={onStart}>Start singing</button>
      </section>
    </main>
  )
}

function SingScreen({
  line,
  audioUrl,
  language,
  round,
  playerLabel,
  playerColor,
  getSession,
  onHome,
  onScored,
}: {
  line: PracticeLine
  audioUrl: string
  language: Language
  round: 1 | 2 | 3
  playerLabel: string
  playerColor: string
  getSession: () => Promise<AudioSession>
  onHome: () => void
  onScored: (samples: PitchSample[]) => void
}) {
  const [singState, setSingState] = useState<SingState>("ready")
  const [count, setCount] = useState(COUNT_IN_BEATS)
  const [progress, setProgress] = useState(0)
  const [liveSamples, setLiveSamples] = useState<PitchSample[]>([])
  const [error, setError] = useState<ErrorKind>(null)
  const [referencePlaying, setReferencePlaying] = useState(false)
  const [clipFailed, setClipFailed] = useState(false)

  const referenceRef = useRef<HTMLAudioElement | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const detectorRef = useRef<ReturnType<typeof createPitchDetector> | null>(
    null,
  )
  const samplesRef = useRef<PitchSample[]>([])
  const rafRef = useRef(0)
  const singStateRef = useRef<SingState>("ready")
  singStateRef.current = singState
  const onScoredRef = useRef(onScored)
  onScoredRef.current = onScored

  // Stops this take only; the match keeps the mic stream open.
  const cleanup = () => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = 0
    detectorRef.current?.stop()
    detectorRef.current = null
    audioCtxRef.current = null
  }

  useEffect(() => cleanup, [])

  const clipStart = line.audioStart ?? 0
  const clipEnd = line.audioEnd

  const stopReference = () => {
    const audio = referenceRef.current
    if (audio) {
      audio.pause()
      audio.currentTime = clipStart
    }
    setReferencePlaying(false)
  }

  const toggleReference = () => {
    const audio = referenceRef.current
    if (!audio || clipFailed) return
    if (referencePlaying) {
      stopReference()
      return
    }
    audio.currentTime = clipStart
    setReferencePlaying(true)
    audio.play().catch((err: unknown) => {
      setReferencePlaying(false)
      if (err instanceof DOMException && err.name === "NotSupportedError") {
        setClipFailed(true)
      }
    })
  }

  // timeupdate fires only ~4 times a second, which would bleed into the next
  // line of the clip, so watch the end of the range every frame instead.
  useEffect(() => {
    if (!referencePlaying || clipEnd === undefined) return
    let frame = 0
    const watch = () => {
      const audio = referenceRef.current
      if (audio && audio.currentTime >= clipEnd) {
        stopReference()
        return
      }
      frame = requestAnimationFrame(watch)
    }
    frame = requestAnimationFrame(watch)
    return () => cancelAnimationFrame(frame)
  }, [referencePlaying, clipEnd])

  useEffect(() => () => referenceRef.current?.pause(), [])

  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState !== "hidden") return
      const state = singStateRef.current
      if (state !== "counting" && state !== "recording") return
      cleanup()
      setProgress(0)
      setLiveSamples([])
      setSingState("ready")
      setError("interrupted")
    }
    document.addEventListener("visibilitychange", onHidden)
    return () => document.removeEventListener("visibilitychange", onHidden)
  }, [])

  const startRecording = async () => {
    if (singState !== "ready") return
    stopReference()
    setError(null)
    setProgress(0)
    setLiveSamples([])
    samplesRef.current = []
    setSingState("starting")

    let session: AudioSession
    try {
      session = await getSession()
    } catch (err) {
      setSingState("ready")
      if (err instanceof MicrophoneError) {
        setError(err.kind)
      } else {
        setError("generic")
      }
      return
    }
    const ctx = session.ctx
    audioCtxRef.current = ctx

    const detector = createPitchDetector({
      ctx,
      stream: session.stream,
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
          const unclear = isUnclearTake(
            finalSamples.length,
            detector.framesAnalyzed(),
          )
          cleanup()
          if (unclear) {
            setSingState("ready")
            setProgress(0)
            setLiveSamples([])
            setError("unclear")
          } else {
            onScoredRef.current(finalSamples)
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
    interrupted: "Take cancelled",
    generic: "Something went wrong",
  }
  const errorBody: Record<Exclude<ErrorKind, null>, string> = {
    blocked:
      "Microphone access is off. Allow it in your browser settings, then try again.",
    "no-device": "We couldn't find a microphone. Connect one and try again.",
    unclear:
      "We couldn't hear a clear pitch, so this take doesn't count. Try again somewhere quieter.",
    interrupted: "The screen left the app mid-take. Sing it again.",
    generic: "The microphone couldn't start. Please try again.",
  }
  const errorAction: Record<Exclude<ErrorKind, null>, string> = {
    blocked: "Retry",
    "no-device": "Retry",
    unclear: "Redo",
    interrupted: "Redo",
    generic: "Retry",
  }

  const headerLabel =
    singState === "recording"
      ? "SING NOW"
      : singState === "starting"
        ? "GETTING READY"
        : `${playerLabel.toUpperCase()}'S TURN`
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
      <ScreenHeader
        round={round}
        playerLabel={playerLabel}
        playerColor={playerColor}
        onHome={onHome}
      />

      <section className="sing-content">
        <div className="instruction-row">
          <div className="instruction">
            <span>{headerLabel}</span>
            <h1>{headerTitle}</h1>
          </div>
          <button
            className={`hear-button ${referencePlaying ? "playing" : ""}`}
            onClick={toggleReference}
            disabled={clipFailed || singState !== "ready"}
            title={clipFailed ? "This line's audio isn't available" : undefined}
            aria-label={
              clipFailed
                ? "Reference line unavailable"
                : referencePlaying
                  ? "Stop reference line"
                  : "Hear reference line"
            }
          >
            <SpeakerIcon />
            <span>{referencePlaying ? "Playing" : "Hear it"}</span>
          </button>
          <audio
            ref={referenceRef}
            src={audioUrl}
            preload="auto"
            onEnded={stopReference}
            onError={() => {
              setClipFailed(true)
              setReferencePlaying(false)
            }}
          />
        </div>

        <LyricSyllables
          line={line}
          language={language}
          activeIndex={activeIndex}
        />

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

function joinWithAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join("")
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`
}

type CoachCopy = {
  heading: string
  body: string
}

function buildCoachCopy(line: PracticeLine, missed: number[]): CoachCopy {
  if (missed.length === 0) {
    return { heading: "Nice and steady", body: "Clean take." }
  }
  const parts = missed.map((i) => {
    const s = line.syllables[i]
    return s.romanization ? `${s.text} (${s.romanization})` : s.text
  })
  return {
    heading: "A couple to clean up",
    body: `Try again on ${joinWithAnd(parts)}.`,
  }
}

type AnnouncerStatus = "loading" | "live" | "fallback" | "rejected"

// Asks the backend for commentary once per round result. Scores never wait on
// it: the built-in line shows until a live reply arrives, and stays on failure.
function useAnnouncement(state: MatchState, shareOnLeaderboard: boolean) {
  // POST /round-result only accepts two players, so solo keeps the built-in line.
  const enabled = state.mode === "battle"
  const [status, setStatus] = useState<AnnouncerStatus>(
    enabled ? "loading" : "fallback",
  )
  const [commentary, setCommentary] = useState<string | null>(null)
  const [coaching, setCoaching] = useState<Record<string, string>>({})
  const [rejectedReasons, setRejectedReasons] = useState<string[]>([])
  const [needsTap, setNeedsTap] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const payloadRef = useRef(
    enabled
      ? buildRoundResultPayload(state, {
          optInToLeaderboard: shareOnLeaderboard,
        })
      : null,
  )

  useEffect(() => {
    const payload = payloadRef.current
    if (!payload) return
    const controller = new AbortController()
    // Deferred so StrictMode's throwaway mount never sends a paid request.
    const start = setTimeout(() => {
      void fetchAnnouncement(payload, controller.signal).then((result) => {
        if (controller.signal.aborted) return
        if (result.kind === "rejected") {
          setRejectedReasons(result.reasons)
          setStatus("rejected")
          return
        }
        if (result.kind === "fallback") {
          setStatus("fallback")
          return
        }
        setCommentary(result.commentary)
        setCoaching(result.coaching)
        setStatus("live")
        const audio = new Audio(result.audioUrl)
        audioRef.current = audio
        audio.play().catch(() => setNeedsTap(true))
      })
    }, 0)
    return () => {
      clearTimeout(start)
      controller.abort()
      audioRef.current?.pause()
      audioRef.current = null
    }
  }, [])

  const playAudio = () => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = 0
    void audio
      .play()
      .then(() => setNeedsTap(false))
      .catch(() => setNeedsTap(true))
  }

  return { status, commentary, coaching, rejectedReasons, needsTap, playAudio }
}

function RoundResultScreen({
  state,
  shareOnLeaderboard,
  onHome,
  onContinue,
}: {
  state: MatchState
  shareOnLeaderboard: boolean
  onHome: () => void
  onContinue: () => void
}) {
  const line = lineForRound(state)
  const winner = state.roundWinner
  const matchOver = isMatchOver(state)
  const announcer = useAnnouncement(state, shareOnLeaderboard)
  const [forceFallback, setForceFallback] = useState(isFallbackForced)
  const solo = state.mode === "solo"
  const players: PlayerIndex[] = solo ? [0] : [0, 1]
  const finishLabel = solo ? "See your total" : "See the winner"

  return (
    <main className="screen result-screen">
      <CornerDots />
      <ScreenHeader round={state.round} onHome={onHome} />

      <section className="result-content">
        <div className={`dual-scores ${solo ? "single" : ""}`}>
          {players.map((player) => {
            const coach = buildCoachCopy(line, state.turnMissed[player])
            return (
              <div
                className={`player-score-card ${
                  winner === player ? "winner" : ""
                }`}
                key={player}
                style={{ "--player": PLAYER_COLORS[player] } as CSSProperties}
              >
                {winner === player && (
                  <span className="winner-badge">✦ Round winner</span>
                )}
                <span
                  className="player-chip"
                  style={{ color: PLAYER_COLORS[player] }}
                >
                  <i
                    className="player-swatch"
                    style={{ background: PLAYER_COLORS[player] }}
                  />
                  {displayName(state, player)}
                </span>
                <div className="score-slots">
                  <div className="score-slot">
                    <small>Tune</small>
                    <strong>{state.turnScores[player] ?? 0}</strong>
                  </div>
                  <WordsComingSoon />
                </div>
                <p>{coach.body}</p>
                {announcer.coaching[PLAYER_IDS[player]] && (
                  <p className="coach-tip">
                    <small>Coach</small>
                    {announcer.coaching[PLAYER_IDS[player]]}
                  </p>
                )}
              </div>
            )
          })}
        </div>

        <div
          className="announcer"
          aria-live="polite"
          style={
            {
              "--player": PLAYER_COLORS[winner ?? 0],
            } as CSSProperties
          }
        >
          <span className="announcer-label">
            <i className="announcer-bars" aria-hidden="true">
              <b />
              <b />
              <b />
              <b />
            </i>
            Announcer
          </span>
          <p className="commentary-line">
            {announcer.commentary ?? fallbackCommentary(state)}
          </p>
          {announcer.status === "loading" && (
            <p className="announcer-status">Announcer is on the mic…</p>
          )}
          {announcer.status === "rejected" && (
            <div className="announcer-error" role="alert">
              <strong>
                Announcer skipped: the backend rejected this round (422)
              </strong>
              {announcer.rejectedReasons.length > 0 && (
                <ul>
                  {announcer.rejectedReasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {announcer.needsTap && (
            <button
              className="announcer-play"
              type="button"
              onClick={announcer.playAudio}
            >
              <SpeakerIcon /> Play announcer
            </button>
          )}
        </div>

        {players.map((player) => (
          <div key={player}>
            {!solo && (
              <p
                className="player-chip"
                style={{ color: PLAYER_COLORS[player] }}
              >
                {displayName(state, player)}
              </p>
            )}
            <LyricSyllables
              line={line}
              language={state.song.language}
              result
              missed={state.turnMissed[player]}
            />
            <PitchLane
              line={line}
              progress={1}
              showVoice
              result
              samples={state.turnSamples[player]}
              missed={state.turnMissed[player]}
            />
          </div>
        ))}

        {!solo && (
          <div className="scoreboard-row">
            <span style={{ color: PLAYER_COLORS[0] }}>
              {displayName(state, 0)}
            </span>
            <span>
              {state.roundWins[0]} – {state.roundWins[1]}
            </span>
            <span style={{ color: PLAYER_COLORS[1] }}>
              {displayName(state, 1)}
            </span>
          </div>
        )}
      </section>

      <div className="result-actions">
        <button className="primary-button" onClick={onContinue}>
          {matchOver ? finishLabel : `Round ${state.round + 1}`} <span>→</span>
        </button>
      </div>

      {import.meta.env.DEV && (
        <details className="state-preview">
          <summary>Announcer (dev)</summary>
          <div>
            <label>
              <input
                type="checkbox"
                checked={forceFallback}
                onChange={(event) => {
                  setFallbackForced(event.target.checked)
                  setForceFallback(event.target.checked)
                }}
              />{" "}
              Force fallback from next round
            </label>
            <span>Status: {announcer.status}</span>
          </div>
        </details>
      )}
    </main>
  )
}

export default function App() {
  const [state, dispatch] = useReducer(matchReducer, undefined, () =>
    createMatchState(loadStoredNames()),
  )
  const sessionRef = useRef<AudioSession | null>(null)
  const [leavePromptOpen, setLeavePromptOpen] = useState(false)
  // Leaderboard opt-in. Not in match reducer: it only affects what we send to
  // the backend, not match flow, so it stays in App state and resets on reload.
  const [shareOnLeaderboard, setShareOnLeaderboard] = useState(false)
  const shareOnLeaderboardRef = useRef(shareOnLeaderboard)
  shareOnLeaderboardRef.current = shareOnLeaderboard

  const inMatch =
    state.phase === "turnReady" ||
    state.phase === "handover" ||
    state.phase === "roundResult"

  useEffect(() => {
    if (!inMatch) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [inMatch])

  useEffect(() => () => sessionRef.current?.close(), [])

  const closeSession = () => {
    sessionRef.current?.close()
    sessionRef.current = null
  }

  const goHome = () => {
    if (inMatch) {
      setLeavePromptOpen(true)
      return
    }
    closeSession()
    dispatch({ type: "GO_HOME" })
  }

  const confirmLeave = () => {
    setLeavePromptOpen(false)
    closeSession()
    dispatch({ type: "GO_HOME" })
  }

  const cancelLeave = () => setLeavePromptOpen(false)

  // Reuse the match's stream; only re-ask if the mic was unplugged or closed.
  const getSession = async (): Promise<AudioSession> => {
    const existing = sessionRef.current
    const track = existing?.stream.getAudioTracks()[0]
    if (
      existing &&
      existing.ctx.state !== "closed" &&
      track?.readyState === "live"
    ) {
      unlockAudio(existing.ctx)
      return existing
    }
    const ctx =
      existing && existing.ctx.state !== "closed"
        ? existing.ctx
        : createAudioContext()
    if (!ctx) throw new MicrophoneError("generic", "No AudioContext")
    unlockAudio(ctx)
    const handle = await requestMicrophone()
    existing?.stop()
    const session = sessionFromMic(ctx, handle)
    sessionRef.current = session
    return session
  }

  const line = lineForRound(state)
  const player = state.currentPlayer

  return (
    <div className="app-shell">
      <div className="site-frame">
        {state.phase === "home" && (
          <HomeScreen onStart={() => dispatch({ type: "GO_MODE" })} />
        )}
        {state.phase === "mode" && (
          <ModeScreen
            onChoose={(mode) => dispatch({ type: "CHOOSE_MODE", mode })}
            onHome={goHome}
          />
        )}
        {state.phase === "song" && (
          <SongScreen
            onChoose={(songId) => dispatch({ type: "SELECT_SONG", songId })}
            onHome={goHome}
          />
        )}
        {state.phase === "setup" && (
          <SetupScreen
            mode={state.mode}
            onChangeMode={() => dispatch({ type: "GO_MODE" })}
            names={state.names}
            onNameChange={(index, name) =>
              dispatch({ type: "SET_NAME", player: index, name })
            }
            onMicReady={(session) => {
              if (sessionRef.current && sessionRef.current !== session) {
                sessionRef.current.stop()
              }
              sessionRef.current = session
            }}
            shareOnLeaderboard={shareOnLeaderboard}
            onShareToggle={setShareOnLeaderboard}
            onStart={() => dispatch({ type: "START_MATCH" })}
          />
        )}
        {state.phase === "turnReady" && (
          <SingScreen
            key={`${state.round}-${player}-${state.replays}`}
            line={line}
            audioUrl={state.song.audioUrl}
            language={state.song.language}
            round={state.round}
            playerLabel={displayName(state, player)}
            playerColor={PLAYER_COLORS[player]}
            getSession={getSession}
            onHome={goHome}
            onScored={(samples) => {
              const result = scoreTurn(line, samples)
              const timing =
                result.syllables.reduce((sum, s) => sum + s.timing, 0) /
                Math.max(1, result.syllables.length)
              dispatch({
                type: "TURN_SCORED",
                score: result.score,
                timing,
                missed: result.missed,
                samples,
              })
            }}
          />
        )}
        {state.phase === "handover" && (
          <HandoverScreen
            state={state}
            onContinue={() => dispatch({ type: "HANDOVER_DONE" })}
          />
        )}
        {state.phase === "roundResult" && (
          <RoundResultScreen
            state={state}
            shareOnLeaderboard={shareOnLeaderboard}
            onHome={goHome}
            onContinue={() => dispatch({ type: "ROUND_CONTINUE" })}
          />
        )}
        {state.phase === "final" && (
          <FinalScreen
            state={state}
            onRematch={() => dispatch({ type: "REMATCH" })}
            onHome={() => {
              closeSession()
              dispatch({ type: "GO_HOME" })
            }}
          />
        )}
        {leavePromptOpen && (
          <LeavePrompt
            mode={state.mode}
            onCancel={cancelLeave}
            onConfirm={confirmLeave}
          />
        )}
      </div>
    </div>
  )
}

function LeavePrompt({
  mode,
  onCancel,
  onConfirm,
}: {
  mode: GameMode
  onCancel: () => void
  onConfirm: () => void
}) {
  const session = mode === "solo" ? "session" : "battle"
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onCancel])
  return (
    <div
      className="leave-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="leave-title"
      onClick={onCancel}
    >
      <div className="leave-dialog" onClick={(e) => e.stopPropagation()}>
        <h2 id="leave-title">Leave this {session}?</h2>
        <p>Your scores for this round will be lost.</p>
        <div className="leave-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={onCancel}
            autoFocus
          >
            Stay
          </button>
          <button className="primary-button" type="button" onClick={onConfirm}>
            Leave
          </button>
        </div>
      </div>
    </div>
  )
}
