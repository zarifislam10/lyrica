// Frontend side of the voice-clone router.
//
// The server returns an opaque session id; the real ElevenLabs voice id
// never crosses the wire. Everything in this file is thin fetch glue —
// errors are mapped to a small set of codes so the UI can show a friendly
// message and fall back to the standard "Hear it" clip.
//
// Rules from AGENTS.md:
//   - Explicit player opt-in before we record (handled by the caller).
//   - Delete the clone when the match ends, on rematch, and on leave.
//   - Never log or persist the recorded sample anywhere on the client.

const API_URL = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8000"

export type VoiceCloneErrorCode = "network" | "too-large" | "rejected" | "unsupported" | "expired" | "unknown"

export class VoiceCloneError extends Error {
  code: VoiceCloneErrorCode

  constructor(code: VoiceCloneErrorCode, message: string) {
    super(message)
    this.name = "VoiceCloneError"
    this.code = code
  }
}

function errorFromStatus(status: number): VoiceCloneErrorCode {
  if (status === 413) return "too-large"
  if (status === 400 || status === 422) return "rejected"
  if (status === 404) return "expired"
  if (status === 503) return "unsupported"
  return "unknown"
}

/** Upload a sample WAV/WebM to the server. Returns an opaque session id. */
export async function cloneVoice(
  sample: Blob,
  options?: { signal?: AbortSignal },
): Promise<string> {
  const form = new FormData()
  // Filename only matters for ElevenLabs' MIME sniffing; the backend doesn't
  // read it. Use a neutral name.
  form.append("sample", sample, "sample.webm")

  let response: Response
  try {
    response = await fetch(`${API_URL}/voice/clone`, {
      method: "POST",
      body: form,
      signal: options?.signal,
    })
  } catch (err) {
    if ((err as DOMException | null)?.name === "AbortError") throw err
    throw new VoiceCloneError("network", "Could not reach the voice service.")
  }

  if (!response.ok) {
    throw new VoiceCloneError(
      errorFromStatus(response.status),
      "The voice service refused the sample.",
    )
  }

  const body = (await response.json().catch(() => null)) as {
    sessionId?: unknown
  } | null
  const sessionId =
    body && typeof body.sessionId === "string" ? body.sessionId : ""
  if (!sessionId) {
    throw new VoiceCloneError("unknown", "No session id was returned.")
  }
  return sessionId
}

/** Ask the server to read one line in the cloned voice. Returns MP3 bytes. */
export async function sayLine(args: {
  sessionId: string
  songId: string
  lineId: number
  text: string
  language: string
  signal?: AbortSignal
}): Promise<Blob> {
  let response: Response
  try {
    response = await fetch(`${API_URL}/voice/say`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: args.sessionId,
        songId: args.songId,
        lineId: args.lineId,
        text: args.text,
        language: args.language,
      }),
      signal: args.signal,
    })
  } catch (err) {
    if ((err as DOMException | null)?.name === "AbortError") throw err
    throw new VoiceCloneError("network", "Could not reach the voice service.")
  }

  if (!response.ok) {
    throw new VoiceCloneError(
      errorFromStatus(response.status),
      "The voice service could not generate audio.",
    )
  }
  return await response.blob()
}

/** Idempotent. Best-effort: use `keepalive` so a page close still triggers it. */
export async function deleteVoice(sessionId: string): Promise<void> {
  if (!sessionId) return
  try {
    await fetch(`${API_URL}/voice/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      // keepalive lets the request outlive the page: important for the
      // "player closed the tab" case so clones aren't left behind.
      keepalive: true,
    })
  } catch {
    // Non-fatal: the server's 30-minute sweeper will clean up either way.
  }
}
