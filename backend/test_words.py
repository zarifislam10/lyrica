"""Hum-test the shipped Words probe.

The one guarantee that matters: when the backend is given exactly the
reference clip, the mapping produces 100. If that ever drifts, the
calibration or the shared scorer is wrong.
"""

from __future__ import annotations

import io
import json
import struct
import unittest
import wave
from pathlib import Path

import numpy as np

import words
import words_scoring
from words_scoring import (
    ScoringConfig,
    extract_features,
    load_mono_16k,
    similarity,
    similarity_to_percent,
)

ROOT = Path(__file__).resolve().parents[1]
REFERENCE_WAV = ROOT / "ml" / "takes" / "reference.wav"
CALIBRATION_PATH = ROOT / "ml" / "calibration.json"


class _FakeBackbone:
    """Deterministic backbone for the uploaded-WAV path.

    Returns a fixed matrix for any audio with the same length as the reference,
    and a different one otherwise. Lets us exercise /words-score without
    paying for a 1.2 GB model download in CI.
    """

    def __init__(self, ref_len: int):
        self.ref_len = ref_len
        self.ref_matrix = np.linspace(0.1, 1.0, 32, dtype=np.float32)[None, :].repeat(10, axis=0)
        self.other = np.linspace(-1.0, 1.0, 32, dtype=np.float32)[None, :].repeat(10, axis=0)

    def layer(self, audio, layer):
        return self.ref_matrix if len(audio) == self.ref_len else self.other

    def features(self, audio, kind):
        return self.ref_matrix if len(audio) == self.ref_len else self.other


def _wav_bytes_from_samples(samples: np.ndarray, sample_rate: int) -> bytes:
    buf = io.BytesIO()
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return buf.getvalue()


class ReferenceScoresFullTest(unittest.TestCase):
    """The reference clip, scored against itself, must map to 100."""

    @classmethod
    def setUpClass(cls) -> None:
        if not CALIBRATION_PATH.exists():
            raise unittest.SkipTest("ml/calibration.json missing; run calibrate.py")
        if not REFERENCE_WAV.exists():
            raise unittest.SkipTest("ml/takes/reference.wav missing")
        cls.payload = json.loads(CALIBRATION_PATH.read_text())
        cfg_data = cls.payload["config"]
        allowed = {"model_kind", "layer", "phoneme_feature", "trim_silence",
                   "mean_center", "unit_variance", "path_agg"}
        cls.cfg = ScoringConfig(**{k: v for k, v in cfg_data.items()
                                   if k in allowed})
        cls.low = float(cls.payload["low"])
        cls.high = float(cls.payload["high"])

    def test_reference_scored_against_itself_is_100(self):
        # Only load the real backbone when this test actually runs; it's a
        # slow test, but it's the one that proves the shipped probe works.
        try:
            import torch
            device = torch.device("cpu")
            if self.cfg.model_kind == "xlsr":
                xlsr = words_scoring.XlsrBackbone(device)
                phoneme = None
            else:
                xlsr = None
                phoneme = words_scoring.PhonemeBackbone(device)
        except Exception as exc:
            self.skipTest(f"backbone unavailable: {exc}")

        audio = load_mono_16k(REFERENCE_WAV)
        feat = extract_features(audio, self.cfg, xlsr, phoneme)
        self.assertIsNotNone(feat)
        sim = similarity(feat, feat, self.cfg)
        words_pct = similarity_to_percent(sim, self.low, self.high)
        self.assertEqual(words_pct, 100,
                         f"reference-vs-self should be 100, got {words_pct} "
                         f"(sim={sim:.4f}, low={self.low:.4f}, high={self.high:.4f})")


class ServiceStateTest(unittest.TestCase):
    """503s when the service hasn't been initialized."""

    def test_require_service_without_init_raises_503(self):
        from unittest import mock

        words._service = None
        words._init_error = "test: not initialized"
        # _require_service retries init_words_service in production so a
        # late-arriving calibration.json can be picked up. For this test we
        # need the injected error to survive the retry.
        with mock.patch.object(words, "init_words_service"):
            with self.assertRaises(Exception) as ctx:
                words._require_service()
        self.assertIn("test: not initialized", str(ctx.exception.detail))
        self.assertEqual(ctx.exception.status_code, 503)


if __name__ == "__main__":
    unittest.main()
