import { practiceLines } from "@/data/lines"
import type { PitchSample, PracticeLine } from "@/domain/types"

export const NAMES_STORAGE_KEY = "lyrica.playerNames"
export const MAX_NAME_LENGTH = 12
export const MAX_UNCLEAR_ATTEMPTS = 2

export type MatchPhase =
  | "home"
  | "setup"
  | "turnReady"
  | "handover"
  | "roundResult"
  | "final"

export type PlayerIndex = 0 | 1
export type RoundNumber = 1 | 2 | 3

export type MatchState = {
  phase: MatchPhase
  names: [string, string]
  round: RoundNumber
  openingSinger: PlayerIndex
  firstSinger: PlayerIndex
  currentPlayer: PlayerIndex
  turnScores: [number | null, number | null]
  turnMissed: [number[], number[]]
  turnSamples: [PitchSample[], PitchSample[]]
  roundWins: [number, number]
  unclearAttempts: [number, number]
  tieReplayUsed: boolean
}

export type MatchAction =
  | { type: "GO_SETUP" }
  | { type: "SET_NAME"; player: PlayerIndex; name: string }
  | { type: "START_MATCH" }
  | {
      type: "TURN_SCORED"
      score: number
      missed: number[]
      samples: PitchSample[]
    }
  | { type: "TURN_UNCLEAR" }
  | { type: "HANDOVER_DONE" }
  | { type: "ROUND_CONTINUE" }
  | { type: "REMATCH" }
  | { type: "GO_HOME" }

export const PLAYER_COLORS: [string, string] = ["#FF4FA3", "#19B5FF"]

const emptyTurn = {
  turnScores: [null, null] as [number | null, number | null],
  turnMissed: [[], []] as [number[], number[]],
  turnSamples: [[], []] as [PitchSample[], PitchSample[]],
  unclearAttempts: [0, 0] as [number, number],
}

export function loadStoredNames(): [string, string] {
  try {
    const raw = localStorage.getItem(NAMES_STORAGE_KEY)
    if (!raw) return ["", ""]
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed) || parsed.length < 2) return ["", ""]
    return [String(parsed[0] ?? ""), String(parsed[1] ?? "")]
  } catch {
    return ["", ""]
  }
}

export function persistNames(names: [string, string]) {
  try {
    localStorage.setItem(NAMES_STORAGE_KEY, JSON.stringify(names))
  } catch {
    // ignore quota / private mode
  }
}

export function normalizeName(name: string, player: PlayerIndex): string {
  const trimmed = name.trim().slice(0, MAX_NAME_LENGTH)
  return trimmed || `Player ${player + 1}`
}

export function displayName(state: MatchState, player: PlayerIndex): string {
  if (state.names[0] === state.names[1]) {
    return `${state.names[player]} ${player + 1}`
  }
  return state.names[player]
}

export function lineForRound(round: RoundNumber): PracticeLine {
  return practiceLines[round - 1] ?? practiceLines[0]
}

export function createMatchState(
  names: [string, string] = ["", ""],
): MatchState {
  return {
    phase: "home",
    names,
    round: 1,
    openingSinger: 0,
    firstSinger: 0,
    currentPlayer: 0,
    roundWins: [0, 0],
    tieReplayUsed: false,
    ...emptyTurn,
  }
}

function otherPlayer(player: PlayerIndex): PlayerIndex {
  return player === 0 ? 1 : 0
}

function allMissed(round: RoundNumber): number[] {
  return lineForRound(round).syllables.map((_, index) => index)
}

function decideRoundWinner(state: MatchState): PlayerIndex {
  const [a, b] = state.turnScores
  const scoreA = a ?? 0
  const scoreB = b ?? 0
  if (scoreA !== scoreB) return scoreA > scoreB ? 0 : 1
  const missedA = state.turnMissed[0].length
  const missedB = state.turnMissed[1].length
  if (missedA !== missedB) return missedA < missedB ? 0 : 1
  return state.firstSinger
}

