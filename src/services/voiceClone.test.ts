import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  cloneVoice,
  deleteVoice,
  sayLine,
  VoiceCloneError,
} from "@/services/voiceClone"

type FetchFn = typeof globalThis.fetch

const originalFetch: FetchFn | undefined = globalThis.fetch

afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch
  } else {
    delete (globalThis as unknown as { fetch?: FetchFn }).fetch
  }
  vi.restoreAllMocks()
})

function mockFetch(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
) {
  const fn = vi.fn().mockImplementation(impl as never)
  globalThis.fetch = (fn as unknown as FetchFn)
  return fn
}

describe("voiceClone service", () => {
  describe("cloneVoice", () => {
    it("returns the sessionId on success", async () => {
      mockFetch(
        async () =>
          new Response(JSON.stringify({ sessionId: "sess-abc" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      )
      const id = await cloneVoice(new Blob([new Uint8Array([1, 2, 3])]))
      expect(id).toBe("sess-abc")
    })

    it("maps 413 to too-large", async () => {
      mockFetch(async () => new Response("too big", { status: 413 }))
      await expect(cloneVoice(new Blob([]))).rejects.toMatchObject({
        code: "too-large",
      })
    })

    it("maps 503 to unsupported", async () => {
      mockFetch(async () => new Response("", { status: 503 }))
      await expect(cloneVoice(new Blob([]))).rejects.toMatchObject({
        code: "unsupported",
      })
    })

    it("maps a network error to a network VoiceCloneError", async () => {
      mockFetch(async () => {
        throw new TypeError("Failed to fetch")
      })
      await expect(cloneVoice(new Blob([]))).rejects.toBeInstanceOf(
        VoiceCloneError,
      )
    })

    it("rejects when response has no sessionId", async () => {
      mockFetch(
        async () =>
          new Response(JSON.stringify({ nope: true }), { status: 200 }),
      )
      await expect(cloneVoice(new Blob([]))).rejects.toMatchObject({
        code: "unknown",
      })
    })
  })

  describe("sayLine", () => {
    it("posts the expected JSON and returns the audio blob", async () => {
      const seenInits: RequestInit[] = []
      mockFetch(async (_url, init) => {
        if (init) seenInits.push(init)
        return new Response(new Blob([new Uint8Array([0x49, 0x44, 0x33])]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        })
      })
      const blob = await sayLine({
        sessionId: "sess-abc",
        songId: "hb-en",
        lineId: 3,
        text: "Happy birthday",
        language: "en",
      })
      expect(blob).toBeInstanceOf(Blob)
      expect(seenInits).toHaveLength(1)
      expect(seenInits[0].method).toBe("POST")
      expect(JSON.parse(String(seenInits[0].body))).toEqual({
        sessionId: "sess-abc",
        songId: "hb-en",
        lineId: 3,
        text: "Happy birthday",
        language: "en",
      })
    })

    it("maps 404 to expired", async () => {
      mockFetch(async () => new Response("", { status: 404 }))
      await expect(
        sayLine({
          sessionId: "s",
          songId: "x",
          lineId: 0,
          text: "hi",
          language: "en",
        }),
      ).rejects.toMatchObject({ code: "expired" })
    })
  })

  describe("deleteVoice", () => {
    it("sends a DELETE and swallows errors", async () => {
      const fn = mockFetch(async () => new Response("", { status: 200 }))
      await deleteVoice("sess-abc")
      expect(fn).toHaveBeenCalledWith(
        expect.stringContaining("/voice/sess-abc"),
        expect.objectContaining({ method: "DELETE" }),
      )
    })

    it("is a no-op for an empty id and does not call fetch", async () => {
      const fn = mockFetch(async () => new Response(""))
      await deleteVoice("")
      expect(fn).not.toHaveBeenCalled()
    })

    it("never throws when the network fails", async () => {
      mockFetch(async () => {
        throw new TypeError("Failed to fetch")
      })
      await expect(deleteVoice("sess-abc")).resolves.toBeUndefined()
    })
  })
})
