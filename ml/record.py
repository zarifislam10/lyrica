"""Record a take from the default mic into ml/takes/<good|bad>/<name>.wav.

Format matches the wav2vec2 probe: 16 kHz, mono, PCM 16-bit WAV.
The duration is pulled from ml/takes/reference.wav (plus a one-second
tail so the singer isn't cut off), so run make_reference.py first.

Usage:
    python ml/record.py good normal
    python ml/record.py bad hum
"""

import argparse
import sys
import time
import wave
from pathlib import Path

import sounddevice as sd
import soundfile as sf

REPO_ROOT = Path(__file__).resolve().parents[1]
REFERENCE_WAV = REPO_ROOT / "ml" / "takes" / "reference.wav"
TAKES_DIR = REPO_ROOT / "ml" / "takes"
SAMPLE_RATE = 16_000
TAIL_SECONDS = 1.0


def reference_duration_seconds() -> float:
    if not REFERENCE_WAV.exists():
        print(f"Missing reference clip: {REFERENCE_WAV}\n"
              "Run `python ml/make_reference.py` first.", file=sys.stderr)
        sys.exit(2)
    with wave.open(str(REFERENCE_WAV), "rb") as wav:
        frames = wav.getnframes()
        rate = wav.getframerate()
    return frames / float(rate)


def countdown(seconds: int = 3) -> None:
    for n in range(seconds, 0, -1):
        print(n, flush=True)
        time.sleep(1)
    print("GO", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("label", choices=["good", "bad"],
                        help="Bucket to save under.")
    parser.add_argument("name",
                        help="File name without extension (e.g. normal, hum).")
    args = parser.parse_args()

    duration = reference_duration_seconds() + TAIL_SECONDS
    out_dir = TAKES_DIR / args.label
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{args.name}.wav"

    print(f"Recording {duration:.2f}s to {out_path}")
    countdown()

    audio = sd.rec(int(duration * SAMPLE_RATE),
                   samplerate=SAMPLE_RATE,
                   channels=1,
                   dtype="int16")
    sd.wait()

    sf.write(str(out_path), audio, SAMPLE_RATE, subtype="PCM_16")
    print(str(out_path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
