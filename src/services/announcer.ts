import type { RoundResultPayload } from "@/domain/announcer"

// The backend gives up after 5s; the extra second covers the network.
export const ANNOUNCER_TIMEOUT_MS = 6000
export const FORCE_FALLBACK_KEY = "lyrica.forceAnnouncerFallback"

const API_URL = (
  import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8000"
).replace(/\/$/, "")

export type Announcement = {
  commentary: string
  audioUrl: string
}

export function isFallbackForced(): boolean {
  if (!import.meta.env.DEV) return false
  try {
    return localStorage.getItem(FORCE_FALLBACK_KEY) === "1"
  } catch {
    return false
  }
}

export function setFallbackForced(forced: boolean) {
  try {
    if (forced) localStorage.setItem(FORCE_FALLBACK_KEY, "1")
    else localStorage.removeItem(FORCE_FALLBACK_KEY)
  } catch {
    // ignore private mode
  }
}

/**
 * Returns live commentary + audio, or null when the caller should keep its
 * built-in line (timeout, offline, backend fallback, or missing audio).
 */
export async function fetchAnnouncement(
  payload: RoundResultPayload,
  signal: AbortSignal,
): Promise<Announcement | null> {
  if (isFallbackForced()) return null

  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), ANNOUNCER_TIMEOUT_MS)
  const onAbort = () => timeout.abort()
  signal.addEventListener("abort", onAbort)

  try {
    const response = await fetch(`${API_URL}/round-result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: timeout.signal,
    })
    if (!response.ok) {
      if (import.meta.env.DEV && response.status === 422) {
        console.error(
          "POST /round-result rejected the payload",
          payload,
          await response.json().catch(() => null),
        )
      }
      return null
    }
    const result = (await response.json()) as {
      commentary?: unknown
      audioUrl?: unknown
      fallback?: unknown
    }
    if (
      result.fallback ||
      typeof result.commentary !== "string" ||
      typeof result.audioUrl !== "string"
    ) {
      return null
    }
    return { commentary: result.commentary, audioUrl: result.audioUrl }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", onAbort)
  }
}
