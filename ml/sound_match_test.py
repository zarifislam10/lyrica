"""Original PASS/FAIL hum-test probe.

Still uses frozen wav2vec2-xls-r-300m hidden states + DTW cosine, as before,
just now imports the model/scoring code from backend/words_scoring.py so
there's exactly one implementation to maintain.

For each probed hidden layer, we print lowest good, highest bad, and PASS
if lowest good > highest bad. For method selection and the 0-100 scale,
use ml/calibrate.py.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Iterable, Optional

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import torch  # noqa: E402

from words_scoring import (  # noqa: E402
    XLSR_NAME,
    ScoringConfig,
    XlsrBackbone,
    extract_features,
    load_mono_16k,
    similarity,
)

LAYERS = (6, 9, 12)
AUDIO_EXTS = (".wav", ".m4a", ".mp3")

TAKES_DIR = Path(__file__).resolve().parent / "takes"
GOOD_DIR = TAKES_DIR / "good"
BAD_DIR = TAKES_DIR / "bad"


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
    print(f"Loading {XLSR_NAME} (first run downloads ~1.2 GB)...")
    xlsr = XlsrBackbone(device)

    print(f"Reference: {reference.name}")
    print(f"Good takes: {len(good_takes)}  Bad takes: {len(bad_takes)}")
    print()

    ref_audio = load_mono_16k(reference)
    good_audio = [(p.name, load_mono_16k(p)) for p in good_takes]
    bad_audio = [(p.name, load_mono_16k(p)) for p in bad_takes]

    for layer in LAYERS:
        cfg = ScoringConfig("xlsr", layer=layer)
        ref_feat = extract_features(ref_audio, cfg, xlsr, None)
        assert ref_feat is not None
        good_scores = [(n, similarity(ref_feat,
                                      extract_features(a, cfg, xlsr, None),
                                      cfg))
                       for n, a in good_audio]
        bad_scores = [(n, similarity(ref_feat,
                                     extract_features(a, cfg, xlsr, None),
                                     cfg))
                      for n, a in bad_audio]

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
