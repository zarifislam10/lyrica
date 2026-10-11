import { afterEach, describe, expect, it, vi } from "vitest"

import { scoreTurn } from "@/domain/scoring"
import type { PracticeLine } from "@/domain/types"

const line: PracticeLine = {
  id: 1,
  text: "test",
  syllables: [
    { text: "a", start: 0, end: 0.6, semitones: 0 },
    { text: "b", start: 0.6, end: 1.2, semitones: -3 },
  ],
}

type MockOsc = {
  type: string
  frequency: { setValueAtTime: ReturnType<typeof vi.fn> }
  connect: (dest: unknown) => MockOsc
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
}
type MockGain = {
  gain: {
    setValueAtTime: ReturnType<typeof vi.fn>
    exponentialRampToValueAtTime: ReturnType<typeof vi.fn>
  }
  connect: (dest: unknown) => MockGain
  disconnect: ReturnType<typeof vi.fn>
}
type MockFilter = {
  type: string
  frequency: { setValueAtTime: ReturnType<typeof vi.fn> }
  Q: { setValueAtTime: ReturnType<typeof vi.fn> }
  connect: (dest: unknown) => MockFilter
  disconnect: ReturnType<typeof vi.fn>
}

type MockSource = {
  buffer: AudioBuffer | null
  connect: (dest: unknown) => MockSource
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
}

type Scheduled = {
  oscillators: MockOsc[]
  sources: MockSource[]
}

function makeMockAudioContext() {
  const scheduled: Scheduled = { oscillators: [], sources: [] }
  const ctx = {
    currentTime: 0,
    state: "running" as AudioContextState,
    sampleRate: 44100,
    destination: {},
    resume: vi.fn().mockResolvedValue(undefined),
    createOscillator: (): MockOsc => {
      const osc: MockOsc = {
        type: "sine",
        frequency: { setValueAtTime: vi.fn() },
        connect: (_dest: unknown) => osc,
        start: vi.fn(),
        stop: vi.fn(),
        disconnect: vi.fn(),
      }
      scheduled.oscillators.push(osc)
      return osc
    },
    createGain: (): MockGain => {
      const gain: MockGain = {
        gain: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: (_dest: unknown) => gain,
        disconnect: vi.fn(),
      }
      return gain
    },
    createBiquadFilter: (): MockFilter => {
      const filter: MockFilter = {
        type: "lowpass",
        frequency: { setValueAtTime: vi.fn() },
        Q: { setValueAtTime: vi.fn() },
        connect: (_dest: unknown) => filter,
        disconnect: vi.fn(),
      }
      return filter
    },
    createBuffer: (_c: number, length: number, _sr: number) => ({
      length,
      getChannelData: () => new Float32Array(length),
    }),
    createBufferSource: (): MockSource => {
      const src: MockSource = {
        buffer: null,
        connect: (_dest: unknown) => src,
        start: vi.fn(),
        stop: vi.fn(),
        disconnect: vi.fn(),
      }
      scheduled.sources.push(src)
      return src
    },
  }
  return { ctx, scheduled }
}

afterEach(() => {
  vi.resetModules()
  delete (globalThis as unknown as { window?: unknown }).window
})

async function loadMelody(ctx: unknown) {
  // Minimal stub for the module's AudioContext lookup. The module only
  // calls `new window.AudioContext()`; a factory returning the mock ctx is
  // enough.
  const AudioCtor = function () {
    return ctx
  } as unknown as typeof AudioContext
  ;(globalThis as unknown as {
    window: { AudioContext: typeof AudioContext }
  }).window = {
    AudioContext: AudioCtor,
  }
  return await import("./melody")
}

describe("melody", () => {
  it("schedules one oscillator per syllable for the full line", async () => {
    const { ctx, scheduled } = makeMockAudioContext()
    const { playLine, stopAll } = await loadMelody(ctx)

    playLine(line)
    expect(scheduled.oscillators).toHaveLength(line.syllables.length)
    stopAll()
  })

  it("count-in schedules exactly `beats` tones", async () => {
    const { ctx, scheduled } = makeMockAudioContext()
    const { playCountIn, stopAll } = await loadMelody(ctx)

    playCountIn(line, 3, 0.6)
    expect(scheduled.oscillators).toHaveLength(3)
    stopAll()
  })

  it("beat track schedules only unpitched noise sources (no oscillators)", async () => {
    const { ctx, scheduled } = makeMockAudioContext()
    const { playBeatTrack, stopAll } = await loadMelody(ctx)

    playBeatTrack(line, 0, 0.6)
    // No pitched tones — this is what keeps the beat out of pitch scoring.
    expect(scheduled.oscillators).toHaveLength(0)
    expect(scheduled.sources.length).toBeGreaterThan(0)
    stopAll()
  })

  it("stopAll stops every scheduled node", async () => {
    const { ctx, scheduled } = makeMockAudioContext()
    const { playLine, playBeatTrack, stopAll } = await loadMelody(ctx)

    playLine(line)
    playBeatTrack(line, 0, 0.6)
    stopAll()

    for (const osc of scheduled.oscillators) expect(osc.stop).toHaveBeenCalled()
    for (const src of scheduled.sources) expect(src.stop).toHaveBeenCalled()
  })

  it("a silent take still scores zero after loading melody (no shared state with scoring)", async () => {
    // Import order shouldn't matter — scoring is a pure function; verify
    // explicitly in case a future melody change pulls in a module that
    // mutates globals.
    const { ctx } = makeMockAudioContext()
    await loadMelody(ctx)
    const result = scoreTurn(line, [])
    expect(result.score).toBe(0)
  })
})
