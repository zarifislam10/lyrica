import { PitchDetector } from "pitchy"

import type { PitchSample } from "@/domain/types"

export const CLARITY_THRESHOLD = 0.8

const FFT_SIZE = 2048

type CreateOptions = {
  ctx: AudioContext
  stream: MediaStream
  onSample: (sample: PitchSample) => void
}

export type PitchStream = {
  start: (startTime: number) => void
  stop: () => void
  /** Frames analyzed since start, clear or not. */
  framesAnalyzed: () => number
}

/**
 * Pipes a MediaStream through an AnalyserNode and runs pitchy on every
 * animation frame. Emits one PitchSample per frame whose clarity meets
 * CLARITY_THRESHOLD; lower-clarity frames are dropped.
 */
export function createPitchDetector({
  ctx,
  stream,
  onSample,
}: CreateOptions): PitchStream {
  const source = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = FFT_SIZE
  source.connect(analyser)

  const buffer = new Float32Array(analyser.fftSize)
  const detector = PitchDetector.forFloat32Array(analyser.fftSize)

  let rafId = 0
  let running = false
  let startAt = 0
  let frames = 0

  const tick = () => {
    if (!running) return
    frames += 1
    analyser.getFloatTimeDomainData(buffer)
    const [hz, clarity] = detector.findPitch(buffer, ctx.sampleRate)
    if (clarity >= CLARITY_THRESHOLD && hz > 0) {
      const pitch = 69 + 12 * Math.log2(hz / 440)
      const timeMs = Math.max(0, (ctx.currentTime - startAt) * 1000)
      onSample({ timeMs, pitch, clarity })
    }
    rafId = requestAnimationFrame(tick)
  }

  return {
    start(startTime: number) {
      if (running) return
      running = true
      startAt = startTime
      frames = 0
      rafId = requestAnimationFrame(tick)
    },
    framesAnalyzed: () => frames,
    stop() {
      if (!running) return
      running = false
      cancelAnimationFrame(rafId)
      try {
        source.disconnect()
      } catch {
        // disconnect may throw if already disconnected; safe to ignore
      }
    },
  }
}
