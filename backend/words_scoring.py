"""Shared Words-score logic.

Both the backend FastAPI router (backend/words.py) and the ml scripts
(ml/calibrate.py, ml/sound_match_test.py) import from here so there is
exactly one place that knows how to load the model, extract features,
and score a take against a reference.
"""

from __future__ import annotations

import io
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Optional

import numpy as np
import soundfile as sf
import torch
import torchaudio.functional as AF

XLSR_NAME = "facebook/wav2vec2-xls-r-300m"
PHONEME_NAME = "facebook/wav2vec2-xlsr-53-espeak-cv-ft"
TARGET_SR = 16_000
TRIM_PEAK_DB = -30.0
TRIM_FRAME_MS = 25

ModelKind = Literal["xlsr", "phoneme"]
PhonemeFeature = Literal["probs", "logprobs"]
PathAgg = Literal["mean", "median"]


@dataclass(frozen=True)
class ScoringConfig:
    model_kind: ModelKind
    layer: Optional[int] = None
    phoneme_feature: Optional[PhonemeFeature] = None
    trim_silence: bool = False
    mean_center: bool = False
    unit_variance: bool = False
    path_agg: PathAgg = "mean"


# ---------- Audio IO ----------------------------------------------------------


def load_mono_16k(path: Path) -> np.ndarray:
    """Read a WAV/FLAC/OGG file as float32 mono at 16 kHz."""
    data, sr = sf.read(str(path), always_2d=True)
    mono = data.mean(axis=1).astype(np.float32)
    if sr != TARGET_SR:
        tensor = torch.from_numpy(mono).unsqueeze(0)
        tensor = AF.resample(tensor, sr, TARGET_SR)
        mono = tensor.squeeze(0).numpy()
    return mono


def decode_mp3_to_mono_16k(path: Path) -> np.ndarray:
    """Decode an mp3 via system ffmpeg into a float32 mono 16 kHz array."""
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg not found on PATH; install it (brew install ffmpeg).")
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path),
           "-ac", "1", "-ar", str(TARGET_SR), "-f", "wav", "-c:a", "pcm_s16le",
           "pipe:1"]
    result = subprocess.run(cmd, capture_output=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed decoding {path.name}: "
                           f"{result.stderr.decode('utf-8', 'replace').strip()}")
    data, sr = sf.read(io.BytesIO(result.stdout), always_2d=True)
    mono = data.mean(axis=1).astype(np.float32)
    assert sr == TARGET_SR, f"ffmpeg should have returned {TARGET_SR} Hz"
    return mono


def load_wav_bytes_mono_16k(data: bytes) -> Optional[np.ndarray]:
    """Decode an in-memory WAV. Returns None if the bytes aren't a valid WAV."""
    try:
        samples, sr = sf.read(io.BytesIO(data), always_2d=True)
    except Exception:
        return None
    mono = samples.mean(axis=1).astype(np.float32)
    if sr != TARGET_SR:
        tensor = torch.from_numpy(mono).unsqueeze(0)
        tensor = AF.resample(tensor, sr, TARGET_SR)
        mono = tensor.squeeze(0).numpy()
    return mono


def trim_silence(audio: np.ndarray) -> np.ndarray:
    """Drop leading/trailing frames quieter than TRIM_PEAK_DB below the peak RMS."""
    frame_len = int(TARGET_SR * TRIM_FRAME_MS / 1000)
    if len(audio) < frame_len * 2:
        return audio
    n_frames = len(audio) // frame_len
    rms = np.array([
        float(np.sqrt(np.mean(audio[i * frame_len:(i + 1) * frame_len] ** 2) + 1e-12))
        for i in range(n_frames)
    ], dtype=np.float32)
    peak = rms.max()
    if peak <= 0:
        return audio
    threshold = peak * (10.0 ** (TRIM_PEAK_DB / 20.0))
    mask = rms > threshold
    if not mask.any():
        return audio
    first = int(np.argmax(mask))
    last = n_frames - 1 - int(np.argmax(mask[::-1]))
    return audio[first * frame_len:(last + 1) * frame_len]


# ---------- Backbones ---------------------------------------------------------


class XlsrBackbone:
    """Frozen wav2vec2-xls-r-300m, returns per-layer hidden states."""

    def __init__(self, device: torch.device):
        from transformers import AutoFeatureExtractor, AutoModel
        self.fe = AutoFeatureExtractor.from_pretrained(XLSR_NAME)
        self.model = AutoModel.from_pretrained(XLSR_NAME)
        self.model.eval()
        self.model.to(device)
        self.device = device

    def layer(self, audio: np.ndarray, layer: int) -> np.ndarray:
        inputs = self.fe(audio, sampling_rate=TARGET_SR, return_tensors="pt")
        iv = inputs["input_values"].to(self.device)
        with torch.no_grad():
            out = self.model(iv, output_hidden_states=True)
        return out.hidden_states[layer].squeeze(0).cpu().numpy().astype(np.float32)


