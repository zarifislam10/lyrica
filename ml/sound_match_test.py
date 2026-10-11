"""
Standalone pronunciation-similarity probe for Lyrica.

Question: can a frozen pre-trained speech model distinguish "good" takes of a
reference line from "bad" ones, using only cosine similarity between frame
embeddings aligned by dynamic time warping?

Inputs (relative to this script):
    takes/reference.(wav|m4a|mp3)   the reference recording
    takes/good/*.(wav|m4a|mp3)      takes we expect to score high
    takes/bad/*.(wav|m4a|mp3)       takes we expect to score low

For each take and each probed hidden layer, we print:
    - score (mean cosine similarity along the DTW path)
    - lowest good score, highest bad score, and the gap
    - PASS if lowest good > highest bad, else FAIL

No training. The model is loaded once and run in eval mode under torch.no_grad.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Iterable

import numpy as np
import soundfile as sf
import torch
import torchaudio.functional as AF
from transformers import AutoFeatureExtractor, AutoModel

MODEL_NAME = "facebook/wav2vec2-xls-r-300m"
TARGET_SR = 16_000
LAYERS = (6, 9, 12)
AUDIO_EXTS = (".wav", ".m4a", ".mp3")

TAKES_DIR = Path(__file__).resolve().parent / "takes"
GOOD_DIR = TAKES_DIR / "good"
BAD_DIR = TAKES_DIR / "bad"


def find_reference() -> Path | None:
    for ext in AUDIO_EXTS:
        candidate = TAKES_DIR / f"reference{ext}"
        if candidate.exists():
            return candidate
    return None


def list_takes(folder: Path) -> list[Path]:
    if not folder.exists():
        return []
    files: list[Path] = []
    for ext in AUDIO_EXTS:
        files.extend(sorted(folder.glob(f"*{ext}")))
    return files


def load_mono_16k(path: Path) -> np.ndarray:
    """Read audio file -> float32 mono numpy array resampled to 16 kHz."""
    data, sr = sf.read(str(path), always_2d=True)
    # soundfile returns (frames, channels); collapse to mono by mean.
    mono = data.mean(axis=1).astype(np.float32)
    if sr != TARGET_SR:
        tensor = torch.from_numpy(mono).unsqueeze(0)
        tensor = AF.resample(tensor, sr, TARGET_SR)
        mono = tensor.squeeze(0).numpy()
    return mono


def frame_embeddings(
    audio: np.ndarray,
    model: AutoModel,
    feature_extractor: AutoFeatureExtractor,
    device: torch.device,
) -> dict[int, np.ndarray]:
    """Return {layer_index: (frames, dim) float32 numpy array} for LAYERS."""
    inputs = feature_extractor(
        audio,
        sampling_rate=TARGET_SR,
        return_tensors="pt",
    )
    input_values = inputs["input_values"].to(device)
    with torch.no_grad():
        outputs = model(input_values, output_hidden_states=True)
    # hidden_states is a tuple of (num_layers + 1) tensors shaped (1, frames, dim).
    # Index 0 is the CNN output; indices 1..N correspond to transformer layers 1..N.
    out: dict[int, np.ndarray] = {}
    for layer in LAYERS:
        hidden = outputs.hidden_states[layer].squeeze(0).cpu().numpy()
        out[layer] = hidden.astype(np.float32)
    return out


def l2_normalize_rows(x: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(x, axis=1, keepdims=True)
    norms = np.maximum(norms, 1e-12)
    return x / norms


def dtw_mean_cosine(ref: np.ndarray, take: np.ndarray) -> float:
    """
    DTW over the cosine distance matrix between L2-normalized frames.
    Returns the mean cosine similarity along the optimal path.
    """
    ref_n = l2_normalize_rows(ref)
    take_n = l2_normalize_rows(take)
    # cosine distance in [0, 2]
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
    # Backtrack to collect the path's cosine similarities.
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
    if not sims:
        return 0.0
    return float(np.mean(sims))


def print_takes_help(missing: Iterable[str]) -> None:
    print("Nothing to score. Add recordings and re-run.")
    print()
    for item in missing:
        print(f"  missing: {item}")
    print()
    print("Expected layout (relative to this script):")
    print("  takes/reference.wav        (or .m4a / .mp3)")
    print("  takes/good/*.wav           at least one file")
    print("  takes/bad/*.wav            at least one file")
    print()
    print("See ml/README.md for recording tips.")


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
    print(f"Loading {MODEL_NAME} (first run downloads ~1.2 GB)...")
    feature_extractor = AutoFeatureExtractor.from_pretrained(MODEL_NAME)
    model = AutoModel.from_pretrained(MODEL_NAME)
    model.eval()
    model.to(device)

    print(f"Reference: {reference.name}")
    print(f"Good takes: {len(good_takes)}  Bad takes: {len(bad_takes)}")
    print()

    ref_audio = load_mono_16k(reference)
    ref_layers = frame_embeddings(ref_audio, model, feature_extractor, device)

    def embed(path: Path) -> dict[int, np.ndarray]:
        return frame_embeddings(
            load_mono_16k(path), model, feature_extractor, device
        )

    good_embeds = [(p.name, embed(p)) for p in good_takes]
    bad_embeds = [(p.name, embed(p)) for p in bad_takes]

    for layer in LAYERS:
        ref_l = ref_layers[layer]
        good_scores = [
            (name, dtw_mean_cosine(ref_l, emb[layer])) for name, emb in good_embeds
        ]
        bad_scores = [
            (name, dtw_mean_cosine(ref_l, emb[layer])) for name, emb in bad_embeds
        ]

        print(f"=== layer {layer} ===")
        print(f"  {'take':<40} {'label':<6} {'score':>8}")
        for name, score in good_scores:
            print(f"  {name:<40} {'good':<6} {score:>8.4f}")
        for name, score in bad_scores:
            print(f"  {name:<40} {'bad':<6} {score:>8.4f}")
        lowest_good = min(s for _, s in good_scores)
        highest_bad = max(s for _, s in bad_scores)
        gap = lowest_good - highest_bad
        verdict = "PASS" if lowest_good > highest_bad else "FAIL"
        print(f"  lowest good: {lowest_good:.4f}")
        print(f"  highest bad: {highest_bad:.4f}")
        print(f"  gap:         {gap:+.4f}   verdict: {verdict}")
        print()

    return 0


if __name__ == "__main__":
    sys.exit(main())
