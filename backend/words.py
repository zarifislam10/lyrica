"""POST /words-score: Did the singer say the line's words?

Uses the frozen speech model and the calibration picked by ml/calibrate.py.
Model is loaded once at startup; per-song reference features are built from
the Hear-it mp3s in public/songs/ the first time they're asked for.

Uploaded audio is read into memory, scored, and dropped. Nothing is written
to disk and nothing about the audio is logged.
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np
import torch
from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from words_scoring import (
    PhonemeBackbone,
    ScoringConfig,
    XlsrBackbone,
    decode_mp3_to_mono_16k,
    extract_features,
    load_wav_bytes_mono_16k,
    similarity,
    similarity_to_percent,
)

ROOT = Path(__file__).resolve().parents[1]
CALIBRATION_PATH = ROOT / "ml" / "calibration.json"
PUBLIC_SONGS = ROOT / "public" / "songs"

# Named threshold the spec asked for: at or above this on the 0-100 scale,
# we say the words came through.
HEARD_WORDS_THRESHOLD = 50
# Cap on uploaded audio size to protect the server (10 MB).
MAX_UPLOAD_BYTES = 10 * 1024 * 1024

router = APIRouter()


@dataclass
class WordsService:
    cfg: ScoringConfig
    low: float
    high: float
    xlsr: Optional[XlsrBackbone]
    phoneme: Optional[PhonemeBackbone]
    _ref_cache: dict[str, np.ndarray]
    _cache_lock: threading.Lock

    def reference_features(self, song_id: str) -> np.ndarray:
        cached = self._ref_cache.get(song_id)
        if cached is not None:
            return cached
        with self._cache_lock:
            cached = self._ref_cache.get(song_id)
            if cached is not None:
                return cached
            mp3 = PUBLIC_SONGS / f"{song_id}.mp3"
            if not mp3.exists():
                raise FileNotFoundError(song_id)
            audio = decode_mp3_to_mono_16k(mp3)
            feat = extract_features(audio, self.cfg, self.xlsr, self.phoneme)
            if feat is None:
                raise RuntimeError("could not extract reference features")
            self._ref_cache[song_id] = feat
            return feat


_service: Optional[WordsService] = None
_init_error: Optional[str] = None
_init_lock = threading.Lock()


def _load_calibration() -> dict:
    raw = json.loads(CALIBRATION_PATH.read_text())
    # ScoringConfig expects named args; strip any extras.
    cfg_data = raw["config"]
    allowed = {"model_kind", "layer", "phoneme_feature", "trim_silence",
               "mean_center", "unit_variance", "path_agg"}
    raw["config"] = {k: v for k, v in cfg_data.items() if k in allowed}
    return raw


def init_words_service() -> None:
    """Called at app startup and retried from _require_service() so a
    calibration file that appears later (e.g. after `python ml/calibrate.py`)
    can be picked up without restarting the server."""
    global _service, _init_error
    with _init_lock:
        if _service is not None:
            return
        _init_error = None
        if not CALIBRATION_PATH.exists():
            _init_error = ("Words probe not calibrated. "
                           "Run `python ml/calibrate.py` first.")
            return
        try:
            payload = _load_calibration()
            cfg = ScoringConfig(**payload["config"])
            device = torch.device("cpu")
            xlsr = XlsrBackbone(device) if cfg.model_kind == "xlsr" else None
            phoneme = PhonemeBackbone(device) if cfg.model_kind == "phoneme" else None
            _service = WordsService(
                cfg=cfg,
                low=float(payload["low"]),
                high=float(payload["high"]),
                xlsr=xlsr,
                phoneme=phoneme,
                _ref_cache={},
                _cache_lock=threading.Lock(),
            )
        except Exception as exc:
            _init_error = f"Words probe failed to load: {type(exc).__name__}"


def _require_service() -> WordsService:
    if _service is None:
        # Retry init in case calibration.json has landed since startup.
        init_words_service()
    if _service is None:
        raise HTTPException(503, _init_error
                            or "Words probe is not available.")
    return _service


@router.post("/words-score")
async def words_score(
    song_id: str = Form(..., alias="songId"),
    line_id: int = Form(..., alias="lineId"),
    audio: UploadFile = File(...),
) -> dict:
    svc = _require_service()
    # line_id is accepted for the API shape; today every mp3 clip speaks the
    # one line we care about, so the reference is cached per song.
    del line_id

    raw = await audio.read()
    if not raw:
        raise HTTPException(400, "Empty audio upload.")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "Audio upload too large.")
    samples = load_wav_bytes_mono_16k(raw)
    if samples is None or samples.size == 0:
        raise HTTPException(400, "Audio must be a readable WAV.")

    try:
        ref_feat = svc.reference_features(song_id)
    except FileNotFoundError:
        raise HTTPException(503, "Reference clip is not available for this song.")
    except Exception:
        raise HTTPException(503, "Reference could not be built.")

    take_feat = extract_features(samples, svc.cfg, svc.xlsr, svc.phoneme)
    if take_feat is None:
        raise HTTPException(503, "Words probe is misconfigured.")

    sim = similarity(ref_feat, take_feat, svc.cfg)
    words = similarity_to_percent(sim, svc.low, svc.high)
    return {"words": words, "heardWords": words >= HEARD_WORDS_THRESHOLD}
