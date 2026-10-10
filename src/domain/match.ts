import { practiceLines } from "@/data/lines"
import type { PitchSample, PracticeLine } from "@/domain/types"

export const NAMES_STORAGE_KEY = "lyrica.playerNames"
export const MAX_NAME_LENGTH = 12

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
  turnTiming: [number | null, number | null]
  turnMissed: [number[], number[]]
  turnSamples: [PitchSample[], PitchSample[]]
  roundWins: [number, number]
  roundWinner: PlayerIndex | null
  // How many times the current round has been replayed after a tie.
  replays: number
}

export type MatchAction =
  | { type: "GO_SETUP" }
  | { type: "SET_NAME"; player: PlayerIndex; name: string }
  | { type: "START_MATCH" }
  | {
      type: "TURN_SCORED"
      score: number
      timing: number
      missed: number[]
      samples: PitchSample[]
    }
  | { type: "HANDOVER_DONE" }
  | { type: "ROUND_CONTINUE" }
  | { type: "REMATCH" }
  | { type: "GO_HOME" }

export const PLAYER_COLORS: [string, string] = ["#FF4FA3", "#19B5FF"]

const emptyTurn = {
  turnScores: [null, null] as [number | null, number | null],
  turnTiming: [null, null] as [number | null, number | null],
  turnMissed: [[], []] as [number[], number[]],
  turnSamples: [[], []] as [PitchSample[], PitchSample[]],
  roundWinner: null,
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
    replays: 0,
    ...emptyTurn,
  }
}

function otherPlayer(player: PlayerIndex): PlayerIndex {
  return player === 0 ? 1 : 0
}

function higher(a: number, b: number): PlayerIndex | null {
  if (a === b) return null
  return a > b ? 0 : 1
}

// A tied score replays the round once. After that, the better timing score
// wins; if timing is also equal, the round is replayed again.
function afterBothSung(state: MatchState): MatchState {
  const byScore = higher(state.turnScores[0] ?? 0, state.turnScores[1] ?? 0)
  const byTiming =
    state.replays > 0
      ? higher(state.turnTiming[0] ?? 0, state.turnTiming[1] ?? 0)
      : null
  const winner = byScore ?? byTiming

  if (winner === null) {
    return {
      ...state,
      phase: "turnReady",
      currentPlayer: state.firstSinger,
      replays: state.replays + 1,
      ...emptyTurn,
    }
  }

  const roundWins: [number, number] = [...state.roundWins]
  roundWins[winner] += 1
  return { ...state, phase: "roundResult", roundWins, roundWinner: winner }
}

export function isMatchOver(state: MatchState): boolean {
  return (
    state.roundWins[0] >= 2 || state.roundWins[1] >= 2 || state.round === 3
  )
}

function applyTurnScore(
  state: MatchState,
  payload: {
    score: number
    timing: number
    missed: number[]
    samples: PitchSample[]
  },
): MatchState {
  const player = state.currentPlayer
  const turnScores: [number | null, number | null] = [...state.turnScores]
  const turnTiming: [number | null, number | null] = [...state.turnTiming]
  const turnMissed: [number[], number[]] = [
    [...state.turnMissed[0]],
    [...state.turnMissed[1]],
  ]
  const turnSamples: [PitchSample[], PitchSample[]] = [
    [...state.turnSamples[0]],
    [...state.turnSamples[1]],
  ]
  turnScores[player] = payload.score
  turnTiming[player] = payload.timing
  turnMissed[player] = payload.missed
  turnSamples[player] = payload.samples

  const next: MatchState = {
    ...state,
    turnScores,
    turnTiming,
    turnMissed,
    turnSamples,
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
        replays: 0,
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
  if (state.roundWinner === null) return `Round ${state.round} is done`
  return `${displayName(state, state.roundWinner)} takes round ${state.round}`
}
