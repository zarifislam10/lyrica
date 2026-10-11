import { describe, expect, it } from "vitest"

import { buildRoundResultPayload, describeRejection } from "@/domain/announcer"
import { createMatchState, matchReducer } from "@/domain/match"

function finishedRound(names: [string, string] = ["Ava", "Sam"]) {
  let state = matchReducer(createMatchState(names), {
    type: "CHOOSE_MODE",
    mode: "battle",
  })
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
        { id: "p1", name: "Ava", score: 82, missedSyllables: ["birth"] },
        { id: "p2", name: "Sam", score: 74, missedSyllables: ["py", "birth"] },
      ],
      winnerId: "p1",
    })
  })

  it("sends numbered names when both players share a name", () => {
    const payload = buildRoundResultPayload(finishedRound(["Ava", "Ava"]))
    expect(payload.players.map((p) => p.name)).toEqual(["Ava 1", "Ava 2"])
  })
})

describe("describeRejection", () => {
  it("names the rejected field and the problem", () => {
    expect(
      describeRejection({
        detail: [
          {
            loc: ["body", "players", 0, "name"],
            msg: "String should have at least 1 character",
          },
          {
            loc: ["body", "round"],
            msg: "Input should be less than or equal to 3",
          },
        ],
      }),
    ).toEqual([
      "players.0.name: String should have at least 1 character",
      "round: Input should be less than or equal to 3",
    ])
  })

  it("keeps a model-level error that has no field", () => {
    expect(
      describeRejection({
        detail: [
          { loc: ["body"], msg: "Value error, Player IDs must be distinct" },
        ],
      }),
    ).toEqual(["Value error, Player IDs must be distinct"])
  })

  it("shows at most three reasons", () => {
    const detail = Array.from({ length: 5 }, (_, i) => ({
      loc: ["body", `f${i}`],
      msg: "bad",
    }))
    expect(describeRejection({ detail })).toHaveLength(3)
  })

  it("returns nothing for bodies it doesn't understand", () => {
    expect(describeRejection(null)).toEqual([])
    expect(describeRejection({ detail: "Not Found" })).toEqual([])
    expect(describeRejection("oops")).toEqual([])
  })
})
