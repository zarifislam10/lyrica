import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
} from "react"

import { SECONDS_PER_BEAT, songs } from "@/data/songs"
import {
  PLAYER_COLORS,
  ROUNDS_PER_MATCH,
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
import {
  bouncingBall,
  syllableDisplayTexts,
  syllableFill,
  type BallPosition,
} from "@/domain/lyrics"
import { isUnclearTake } from "@/domain/clarity"
import { scoreTurn, timeWeightedMedianPitch } from "@/domain/scoring"
import type { Language, PitchSample, PracticeLine, Song } from "@/domain/types"
import SetupScreen from "@/screens/SetupScreen"
import HandoverScreen from "@/screens/HandoverScreen"
import FinalScreen from "@/screens/FinalScreen"
import { LANGUAGE_NAMES } from "@/screens/SongTag"
import WordsCard from "@/components/WordsCard"
import MyTakePlayback from "@/components/MyTakePlayback"
import SyllableBreakdown from "@/components/SyllableBreakdown"
import VoiceClonePanel from "@/components/VoiceClonePanel"
import { deleteVoice } from "@/services/voiceClone"
import {
  createAudioContext,
  sessionFromMic,
  unlockAudio,
  type AudioSession,
} from "@/services/audioSession"
import { startWordsCapture, type WordsCapture } from "@/services/words"
import {
  fetchAnnouncement,
  isFallbackForced,
  setFallbackForced,
} from "@/services/announcer"
import { MicrophoneError, requestMicrophone } from "@/services/microphone"
import {
  playBeatTrack,
  playCountIn,
  playSingAlongTrack,
  playLine as playMelodyLine,
  stopAll as stopAllMelody,
} from "@/services/melody"
import { createPitchDetector } from "@/services/pitch"

type SingState = "ready" | "starting" | "counting" | "recording"
type ErrorKind = "blocked" | "no-device" | "unclear" | "interrupted" | "generic" | null

const DURATION = TURN_SECONDS
const COUNT_IN_BEATS = 3
// Same tempo as the melody, so the count-in sets the beat the line is sung on.
const COUNT_IN_INTERVAL = SECONDS_PER_BEAT
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
  fill,
  litColor,
  ball,
}: {
  line: PracticeLine
  language: Language
  activeIndex?: number
  result?: boolean
  missed?: number[]
  fill?: number[]
  litColor?: string
  ball?: BallPosition
}) {
  const texts = syllableDisplayTexts(line)
  return (
    <div
      className={[
        "lyric-grid",
        fill ? "singing" : "",
        ball ? "with-ball" : "",
      ].join(" ")}
      lang={language}
      // Arabic reads right to left here; the pitch lane stays left to right
      // as a timeline. Agreed with the team, not an oversight.
      dir={language === "ar" ? "rtl" : "ltr"}
      style={
        {
          "--syllable-count": line.syllables.length,
          "--lit": litColor,
        } as CSSProperties
      }
    >
      {line.syllables.map((syllable, index) => {
        const isMissed = missed.includes(index)
        const sung = fill?.[index] ?? 0
        return (
          <div
            className={[
              "syllable",
              activeIndex === index ? "active" : "",
              fill && sung >= 1 ? "sung" : "",
              result ? (isMissed ? "missed" : "matched") : "",
            ].join(" ")}
            style={
              fill ? { "--fill": `${sung * 100}%` } as CSSProperties : undefined
            }
            key={`${line.id}-${index}`}
          >
            <span className="hangul">{texts[index]}</span>
            {syllable.romanization && (
              <span className="roman">{syllable.romanization}</span>
            )}
          </div>
        )
      })}
      {ball && (
        <span
          className="lyric-ball"
          aria-hidden="true"
          style={{ "--slot": ball.slot, "--lift": ball.lift } as CSSProperties}
        />
      )}
    </div>
  )
}

// Maps a semitone offset (bar) or a sample's pitch-relative-to-the-singer's-
// median (voice) to the SVG y coordinate used by `.voice-line`. Returned y is
// in the same 0..100 range as the target bars' CSS `bottom: X%`, so the voice
// line and the bars sit on the same scale.
function laneYFromSemitones(semitones: number): number {
  const percent = Math.max(
    LANE_MIN_PERCENT,
    Math.min(LANE_MAX_PERCENT, 50 + semitones * LANE_PERCENT_PER_SEMITONE),
  )
  return 100 - percent
}

// Duration-weighted median of a line's target semitones. Mirrors the
// `targetReference` the Tune scorer uses internally so the voice line and
// target bars share the same vertical anchor.
function targetMedianSemitones(line: PracticeLine): number {
  const entries = line.syllables
    .map((s) => ({ v: s.semitones, w: Math.max(0, s.end - s.start) }))
    .filter((e) => e.w > 0)
    .sort((a, b) => a.v - b.v)
  const total = entries.reduce((sum, e) => sum + e.w, 0)
  if (total === 0) return 0
  const half = total / 2
  let acc = 0
  for (const e of entries) {
    acc += e.w
    if (acc >= half) return e.v
  }
  return entries[entries.length - 1].v
}

// Discrete per-sample points for the glowing orb + trail. Returns points
// in the same 0..100 (x) / 0..100 (y) space as the target bars so the
// orb overlays correctly. Replaces the old polyline voice-line.
type VoicePoint = {
  x: number
  y: number
  tMs: number
}
function samplesPoints(
  samples: PitchSample[],
  singerMedian: number,
  targetMedian: number,
  durationSec: number,
): VoicePoint[] {
  const points: VoicePoint[] = []
  for (const sample of samples) {
    // Octave-fold toward the target melody's centre. UltraStar and
    // allkaraoke both score pitch octave-ignored, so a singer who hits
    // the right note in a different octave gets visual credit.
    let semitones = sample.pitch - singerMedian + targetMedian
    while (semitones - targetMedian > 6) semitones -= 12
    while (semitones - targetMedian < -6) semitones += 12
    const y = laneYFromSemitones(semitones)
    // Horizontal position within the lane, as a 0..100 percentage.
    const xPercent = Math.max(
      0,
      Math.min(100, (sample.timeMs / (durationSec * 1000)) * 100),
    )
    points.push({ x: xPercent, y, tMs: sample.timeMs })
  }
  return points
}