class PhonemeBackbone:
    """Phoneme CTC head; returns per-frame vocab probabilities or log-probs."""

    def __init__(self, device: torch.device):
        from transformers import Wav2Vec2FeatureExtractor, Wav2Vec2ForCTC
        self.fe = Wav2Vec2FeatureExtractor.from_pretrained(PHONEME_NAME)
        self.model = Wav2Vec2ForCTC.from_pretrained(PHONEME_NAME)
        self.model.eval()
        self.model.to(device)
        self.device = device

    def features(self, audio: np.ndarray, kind: PhonemeFeature) -> np.ndarray:
        inputs = self.fe(audio, sampling_rate=TARGET_SR, return_tensors="pt")
        iv = inputs["input_values"].to(self.device)
        with torch.no_grad():
            logits = self.model(iv).logits
        if kind == "probs":
            feats = torch.softmax(logits, dim=-1)
        else:
            feats = torch.log_softmax(logits, dim=-1)
        return feats.squeeze(0).cpu().numpy().astype(np.float32)


# ---------- Feature extraction + scoring --------------------------------------


def extract_features(
    audio: np.ndarray,
    cfg: ScoringConfig,
    xlsr: Optional[XlsrBackbone],
    phoneme: Optional[PhonemeBackbone],
) -> Optional[np.ndarray]:
    """Run the configured backbone on `audio` and return a (frames, dim) matrix."""
    prepared = trim_silence(audio) if cfg.trim_silence else audio
    if cfg.model_kind == "xlsr":
        if xlsr is None or cfg.layer is None:
            return None
        return xlsr.layer(prepared, cfg.layer)
    if cfg.model_kind == "phoneme":
        if phoneme is None or cfg.phoneme_feature is None:
            return None
        return phoneme.features(prepared, cfg.phoneme_feature)
    return None


def l2_normalize_rows(x: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(x, axis=1, keepdims=True)
    return x / np.maximum(norms, 1e-12)


def normalize_frames(x: np.ndarray, mean_center: bool,
                     unit_variance: bool) -> np.ndarray:
    out = x
    if mean_center:
        out = out - out.mean(axis=0, keepdims=True)
    if unit_variance:
        std = out.std(axis=0, keepdims=True)
        out = out / np.maximum(std, 1e-12)
    return out


def dtw_path_sims(ref: np.ndarray, take: np.ndarray) -> np.ndarray:
    """DTW over the cosine distance; return cosine similarities along the path."""
    ref_n = l2_normalize_rows(ref)
    take_n = l2_normalize_rows(take)
    dist = 1.0 - ref_n @ take_n.T
    n, m = dist.shape
    inf = np.float32(np.inf)
    cost = np.full((n + 1, m + 1), inf, dtype=np.float32)
    cost[0, 0] = 0.0
    for i in range(1, n + 1):
        row_prev = cost[i - 1]
        row = cost[i]
        d_row = dist[i - 1]
        for j in range(1, m + 1):
            best = row_prev[j - 1]
            left = row[j - 1]
            up = row_prev[j]
            if left < best:
                best = left
            if up < best:
                best = up
            row[j] = d_row[j - 1] + best
    i, j = n, m
    sims: list[float] = []
    while i > 0 and j > 0:
        sims.append(1.0 - float(dist[i - 1, j - 1]))
        diag = cost[i - 1, j - 1]
        left = cost[i, j - 1]
        up = cost[i - 1, j]
        step = min(diag, left, up)
        if step == diag:
            i -= 1
            j -= 1
        elif step == up:
            i -= 1
        else:
            j -= 1
    return np.array(sims, dtype=np.float32) if sims else np.array([0.0],
                                                                   dtype=np.float32)


def aggregate_sims(sims: np.ndarray, how: PathAgg) -> float:
    if how == "median":
        return float(np.median(sims))
    return float(np.mean(sims))


def similarity(
    ref_feat: np.ndarray,
    take_feat: np.ndarray,
    cfg: ScoringConfig,
) -> float:
    """Cosine similarity between a reference and take, DTW-aligned per config."""
    ref_norm = normalize_frames(ref_feat, cfg.mean_center, cfg.unit_variance)
    take_norm = normalize_frames(take_feat, cfg.mean_center, cfg.unit_variance)
    sims = dtw_path_sims(ref_norm, take_norm)
    return aggregate_sims(sims, cfg.path_agg)


def similarity_to_percent(sim: float, low: float, high: float) -> int:
    """Map similarity to a 0-100 integer. Clamps outside [low, high]."""
    if high <= low:
        return 0
    scaled = 100.0 * (sim - low) / (high - low)
    return int(round(max(0.0, min(100.0, scaled))))
