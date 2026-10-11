"""
Sweep scoring options on the recordings in ml/takes/ and pick the method
with the widest good/bad gap.

Switchable options (set per Config):
  model_kind       "xlsr"    frozen facebook/wav2vec2-xls-r-300m hidden states
                   "phoneme" facebook/wav2vec2-xlsr-53-espeak-cv-ft CTC logits
  layer            for xlsr only; hidden state index 1..24
  phoneme_feature  for phoneme only; "probs" (softmax) or "logprobs" (log softmax)
  trim_silence     cut leading/trailing low-energy audio before embedding
  mean_center      subtract the clip's mean frame vector before cosine
  unit_variance    then divide each dimension by its stdev across frames
  path_agg         "mean" or "median" similarity along the DTW path

Prints one comparison table and, if the best gap >= MIN_GAP, writes the
winning config to ml/calibration.json. Says plainly when nothing clears the bar.
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable, Literal, Optional

import numpy as np
import soundfile as sf
import torch
import torchaudio.functional as AF
from transformers import AutoFeatureExtractor, AutoModel

XLSR_NAME = "facebook/wav2vec2-xls-r-300m"
PHONEME_NAME = "facebook/wav2vec2-xlsr-53-espeak-cv-ft"
TARGET_SR = 16_000
AUDIO_EXTS = (".wav", ".m4a", ".mp3")

# Gap we need before we're willing to ship a calibration.
MIN_GAP = 0.08
# Peak-relative dB threshold for trim_silence.
TRIM_PEAK_DB = -30.0
TRIM_FRAME_MS = 25

TAKES_DIR = Path(__file__).resolve().parent / "takes"
GOOD_DIR = TAKES_DIR / "good"
BAD_DIR = TAKES_DIR / "bad"
CALIBRATION_PATH = Path(__file__).resolve().parent / "calibration.json"


# ---------- Config ------------------------------------------------------------


ModelKind = Literal["xlsr", "phoneme"]
PhonemeFeature = Literal["probs", "logprobs"]
PathAgg = Literal["mean", "median"]


@dataclass(frozen=True)
class Config:
    name: str
    model_kind: ModelKind
    layer: Optional[int] = None
    phoneme_feature: Optional[PhonemeFeature] = None
    trim_silence: bool = False
    mean_center: bool = False
    unit_variance: bool = False
    path_agg: PathAgg = "mean"

    def feature_key(self) -> tuple:
        """What determines the raw per-frame features (model + trim)."""
        return (self.model_kind, self.trim_silence,
                self.layer, self.phoneme_feature)


# ---------- Audio IO ----------------------------------------------------------


def find_reference() -> Optional[Path]:
    for ext in AUDIO_EXTS:
        p = TAKES_DIR / f"reference{ext}"
        if p.exists():
            return p
    return None


def list_takes(folder: Path) -> list[Path]:
    if not folder.exists():
        return []
    files: list[Path] = []
    for ext in AUDIO_EXTS:
        files.extend(sorted(folder.glob(f"*{ext}")))
    return files


def load_mono_16k(path: Path) -> np.ndarray:
    data, sr = sf.read(str(path), always_2d=True)
    mono = data.mean(axis=1).astype(np.float32)
    if sr != TARGET_SR:
        tensor = torch.from_numpy(mono).unsqueeze(0)
        tensor = AF.resample(tensor, sr, TARGET_SR)
        mono = tensor.squeeze(0).numpy()
    return mono


def trim_silence(audio: np.ndarray) -> np.ndarray:
    """Drop leading/trailing frames quieter than TRIM_PEAK_DB below peak RMS."""
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
    start = first * frame_len
    end = (last + 1) * frame_len
    return audio[start:end]


# ---------- Model wrappers ----------------------------------------------------


class XlsrBackbone:
    """Frozen wav2vec2-xls-r-300m, returns per-layer hidden states."""

    def __init__(self, device: torch.device):
        print(f"Loading {XLSR_NAME} (first run downloads ~1.2 GB)...")
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
        hidden = out.hidden_states[layer].squeeze(0).cpu().numpy()
        return hidden.astype(np.float32)


class PhonemeBackbone:
    """Phoneme CTC head; returns per-frame vocab probabilities or log-probs."""

    def __init__(self, device: torch.device):
        # Imports deferred so a missing model doesn't crash the whole script.
        from transformers import Wav2Vec2ForCTC, Wav2Vec2FeatureExtractor

        print(f"Loading {PHONEME_NAME} (first run downloads ~1 GB)...")
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


# ---------- Scoring -----------------------------------------------------------


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
    """DTW over cosine distance; return cosine similarities along the path."""
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


def aggregate(sims: np.ndarray, how: PathAgg) -> float:
    if how == "median":
        return float(np.median(sims))
    return float(np.mean(sims))


# ---------- Feature cache -----------------------------------------------------


@dataclass
class ClipFeatures:
    # (model_kind, trim, layer, phoneme_feature) -> features
    cache: dict[tuple, np.ndarray] = field(default_factory=dict)


def extract(audio_raw: np.ndarray, cfg: Config,
            xlsr: Optional[XlsrBackbone],
            phoneme: Optional[PhonemeBackbone]) -> Optional[np.ndarray]:
    audio = trim_silence(audio_raw) if cfg.trim_silence else audio_raw
    if cfg.model_kind == "xlsr":
        if xlsr is None or cfg.layer is None:
            return None
        return xlsr.layer(audio, cfg.layer)
    if cfg.model_kind == "phoneme":
        if phoneme is None or cfg.phoneme_feature is None:
            return None
        return phoneme.features(audio, cfg.phoneme_feature)
    return None


def features_for(clip: ClipFeatures, audio: np.ndarray, cfg: Config,
                 xlsr: Optional[XlsrBackbone],
                 phoneme: Optional[PhonemeBackbone]) -> Optional[np.ndarray]:
    key = cfg.feature_key()
    hit = clip.cache.get(key)
    if hit is not None:
        return hit
    feat = extract(audio, cfg, xlsr, phoneme)
    if feat is not None:
        clip.cache[key] = feat
    return feat


# ---------- Config catalog ----------------------------------------------------


def build_configs(include_phoneme: bool) -> list[Config]:
    rows: list[Config] = [
        # Baselines that reproduce the current probe.
        Config("baseline xlsr L9", "xlsr", layer=9),
        Config("baseline xlsr L12", "xlsr", layer=12),

        # Each knob alone, at the previously best layer.
        Config("trim xlsr L12", "xlsr", layer=12, trim_silence=True),
        Config("mean-center xlsr L12", "xlsr", layer=12, mean_center=True),
        Config("unit-var xlsr L12", "xlsr", layer=12, unit_variance=True),

        # Trim + normalize across the requested layer sweep.
        Config("trim+mean xlsr L12", "xlsr", layer=12,
               trim_silence=True, mean_center=True),
        Config("trim+mean xlsr L15", "xlsr", layer=15,
               trim_silence=True, mean_center=True),
        Config("trim+mean xlsr L18", "xlsr", layer=18,
               trim_silence=True, mean_center=True),
        Config("trim+mean xlsr L21", "xlsr", layer=21,
               trim_silence=True, mean_center=True),
        Config("trim+mean xlsr L24", "xlsr", layer=24,
               trim_silence=True, mean_center=True),

        # Full normalization at the same layers.
        Config("trim+mean+uv xlsr L12", "xlsr", layer=12,
               trim_silence=True, mean_center=True, unit_variance=True),
        Config("trim+mean+uv xlsr L15", "xlsr", layer=15,
               trim_silence=True, mean_center=True, unit_variance=True),
        Config("trim+mean+uv xlsr L18", "xlsr", layer=18,
               trim_silence=True, mean_center=True, unit_variance=True),
        Config("trim+mean+uv xlsr L21", "xlsr", layer=21,
               trim_silence=True, mean_center=True, unit_variance=True),
        Config("trim+mean+uv xlsr L24", "xlsr", layer=24,
               trim_silence=True, mean_center=True, unit_variance=True),

        # Median-path variants of the baseline + the layer sweep.
        Config("baseline xlsr L9 median", "xlsr", layer=9, path_agg="median"),
        Config("baseline xlsr L12 median", "xlsr", layer=12, path_agg="median"),
        Config("trim+mean xlsr L12 median", "xlsr", layer=12,
               trim_silence=True, mean_center=True, path_agg="median"),
        Config("trim+mean xlsr L18 median", "xlsr", layer=18,
               trim_silence=True, mean_center=True, path_agg="median"),
        Config("trim+mean xlsr L24 median", "xlsr", layer=24,
               trim_silence=True, mean_center=True, path_agg="median"),
    ]
    if include_phoneme:
        rows.extend([
            Config("phoneme probs raw", "phoneme", phoneme_feature="probs"),
            Config("phoneme logprobs raw", "phoneme",
                   phoneme_feature="logprobs"),
            Config("trim+mean phoneme probs", "phoneme",
                   phoneme_feature="probs",
                   trim_silence=True, mean_center=True),
            Config("trim+mean phoneme logprobs", "phoneme",
                   phoneme_feature="logprobs",
                   trim_silence=True, mean_center=True),
            Config("trim+mean phoneme probs median", "phoneme",
                   phoneme_feature="probs",
                   trim_silence=True, mean_center=True, path_agg="median"),
            Config("trim+mean phoneme logprobs median", "phoneme",
                   phoneme_feature="logprobs",
                   trim_silence=True, mean_center=True, path_agg="median"),
        ])
    return rows


# ---------- Runner ------------------------------------------------------------


def print_takes_help(missing: Iterable[str]) -> None:
    print("Nothing to score. Add recordings and re-run.")
    for item in missing:
        print(f"  missing: {item}")


def score_method(
    cfg: Config,
    ref_audio: np.ndarray,
    good: list[tuple[str, np.ndarray, ClipFeatures]],
    bad: list[tuple[str, np.ndarray, ClipFeatures]],
    ref_cache: ClipFeatures,
    xlsr: Optional[XlsrBackbone],
    phoneme: Optional[PhonemeBackbone],
) -> Optional[dict[str, Any]]:
    ref_feat = features_for(ref_cache, ref_audio, cfg, xlsr, phoneme)
    if ref_feat is None:
        return None
    ref_norm = normalize_frames(ref_feat, cfg.mean_center, cfg.unit_variance)

    def take_score(audio: np.ndarray, clip: ClipFeatures) -> Optional[float]:
        feat = features_for(clip, audio, cfg, xlsr, phoneme)
        if feat is None:
            return None
        take_norm = normalize_frames(feat, cfg.mean_center, cfg.unit_variance)
        sims = dtw_path_sims(ref_norm, take_norm)
        return aggregate(sims, cfg.path_agg)

    good_scores: list[tuple[str, float]] = []
    for name, audio, clip in good:
        s = take_score(audio, clip)
        if s is None:
            return None
        good_scores.append((name, s))
    bad_scores: list[tuple[str, float]] = []
    for name, audio, clip in bad:
        s = take_score(audio, clip)
        if s is None:
            return None
        bad_scores.append((name, s))

    all_scores = [s for _, s in good_scores + bad_scores]
    lowest_good = min(s for _, s in good_scores)
    highest_bad = max(s for _, s in bad_scores)
    gap = lowest_good - highest_bad
    spread = max(all_scores) - min(all_scores)
    rel = gap / spread if spread > 1e-9 else 0.0
    return {
        "config": cfg,
        "good_scores": good_scores,
        "bad_scores": bad_scores,
        "lowest_good": lowest_good,
        "highest_bad": highest_bad,
        "gap": gap,
        "spread": spread,
        "gap_over_spread": rel,
    }


def main() -> int:
    reference = find_reference()
    good_takes = list_takes(GOOD_DIR)
    bad_takes = list_takes(BAD_DIR)

    missing: list[str] = []
    if reference is None:
        missing.append(f"{TAKES_DIR}/reference.(wav|m4a|mp3)")
    if not good_takes:
        missing.append(f"{GOOD_DIR}/*.(wav|m4a|mp3)")
    if not bad_takes:
        missing.append(f"{BAD_DIR}/*.(wav|m4a|mp3)")
    if missing:
        print_takes_help(missing)
        return 0

    device = torch.device("cpu")

    xlsr = XlsrBackbone(device)
    phoneme: Optional[PhonemeBackbone]
    try:
        phoneme = PhonemeBackbone(device)
    except Exception as exc:
        print(f"Phoneme model unavailable: {type(exc).__name__}: {exc}")
        print("Skipping phoneme-based methods.")
        phoneme = None

    configs = build_configs(include_phoneme=phoneme is not None)

    print(f"Reference: {reference.name}")
    print(f"Good takes: {len(good_takes)}  Bad takes: {len(bad_takes)}")
    print()

    ref_audio = load_mono_16k(reference)
    ref_cache = ClipFeatures()
    good = [(p.name, load_mono_16k(p), ClipFeatures()) for p in good_takes]
    bad = [(p.name, load_mono_16k(p), ClipFeatures()) for p in bad_takes]

    results: list[dict[str, Any]] = []
    for cfg in configs:
        res = score_method(cfg, ref_audio, good, bad, ref_cache, xlsr, phoneme)
        if res is None:
            continue
        results.append(res)

    # Comparison table.
    header = f"{'method':<36} {'low good':>9} {'high bad':>9} {'gap':>9} {'gap/spread':>11}"
    print(header)
    print("-" * len(header))
    for res in results:
        cfg: Config = res["config"]
        print(f"{cfg.name:<36} "
              f"{res['lowest_good']:>9.4f} "
              f"{res['highest_bad']:>9.4f} "
              f"{res['gap']:>+9.4f} "
              f"{res['gap_over_spread']:>11.3f}")
    print()

    if not results:
        print("No methods produced scores.")
        return 1

    best = max(results, key=lambda r: r["gap"])
    best_cfg: Config = best["config"]
    print(f"Best method: {best_cfg.name}")
    print(f"  gap:         {best['gap']:+.4f}")
    print(f"  gap/spread:  {best['gap_over_spread']:.3f}")
    print(f"  lowest good: {best['lowest_good']:.4f}")
    print(f"  highest bad: {best['highest_bad']:.4f}")
    print(f"  threshold to ship: {MIN_GAP:.3f}")

    if best["gap"] >= MIN_GAP:
        payload: dict[str, Any] = {
            "method": best_cfg.name,
            "config": asdict(best_cfg),
            "gap": best["gap"],
            "gap_over_spread": best["gap_over_spread"],
            "lowest_good": best["lowest_good"],
            "highest_bad": best["highest_bad"],
            "min_gap_threshold": MIN_GAP,
            "models": {
                "xlsr": XLSR_NAME,
                "phoneme": PHONEME_NAME if phoneme is not None else None,
            },
            "sample_rate": TARGET_SR,
            "trim_peak_db": TRIM_PEAK_DB,
            "trim_frame_ms": TRIM_FRAME_MS,
        }
        CALIBRATION_PATH.write_text(json.dumps(payload, indent=2) + "\n")
        print(f"\nWrote {CALIBRATION_PATH}")
    else:
        print(f"\nNo method cleared the {MIN_GAP:.3f} gap threshold. "
              "Not writing calibration.json.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