// Only the last N ms of samples are drawn as the fading orb trail; older
// samples get discarded so the trail stays short and readable.
const TRAIL_WINDOW_MS = 900

// Semitone tolerance for the on-target hit indicator. ±2 is a little tighter
// than the scorer's "good enough" so visual feedback actually feels earned.
const HIT_TOLERANCE_SEMITONES = 2

// Smule-style tiered feedback thresholds. Perfect/great/good read as
// different pop text + colors so the singer sees how close they are even
// inside the credit zone. "none" means the sample is outside credit at all.
type HitTier = "perfect" | "great" | "good" | "none"
function hitTierFromDelta(absDelta: number): HitTier {
  if (absDelta <= 1) return "perfect"
  if (absDelta <= 3) return "great"
  if (absDelta <= 5) return "good"
  return "none"
}

// Half-width of the drawn "credit zone" ribbon around each target bar.
// At ±3 semitones the scorer gives roughly half credit (linear interp
// between PITCH_FULL_SEMITONES=1 and PITCH_ZERO_SEMITONES=5), so this is
// the "if you're inside this band you'll still earn points" boundary.
// Visual only — the scorer owns the real numbers.
const CREDIT_ZONE_SEMITONES = 3

// Syllables held longer than this get a visual "hold" cue so singers see
// which notes to sustain. Below this is a quick syllable, no cue needed.
const HOLD_HINT_SECONDS = 0.7

// For long-held syllables, repeat the final vowel so "nae" (1.7 s) reads
// as "naeeee". Gives the singer a visual cue for how long to sustain the
// vowel, which the bar width alone doesn't communicate. Caps at +6 letters
// so very long notes don't overflow the bar label.
function sustainedLabel(label: string, durationSec: number): string {
  if (durationSec < HOLD_HINT_SECONDS) return label
  const trailingVowels = label.match(/[aeiouAEIOU]+(?=[^aeiouAEIOU]*$)/)
  if (!trailingVowels) return label
  const run = trailingVowels[0]
  const sustained = run[run.length - 1]
  const extra = Math.min(6, Math.round((durationSec - HOLD_HINT_SECONDS) * 3))
  if (extra <= 0) return label
  return label.replace(
    new RegExp(`${run}([^aeiouAEIOU]*)$`),
    `${run}${sustained.repeat(extra)}$1`,
  )
}

