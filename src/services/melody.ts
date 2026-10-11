// Backing melody for the sing screen.
//
// Everything is synthesized at runtime with the Web Audio API — no audio
// files, no new dependencies. Pitches come from each syllable's `semitones`
// field in the song data; timing comes from `start`/`end` and the shared
// `SECONDS_PER_BEAT` tempo.
//
// There are four things this module can play:
//   1. The full pitched melody for a line (Hear it, plus the opt-in guide
//      during recording).
//   2. A three-beat pitched count-in on the line's first note, so the
//      player hears the key and the tempo before they sing.
//   3. An unpitched beat track (short filtered noise ticks) that plays
//      alongside recording by default — pitch detection and the Words
//      model can't lock onto noise, so this stays out of scoring.
//   4. The pitched melody + beat ticks together — opt-in only, labelled
//      "headphones only" because speakers would bleed back into the mic.
//
// A single AudioContext is owned here so "Hear it" works before the mic
// session has started. Every scheduled node is tracked and torn down by
// `stopAll()`, which the UI calls on leave, record-end, and visibility
// change.

import type { PracticeLine } from "@/domain/types"

// Single volume knob. Melody plays softly so headphones aren't painful and
// so the beat track can't dominate the player's own voice over speakers.
export const MELODY_VOLUME = 0.12

// 0 semitones = middle C. Happy Birthday's "0" note is C, "-5" is the G
// below it. That puts the melody roughly in a comfortable baritone/alto
// range for a guide tone.
const TONIC_HZ = 261.6256

// Envelope shape for pitched tones. Fast attack so notes feel on the beat,
// short release so legato notes don't blur into each other.
const ATTACK_S = 0.012
const RELEASE_S = 0.07

// Unpitched beat tick: a narrow burst of band-passed noise. No tonal centre
// for a pitch detector to latch onto, but a clear pulse the singer can feel.
const TICK_DURATION_S = 0.03
const TICK_FILTER_HZ = 1800

// Minimum envelope target. `exponentialRampToValueAtTime` can't ramp to 0,
// so we glide to a near-silent floor instead.
const SILENT_FLOOR = 0.0001

function semitonesToHz(semitones: number): number {
  return TONIC_HZ * 2 ** (semitones / 12)
}

type Handle = { stop: () => void }

const NOOP_HANDLE: Handle = { stop: () => {} }

let sharedCtx: AudioContext | null = null
let outstanding = new Set<Handle>()

function getCtx(): AudioContext | null {
  if (sharedCtx && sharedCtx.state !== "closed") return sharedCtx
  const AudioCtor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext
  if (!AudioCtor) return null
  sharedCtx = new AudioCtor()
  // Autoplay rules: context may be suspended until a user gesture. Resume is
  // best-effort; if it fails the scheduled nodes just stay silent, which is
  // better than throwing.
  void sharedCtx.resume().catch(() => {})
  return sharedCtx
}

function scheduleTone(
  ctx: AudioContext,
  startAt: number,
  durationS: number,
  hz: number,
  peakGain: number,
): OscillatorNode {
  const osc = ctx.createOscillator()
  // Triangle is softer than sawtooth or square — closest to a flute without
  // extra filtering. Keeps the guide pleasant on headphones.
  osc.type = "triangle"
  osc.frequency.setValueAtTime(hz, startAt)
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(SILENT_FLOOR, startAt)
  // Attack can't be longer than the note itself. For very short notes we
  // clip it to the first third.
  const attack = Math.min(ATTACK_S, durationS * 0.3)
  gain.gain.exponentialRampToValueAtTime(peakGain, startAt + attack)
  // Release starts late enough that we always have a sustain segment.
  const releaseStart = startAt + Math.max(attack + 0.01, durationS - RELEASE_S)
  gain.gain.setValueAtTime(peakGain, releaseStart)
  gain.gain.exponentialRampToValueAtTime(SILENT_FLOOR, startAt + durationS)
  osc.connect(gain).connect(ctx.destination)
  osc.start(startAt)
  // Give the ramp a tiny tail to finish before we actually stop the node.
  osc.stop(startAt + durationS + 0.02)
  return osc
}

