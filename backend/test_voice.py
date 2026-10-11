"""Tests for the voice-clone router. No real ElevenLabs calls.

Run from the repo root:

    python -m unittest discover -s backend -v
"""

import asyncio
import os
import time
import unittest
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

import main
import voice


def _mock_transport(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


class VoiceRouterTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"ELEVENLABS_API_KEY": "test-key"})
        self.env.start()
        self.addCleanup(self.env.stop)
        # Fresh module state for every test — otherwise sessions bleed across.
        voice._sessions.clear()
        self.client = TestClient(main.app)
        self.addCleanup(self.client.close)
        self.addCleanup(voice._sessions.clear)

    def _patch_httpx(self, handler):
        client = _mock_transport(handler)
        return patch.object(voice.httpx, "AsyncClient", return_value=client), client

    # ---- /voice/clone ----------------------------------------------------

    def test_clone_missing_key_returns_503(self):
        with patch.dict(os.environ, {"ELEVENLABS_API_KEY": ""}, clear=False):
            response = self.client.post(
                "/voice/clone",
                files={"sample": ("s.wav", b"RIFFxx", "audio/wav")},
            )
        self.assertEqual(response.status_code, 503)
        # Error message must not reveal that we even looked at the key.
        self.assertNotIn("test-key", response.text)

    def test_clone_empty_sample_rejected(self):
        response = self.client.post(
            "/voice/clone",
            files={"sample": ("s.wav", b"", "audio/wav")},
        )
        self.assertEqual(response.status_code, 400)

    def test_clone_oversized_sample_rejected(self):
        big = b"\x00" * (voice.MAX_SAMPLE_BYTES + 1)
        response = self.client.post(
            "/voice/clone",
            files={"sample": ("s.wav", big, "audio/wav")},
        )
        self.assertEqual(response.status_code, 413)

    def test_clone_success_returns_opaque_session_id(self):
        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.url.path, "/v1/voices/add")
            self.assertEqual(request.headers["xi-api-key"], "test-key")
            return httpx.Response(200, json={"voice_id": "secret-voice-id"})

        patcher, _ = self._patch_httpx(handler)
        with patcher:
            response = self.client.post(
                "/voice/clone",
                files={"sample": ("s.wav", b"RIFFxxxx", "audio/wav")},
            )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertIn("sessionId", body)
        session_id = body["sessionId"]
        self.assertNotIn("secret-voice-id", response.text)
        # Session is stored server-side with the real voice id.
        self.assertEqual(voice._sessions[session_id].voice_id, "secret-voice-id")

    def test_clone_upstream_failure_returns_502(self):
        def handler(request):
            return httpx.Response(401, json={"detail": "bad key"})

        patcher, _ = self._patch_httpx(handler)
        with patcher:
            response = self.client.post(
                "/voice/clone",
                files={"sample": ("s.wav", b"RIFFxxxx", "audio/wav")},
            )
        self.assertEqual(response.status_code, 502)
        # Never surface the provider's body.
        self.assertNotIn("bad key", response.text)

    def test_clone_missing_voice_id_in_response(self):
        patcher, _ = self._patch_httpx(
            lambda r: httpx.Response(200, json={"not_a_voice_id": "oops"})
        )
        with patcher:
            response = self.client.post(
                "/voice/clone",
                files={"sample": ("s.wav", b"RIFFxxxx", "audio/wav")},
            )
        self.assertEqual(response.status_code, 502)

    # ---- /voice/say ------------------------------------------------------

    def _seed_session(self, voice_id="vid-123"):
        session_id = "abcdef0123456789"
        voice._sessions[session_id] = voice.VoiceSession(
            voice_id=voice_id, created_at=time.monotonic()
        )
        return session_id

    def test_say_requires_known_session(self):
        response = self.client.post(
            "/voice/say",
            json={"sessionId": "nope", "songId": "hb-en", "lineId": 0, "text": "hi"},
        )
        self.assertEqual(response.status_code, 404)

    def test_say_validates_body(self):
        session_id = self._seed_session()
        # Missing lineId
        bad = self.client.post(
            "/voice/say",
            json={"sessionId": session_id, "songId": "hb-en", "text": "hi"},
        )
        self.assertEqual(bad.status_code, 422)
        # Empty text
        bad2 = self.client.post(
            "/voice/say",
            json={"sessionId": session_id, "songId": "hb-en", "lineId": 0, "text": ""},
        )
        self.assertEqual(bad2.status_code, 422)
        # Too long
        bad3 = self.client.post(
            "/voice/say",
            json={
                "sessionId": session_id,
                "songId": "hb-en",
                "lineId": 0,
                "text": "x" * (voice.MAX_TEXT_CHARS + 1),
            },
        )
        self.assertEqual(bad3.status_code, 413)

    def test_say_calls_elevenlabs_and_caches_result(self):
        session_id = self._seed_session(voice_id="vid-xyz")
        calls = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request.url.path)
            self.assertEqual(request.url.path, "/v1/text-to-speech/vid-xyz")
            return httpx.Response(200, content=b"MP3DATA", headers={"content-type": "audio/mpeg"})

        patcher, _ = self._patch_httpx(handler)
        payload = {
            "sessionId": session_id, "songId": "hb-en", "lineId": 1,
            "text": "Happy birthday", "language": "en",
        }
        with patcher:
            first = self.client.post("/voice/say", json=payload)
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.headers["content-type"], "audio/mpeg")
        self.assertEqual(first.content, b"MP3DATA")
        self.assertEqual(len(calls), 1)

        # Second call for same (song, line) must hit cache, not the provider.
        def should_not_run(_r):
            raise AssertionError("provider called on cache hit")

        patcher2, _ = self._patch_httpx(should_not_run)
        with patcher2:
            second = self.client.post("/voice/say", json=payload)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.content, b"MP3DATA")

    def test_say_upstream_failure_returns_502(self):
        session_id = self._seed_session()
        patcher, _ = self._patch_httpx(lambda r: httpx.Response(500, content=b""))
        with patcher:
            response = self.client.post(
                "/voice/say",
                json={"sessionId": session_id, "songId": "hb-en", "lineId": 0, "text": "hi"},
            )
        self.assertEqual(response.status_code, 502)

    # ---- DELETE /voice/{id} and TTL sweeper ------------------------------

    def test_delete_is_idempotent_and_hits_provider(self):
        session_id = self._seed_session(voice_id="vid-delete")
        deleted = []

        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.method, "DELETE")
            self.assertEqual(request.url.path, "/v1/voices/vid-delete")
            deleted.append(True)
            return httpx.Response(200, json={"status": "ok"})

        patcher, _ = self._patch_httpx(handler)
        with patcher:
            first = self.client.delete(f"/voice/{session_id}")
        self.assertEqual(first.status_code, 200)
        self.assertTrue(deleted)
        self.assertNotIn(session_id, voice._sessions)

        # Second delete: session already gone, no provider call.
        second = self.client.delete(f"/voice/{session_id}")
        self.assertEqual(second.status_code, 200)

    def test_sweeper_drops_expired_sessions(self):
        async def run():
            voice._sessions.clear()
            voice._sessions["fresh"] = voice.VoiceSession(
                voice_id="v-fresh", created_at=time.monotonic()
            )
            voice._sessions["stale"] = voice.VoiceSession(
                voice_id="v-stale",
                created_at=time.monotonic() - voice.SESSION_TTL_SECONDS - 10,
            )
            deleted = []

            def handler(request):
                deleted.append(request.url.path)
                return httpx.Response(200)

            with patch.object(
                voice.httpx, "AsyncClient", return_value=_mock_transport(handler)
            ):
                await voice._sweep_once(time.monotonic())

            self.assertIn("fresh", voice._sessions)
            self.assertNotIn("stale", voice._sessions)
            self.assertEqual(deleted, ["/v1/voices/v-stale"])

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
