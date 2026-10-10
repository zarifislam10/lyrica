"""Run with python -m unittest discover -s backend (no provider credits used)."""

import asyncio
import base64
import copy
import json
import os
import time
import unittest
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

import main
import round_result

REQUEST = {
    "round": 1, "lineId": "1",
    "players": [
        {"id": "p1", "name": "Laiba", "score": 85, "missedSyllables": []},
        {"id": "p2", "name": "Zarif", "score": 72, "missedSyllables": ["녕"]},
    ],
    "winnerId": "p1",
}
GEMINI = {"candidates": [{"finishReason": "STOP", "content": {
    "parts": [{"text": "Great effort from both singers!"}]
}}]}
AsyncClient = httpx.AsyncClient


class RoundResultTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {
            "GEMINI_API_KEY": "test-gemini", "ELEVENLABS_API_KEY": "test-eleven",
            "GEMINI_MODEL": "test-model", "ELEVENLABS_VOICE_ID": "test-voice",
            "ELEVENLABS_ROUND_MODEL_ID": "test-tts",
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        self.client = TestClient(main.app)
        self.addCleanup(self.client.close)

    def call(self, handler, request=None):
        provider = AsyncClient(transport=httpx.MockTransport(handler))
        with patch.object(round_result.httpx, "AsyncClient", return_value=provider):
            response = self.client.post("/round-result", json=request or REQUEST)
        self.assertTrue(provider.is_closed)
        return response

    def assert_fallback(self, response):
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            "commentary": "Laiba wins round 1! Great effort from both players.",
            "audioUrl": None, "fallback": True,
        })
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertNotIn("test-gemini", response.text)

    def test_success_calls_providers_in_order_and_returns_playable_audio(self):
        calls = []
        def handler(request):
            calls.append(request)
            body = json.loads(request.content)
            if len(calls) == 1:
                self.assertEqual(request.headers["x-goog-api-key"], "test-gemini")
                self.assertEqual(json.loads(body["contents"][0]["parts"][0]["text"]), REQUEST)
                return httpx.Response(200, json=GEMINI)
            self.assertEqual(request.headers["xi-api-key"], "test-eleven")
            self.assertEqual(body["text"], "Laiba wins round 1! Great effort from both singers!")
            self.assertEqual(body["model_id"], "test-tts")
            return httpx.Response(200, content=b"fake-mp3", headers={"Content-Type": "audio/mpeg"})
        response = self.call(handler)
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["fallback"])
        self.assertEqual(base64.b64decode(response.json()["audioUrl"].split(",")[1]), b"fake-mp3")
        self.assertEqual(len(calls), 2)

    def test_missing_key_returns_immediate_fallback_without_network(self):
        with patch.dict(os.environ, {"GEMINI_API_KEY": ""}), patch.object(round_result, "generate_result") as generate:
            self.assert_fallback(self.client.post("/round-result", json=REQUEST))
            generate.assert_not_called()

    def test_tie_is_supplied_by_frontend(self):
        request = copy.deepcopy(REQUEST)
        request["winnerId"] = None
        request["players"][1]["score"] = 85
        with patch.dict(os.environ, {"GEMINI_API_KEY": ""}):
            response = self.client.post("/round-result", json=request)
        self.assertEqual(response.json()["commentary"], "Round 1 is a tie! Great effort from both players.")

    def test_invalid_payloads_are_rejected_before_provider_calls(self):
        cases = []
        for field, value in [("round", 0), ("round", 4), ("winnerId", "stranger"), ("players", REQUEST["players"][:1])]:
            case = copy.deepcopy(REQUEST)
            case[field] = value
            cases.append(case)
        for field, value in [("score", -1), ("score", 101), ("name", "  "), ("name", "x" * 41), ("id", "p2")]:
            case = copy.deepcopy(REQUEST)
            case["players"][0][field] = value
            cases.append(case)
        with patch.object(round_result, "generate_result") as generate:
            for case in cases:
                with self.subTest(case=case):
                    self.assertEqual(self.client.post("/round-result", json=case).status_code, 422)
            generate.assert_not_called()

    def test_gemini_errors_and_malformed_results_fall_back(self):
        for status, body in [(401, {"error": "private details"}), (429, {}), (500, {}), (200, {}),
                             (200, {"candidates": []}), (200, {"candidates": [{"finishReason": "SAFETY"}]})]:
            with self.subTest(status=status, body=body):
                self.assert_fallback(self.call(lambda request: httpx.Response(status, json=body)))

    def test_tts_errors_or_invalid_audio_fall_back(self):
        for status, audio, mime in [(401, b"private", "application/json"), (429, b"", "audio/mpeg"),
                                     (200, b"", "audio/mpeg"), (200, b"{}", "application/json")]:
            def handler(request):
                if request.url.host == "generativelanguage.googleapis.com":
                    return httpx.Response(200, json=GEMINI)
                return httpx.Response(status, content=audio, headers={"Content-Type": mime})
            with self.subTest(status=status, mime=mime):
                self.assert_fallback(self.call(handler))

    def test_provider_connection_error_falls_back(self):
        def handler(request):
            raise httpx.ConnectError("private provider detail")
        self.assert_fallback(self.call(handler))

    def test_deadline_cancels_slow_provider(self):
        cancelled = []
        async def handler(request):
            try:
                await asyncio.sleep(10)
            finally:
                cancelled.append(True)
        start = time.monotonic()
        with patch.object(round_result, "GENERATION_DEADLINE_SECONDS", 0.03):
            self.assert_fallback(self.call(handler))
        self.assertLess(time.monotonic() - start, 1)
        self.assertEqual(cancelled, [True])

    def test_deadline_covers_both_providers_not_each_individually(self):
        calls = []
        async def handler(request):
            calls.append(request.url.host)
            await asyncio.sleep(0.08)
            if len(calls) == 1:
                return httpx.Response(200, json=GEMINI)
            return httpx.Response(200, content=b"audio", headers={"Content-Type": "audio/mpeg"})
        with patch.object(round_result, "GENERATION_DEADLINE_SECONDS", 0.12):
            self.assert_fallback(self.call(handler))
        self.assertEqual(len(calls), 2)

    def test_cors_and_health(self):
        response = self.client.options("/round-result", headers={
            "Origin": "http://localhost:8443", "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["access-control-allow-origin"], "http://localhost:8443")
        denied = self.client.options("/round-result", headers={
            "Origin": "https://unconfigured.example", "Access-Control-Request-Method": "POST",
        })
        self.assertNotIn("access-control-allow-origin", denied.headers)
        self.assertEqual(self.client.get("/health").json(), {"status": "ok"})


if __name__ == "__main__":
    unittest.main()
