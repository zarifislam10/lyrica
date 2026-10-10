import type { MicrophoneHandle } from "@/services/microphone"

export type AudioSession = {
  ctx: AudioContext
  stream: MediaStream
  stop: () => void
  close: () => void
}

export function createAudioContext(): AudioContext | null {
  const AudioCtor: typeof AudioContext | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext
  if (!AudioCtor) return null
  const ctx = new AudioCtor()
  void ctx.resume().catch(() => {})
  return ctx
}

/** Play a silent buffer so iPhone Safari allows later announcer audio. */
export function unlockAudio(ctx: AudioContext) {
  void ctx.resume().catch(() => {})
  const buffer = ctx.createBuffer(1, 1, ctx.sampleRate)
  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.connect(ctx.destination)
  source.start(0)
}

export function sessionFromMic(
  ctx: AudioContext,
  handle: MicrophoneHandle,
): AudioSession {
  return {
    ctx,
    stream: handle.stream,
    stop: () => {
      handle.stop()
    },
    close: () => {
      handle.stop()
      if (ctx.state !== "closed") {
        void ctx.close().catch(() => {})
      }
    },
  }
}

export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12)
}
