import { describeRejection, type RoundResultPayload } from "@/domain/announcer"

// The backend gives up after 5s; the extra second covers the network.
export const ANNOUNCER_TIMEOUT_MS = 6000
export const FORCE_FALLBACK_KEY = "lyrica.forceAnnouncerFallback"

const API_URL = (
  import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8000"
).replace(/\/$/, "")

type LiveAnnouncement = {
  kind: "live"
  commentary: string
  audioUrl: string
}

type RejectedAnnouncement = {
  kind: "rejected"
  reasons: string[]
}

export type AnnouncerResult = LiveAnnouncement | {
  kind: "fallback"
} | RejectedAnnouncement

const FALLBACK: AnnouncerResult = { kind: "fallback" }

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
 * Live commentary + audio; "fallback" when the caller should keep its built-in
 * line (timeout, offline, backend fallback, or missing audio); or "rejected"
 * when the backend refused our payload (422), which means a frontend bug.
 */
export async function fetchAnnouncement(
  payload: RoundResultPayload,
  signal: AbortSignal,
): Promise<AnnouncerResult> {
  if (isFallbackForced()) return FALLBACK

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
    if (response.status === 422) {
      const body: unknown = await response.json().catch(() => null)
      if (import.meta.env.DEV) {
        console.error("POST /round-result rejected the payload", payload, body)
      }
      return { kind: "rejected", reasons: describeRejection(body) }
    }
    if (!response.ok) return FALLBACK
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
      return FALLBACK
    }
    return {
      kind: "live",
      commentary: result.commentary,
      audioUrl: result.audioUrl,
    }
  } catch {
    return FALLBACK
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", onAbort)
  }
}