function PitchLane({
  line,
  progress = 0,
  showVoice = false,
  result = false,
  samples,
  missed = [],
  duration = DURATION,
}: {
  line: PracticeLine
  progress?: number
  showVoice?: boolean
  result?: boolean
  samples?: PitchSample[]
  missed?: number[]
  duration?: number
}) {
  const singerMedian = useMemo(() => {
    if (!samples || samples.length === 0) return null
    return timeWeightedMedianPitch(samples)
  }, [samples])
  const targetMedian = useMemo(() => targetMedianSemitones(line), [line])
  const voicePoints = useMemo<VoicePoint[]>(() => {
    if (!samples || samples.length === 0 || singerMedian === null) return []
    return samplesPoints(samples, singerMedian, targetMedian, duration)
  }, [samples, singerMedian, targetMedian, duration])
  // Trail = recent samples (last ~1s) that fade behind the orb. Orb =
  // the newest sample's point, drawn solid at the playhead. For result
  // replays, show the full flight path so the user can see their shape.
  const latestPoint =
    voicePoints.length > 0 ? voicePoints[voicePoints.length - 1] : null
  const trailPoints = useMemo(() => {
    if (voicePoints.length === 0) return []
    if (result) return voicePoints
    const cutoff = (latestPoint?.tMs ?? 0) - TRAIL_WINDOW_MS
    return voicePoints.filter((p) => p.tMs >= cutoff)
  }, [voicePoints, result, latestPoint])

  // Live hit detection: find the syllable active at the latest sample's
  // time, and check if that sample (rebased to the target's octave) sits
  // within tolerance of the syllable's target semitone. Only runs while
  // recording so result replays stay stable.
  const live = showVoice && !result
  const { isHitting, activeIndex, activeTier } = useMemo(() => {
    const empty = {
      isHitting: false,
      activeIndex: -1,
      activeTier: "none" as HitTier,
    }
    if (!live || !samples || samples.length === 0 || singerMedian === null)
      return empty
    const latest = samples[samples.length - 1]
    const tSec = latest.timeMs / 1000
    const idx = line.syllables.findIndex(
      (s) => tSec >= s.start && tSec <= s.end,
    )
    if (idx < 0) return empty
    const target = line.syllables[idx].semitones
    let delta = latest.pitch - singerMedian + targetMedian - target
    while (delta > 6) delta -= 12
    while (delta < -6) delta += 12
    const absDelta = Math.abs(delta)
    return {
      isHitting: absDelta <= HIT_TOLERANCE_SEMITONES,
      activeIndex: idx,
      activeTier: hitTierFromDelta(absDelta),
    }
  }, [live, samples, singerMedian, targetMedian, line])
  // viewBox height matches the 0..100 lane percent so the voice line and the
  // target bars share one scale. preserveAspectRatio="none" stretches to fit.

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
        const left = (syllable.start / duration) * 100
        const width = ((syllable.end - syllable.start) / duration) * 100
        const syllableDuration = syllable.end - syllable.start
        const isActiveHit = isHitting && index === activeIndex
        const isHold = syllableDuration >= HOLD_HINT_SECONDS
        const barClasses = ["target-bar"]
        if (result && missed.includes(index)) barClasses.push("missed")
        if (isActiveHit) barClasses.push("hit")
        if (isHold) barClasses.push("hold")
        // "Credit zone" ribbon: the band inside which the scorer still
        // awards at least ~50% of this syllable's pitch points. Purely
        // informational, so singers see how much slack they have before
        // a note stops counting at all.
        const zoneBottom = laneBottomPercent(
          syllable.semitones - CREDIT_ZONE_SEMITONES,
        )
        const zoneTop = laneBottomPercent(
          syllable.semitones + CREDIT_ZONE_SEMITONES,
        )
        const zoneHeight = Math.max(0, zoneTop - zoneBottom)
        return (
          <div key={`${line.id}-${index}-pitch`}>
            {!result && (
              <div
                className="credit-zone"
                aria-hidden="true"
                style={{
                  left: `${left}%`,
                  width: `${width}%`,
                  bottom: `${zoneBottom}%`,
                  height: `${zoneHeight}%`,
                }}
              />
            )}
            <div
              className={barClasses.join(" ")}
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
              {sustainedLabel(
                syllable.romanization ?? syllable.text,
                syllableDuration,
              )}
              {isHold && (
                <span className="bar-hold-cue" aria-hidden="true">
                  {" "}
                  ~
                </span>
              )}
            </span>
          </div>
        )
      })}
      {showVoice && trailPoints.length > 0 && (
        <div
          className={`voice-orb-layer ${isHitting ? "hitting" : ""} ${
            result ? "result" : ""
          }`}
          aria-hidden="true"
        >
          {trailPoints.map((p, i) => {
            // Trail dots fade from oldest (dim) to newest (bright). Older
            // dots are also smaller, so the eye reads the orb's direction
            // of travel. During result replay, show the whole flight path
            // at full opacity so the user can study their shape.
            const ageRatio = result
              ? 1
              : (i + 1) / Math.max(1, trailPoints.length)
            const opacity = result ? 0.6 : 0.08 + 0.72 * ageRatio
            const size = result ? 6 : 3 + 6 * ageRatio
            return (
              <span
                key={`${p.tMs}-${i}`}
                className="voice-trail-dot"
                style={{
                  left: `${p.x}%`,
                  top: `${p.y}%`,
                  opacity,
                  width: `${size}px`,
                  height: `${size}px`,
                }}
              />
            )
          })}
          {!result && latestPoint && (
            <span
              className="voice-orb"
              style={{
                left: `${latestPoint.x}%`,
                top: `${latestPoint.y}%`,
              }}
            />
          )}
        </div>
      )}
      {!result && progress > 0 && progress < 1 && (
        <div className="playhead" style={{ left: `${progress * 100}%` }}>
          <span />
        </div>
      )}
      {live &&
        activeIndex >= 0 &&
        activeTier !== "none" &&
        (() => {
          const syl = line.syllables[activeIndex]
          const centerLeft = ((syl.start + syl.end) / 2 / duration) * 100
          const label =
            activeTier === "perfect"
              ? "PERFECT!"
              : activeTier === "great"
                ? "GREAT!"
                : "GOOD!"
          return (
            <span
              key={`${line.id}-${activeIndex}-${activeTier}`}
              className={`hit-pop hit-pop-${activeTier}`}
              style={{ left: `${centerLeft}%` }}
              aria-hidden="true"
            >
              {label}
            </span>
          )
        })()}
      <div className="lane-time">
        <span>0:00</span>
        <span>
          0:
          {String(Math.round(duration)).padStart(2, "0")}
        </span>
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
  const multiRound = ROUNDS_PER_MATCH > 1
  return (
    <header className="screen-header">
      <Brand onHome={onHome} />
      <div className="line-progress">
        <span>
          {multiRound && (
            <>
              Round {round} <i>of</i> {ROUNDS_PER_MATCH}
            </>
          )}
          {multiRound && playerLabel ? <> · </> : null}
          {playerLabel ? (
            <b style={{ color: playerColor, fontWeight: 800 }}>{playerLabel}</b>
          ) : null}
        </span>
        {multiRound && (
          <div
            className="progress-dots"
            aria-label={`Round ${round} of ${ROUNDS_PER_MATCH}`}
          >
            {Array.from({ length: ROUNDS_PER_MATCH }, (_, i) => i + 1).map(
              (item) => (
                <i className={item === round ? "active" : ""} key={item} />
              ),
            )}
          </div>
        )}
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
    body: "Sing a line on your own. Get a Tune score and the syllables to fix.",
  },
  {
    mode: "battle",
    title: "Battle",
    body: "Two players, one device. Take turns singing the same line. Higher score wins.",
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

// Per-language gradient for the song cover tile. Replaces missing cover
// art with a themed card the user can tap, until real artwork is wired up
// (drop a <song-id>-cover.jpg in public/songs/ and read it off song.coverUrl).
const LANGUAGE_COVER_GRADIENT: Record<Language, string> = {
  en: "linear-gradient(135deg, #ff4fa3 0%, #9b3dff 100%)",
  ko: "linear-gradient(135deg, #19b5ff 0%, #9b3dff 100%)",
  ar: "linear-gradient(135deg, #ffd96b 0%, #ff4fa3 100%)",
}

function SongScreen({
  onChoose,
  onHome,
}: {
  onChoose: (songId: string) => void
  onHome: () => void
}) {
  const [selectedLanguage, setSelectedLanguage] = useState<Language | null>(
    null,
  )

  // Group songs by language once so the language picker shows one card per
  // language (not one per song) and the song picker filters cheaply.
  const songsByLanguage = useMemo(() => {
    const map = new Map<Language, Song[]>()
    for (const song of songs) {
      const list = map.get(song.language) ?? []
      list.push(song)
      map.set(song.language, list)
    }
    return map
  }, [])

  return (
    <main className="screen setup-screen">
      <CornerDots />
      <header className="screen-header">
        <Brand onHome={onHome} />
      </header>
      <section className="setup-content">
        {selectedLanguage === null ? (
          <>
            <h1>Pick a language to sing in</h1>
            <div className="mode-options">
              {Array.from(songsByLanguage.entries()).map(([lang, list]) => (
                <button
                  className="mode-card"
                  type="button"
                  key={lang}
                  onClick={() => setSelectedLanguage(lang)}
                >
                  <strong>{LANGUAGE_NAMES[lang]}</strong>
                  <span>
                    {list.length} song{list.length === 1 ? "" : "s"}
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <button
              className="change-mode-button"
              type="button"
              onClick={() => setSelectedLanguage(null)}
            >
              ← Back to languages
            </button>
            <h1>Pick a song</h1>
            <div className="song-grid">
              {(songsByLanguage.get(selectedLanguage) ?? []).map((song) => (
                <button
                  className="song-card"
                  type="button"
                  key={song.id}
                  onClick={() => onChoose(song.id)}
                >
                  {song.coverUrl ? (
                    <img
                      className="song-cover song-cover-image"
                      src={song.coverUrl}
                      alt=""
                      aria-hidden="true"
                    />
                  ) : (
                    <span
                      className="song-cover"
                      aria-hidden="true"
                      style={{
                        background: LANGUAGE_COVER_GRADIENT[song.language],
                      }}
                    >
                      <span
                        className="song-cover-title"
                        lang={song.language}
                        dir={song.language === "ar" ? "rtl" : "ltr"}
                      >
                        {song.title}
                      </span>
                    </span>
                  )}
                  <strong>{song.title}</strong>
                  <span className="song-card-meta">
                    {LANGUAGE_NAMES[song.language]}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
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
  nextLine,
  audioUrl,
  backingTrackUrl,
  language,
  round,
  totalLines,
  playerLabel,
  playerColor,
  getSession,
  onHome,
  onScored,
  onBlob,
}: {
  line: PracticeLine
  nextLine?: PracticeLine
  audioUrl: string
  backingTrackUrl?: string
  language: Language
  round: 1 | 2 | 3
  totalLines: number
  playerLabel: string
  playerColor: string
  getSession: () => Promise<AudioSession>
  onHome: () => void
  onScored: (samples: PitchSample[]) => void
  onBlob: (blob: Blob | null) => void
}) {
  const [singState, setSingState] = useState<SingState>("ready")
  const [count, setCount] = useState(COUNT_IN_BEATS)
  const [progress, setProgress] = useState(0)
  const [liveSamples, setLiveSamples] = useState<PitchSample[]>([])
  const [error, setError] = useState<ErrorKind>(null)
  const [referencePlaying, setReferencePlaying] = useState(false)
  const [clipFailed, setClipFailed] = useState(false)
  // Opt-in: the mic hears the pitched melody and it corrupts both the Tune
  // score and the Words model, so this is off by default and labelled
  // headphones-only in the UI.
  const [guideWhileSinging, setGuideWhileSinging] = useState(false)

  const referenceRef = useRef<HTMLAudioElement | null>(null)
  const backingRef = useRef<HTMLAudioElement | null>(null)
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
  const onBlobRef = useRef(onBlob)
  onBlobRef.current = onBlob
  const wordsCaptureRef = useRef<WordsCapture | null>(null)

  const stopBacking = () => {
    const backing = backingRef.current
    if (!backing) return
    backing.pause()
    backing.currentTime = line.audioStart ?? 0
  }

  // Stops this take only; the match keeps the mic stream open.
  const cleanup = () => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = 0
    detectorRef.current?.stop()
    detectorRef.current = null
    audioCtxRef.current = null
    wordsCaptureRef.current?.dispose()
    wordsCaptureRef.current = null
    stopAllMelody()
    stopBacking()
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
    stopAllMelody()
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
    // Melody plays alongside the spoken clip so Hear it carries the tune too.
    playMelodyLine(line)
    audio.play().catch((err: unknown) => {
      stopAllMelody()
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

    // Record the turn's audio alongside pitch detection. Any failure is
    // swallowed inside the service; the Words card falls back to "unavailable".
    wordsCaptureRef.current = startWordsCapture(session.stream, ctx)

    const detector = createPitchDetector({
      ctx,
      stream: session.stream,
      onSample: (sample) => {
        samplesRef.current = [...samplesRef.current, sample]
        setLiveSamples(samplesRef.current)
      },
    })
    detectorRef.current = detector

    // If the song has an instrumental backing track with a vocal-entry
    // offset (audioStart > 0), play the intro build-up before recording
    // begins so the singer isn't dropped into mid-song. Capped at 6s so
    // long intros don't make the turn feel sluggish.
    const audioStart = line.audioStart ?? 0
    const INTRO_PRE_ROLL_SECONDS = 6
    const introPreRoll =
      backingTrackUrl && audioStart > 0
        ? Math.min(audioStart, INTRO_PRE_ROLL_SECONDS)
        : 0
    const preRollSeconds = Math.max(COUNT_IN_SECONDS, introPreRoll)
    const countStart = ctx.currentTime
    const recordStart = countStart + preRollSeconds
    const recordEnd = recordStart + DURATION
    const countInStart = recordStart - COUNT_IN_SECONDS

    setCount(introPreRoll > COUNT_IN_SECONDS ? 0 : COUNT_IN_BEATS)
    setSingState("counting")

    // When there's an intro to play, start the backing immediately and
    // seek so the vocal entry (audioStart) lands exactly at recordStart.
    // Count-in beats are delayed into the final COUNT_IN_SECONDS of the
    // pre-roll so they overlap with the music, not the silent prelude.
    if (introPreRoll > 0) {
      const backing = backingRef.current
      if (backingTrackUrl && backing) {
        backing.currentTime = Math.max(0, audioStart - introPreRoll)
        backing.volume = 0.55
        void backing.play().catch(() => {
          // Fallback: synth beats will take over at the countInStart gate.
        })
      }
      const countInDelayMs = Math.max(
        0,
        (introPreRoll - COUNT_IN_SECONDS) * 1000,
      )
      window.setTimeout(
        () => playCountIn(line, COUNT_IN_BEATS, COUNT_IN_INTERVAL),
        countInDelayMs,
      )
    } else {
      // No intro — count-in beats fire immediately, as before.
      playCountIn(line, COUNT_IN_BEATS, COUNT_IN_INTERVAL)
    }

    let hasStartedRecording = false
    let beatsScheduled = false

    const loop = () => {
      const ctxNow = audioCtxRef.current
      if (!ctxNow || ctxNow.state === "closed") return
      const now = ctxNow.currentTime
      if (now < recordStart) {
        const remaining = recordStart - now
        // Show the big count number only in the last COUNT_IN_SECONDS of
        // pre-roll. Before that (intro music playing), setCount(0) tells
        // the overlay to show a "listen…" message instead of a stale "3".
        const nextCount =
          now < countInStart
            ? 0
            : Math.max(1, Math.ceil(remaining / COUNT_IN_INTERVAL))
        setCount(nextCount)
        if (!beatsScheduled && remaining < 0.08) {
          // Schedule once right before record-start. If this song has a
          // backing track with no intro pre-roll, start it now so vocals
          // enter in sync. If there's no backing track at all, fall back
          // to the synth guide. If we already started the backing during
          // pre-roll (introPreRoll > 0), skip — it's still playing.
          beatsScheduled = true
          const backing = backingRef.current
          if (backingTrackUrl && backing && introPreRoll === 0) {
            backing.currentTime = 0
            backing.volume = 0.55
            void backing.play().catch(() => {
              playBeatTrack(line, 0, SECONDS_PER_BEAT)
            })
          } else if (!backingTrackUrl) {
            if (guideWhileSinging) {
              playSingAlongTrack(line, remaining, SECONDS_PER_BEAT)
            } else {
              playBeatTrack(line, remaining, SECONDS_PER_BEAT)
            }
          }
        }
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
          // Hand off the Words capture before cleanup() disposes it. The blob
          // is awaited so the ref is populated before TURN_SCORED dispatches,
          // guaranteeing the RoundResult screen sees it on first paint.
          const capture = wordsCaptureRef.current
          wordsCaptureRef.current = null
          cancelAnimationFrame(rafRef.current)
          rafRef.current = 0
          detectorRef.current?.stop()
          detectorRef.current = null
          audioCtxRef.current = null
          stopBacking()
          if (unclear) {
            capture?.dispose()
            setSingState("ready")
            setProgress(0)
            setLiveSamples([])
            setError("unclear")
          } else {
            const settle = capture ? capture.stop() : Promise.resolve(null)
            void settle
              .then((blob) => {
                onBlobRef.current(blob)
                onScoredRef.current(finalSamples)
              })
              .catch(() => {
                // Capture errored on teardown — still score the pitch samples
                // and hand off a null blob so the UI doesn't hang on recording.
                onBlobRef.current(null)
                onScoredRef.current(finalSamples)
              })
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

  const fill =
    singState === "recording"
      ? syllableFill(line.syllables, progress * DURATION)
      : undefined
  const ball = bouncingBall(
    line.syllables,
    singState === "recording" ? progress * DURATION : 0,
  )

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
        <div
          className="line-progress"
          aria-label={`Line ${line.id} of ${totalLines}`}
        >
          <span className="line-progress-label">
            Line {line.id} / {totalLines}
          </span>
          <span className="line-progress-track" aria-hidden="true">
            {Array.from({ length: totalLines }, (_, i) => (
              <span
                key={i}
                className={`line-progress-dot ${
                  i + 1 < line.id ? "done" : i + 1 === line.id ? "current" : ""
                }`}
              />
            ))}
          </span>
        </div>
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
          {backingTrackUrl && (
            <audio ref={backingRef} src={backingTrackUrl} preload="auto" />
          )}
        </div>

        <label className="guide-toggle">
          <input
            type="checkbox"
            checked={guideWhileSinging}
            onChange={(e) => setGuideWhileSinging(e.target.checked)}
            disabled={singState !== "ready"}
          />
          <span>Sing-along backing track (headphones only)</span>
        </label>

        <LyricSyllables
          line={line}
          language={language}
          activeIndex={activeIndex}
          fill={fill}
          litColor={playerColor}
          ball={ball}
        />

        {nextLine && (
          <p className="next-line">
            <span className="next-line-label">Next line</span>
            <span
              className="next-line-text"
              lang={language}
              dir={language === "ar" ? "rtl" : "ltr"}
            >
              {nextLine.text}
            </span>
            {nextLine.romanization && (
              <span className="next-line-roman">{nextLine.romanization}</span>
            )}
          </p>
        )}

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
        <div
          className="count-overlay"
          aria-live="assertive"
          style={{ "--beat": `${COUNT_IN_INTERVAL}s` } as CSSProperties}
        >
          <div className="count-beat" key={count}>
            <i className="count-ring" aria-hidden="true" />
            <span>{count > 0 ? count : "♪"}</span>
          </div>
          <small>
            {count > 0
              ? "Start singing on the beat after 1"
              : "Listen for the intro…"}
          </small>
        </div>
      )}
    </main>
  )
}

// Perform mode routes songs that have a full backing track plus per-line
// audio windows (audioStart/audioEnd). Continuous karaoke: the full backing
// plays start to finish, lyrics scroll, pitch samples span the whole song,
// and a single aggregate score comes out at the end. Falls back to the
// turn-based SingScreen for songs without this shape (Happy Birthday etc.).
function isPerformSong(song: Song): boolean {
  if (!song.backingTrackUrl) return false
  return song.lines.every(
    (l) => l.audioStart !== undefined && l.audioEnd !== undefined,
  )
}

type PerformPhase = "ready" | "starting" | "countingIn" | "singing" | "done"

type PerformAggregate = {
  score: number
  timing: number
  missed: number[]
  samples: PitchSample[]
  line: PracticeLine
}

function PerformScreen({
  song,
  playerLabel,
  playerColor,
  getSession,
  onHome,
  onComplete,
  onBlob,
}: {
  song: Song
  playerLabel: string
  playerColor: string
  getSession: () => Promise<AudioSession>
  onHome: () => void
  onComplete: (aggregate: PerformAggregate) => void
  onBlob: (blob: Blob | null) => void
}) {
  const [phase, setPhase] = useState<PerformPhase>("ready")
  const [count, setCount] = useState(COUNT_IN_BEATS)
  const [elapsedSec, setElapsedSec] = useState(0)
  const [currentLineIndex, setCurrentLineIndex] = useState(-1)
  const [liveSamples, setLiveSamples] = useState<PitchSample[]>([])
  const [error, setError] = useState<ErrorKind>(null)

  const backingRef = useRef<HTMLAudioElement | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const detectorRef = useRef<ReturnType<typeof createPitchDetector> | null>(
    null,
  )
  const samplesRef = useRef<PitchSample[]>([])
  const rafRef = useRef(0)
  const wordsCaptureRef = useRef<WordsCapture | null>(null)
  const phaseRef = useRef<PerformPhase>("ready")
  phaseRef.current = phase
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete
  const onBlobRef = useRef(onBlob)
  onBlobRef.current = onBlob

  // One beat of silence past the final line so the last syllable can resolve
  // and the backing's tail doesn't abruptly cut.
  const songEndSec = useMemo(() => {
    const maxEnd = song.lines.reduce(
      (max, l) => Math.max(max, l.audioEnd ?? 0),
      0,
    )
    return maxEnd + 0.6
  }, [song])

  const cleanup = () => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = 0
    detectorRef.current?.stop()
    detectorRef.current = null
    audioCtxRef.current = null
    wordsCaptureRef.current?.dispose()
    wordsCaptureRef.current = null
    const backing = backingRef.current
    if (backing) {
      backing.pause()
      backing.currentTime = 0
    }
  }

  useEffect(() => cleanup, [])

  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState !== "hidden") return
      const p = phaseRef.current
      if (p !== "countingIn" && p !== "singing") return
      cleanup()
      setPhase("ready")
      setElapsedSec(0)
      setCurrentLineIndex(-1)
      setLiveSamples([])
      setError("interrupted")
    }
    document.addEventListener("visibilitychange", onHidden)
    return () => document.removeEventListener("visibilitychange", onHidden)
  }, [])

  const start = async () => {
    if (phase !== "ready") return
    setError(null)
    setElapsedSec(0)
    setCurrentLineIndex(-1)
    setLiveSamples([])
    samplesRef.current = []
    setPhase("starting")

    let session: AudioSession
    try {
      session = await getSession()
    } catch (err) {
      setPhase("ready")
      if (err instanceof MicrophoneError) setError(err.kind)
      else setError("generic")
      return
    }
    const ctx = session.ctx
    audioCtxRef.current = ctx

    wordsCaptureRef.current = startWordsCapture(session.stream, ctx)

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
    const songStart = countStart + COUNT_IN_SECONDS
    const songEndCtx = songStart + songEndSec

    setPhase("countingIn")
    setCount(COUNT_IN_BEATS)
    // Use the first line's chord/semitone context for the count-in pitches.
    playCountIn(song.lines[0], COUNT_IN_BEATS, COUNT_IN_INTERVAL)

    let hasStarted = false

    const loop = () => {
      const c = audioCtxRef.current
      if (!c || c.state === "closed") return
      const now = c.currentTime

      if (now < songStart) {
        const remaining = songStart - now
        setCount(Math.max(1, Math.ceil(remaining / COUNT_IN_INTERVAL)))
      } else {
        if (!hasStarted) {
          hasStarted = true
          setPhase("singing")
          // detector.timeMs = ms since songStart = ms since elapsed=0.
          detector.start(songStart)
          const backing = backingRef.current
          if (backing) {
            backing.currentTime = 0
            backing.volume = 0.55
            void backing.play().catch(() => {
              // If backing fails, singing continues silently — scoring is
              // unaffected because samples still line up to the song clock.
            })
          }
        }

        const elapsed = now - songStart
        setElapsedSec(elapsed)
        const idx = song.lines.findIndex((l) => {
          const start = l.audioStart ?? 0
          const end = l.audioEnd ?? start
          return elapsed >= start && elapsed <= end
        })
        setCurrentLineIndex(idx)

        if (now >= songEndCtx) {
          const finalSamples = samplesRef.current
          const capture = wordsCaptureRef.current
          wordsCaptureRef.current = null
          cancelAnimationFrame(rafRef.current)
          rafRef.current = 0
          detectorRef.current?.stop()
          detectorRef.current = null
          audioCtxRef.current = null
          const backing = backingRef.current
          if (backing) backing.pause()
          setPhase("done")

          // Score every line, then average. For the match reducer we need a
          // single line/samples/missed triple; use the line the singer scored
          // highest on so the result screen shows their best moment.
          const perLine = song.lines.map((l) => {
            const startMs = (l.audioStart ?? 0) * 1000
            const endMs = (l.audioEnd ?? 0) * 1000
            const rebased = finalSamples
              .filter((s) => s.timeMs >= startMs && s.timeMs <= endMs)
              .map((s) => ({ ...s, timeMs: s.timeMs - startMs }))
            return { line: l, samples: rebased, result: scoreTurn(l, rebased) }
          })
          const totalScore =
            perLine.reduce((sum, p) => sum + p.result.score, 0) / perLine.length
          const totalTiming =
            perLine.reduce((sum, p) => {
              const avg =
                p.result.syllables.reduce((a, s) => a + s.timing, 0) /
                Math.max(1, p.result.syllables.length)
              return sum + avg
            }, 0) / perLine.length
          const best = perLine.reduce((a, b) =>
            b.result.score > a.result.score ? b : a,
          )

          const aggregate: PerformAggregate = {
            score: totalScore,
            timing: totalTiming,
            missed: best.result.missed,
            samples: best.samples,
            line: best.line,
          }

          const settle = capture ? capture.stop() : Promise.resolve(null)
          void settle
            .then((blob) => {
              onBlobRef.current(blob)
              onCompleteRef.current(aggregate)
            })
            .catch(() => {
              onBlobRef.current(null)
              onCompleteRef.current(aggregate)
            })
          return
        }
      }
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
  }

  // The current line's samples, rebased so timeMs starts at 0 at line start.
  // Lets us reuse PitchLane for the live lane while the song plays through.
  const currentLine =
    currentLineIndex >= 0 ? song.lines[currentLineIndex] : null
  const currentLineStart = currentLine?.audioStart ?? 0
  const currentLineEnd = currentLine?.audioEnd ?? currentLineStart + DURATION
  const currentLineDuration = Math.max(0.5, currentLineEnd - currentLineStart)
  const currentLineSamples = useMemo<PitchSample[]>(() => {
    if (!currentLine) return []
    const startMs = currentLineStart * 1000
    const endMs = currentLineEnd * 1000
    const out: PitchSample[] = []
    for (const s of liveSamples) {
      if (s.timeMs < startMs || s.timeMs > endMs) continue
      out.push({ ...s, timeMs: s.timeMs - startMs })
    }
    return out
  }, [currentLine, currentLineStart, currentLineEnd, liveSamples])
  const currentLineProgress = currentLine
    ? Math.min(
        1,
        Math.max(0, (elapsedSec - currentLineStart) / currentLineDuration),
      )
    : 0

  // When we're between lines (or before line 1), the "up next" panel takes
  // over so the singer sees the words and a countdown bar instead of a
  // mystery pause. nextLineIndex = first line whose audioStart is still
  // ahead of us; -1 when the song is done or we're mid-line.
  const nextLineIndex = useMemo(() => {
    if (currentLineIndex >= 0) return -1
    return song.lines.findIndex((l) => (l.audioStart ?? 0) > elapsedSec)
  }, [song, currentLineIndex, elapsedSec])
  const nextLine = nextLineIndex >= 0 ? song.lines[nextLineIndex] : null
  // Countdown bar fills as the next line approaches. 4 s window: short
  // enough to read as "about to start", long enough to read the line.
  const PREVIEW_WINDOW_SEC = 4
  const previewRemaining = nextLine
    ? Math.max(0, (nextLine.audioStart ?? 0) - elapsedSec)
    : 0
  const previewProgress = nextLine
    ? Math.min(1, Math.max(0, 1 - previewRemaining / PREVIEW_WINDOW_SEC))
    : 0
  const showPreview = phase === "singing" && !currentLine && !!nextLine
  const previewCountdown = Math.max(1, Math.ceil(previewRemaining))

  const songProgress = Math.min(1, Math.max(0, elapsedSec / songEndSec))

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

  const headerLabel =
    phase === "singing"
      ? "KARAOKE"
      : phase === "starting"
        ? "GETTING READY"
        : phase === "countingIn"
          ? "GET READY"
          : `${playerLabel.toUpperCase()}'S TURN`
  const headerTitle =
    phase === "singing"
      ? song.title
      : phase === "starting"
        ? "Starting microphone…"
        : "Sing the whole song"

  return (
    <main className="screen sing-screen perform-screen">
      <CornerDots />
      <ScreenHeader
        round={1}
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
        </div>

        <div className="perform-progress-bar" aria-hidden="true">
          <span style={{ width: `${songProgress * 100}%` }} />
        </div>

        <ol className="perform-lyric-stack" aria-live="polite">
          {song.lines.map((l, i) => {
            const state =
              i === currentLineIndex
                ? "current"
                : i < currentLineIndex
                  ? "done"
                  : "upcoming"
            return (
              <li
                key={l.id}
                className={`perform-lyric-line ${state}`}
                lang={song.language}
                dir={song.language === "ar" ? "rtl" : "ltr"}
              >
                <span className="perform-lyric-text">{l.text}</span>
                {l.romanization && (
                  <span className="perform-lyric-roman">{l.romanization}</span>
                )}
              </li>
            )
          })}
        </ol>

        {showPreview && nextLine && (
          <div className="perform-preview" aria-live="polite">
            <span className="perform-preview-label">
              Up next in {previewCountdown}s
            </span>
            <div
              className="perform-preview-text"
              lang={song.language}
              dir={song.language === "ar" ? "rtl" : "ltr"}
            >
              {nextLine.text}
            </div>
            {nextLine.romanization && (
              <div className="perform-preview-roman">
                {nextLine.romanization}
              </div>
            )}
            <div className="perform-preview-bar" aria-hidden="true">
              <span style={{ width: `${previewProgress * 100}%` }} />
            </div>
          </div>
        )}

        {currentLine && (
          <PitchLane
            line={currentLine}
            progress={currentLineProgress}
            showVoice={phase === "singing"}
            samples={currentLineSamples}
            duration={currentLineDuration}
          />
        )}

        {song.backingTrackUrl && (
          <audio ref={backingRef} src={song.backingTrackUrl} preload="auto" />
        )}

        <div
          className={`listen-status ${
            (phase === "singing" && !!currentLine) || phase === "starting"
              ? "visible"
              : ""
          }`}
        >
          <span className="listening-dot" />
          <MicIcon />
          {phase === "starting" ? "Starting microphone…" : "Listening…"}
        </div>

        {error && (
          <div className="inline-error" role="alert">
            <strong>{errorTitle[error]}</strong>
            <p>{errorBody[error]}</p>
            <button onClick={start} disabled={phase !== "ready"}>
              Retry
            </button>
          </div>
        )}
      </section>

      <div className="record-area">
        <p>
          {phase === "ready"
            ? "Tap to start the song"
            : phase === "starting"
              ? "Allow microphone access"
              : phase === "countingIn"
                ? "Here we go"
                : phase === "singing"
                  ? "Keep singing"
                  : "Scoring…"}
        </p>
        <button
          className={`record-button ${phase === "singing" ? "active" : ""}`}
          onClick={start}
          disabled={phase !== "ready"}
          aria-label="Start singing"
        >
          <RecordDotRing />
          <span>
            <MicIcon />
          </span>
        </button>
      </div>

      {phase === "countingIn" && (
        <div
          className="count-overlay"
          aria-live="assertive"
          style={{ "--beat": `${COUNT_IN_INTERVAL}s` } as CSSProperties}
        >
          <div className="count-beat" key={count}>
            <i className="count-ring" aria-hidden="true" />
            <span>{count}</span>
          </div>
          <small>Start singing on the beat after 1</small>
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
  wordsBlobs,
  shareOnLeaderboard,
  voiceSessionIds,
  onVoiceSessionCreated,
  onHome,
  onContinue,
}: {
  state: MatchState
  wordsBlobs: (Blob | null)[]
  shareOnLeaderboard: boolean
  voiceSessionIds: [string | null, string | null]
  onVoiceSessionCreated: (player: PlayerIndex, sessionId: string) => void
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
                <WordsCard
                  tune={state.turnScores[player] ?? 0}
                  wav={wordsBlobs[player] ?? null}
                  songId={state.song.id}
                  lineId={line.id}
                />
                <MyTakePlayback wav={wordsBlobs[player] ?? null} />
                <SyllableBreakdown
                  line={line}
                  song={state.song}
                  missed={state.turnMissed[player]}
                  wav={wordsBlobs[player] ?? null}
                  showTakePerSyllable={!isPerformSong(state.song)}
                />
                <p>{coach.body}</p>
                {announcer.coaching[PLAYER_IDS[player]] && (
                  <p className="coach-tip">
                    <small>Coach</small>
                    {announcer.coaching[PLAYER_IDS[player]]}
                  </p>
                )}
                <VoiceClonePanel
                  line={line}
                  songId={state.song.id}
                  language={state.song.language}
                  sessionId={voiceSessionIds[player] ?? null}
                  onSessionCreated={(id) => onVoiceSessionCreated(player, id)}
                />
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

        {!solo && ROUNDS_PER_MATCH > 1 && (
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
  // The WAV for each player's most recent turn. Written when the recorder
  // stops, read by the WordsCard rendered inside RoundResultScreen.
  const wordsBlobsRef = useRef<(Blob | null)[]>([null, null])
  const [leavePromptOpen, setLeavePromptOpen] = useState(false)
  // Leaderboard opt-in. Not in match reducer: it only affects what we send to
  // the backend, not match flow, so it stays in App state and resets on reload.
  const [shareOnLeaderboard, setShareOnLeaderboard] = useState(false)
  const shareOnLeaderboardRef = useRef(shareOnLeaderboard)
  shareOnLeaderboardRef.current = shareOnLeaderboard

  // Per-player voice-clone session ids. These are opaque — the real
  // ElevenLabs voice id stays server-side. Deleted on match end,
  // rematch, go-home, and when the match leaves the sing/result loop.
  const [voiceSessionIds, setVoiceSessionIds] =
    useState<[string | null, string | null]>([null, null])
  const voiceSessionIdsRef = useRef(voiceSessionIds)
  voiceSessionIdsRef.current = voiceSessionIds

  const clearVoiceSessions = () => {
    const current = voiceSessionIdsRef.current
    setVoiceSessionIds([null, null])
    for (const id of current) if (id) void deleteVoice(id)
  }

  const handleVoiceSessionCreated = (player: PlayerIndex, id: string) => {
    setVoiceSessionIds((prev) => {
      const next: [string | null, string | null] = [
        ...prev,
      ] as [string | null, string | null]
      // If a prior clone exists for this player (e.g. they recorded again)
      // delete it on the server before replacing.
      const old = next[player]
      if (old && old !== id) void deleteVoice(old)
      next[player] = id
      return next
    })
  }

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

  // Belt-and-braces: delete any lingering voice clones if the player
  // closes the tab. keepalive on the DELETE lets the request land.
  useEffect(() => {
    const onUnload = () => {
      for (const id of voiceSessionIdsRef.current) {
        if (id) void deleteVoice(id)
      }
    }
    window.addEventListener("pagehide", onUnload)
    return () => window.removeEventListener("pagehide", onUnload)
  }, [])

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
    clearVoiceSessions()
    dispatch({ type: "GO_HOME" })
  }

  const confirmLeave = () => {
    setLeavePromptOpen(false)
    closeSession()
    clearVoiceSessions()
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
        {state.phase === "turnReady" &&
          (state.mode === "solo" && isPerformSong(state.song) ? (
            <PerformScreen
              key={`${state.round}-${player}-${state.replays}`}
              song={state.song}
              playerLabel={displayName(state, player)}
              playerColor={PLAYER_COLORS[player]}
              getSession={getSession}
              onHome={goHome}
              onComplete={(aggregate) => {
                dispatch({
                  type: "TURN_SCORED",
                  score: aggregate.score,
                  timing: aggregate.timing,
                  missed: aggregate.missed,
                  samples: aggregate.samples,
                })
              }}
              onBlob={(blob) => {
                wordsBlobsRef.current[player] = blob
              }}
            />
          ) : (
            <SingScreen
              key={`${state.round}-${player}-${state.replays}`}
              line={line}
              nextLine={
                isMatchOver(state) ? undefined : state.song.lines[state.round]
              }
              audioUrl={state.song.audioUrl}
              backingTrackUrl={state.song.backingTrackUrl}
              language={state.song.language}
              round={state.round}
              totalLines={state.song.lines.length}
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
              onBlob={(blob) => {
                wordsBlobsRef.current[player] = blob
              }}
            />
          ))}
        {state.phase === "handover" && (
          <HandoverScreen
            state={state}
            onContinue={() => dispatch({ type: "HANDOVER_DONE" })}
          />
        )}
        {state.phase === "roundResult" && (
          <RoundResultScreen
            state={state}
            wordsBlobs={wordsBlobsRef.current}
            shareOnLeaderboard={shareOnLeaderboard}
            voiceSessionIds={voiceSessionIds}
            onVoiceSessionCreated={handleVoiceSessionCreated}
            onHome={goHome}
            onContinue={() => dispatch({ type: "ROUND_CONTINUE" })}
          />
        )}
        {state.phase === "final" && (
          <FinalScreen
            state={state}
            onRematch={() => {
              clearVoiceSessions()
              dispatch({ type: "REMATCH" })
            }}
            onHome={() => {
              closeSession()
              clearVoiceSessions()
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
