import { useEffect, useState } from "react"

import type { Language } from "@/domain/types"

type Entry = {
  player: string
  bestTune: number
  turns: number
}

type Hardest = {
  syllable: string
  misses: number
}

const API_URL = (
  import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8000"
).replace(/\/$/, "")

const LANGUAGE_LABEL: Record<Language, string> = {
  en: "English",
  ko: "Korean",
  ar: "Arabic",
}

async function fetchJson<T>(path: string, signal: AbortSignal): Promise<T[]> {
  try {
    const response = await fetch(`${API_URL}${path}`, { signal })
    if (!response.ok) return []
    const body = (await response.json()) as unknown
    return Array.isArray(body) ? body as T[] : []
  } catch {
    return []
  }
}

export default function LeaderboardPanel({ language }: { language: Language }) {
  const [top, setTop] = useState<Entry[]>([])
  const [hardest, setHardest] = useState<Hardest[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    const query = `?language=${language}`
    Promise.all([
      fetchJson<Entry>(`/leaderboard${query}`, controller.signal),
      fetchJson<Hardest>(`/leaderboard/hardest${query}`, controller.signal),
    ]).then(([t, h]) => {
      if (controller.signal.aborted) return
      setTop(t)
      setHardest(h)
      setLoaded(true)
    })
    return () => controller.abort()
  }, [language])

  if (!loaded) return null
  if (top.length === 0 && hardest.length === 0) return null

  return (
    <section className="leaderboard-panel" aria-label="Leaderboard">
      <header>
        <h2>{LANGUAGE_LABEL[language]} leaderboard</h2>
      </header>
      {top.length > 0 && (
        <ol className="leaderboard-list">
          {top.map((entry) => (
            <li key={entry.player}>
              <span>{entry.player}</span>
              <b>{entry.bestTune}</b>
            </li>
          ))}
        </ol>
      )}
      {hardest.length > 0 && (
        <div className="leaderboard-hardest">
          <small>Hardest syllables</small>
          <ul>
            {hardest.map((row) => (
              <li key={row.syllable}>
                <span>{row.syllable}</span>
                <b>×{row.misses}</b>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
