import { describe, expect, it } from "vitest"

import { songs } from "@/data/songs"

import {
  ROUNDS_PER_MATCH,
  createMatchState,
  displayName,
  fallbackCommentary,
  lineForRound,
  matchReducer,
  normalizeName,
  soloTotal,
  type GameMode,
  type MatchState,
  type RoundNumber,
} from "@/domain/match"

function turn(score: number, timing = 0.8, missed: number[] = []) {
  return {
    type: "TURN_SCORED" as const,
    score,
    timing,
    missed,
    samples: [],
  }
}

function started(mode: GameMode = "battle", rounds?: RoundNumber) {
  const picking = matchReducer(
    createMatchState(["Ava", "Sam"], "battle", songs[0], rounds),
    { type: "GO_MODE" },
  )
  const setup = matchReducer(picking, { type: "CHOOSE_MODE", mode })
  return matchReducer(setup, { type: "START_MATCH" })
}

function playRound(
  state: MatchState,
  first: ReturnType<typeof turn>,
  second: ReturnType<typeof turn>,
) {
  const afterFirst = matchReducer(state, first)
  const ready = matchReducer(afterFirst, { type: "HANDOVER_DONE" })
  return matchReducer(ready, second)
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
    const afterP1 = matchReducer(started(), turn(80))
    expect(afterP1.phase).toBe("handover")
    expect(afterP1.currentPlayer).toBe(1)
    expect(afterP1.turnScores[0]).toBe(80)

    const readyP2 = matchReducer(afterP1, { type: "HANDOVER_DONE" })
    expect(readyP2.phase).toBe("turnReady")
    expect(readyP2.currentPlayer).toBe(1)

    const afterP2 = matchReducer(readyP2, turn(70))
    expect(afterP2.phase).toBe("roundResult")
    expect(afterP2.roundWinner).toBe(0)
    expect(afterP2.roundWins).toEqual([1, 0])
  })

  it("replays a tied round once, then gives a second tie to better timing", () => {
    const tied = playRound(started(), turn(80, 0.9), turn(80, 0.5))
    expect(tied.phase).toBe("turnReady")
    expect(tied.replays).toBe(1)
    expect(tied.turnScores).toEqual([null, null])
    expect(tied.currentPlayer).toBe(0)

    const decided = playRound(tied, turn(75, 0.6), turn(75, 0.9))
    expect(decided.phase).toBe("roundResult")
    expect(decided.roundWinner).toBe(1)
    expect(decided.roundWins).toEqual([0, 1])
  })

  it("does not favor the first singer when score and timing both tie", () => {
    const tied = playRound(started(), turn(80, 0.7), turn(80, 0.7))
    const tiedAgain = playRound(tied, turn(80, 0.7), turn(80, 0.7))
    expect(tiedAgain.phase).toBe("turnReady")
    expect(tiedAgain.replays).toBe(2)
    expect(tiedAgain.roundWins).toEqual([0, 0])
  })

  it("plays one round by default and ends on its winner", () => {
    expect(ROUNDS_PER_MATCH).toBe(1)
    let state = started()
    expect(state.rounds).toBe(1)
    state = playRound(state, turn(60), turn(90))
    expect(state.phase).toBe("roundResult")
    state = matchReducer(state, { type: "ROUND_CONTINUE" })
    expect(state.phase).toBe("final")
    expect(state.roundWins).toEqual([0, 1])
  })

  it("still replays a tie when the match is a single round", () => {
    const tied = playRound(started(), turn(80, 0.7), turn(80, 0.7))
    expect(tied.phase).toBe("turnReady")
    expect(tied.round).toBe(1)
  })

  it("plays a third round at 1-1 in a best of three", () => {
    let state = started("battle", 3)
    state = playRound(state, turn(90), turn(60))
    state = matchReducer(state, { type: "ROUND_CONTINUE" })
    state = playRound(state, turn(90), turn(60))
    state = matchReducer(state, { type: "ROUND_CONTINUE" })
    expect(state.roundWins).toEqual([1, 1])
    expect(state.phase).toBe("turnReady")
    expect(state.round).toBe(3)
  })

  it("keeps the round count through a rematch and going home", () => {
    let state = started("battle", 3)
    state = matchReducer(state, { type: "REMATCH" })
    expect(state.rounds).toBe(3)
    state = matchReducer(state, { type: "GO_HOME" })
    expect(state.rounds).toBe(3)
    expect(matchReducer(state, { type: "START_MATCH" }).rounds).toBe(3)
  })

  it("alternates who sings first and skips round 3 at 2-0", () => {
    let state = started("battle", 3)
    for (let round = 0; round < 2; round += 1) {
      expect(state.currentPlayer).toBe(round === 0 ? 0 : 1)
      const avaFirst = state.currentPlayer === 0
      state = playRound(
        state,
        turn(avaFirst ? 90 : 60),
        turn(avaFirst ? 60 : 90),
      )
      expect(state.phase).toBe("roundResult")
      state = matchReducer(state, { type: "ROUND_CONTINUE" })
    }
    expect(state.phase).toBe("final")
    expect(state.roundWins).toEqual([2, 0])
    expect(state.round).toBe(2)
  })

  it("rematch keeps names and swaps who sings first", () => {
    let state = playRound(started(), turn(80), turn(70))
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

  it("goes home → mode → song → setup with the chosen mode", () => {
    const picking = matchReducer(createMatchState(), { type: "GO_MODE" })
    expect(picking.phase).toBe("mode")
    const choosing = matchReducer(picking, {
      type: "CHOOSE_MODE",
      mode: "solo",
    })
    expect(choosing.phase).toBe("song")
    expect(choosing.mode).toBe("solo")
    const setup = matchReducer(choosing, {
      type: "SELECT_SONG",
      songId: "happy-birthday-ko",
    })
    expect(setup.phase).toBe("setup")
    expect(matchReducer(setup, { type: "START_MATCH" }).mode).toBe("solo")
  })
})