function scheduleTick(
  ctx: AudioContext,
  startAt: number,
): AudioBufferSourceNode {
  const length = Math.max(1, Math.ceil(TICK_DURATION_S * ctx.sampleRate))
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  // Linearly-decaying noise. Short enough that the ear reads it as a tick,
  // not a tone, which is why pitch detection ignores it.
  for (let i = 0; i < length; i += 1) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / length)
  }
  const src = ctx.createBufferSource()
  src.buffer = buffer
  const filter = ctx.createBiquadFilter()
  filter.type = "bandpass"
  filter.frequency.setValueAtTime(TICK_FILTER_HZ, startAt)
  filter.Q.setValueAtTime(1.5, startAt)
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(MELODY_VOLUME * 0.5, startAt)
  src.connect(filter).connect(gain).connect(ctx.destination)
  src.start(startAt)
  src.stop(startAt + TICK_DURATION_S + 0.01)
  return src
}

type AnySource = OscillatorNode | AudioBufferSourceNode

function track(nodes: AnySource[]): Handle {
  const handle: Handle = {
    stop: () => {
      for (const node of nodes) {
        try {
          node.stop(0)
        } catch {
          // Node already finished or was never started; both are harmless.
        }
        try {
          node.disconnect()
        } catch {
          // Already disconnected.
        }
      }
      outstanding.delete(handle)
    },
  }
  outstanding.add(handle)
  return handle
}

function lineDurationS(line: PracticeLine): number {
  return line.syllables.reduce((max, s) => Math.max(max, s.end), 0)
}

/** Play the melody for one line, starting now. */
export function playLine(line: PracticeLine, volume = MELODY_VOLUME): Handle {
  const ctx = getCtx()
  if (!ctx) return NOOP_HANDLE
  // Small forward offset so the first note has time to be scheduled instead
  // of starting mid-attack.
  const start = ctx.currentTime + 0.03
  const nodes = line.syllables.map((s) =>
    scheduleTone(
      ctx,
      start + s.start,
      Math.max(0.05, s.end - s.start),
      semitonesToHz(s.semitones),
      volume,
    ),
  )
  return track(nodes)
}

/**
 * Play `beats` pitched beeps on-beat at `intervalS` apart, pitched at the
 * line's starting note. The last beep is one octave up so the player hears
 * the "sing now" boundary.
 */
export function playCountIn(
  line: PracticeLine,
  beats: number,
  intervalS: number,
): Handle {
  const ctx = getCtx()
  if (!ctx) return NOOP_HANDLE
  const baseHz = semitonesToHz(line.syllables[0]?.semitones ?? 0)
  const start = ctx.currentTime + 0.03
  const duration = Math.min(intervalS * 0.6, 0.3)
  const nodes: OscillatorNode[] = []
  for (let i = 0; i < beats; i += 1) {
    const hz = i === beats - 1 ? baseHz * 2 : baseHz
    nodes.push(
      scheduleTone(ctx, start + i * intervalS, duration, hz, MELODY_VOLUME),
    )
  }
  return track(nodes)
}

/**
 * Beat ticks (no pitched notes) for the length of the line, starting in
 * `delayS` seconds. Safe to play during recording — the mic sees only noise
 * bursts, which pitch detection and the Words model both skip.
 */
export function playBeatTrack(
  line: PracticeLine,
  delayS: number,
  secondsPerBeat: number,
): Handle {
  const ctx = getCtx()
  if (!ctx) return NOOP_HANDLE
  const start = ctx.currentTime + Math.max(0, delayS)
  const beats = Math.ceil(lineDurationS(line) / secondsPerBeat) + 1
  const nodes: AudioBufferSourceNode[] = []
  for (let i = 0; i < beats; i += 1) {
    nodes.push(scheduleTick(ctx, start + i * secondsPerBeat))
  }
  return track(nodes)
}

/**
 * Beat ticks AND the pitched melody, synced. The pitched part is the
 * guide-while-singing option — the UI must label it headphones-only.
 */
export function playGuideWithBeat(
  line: PracticeLine,
  delayS: number,
  secondsPerBeat: number,
): Handle {
  const ctx = getCtx()
  if (!ctx) return NOOP_HANDLE
  const start = ctx.currentTime + Math.max(0, delayS)
  const beats = Math.ceil(lineDurationS(line) / secondsPerBeat) + 1
  const nodes: AnySource[] = []
  for (let i = 0; i < beats; i += 1) {
    nodes.push(scheduleTick(ctx, start + i * secondsPerBeat))
  }
  for (const s of line.syllables) {
    nodes.push(
      scheduleTone(
        ctx,
        start + s.start,
        Math.max(0.05, s.end - s.start),
        semitonesToHz(s.semitones),
        MELODY_VOLUME,
      ),
    )
  }
  return track(nodes)
}

/** Cancel every outstanding handle. Idempotent. */
export function stopAll(): void {
  for (const handle of [...outstanding]) handle.stop()
  outstanding = new Set()
}
