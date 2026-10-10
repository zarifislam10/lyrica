import { displayName, lineForRound, type MatchState } from "@/domain/match"

export type RoundResultPlayer = {
  id: string
  name: string
  score: number
  missedSyllables: string[]
}

export type RoundResultPayload = {
  round: number
  lineId: string
  players: [RoundResultPlayer, RoundResultPlayer]
  winnerId: string | null
}

const PLAYER_IDS = ["p1", "p2"] as const

/** Builds the body for `POST /round-result` from a finished round. */
export function buildRoundResultPayload(state: MatchState): RoundResultPayload {
  const line = lineForRound(state.round)
  const player = (index: 0 | 1): RoundResultPlayer => ({
    id: PLAYER_IDS[index],
    name: displayName(state, index),
    score: state.turnScores[index] ?? 0,
    missedSyllables: state.turnMissed[index]
      .map((i) => line.syllables[i]?.hangul)
      .filter((text): text is string => Boolean(text)),
  })
  return {
    round: state.round,
    lineId: String(line.id),
    players: [player(0), player(1)],
    winnerId: state.roundWinner === null ? null : PLAYER_IDS[state.roundWinner],
  }
}
