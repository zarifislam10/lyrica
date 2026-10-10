import { describe, expect, it } from "vitest"

import { buildRoundResultPayload } from "@/domain/announcer"
import { createMatchState, matchReducer } from "@/domain/match"

function finishedRound(names: [string, string] = ["Ava", "Sam"]) {
  let state = matchReducer(createMatchState(names), { type: "GO_SETUP" })
  state = matchReducer(state, { type: "START_MATCH" })
  state = matchReducer(state, {
    type: "TURN_SCORED",
    score: 82,
    timing: 0.9,
    missed: [2],
    samples: [],
  })
  state = matchReducer(state, { type: "HANDOVER_DONE" })
  return matchReducer(state, {
    type: "TURN_SCORED",
    score: 74,
    timing: 0.8,
    missed: [1, 2],
    samples: [],
  })
}

describe("buildRoundResultPayload", () => {
  it("matches the backend contract", () => {
    expect(buildRoundResultPayload(finishedRound())).toEqual({
      round: 1,
      lineId: "1",
      players: [
        { id: "p1", name: "Ava", score: 82, missedSyllables: ["하"] },
        { id: "p2", name: "Sam", score: 74, missedSyllables: ["녕", "하"] },
      ],
      winnerId: "p1",
    })
  })

  it("sends numbered names when both players share a name", () => {
    const payload = buildRoundResultPayload(finishedRound(["Ava", "Ava"]))
    expect(payload.players.map((p) => p.name)).toEqual(["Ava 1", "Ava 2"])
  })
})