function afterBothSung(state: MatchState): MatchState {
  const [scoreA, scoreB] = state.turnScores
  const tied = (scoreA ?? 0) === (scoreB ?? 0)

  if (tied && !state.tieReplayUsed) {
    return {
      ...state,
      phase: "turnReady",
      currentPlayer: state.firstSinger,
      tieReplayUsed: true,
      ...emptyTurn,
    }
  }

  const winner = decideRoundWinner(state)
  const roundWins: [number, number] = [...state.roundWins]
  roundWins[winner] += 1

  return { ...state, phase: "roundResult", roundWins }
}

export function isMatchOver(state: MatchState): boolean {
  return (
    state.roundWins[0] >= 2 || state.roundWins[1] >= 2 || state.round === 3
  )
}

export function roundWinner(state: MatchState): PlayerIndex {
  return decideRoundWinner(state)
}

function applyTurnScore(
  state: MatchState,
  payload: { score: number; missed: number[]; samples: PitchSample[] },
): MatchState {
  const player = state.currentPlayer
  const turnScores: [number | null, number | null] = [...state.turnScores]
  const turnMissed: [number[], number[]] = [
    [...state.turnMissed[0]],
    [...state.turnMissed[1]],
  ]
  const turnSamples: [PitchSample[], PitchSample[]] = [
    [...state.turnSamples[0]],
    [...state.turnSamples[1]],
  ]
  turnScores[player] = payload.score
  turnMissed[player] = payload.missed
  turnSamples[player] = payload.samples

  const next: MatchState = {
    ...state,
    turnScores,
    turnMissed,
    turnSamples,
    unclearAttempts: [0, 0],
  }

  const opponent = otherPlayer(player)
  if (next.turnScores[opponent] == null) {
    return {
      ...next,
      phase: "handover",
      currentPlayer: opponent,
    }
  }
  return afterBothSung(next)
}

export function matchReducer(state: MatchState, action: MatchAction): MatchState {
  switch (action.type) {
    case "GO_SETUP":
      return { ...state, phase: "setup" }
    case "SET_NAME": {
      const names: [string, string] = [...state.names]
      names[action.player] = action.name.slice(0, MAX_NAME_LENGTH)
      return { ...state, names }
    }
    case "START_MATCH": {
      const names: [string, string] = [
        normalizeName(state.names[0], 0),
        normalizeName(state.names[1], 1),
      ]
      persistNames(state.names)
      return {
        ...createMatchState(names),
        phase: "turnReady",
        firstSinger: 0,
        currentPlayer: 0,
      }
    }
    case "TURN_SCORED":
      if (state.phase !== "turnReady") return state
      return applyTurnScore(state, action)
    case "TURN_UNCLEAR": {
      if (state.phase !== "turnReady") return state
      const unclearAttempts: [number, number] = [...state.unclearAttempts]
      unclearAttempts[state.currentPlayer] += 1
      if (unclearAttempts[state.currentPlayer] >= MAX_UNCLEAR_ATTEMPTS) {
        return applyTurnScore(
          { ...state, unclearAttempts },
          {
            score: 0,
            missed: allMissed(state.round),
            samples: [],
          },
        )
      }
      return { ...state, unclearAttempts }
    }
    case "HANDOVER_DONE":
      if (state.phase !== "handover") return state
      return { ...state, phase: "turnReady" }
    case "ROUND_CONTINUE": {
      if (state.phase !== "roundResult") return state
      if (isMatchOver(state)) return { ...state, phase: "final" }
      const nextRound = (state.round + 1) as RoundNumber
      const firstSinger = otherPlayer(state.firstSinger)
      return {
        ...state,
        phase: "turnReady",
        round: nextRound,
        firstSinger,
        currentPlayer: firstSinger,
        tieReplayUsed: false,
        ...emptyTurn,
      }
    }
    case "REMATCH": {
      const opener = otherPlayer(state.openingSinger)
      return {
        ...createMatchState(state.names),
        phase: "turnReady",
        openingSinger: opener,
        firstSinger: opener,
        currentPlayer: opener,
      }
    }
    case "GO_HOME":
      return { ...createMatchState(state.names), phase: "home" }
    default:
      return state
  }
}

export function fallbackCommentary(state: MatchState): string {
  const winner = decideRoundWinner(state)
  return `${displayName(state, winner)} takes round ${state.round}`
}
