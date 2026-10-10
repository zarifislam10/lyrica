import { describe, expect, it } from "vitest"

import { isUnclearTake } from "@/domain/clarity"

describe("isUnclearTake", () => {
  it("accepts a clear take at 60 frames per second", () => {
    expect(isUnclearTake(200, 240)).toBe(false)
  })

  it("accepts a clear take on a slow display (11 frames per second)", () => {
    expect(isUnclearTake(40, 44)).toBe(false)
  })

  it("rejects mostly-noise takes regardless of frame rate", () => {
    expect(isUnclearTake(20, 240)).toBe(true)
    expect(isUnclearTake(3, 44)).toBe(true)
  })

  it("rejects a take where no frames were analyzed", () => {
    expect(isUnclearTake(0, 0)).toBe(true)
  })
})
