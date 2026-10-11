"""One-run calibration for the Words probe.

Scores every take in ml/takes/ with each candidate config, picks the method
with the best separation between the good set and the no-words bad set
(hum, lala, mumbled, whistle, noise), and writes ml/calibration.json.

wrongwords is a known limitation: real English words sung clearly will match
the reference acoustically no matter how we tune the probe. We report its
score for context but leave it out of the method pick.

Scoring code lives in backend/words_scoring.py so the backend and this
script agree on how a take is embedded and compared.
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any, Optional

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import numpy as np  # noqa: E402
import torch  # noqa: E402

from words_scoring import (  # noqa: E402
    PHONEME_NAME,
    TARGET_SR,
    TRIM_FRAME_MS,
    TRIM_PEAK_DB,
    XLSR_NAME,
    PhonemeBackbone,
    ScoringConfig,
    XlsrBackbone,
    extract_features,
    load_mono_16k,
    similarity,
    similarity_to_percent,
)

TAKES_DIR = Path(__file__).resolve().parent / "takes"
GOOD_DIR = TAKES_DIR / "good"
BAD_DIR = TAKES_DIR / "bad"
AUDIO_EXTS = (".wav", ".m4a", ".mp3")
CALIBRATION_PATH = Path(__file__).resolve().parent / "calibration.json"

# No-words bads anchor the "low" end of the scale. wrongwords is a known
# limitation: speech-model features can't tell "right words sung oddly" from
# "right words sung correctly".
NO_WORDS_BAD = {"hum.wav", "lala.wav", "mumbled.wav", "whistle.wav", "noise.wav"}
KNOWN_LIMITATION = {"wrongwords.wav"}

# A method within TIE_WINDOW of the best gap counts as a tie; break by picking
# the faster backbone (xlsr beats phoneme since it skips the CTC head).
TIE_WINDOW = 0.005

MODEL_SPEED_RANK = {"xlsr": 0, "phoneme": 1}


# ---------- IO ---------------------------------------------------------------


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


# ---------- Candidate configs -------------------------------------------------


def candidate_configs() -> list[tuple[str, ScoringConfig]]:
    """Methods to sweep. Keep the same catalog as before so the pick is honest."""
    rows: list[tuple[str, ScoringConfig]] = [
        ("baseline xlsr L9", ScoringConfig("xlsr", layer=9)),
        ("baseline xlsr L12", ScoringConfig("xlsr", layer=12)),
        ("trim xlsr L12", ScoringConfig("xlsr", layer=12, trim_silence=True)),
        ("mean-center xlsr L12",
         ScoringConfig("xlsr", layer=12, mean_center=True)),
        ("unit-var xlsr L12",
         ScoringConfig("xlsr", layer=12, unit_variance=True)),
    ]
    for layer in (12, 15, 18, 21, 24):
        rows.append((f"trim+mean xlsr L{layer}",
                     ScoringConfig("xlsr", layer=layer,
                                   trim_silence=True, mean_center=True)))
        rows.append((f"trim+mean+uv xlsr L{layer}",
                     ScoringConfig("xlsr", layer=layer,
                                   trim_silence=True, mean_center=True,
                                   unit_variance=True)))
    rows.extend([
        ("baseline xlsr L9 median",
         ScoringConfig("xlsr", layer=9, path_agg="median")),
        ("baseline xlsr L12 median",
         ScoringConfig("xlsr", layer=12, path_agg="median")),
        ("trim+mean xlsr L18 median",
         ScoringConfig("xlsr", layer=18,
                       trim_silence=True, mean_center=True, path_agg="median")),
        ("phoneme probs raw",
         ScoringConfig("phoneme", phoneme_feature="probs")),
        ("phoneme logprobs raw",
         ScoringConfig("phoneme", phoneme_feature="logprobs")),
        ("trim+mean phoneme probs",
         ScoringConfig("phoneme", phoneme_feature="probs",
                       trim_silence=True, mean_center=True)),
        ("trim+mean phoneme logprobs",
         ScoringConfig("phoneme", phoneme_feature="logprobs",
                       trim_silence=True, mean_center=True)),
        ("trim+mean phoneme probs median",
         ScoringConfig("phoneme", phoneme_feature="probs",
                       trim_silence=True, mean_center=True, path_agg="median")),
    ])
    return rows


# ---------- Runner ------------------------------------------------------------


def main() -> int:
    reference = find_reference()
    good_takes = list_takes(GOOD_DIR)
    bad_takes = list_takes(BAD_DIR)

    if reference is None or not good_takes or not bad_takes:
        print("Missing recordings in ml/takes/. See ml/README.md.", file=sys.stderr)
        return 2

    bad_by_name = {p.name: p for p in bad_takes}
    no_words_bad = [bad_by_name[n] for n in sorted(NO_WORDS_BAD)
                    if n in bad_by_name]
    missing_bad = sorted(NO_WORDS_BAD - set(bad_by_name))
    known_limit = [bad_by_name[n] for n in sorted(KNOWN_LIMITATION)
                   if n in bad_by_name]

    if not no_words_bad:
        print("None of the expected no-words bad takes are present "
              f"({sorted(NO_WORDS_BAD)}).", file=sys.stderr)
        return 2
    if missing_bad:
        print(f"Missing no-words bad takes (ignored): {missing_bad}")

    device = torch.device("cpu")
    print(f"Loading {XLSR_NAME} ...")
    xlsr = XlsrBackbone(device)
    phoneme: Optional[PhonemeBackbone]
    try:
        print(f"Loading {PHONEME_NAME} ...")
        phoneme = PhonemeBackbone(device)
    except Exception as exc:
        print(f"Phoneme model unavailable: {type(exc).__name__}: {exc}")
        phoneme = None

    print(f"Reference: {reference.name}")
    print(f"Good: {len(good_takes)}  No-words bad: {len(no_words_bad)}  "
          f"Known limitation: {len(known_limit)}")
    print()

    ref_audio = load_mono_16k(reference)
    good_audio = [(p.name, load_mono_16k(p)) for p in good_takes]
    nwb_audio = [(p.name, load_mono_16k(p)) for p in no_words_bad]
    kl_audio = [(p.name, load_mono_16k(p)) for p in known_limit]

    results: list[dict[str, Any]] = []
    for name, cfg in candidate_configs():
        if cfg.model_kind == "phoneme" and phoneme is None:
            continue
        ref_feat = extract_features(ref_audio, cfg, xlsr, phoneme)
        if ref_feat is None:
            continue

        def score_one(audio: np.ndarray) -> float:
            take_feat = extract_features(audio, cfg, xlsr, phoneme)
            if take_feat is None:
                return float("nan")
            return similarity(ref_feat, take_feat, cfg)

        good_scores = [(n, score_one(a)) for n, a in good_audio]
        nwb_scores = [(n, score_one(a)) for n, a in nwb_audio]
        kl_scores = [(n, score_one(a)) for n, a in kl_audio]

        lowest_good = min(s for _, s in good_scores)
        highest_nwb = max(s for _, s in nwb_scores)
        gap = lowest_good - highest_nwb
        results.append({
            "method": name,
            "config": cfg,
            "good_scores": good_scores,
            "nwb_scores": nwb_scores,
            "kl_scores": kl_scores,
            "lowest_good": lowest_good,
            "highest_nwb": highest_nwb,
            "gap": gap,
        })

    # Comparison table.
    header = f"{'method':<36} {'low good':>9} {'high nwb':>9} {'gap':>9}"
    print(header)
    print("-" * len(header))
    for r in sorted(results, key=lambda x: -x["gap"]):
        print(f"{r['method']:<36} "
              f"{r['lowest_good']:>9.4f} "
              f"{r['highest_nwb']:>9.4f} "
              f"{r['gap']:>+9.4f}")
    print()

    if not results:
        print("No methods produced scores.", file=sys.stderr)
        return 1

    # Best gap, with the tie-break: within TIE_WINDOW, prefer the faster backbone.
    best_gap = max(r["gap"] for r in results)
    contenders = [r for r in results if best_gap - r["gap"] <= TIE_WINDOW]
    contenders.sort(key=lambda r: (MODEL_SPEED_RANK[r["config"].model_kind],
                                   r["config"].layer or 0))
    best = contenders[0]
    best_cfg: ScoringConfig = best["config"]

    # Scale anchored on means: low = mean(no-words bad), high = mean(good).
    low = float(np.mean([s for _, s in best["nwb_scores"]]))
    high = float(np.mean([s for _, s in best["good_scores"]]))

    print(f"Pick: {best['method']}")
    print(f"  gap:        {best['gap']:+.4f}")
    print(f"  low  (mean no-words bad): {low:.4f}")
    print(f"  high (mean good):         {high:.4f}")
    if best["kl_scores"]:
        for n, s in best["kl_scores"]:
            pct = similarity_to_percent(s, low, high)
            print(f"  known limitation {n}: sim={s:.4f}  scaled={pct}")
    print()

    # 0-100 scaled report the user asked for.
    probe = {"hum.wav", "wrongwords.wav", "steady.wav", "normal.wav"}
    print("Scaled scores for key takes (0-100):")
    sources = (good_audio, nwb_audio, kl_audio)
    seen: set[str] = set()
    for group in sources:
        for name, _ in group:
            if name in probe and name not in seen:
                # look up the sim from the right list of scores
                for row in (best["good_scores"], best["nwb_scores"],
                            best["kl_scores"]):
                    for n2, s in row:
                        if n2 == name:
                            pct = similarity_to_percent(s, low, high)
                            print(f"  {name:<16} sim={s:.4f}  scaled={pct}")
                            seen.add(name)
    missing_probe = probe - seen
    if missing_probe:
        print(f"  (not recorded, so not scaled: {sorted(missing_probe)})")

    payload: dict[str, Any] = {
        "method": best["method"],
        "config": asdict(best_cfg),
        "low": low,
        "high": high,
        "models": {
            "xlsr": XLSR_NAME,
            "phoneme": PHONEME_NAME,
        },
        "sample_rate": TARGET_SR,
        "trim_peak_db": TRIM_PEAK_DB,
        "trim_frame_ms": TRIM_FRAME_MS,
        "good_takes": [n for n, _ in best["good_scores"]],
        "no_words_bad_takes": [n for n, _ in best["nwb_scores"]],
        "known_limitation_takes": [n for n, _ in best["kl_scores"]],
    }
    CALIBRATION_PATH.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"\nWrote {CALIBRATION_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
