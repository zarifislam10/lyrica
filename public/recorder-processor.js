// AudioWorklet processor that forwards microphone samples to the main
// thread. We buffer ~4096 Float32 samples per message to keep postMessage
// overhead low (vs. the default 128-sample callback).
//
// The main thread stitches the chunks together and encodes a WAV with the
// AudioContext's known sample rate — no container, no decoding, so playback
// matches the recording exactly.

const CHUNK_SIZE = 4096

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._buffer = new Float32Array(CHUNK_SIZE)
    this._offset = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true
    const channel = input[0]
    if (!channel || channel.length === 0) return true

    let i = 0
    while (i < channel.length) {
      const space = CHUNK_SIZE - this._offset
      const take = Math.min(space, channel.length - i)
      this._buffer.set(channel.subarray(i, i + take), this._offset)
      this._offset += take
      i += take
      if (this._offset >= CHUNK_SIZE) {
        const out = this._buffer
        this.port.postMessage(out, [out.buffer])
        this._buffer = new Float32Array(CHUNK_SIZE)
        this._offset = 0
      }
    }
    return true
  }
}

registerProcessor("recorder-processor", RecorderProcessor)
