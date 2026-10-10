export type MicErrorKind = "blocked" | "no-device" | "generic"

export class MicrophoneError extends Error {
  kind: MicErrorKind

  constructor(kind: MicErrorKind, message: string) {
    super(message)
    this.name = "MicrophoneError"
    this.kind = kind
  }
}

export type MicrophoneHandle = {
  stream: MediaStream
  stop: () => void
}

/**
 * Request microphone access. Must only be called from a user gesture.
 * Processing (echo cancellation, noise suppression, auto gain) is disabled
 * so pitch detection sees the raw signal.
 */
export async function requestMicrophone(): Promise<MicrophoneHandle> {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new MicrophoneError(
      "no-device",
      "Microphone API is not available in this browser.",
    )
  }

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    })
  } catch (error) {
    const name = (error as { name?: string } | null)?.name ?? ""
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new MicrophoneError("blocked", "Microphone permission was denied.")
    }
    if (
      name === "NotFoundError" ||
      name === "OverconstrainedError" ||
      name === "NotReadableError"
    ) {
      throw new MicrophoneError("no-device", "No usable microphone was found.")
    }
    throw new MicrophoneError("generic", "Could not start the microphone.")
  }

  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    for (const track of stream.getTracks()) {
      track.stop()
    }
  }

  return { stream, stop }
}
