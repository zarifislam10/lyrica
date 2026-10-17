import { useEffect, useState } from "react"

import { postWordsScore, type WordsResult } from "@/services/words"

type Status = "loading" | "ready" | "unavailable"

type Phase = "pending" | "tune" | "words"

// Threshold for "Aux heard the words." vs the retry line.
const HEARD_WORDS_THRESHOLD = 50

// Two side-by-side bars + a verdict + a small source line, animating in
// Tune-first. Per AGENTS.md: never fabricate a Words number. If the backend
// doesn't land a real score, we render "Words — coming soon" (no number).
export default function WordsCard({
  tune,
  wav,
  songId,
  lineId,
}: {
  tune: number
  wav: Blob | null
  songId: string
  lineId: number
}) {
  const [status, setStatus] = useState<Status>("loading")
  const [result, setResult] = useState<WordsResult | null>(null)
  const [phase, setPhase] = useState<Phase>("pending")

  // One-shot: swap pending → tune → words so the cards animate in order.
  useEffect(() => {
    const tuneTimer = window.setTimeout(() => setPhase("tune"), 120)
    const wordsTimer = window.setTimeout(() => setPhase("words"), 560)
    return () => {
      window.clearTimeout(tuneTimer)
      window.clearTimeout(wordsTimer)
    }
  }, [])

  // Fetch the real Words score. Null = backend offline, cold model, timeout,
  // or any other failure path — we fall back to "coming soon" rather than
  // inventing a number. Cancellation is held in a per-effect local flag so
  // React Strict Mode's double-mount can't race the two resolutions.
  useEffect(() => {
    let cancelled = false
    setStatus("loading")
    setResult(null)
    if (!wav) {
      setStatus("unavailable")
      return
    }
    void postWordsScore(wav, songId, lineId).then((data) => {
      if (cancelled) return
      if (data == null) {
        setStatus("unavailable")
        return
      }
      setResult(data)
      setStatus("ready")
    })
    return () => {
      cancelled = true
    }
  }, [wav, songId, lineId])

  const showWordsNumber = status === "ready" && result != null
  const verdict =
    status === "ready" && result?.heardWords
      ? "Aux heard the words."
      : status === "ready" &&
          result != null &&
          result.words < HEARD_WORDS_THRESHOLD
        ? "Aux heard the tune, but not the words. Try singing the line."
        : null

  return (
    <div className="words-card">
      <div className="words-bars">
        <div
          className={`words-bar tune ${phase !== "pending" ? "enter" : ""}`}
          aria-label="Tune score"
        >
          <small>Tune</small>
          <strong>{tune}</strong>
          <span className="words-bar-caption">Did you hit the notes?</span>
        </div>
        <div
          className={`words-bar words ${phase === "words" ? "enter" : ""} ${
            status
          }`}
          aria-live="polite"
          aria-busy={status === "loading"}
          aria-label="Words score"
        >
          <small>Words</small>
          {showWordsNumber ? (
            <strong>{result.words}</strong>
          ) : status === "loading" ? (
            <span className="words-bar-pending">Listening…</span>
          ) : (
            <span className="words-bar-pending">Coming soon</span>
          )}
          <span className="words-bar-caption">Did you sing the words?</span>
        </div>
      </div>
      {verdict && <p className="words-verdict">{verdict}</p>}
      <p className="words-source">Scored by a speech model, not by pitch.</p>
    </div>
  )
}
