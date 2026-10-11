import { displayName, lineForRound, type MatchState } from "@/domain/match"
import type { Language } from "@/domain/types"

export type MissedSyllable = {
  text: string
  romanization?: string
}

export type RoundResultPlayer = {
  id: string
  name: string
  score: number
  missedSyllables: string[]
  // What our scorer found; the backend's coach only words a tip from these.
  missedDetails: MissedSyllable[]
}

export type RoundResultPayload = {
  round: number
  lineId: string
  players: [RoundResultPlayer, RoundResultPlayer]
  winnerId: string | null
  language: Language
  songId: string
  // Default false. True means both players agreed at setup to post this
  // round to the shared Tiger Data leaderboard under their nicknames.
  optInToLeaderboard: boolean
}

export type RoundResultOptions = {
  optInToLeaderboard: boolean
}

export const PLAYER_IDS = ["p1", "p2"] as const

const MAX_REJECTION_REASONS = 3

type ValidationIssue = {
  loc?: unknown
  msg?: unknown
}

/**
 * Turns a FastAPI 422 body into short "field: problem" lines, e.g.
 * "players.0.name: String should have at least 1 character".
 */
export function describeRejection(body: unknown): string[] {
  const detail = (body as { detail?: unknown } | null)?.detail
  if (!Array.isArray(detail)) return []
  return detail.slice(0, MAX_REJECTION_REASONS).map((item) => {
    const { loc, msg } = (item ?? {}) as ValidationIssue
    const field = Array.isArray(loc)
      ? loc.filter((part) => part !== "body").join(".")
      : ""
    const problem = typeof msg === "string" ? msg : "invalid"
    return field ? `${field}: ${problem}` : problem
  })
}

/** Builds the body for `POST /round-result` from a finished round. */
export function buildRoundResultPayload(
  state: MatchState,
  options: RoundResultOptions = { optInToLeaderboard: false },
): RoundResultPayload {
  const line = lineForRound(state)
  const player = (index: 0 | 1): RoundResultPlayer => {
    const missed = state.turnMissed[index]
      .map((i) => line.syllables[i])
      .filter((syllable) => Boolean(syllable))
    return {
      id: PLAYER_IDS[index],
      name: displayName(state, index),
      score: state.turnScores[index] ?? 0,
      missedSyllables: missed.map((s) => s.text),
      missedDetails: missed.map((s) =>
        s.romanization
          ? { text: s.text, romanization: s.romanization }
          : { text: s.text },
      ),
    }
  }
  return {
    round: state.round,
    lineId: String(line.id),
    players: [player(0), player(1)],
    winnerId: state.roundWinner === null ? null : PLAYER_IDS[state.roundWinner],
    language: state.song.language,
    songId: state.song.id,
    optInToLeaderboard: options.optInToLeaderboard,
  }
}
