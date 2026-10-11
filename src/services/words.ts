// Capture the turn's audio alongside the pitch detector, convert it to the
// 16 kHz mono WAV the backend's Words probe expects, and POST it. If anything
// goes wrong — denied permission, decode failure, 503, or 5 s timeout — we
// return null so the caller can show "Words unavailable" instead of a fake
// number.

const API_URL = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8000"
const WORDS_TARGET_RATE = 16_000
// The first call after a backend restart has to build the per-song reference
// features (decode the mp3 + run the model), which takes several seconds on
// CPU. 5s wasn't enough and users saw "Words unavailable" on their first turn.
const WORDS_TIMEOUT_MS = 15_000

export type WordsResult = {
  words: number
  heardWords: boolean
}

export type WordsCapture = {
  // Resolves to the WAV blob (16 kHz, mono, PCM 16-bit) or null if the
  // recorder never produced any usable audio.
  stop: () => Promise<Blob | null>
  // Idempotent cleanup — safe to call on any exit path (unmount, nav, error).
  dispose: () => void
}

// Pick a mimeType the browser can both record AND decode. Firefox/Chrome
// give us webm/opus; Safari uses mp4/aac. Both go through decodeAudioData.
function pickMimeType(): string | undefined {
  const Rec = (globalThis as unknown as {
    MediaRecorder?: typeof MediaRecorder
  }).MediaRecorder
  if (!Rec) return undefined
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
  ]
  for (const t of candidates) {
    if (Rec.isTypeSupported?.(t)) return t
  }
  return undefined
}

/**
 * Start recording from the shared microphone stream. Call `stop()` once the
 * turn ends to get the WAV. The returned Blob is already resampled to
 * 16 kHz mono so it can be POSTed directly.
 */
export function startWordsCapture(stream: MediaStream): WordsCapture {
  const Rec = (globalThis as unknown as {
    MediaRecorder?: typeof MediaRecorder
  }).MediaRecorder
  if (!Rec) {
    return {
      stop: async () => null,
      dispose: () => {},
    }
  }

  const mimeType = pickMimeType()
  const options = mimeType ? { mimeType } : undefined
  let recorder: MediaRecorder
  try {
    recorder = new Rec(stream, options)
  } catch {
    return {
      stop: async () => null,
      dispose: () => {},
    }
  }

  const chunks: Blob[] = []
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data)
  }

  // Start as soon as possible; the caller usually calls stop() a few seconds later.
  try {
    recorder.start()
  } catch (err) {
    console.warn("[words] recorder.start() threw", err)
    return {
      stop: async () => null,
      dispose: () => {},
    }
  }

  let stopped = false
  const dispose = () => {
    if (recorder.state !== "inactive") {
      try {
        recorder.stop()
      } catch {
        // ignore; we're releasing on an exit path anyway.
      }
    }
  }

  const stop = (): Promise<Blob | null> => {
    if (stopped) return Promise.resolve(null)
    stopped = true
    return new Promise<Blob | null>((resolve) => {
      const finish = async () => {
        if (chunks.length === 0) {
          console.warn("[words] stop(): no chunks captured by MediaRecorder")
          resolve(null)
          return
        }
        const raw = new Blob(chunks, { type: mimeType ?? "audio/webm" })
        try {
          const wav = await rawBlobToWav16kMono(raw)
          if (!wav) console.warn("[words] rawBlobToWav16kMono returned null")
          resolve(wav)
        } catch (err) {
          console.warn("[words] rawBlobToWav16kMono threw", err)
          resolve(null)
        }
      }
      recorder.onstop = () => void finish()
      if (recorder.state === "inactive") {
        void finish()
      } else {
        try {
          recorder.stop()
        } catch {
          void finish()
        }
      }
    })
  }

  return { stop, dispose }
}

async function rawBlobToWav16kMono(raw: Blob): Promise<Blob | null> {
  const buffer = await raw.arrayBuffer()
  if (buffer.byteLength === 0) {
    console.warn("[words] raw blob was empty")
    return null
  }

  // We decode in a short-lived AudioContext so we don't tangle with the mic
  // session's context; closed immediately after.
  const AudioCtor =
    window.AudioContext as typeof AudioContext | undefined ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext
  const OfflineCtor =
    window.OfflineAudioContext as typeof OfflineAudioContext | undefined ??
    (window as unknown as {
      webkitOfflineAudioContext?: typeof OfflineAudioContext
    }).webkitOfflineAudioContext
  if (!AudioCtor || !OfflineCtor) {
    console.warn("[words] AudioContext/OfflineAudioContext unavailable")
    return null
  }

  const decodeCtx = new AudioCtor()
  let decoded: AudioBuffer
  try {
    decoded = await decodeCtx.decodeAudioData(buffer.slice(0))
  } catch (err) {
    console.warn("[words] decodeAudioData failed", err)
    void decodeCtx.close().catch(() => {})
    return null
  }
  void decodeCtx.close().catch(() => {})

  // Resample to 16 kHz mono via OfflineAudioContext.
  const durationSeconds = decoded.duration
  const targetFrames = Math.max(
    1,
    Math.round(durationSeconds * WORDS_TARGET_RATE),
  )
  const offline = new OfflineCtor(1, targetFrames, WORDS_TARGET_RATE)
  const src = offline.createBufferSource()
  src.buffer = decoded
  src.connect(offline.destination)
  src.start(0)
  const rendered = await offline.startRendering()

  return encodeWav(rendered.getChannelData(0), WORDS_TARGET_RATE)
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
 * POST the WAV to /words-score. Enforces a 5 s timeout. Returns null on any
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
    if (!response.ok) {
      console.warn("[words] /words-score responded", response.status)
      return null
    }
    const data: unknown = await response.json()
    if (!isWordsResult(data)) {
      console.warn("[words] response JSON did not match WordsResult", data)
      return null
    }
    return data
  } catch (err) {
    console.warn("[words] fetch to /words-score threw", err)
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
