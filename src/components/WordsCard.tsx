import { useEffect, useState } from "react"

import { postWordsScore, type WordsResult } from "@/services/words"

type Status = "loading" | "ready" | "unavailable"

type Phase = "pending" | "tune" | "words"

// Two side-by-side bars + a verdict + a small source line, animating in
// Tune-first. Never shows a stand-in Words number — if the backend didn't
// land a result in 5 s we fall back to "Words unavailable."
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
  const [status, setStatus] = useState<Status>(wav ? "loading" : "unavailable")
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

  // Kick off the Words fetch when the blob arrives. Any failure flips us to
  // unavailable; a stand-in Words number is never rendered.
  //
  // Cancellation is held in a per-effect local flag, not a ref. Under React 18
  // Strict Mode the effect double-mounts in dev: a ref-based flag gets reset
  // by the second mount, so the first mount's stale resolution still writes
  // to state. With both requests resolving in parallel, whichever landed last
  // decided the UI, which is how a successful 200 was still rendering as
  // "Unavailable" when the parallel sibling request returned null.
  useEffect(() => {
    let cancelled = false
    if (!wav) {
      setStatus("unavailable")
      setResult(null)
      return
    }
    setStatus("loading")
    void postWordsScore(wav, songId, lineId).then((res) => {
      if (cancelled) return
      if (!res) {
        setStatus("unavailable")
        setResult(null)
        return
      }
      setResult(res)
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
      : status === "ready"
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
            <span className="words-bar-pending">Unavailable</span>
          )}
          <span className="words-bar-caption">Did you sing the words?</span>
        </div>
      </div>
      {verdict && <p className="words-verdict">{verdict}</p>}
      <p className="words-source">Scored by a speech model, not by pitch.</p>
    </div>
  )
}