describe("song selection", () => {
  const arabic = songs.find((s) => s.language === "ar")!

  function chosen(songId: string, rounds?: RoundNumber) {
    const choosing = matchReducer(
      createMatchState(["Ava", "Sam"], "battle", songs[0], rounds),
      { type: "CHOOSE_MODE", mode: "battle" },
    )
    return matchReducer(choosing, { type: "SELECT_SONG", songId })
  }

  it("defaults to the first song", () => {
    expect(createMatchState().song).toBe(songs[0])
  })

  it("sets the chosen song and moves on to setup", () => {
    const state = chosen(arabic.id)
    expect(state.song).toBe(arabic)
    expect(state.phase).toBe("setup")
  })

  it("ignores an unknown song id", () => {
    const choosing = matchReducer(createMatchState(), {
      type: "CHOOSE_MODE",
      mode: "battle",
    })
    expect(
      matchReducer(choosing, { type: "SELECT_SONG", songId: "nope" }),
    ).toBe(choosing)
  })

  it("sings the song's line for each round", () => {
    let state = matchReducer(chosen(arabic.id, 3), { type: "START_MATCH" })
    expect(state.song).toBe(arabic)
    expect(lineForRound(state)).toBe(arabic.lines[0])
    state = playRound(state, turn(90), turn(40))
    state = matchReducer(state, { type: "ROUND_CONTINUE" })
    expect(state.round).toBe(2)
    expect(lineForRound(state)).toBe(arabic.lines[1])
  })

  it("keeps the song through a rematch and going home", () => {
    let state = matchReducer(chosen(arabic.id), { type: "START_MATCH" })
    state = matchReducer(state, { type: "REMATCH" })
    expect(state.song).toBe(arabic)
    state = matchReducer(state, { type: "GO_HOME" })
    expect(state.phase).toBe("home")
    expect(state.song).toBe(arabic)
  })
})

describe("solo mode", () => {
  it("shows the result right after each take, with no handover", () => {
    const afterTake = matchReducer(started("solo"), turn(72, 0.8, [1]))
    expect(afterTake.phase).toBe("roundResult")
    expect(afterTake.turnScores[0]).toBe(72)
    expect(afterTake.turnMissed[0]).toEqual([1])
    expect(afterTake.roundWinner).toBeNull()
    expect(afterTake.roundWins).toEqual([0, 0])
    expect(afterTake.soloScores).toEqual([72])
  })

  it("sings one line by default, then shows that score as the total", () => {
    let state = matchReducer(started("solo"), turn(83))
    state = matchReducer(state, { type: "ROUND_CONTINUE" })
    expect(state.phase).toBe("final")
    expect(soloTotal(state)).toBe(83)
  })

  it("plays every line of a three-round match, then averages the scores", () => {
    let state = started("solo", 3)
    for (const score of [90, 60, 81]) {
      expect(state.currentPlayer).toBe(0)
      state = matchReducer(state, turn(score))
      state = matchReducer(state, { type: "ROUND_CONTINUE" })
    }
    expect(state.phase).toBe("final")
    expect(state.round).toBe(3)
    expect(state.soloScores).toEqual([90, 60, 81])
    expect(soloTotal(state)).toBe(77)
  })

  it("sing again stays solo and clears the scores", () => {
    let state = matchReducer(started("solo"), turn(70))
    state = matchReducer(state, { type: "REMATCH" })
    expect(state.mode).toBe("solo")
    expect(state.phase).toBe("turnReady")
    expect(state.currentPlayer).toBe(0)
    expect(state.soloScores).toEqual([])
  })

  it("does not number the solo singer when stored names match", () => {
    const state = {
      ...started("solo"),
      names: ["Ava", "Ava"] as [string, string],
    }
    expect(displayName(state, 0)).toBe("Ava")
  })
})

describe("fallbackCommentary", () => {
  it("doesn't mention round numbers in a single-round match", () => {
    expect(fallbackCommentary(matchReducer(started("solo"), turn(70)))).toBe(
      "Ava finishes the line",
    )
    const battle = playRound(started(), turn(60), turn(90))
    expect(fallbackCommentary(battle)).toBe("Sam wins the battle")
  })

  it("names the round in a longer match", () => {
    const battle = playRound(started("battle", 3), turn(90), turn(60))
    expect(fallbackCommentary(battle)).toBe("Ava takes round 1")
  })
})
