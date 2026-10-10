import { describe, expect, it } from "vitest"

import {
  createMatchState,
  displayName,
  matchReducer,
  normalizeName,
} from "@/domain/match"

const p1Score = {
  type: "TURN_SCORED" as const,
  score: 80,
  missed: [1],
  samples: [],
}

const p2Score = {
  type: "TURN_SCORED" as const,
  score: 70,
  missed: [2],
  samples: [],
}

function started() {
  const setup = matchReducer(createMatchState(["Ava", "Sam"]), {
    type: "GO_SETUP",
  })
  return matchReducer(setup, { type: "START_MATCH" })
}

describe("matchReducer", () => {
  it("starts a match on turnReady with player 0 first", () => {
    const state = started()
    expect(state.phase).toBe("turnReady")
    expect(state.currentPlayer).toBe(0)
    expect(state.round).toBe(1)
    expect(state.names).toEqual(["Ava", "Sam"])
  })

  it("falls back to Player 1 / Player 2 for empty names", () => {
    expect(normalizeName("  ", 0)).toBe("Player 1")
    expect(normalizeName("", 1)).toBe("Player 2")
    expect(normalizeName("VeryLongPlayerName", 0)).toBe("VeryLongPlay")
  })

  it("hides P1's score behind handover until P2 sings", () => {
    const afterP1 = matchReducer(started(), p1Score)
    expect(afterP1.phase).toBe("handover")
    expect(afterP1.currentPlayer).toBe(1)
    expect(afterP1.turnScores[0]).toBe(80)

    const readyP2 = matchReducer(afterP1, { type: "HANDOVER_DONE" })
    expect(readyP2.phase).toBe("turnReady")
    expect(readyP2.currentPlayer).toBe(1)

    const afterP2 = matchReducer(readyP2, p2Score)
    expect(afterP2.phase).toBe("roundResult")
    expect(afterP2.roundWins).toEqual([1, 0])
  })

  it("replays a tied round once, then breaks the second tie", () => {
    const afterP1 = matchReducer(started(), p1Score)
    const readyP2 = matchReducer(afterP1, { type: "HANDOVER_DONE" })
    const tied = matchReducer(readyP2, { ...p2Score, score: 80 })
    expect(tied.phase).toBe("turnReady")
    expect(tied.tieReplayUsed).toBe(true)
    expect(tied.turnScores).toEqual([null, null])
    expect(tied.currentPlayer).toBe(0)

    const replayP1 = matchReducer(tied, { ...p1Score, missed: [1, 2] })
    const replayP2 = matchReducer(
      matchReducer(replayP1, { type: "HANDOVER_DONE" }),
      { ...p2Score, score: 80, missed: [1] },
    )
    expect(replayP2.phase).toBe("roundResult")
    expect(replayP2.roundWins).toEqual([0, 1])
  })

  it("alternates who sings first and skips round 3 at 2-0", () => {
    let state = started()
    const avaWinsTurn = () =>
      matchReducer(state, {
        ...p1Score,
        score: state.currentPlayer === 0 ? 90 : 60,
      })
    for (let round = 0; round < 2; round += 1) {
      expect(state.currentPlayer).toBe(round === 0 ? 0 : 1)
      state = avaWinsTurn()
      state = matchReducer(state, { type: "HANDOVER_DONE" })
      state = avaWinsTurn()
      expect(state.phase).toBe("roundResult")
      state = matchReducer(state, { type: "ROUND_CONTINUE" })
    }
    expect(state.phase).toBe("final")
    expect(state.roundWins).toEqual([2, 0])
    expect(state.round).toBe(2)
  })

  it("scores 0 after two unclear takes", () => {
    let state = started()
    state = matchReducer(state, { type: "TURN_UNCLEAR" })
    expect(state.phase).toBe("turnReady")
    state = matchReducer(state, { type: "TURN_UNCLEAR" })
    expect(state.phase).toBe("handover")
    expect(state.turnScores[0]).toBe(0)
  })

  it("rematch keeps names and swaps who sings first", () => {
    let state = started()
    state = matchReducer(state, p1Score)
    state = matchReducer(state, { type: "HANDOVER_DONE" })
    state = matchReducer(state, p2Score)
    state = matchReducer(state, { type: "ROUND_CONTINUE" })
    const rematch = matchReducer(state, { type: "REMATCH" })
    expect(rematch.phase).toBe("turnReady")
    expect(rematch.names).toEqual(["Ava", "Sam"])
    expect(rematch.roundWins).toEqual([0, 0])
    expect(rematch.firstSinger).toBe(1)
    expect(rematch.currentPlayer).toBe(1)

    const second = matchReducer(rematch, { type: "REMATCH" })
    expect(second.firstSinger).toBe(0)
  })

  it("numbers identical names", () => {
    const state = { ...started(), names: ["Ava", "Ava"] as [string, string] }
    expect(displayName(state, 0)).toBe("Ava 1")
    expect(displayName(state, 1)).toBe("Ava 2")
  })
})
