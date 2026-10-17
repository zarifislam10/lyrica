// Capture the turn's audio by tapping the shared microphone stream through
// an AudioWorklet. We write our own WAV with the AudioContext's known
// sample rate, so playback matches the recording exactly (no webm/opus
// container, no decoding step, no duration=Infinity bug).
//
// Any failure (worklet unsupported, dispose called before stop, 503, or
// 15 s timeout) returns null so the caller can show "Words unavailable"
// instead of a fake number.

const API_URL = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8000"
// The first call after a backend restart has to build the per-song reference
// features (decode the mp3 + run the model), which takes several seconds on
// CPU. 5s wasn't enough and users saw "Words unavailable" on their first turn.
const WORDS_TIMEOUT_MS = 15_000

const WORKLET_URL = "/recorder-processor.js"
const WORKLET_NAME = "recorder-processor"

export type WordsResult = {
  words: number
  heardWords: boolean
}

export type WordsCapture = {
  // Resolves to the WAV blob (AudioContext.sampleRate, mono, PCM 16-bit) or
  // null if nothing was recorded.
  stop: () => Promise<Blob | null>
  // Idempotent cleanup — safe to call on any exit path (unmount, nav, error).
  dispose: () => void
}

/**
 * Start recording from the shared microphone stream using an AudioWorklet.
 * The returned `stop()` resolves to a WAV blob at the AudioContext's native
 * sample rate.
 */
export function startWordsCapture(
  stream: MediaStream,
  ctx: AudioContext,
): WordsCapture {
  // Fast exit if AudioWorklet isn't available (very old Safari).
  if (!ctx.audioWorklet || typeof AudioWorkletNode === "undefined") {
    return {
      stop: async () => null,
      dispose: () => {},
    }
  }

  const sampleRate = ctx.sampleRate
  let source: MediaStreamAudioSourceNode | null = null
  let node: AudioWorkletNode | null = null
  const chunks: Float32Array[] = []
  let totalSamples = 0
  let disposed = false
  let settled = false

  try {
    source = ctx.createMediaStreamSource(stream)
  } catch {
    return {
      stop: async () => null,
      dispose: () => {},
    }
  }

  // addModule is idempotent — the browser dedupes repeat calls per context.
  const nodePromise: Promise<AudioWorkletNode | null> = ctx.audioWorklet
    .addModule(WORKLET_URL)
    .then(() => {
      if (disposed || !source) return null
      const n = new AudioWorkletNode(ctx, WORKLET_NAME)
      n.port.onmessage = (event: MessageEvent) => {
        if (settled) return
        const chunk = event.data as Float32Array
        chunks.push(chunk)
        totalSamples += chunk.length
      }
      source.connect(n)
      // Deliberately NOT connected to ctx.destination — that would echo
      // the mic to the speakers.
      node = n
      return n
    })
    .catch(() => null)

  const teardown = () => {
    try {
      node?.disconnect()
    } catch {
      // ignore
    }
    try {
      source?.disconnect()
    } catch {
      // ignore
    }
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    settled = true
    void nodePromise.then(teardown)
  }

  const stop = async (): Promise<Blob | null> => {
    if (settled) return null
    settled = true
    await nodePromise
    teardown()
    if (totalSamples === 0) return null
    const merged = new Float32Array(totalSamples)
    let offset = 0
    for (const c of chunks) {
      merged.set(c, offset)
      offset += c.length
    }
    return encodeWav(merged, sampleRate)
  }

  return { stop, dispose }
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const byteLength = 44 + samples.length * 2
  const buffer = new ArrayBuffer(byteLength)
  const view = new DataView(buffer)

  // RIFF header
  writeAscii(view, 0, "RIFF")
  view.setUint32(4, byteLength - 8, true)
  writeAscii(view, 8, "WAVE")

  // fmt chunk
  writeAscii(view, 12, "fmt ")
  view.setUint32(16, 16, true) // chunk size for PCM
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate (mono * 16-bit)
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample

  // data chunk
  writeAscii(view, 36, "data")
  view.setUint32(40, samples.length * 2, true)
  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(
      offset,
      clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
      true,
    )
    offset += 2
  }

  return new Blob([buffer], { type: "audio/wav" })
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i))
  }
}

/**
 * POST the WAV to /words-score. Enforces a 15 s timeout. Returns null on any
 * failure (timeout, 503, non-OK, bad JSON) so the caller can show
 * "Words unavailable" instead of a stand-in number.
 */
export async function postWordsScore(
  wav: Blob,
  songId: string,
  lineId: number,
): Promise<WordsResult | null> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), WORDS_TIMEOUT_MS)
  try {
    const form = new FormData()
    form.append("songId", songId)
    form.append("lineId", String(lineId))
    form.append("audio", wav, "take.wav")
    const response = await fetch(`${API_URL}/words-score`, {
      method: "POST",
      body: form,
      signal: controller.signal,
    })
    if (!response.ok) return null
    const data: unknown = await response.json()
    if (!isWordsResult(data)) return null
    return data
  } catch {
    return null
  } finally {
    window.clearTimeout(timer)
  }
}

type WordsResultLike = {
  words?: unknown
  heardWords?: unknown
}

function isWordsResult(data: unknown): data is WordsResult {
  if (!data || typeof data !== "object") return false
  const d = data as WordsResultLike
  return typeof d.words === "number" && typeof d.heardWords === "boolean"
}
