"""Cut line 1 of the English Happy Birthday clip into a clean 16 kHz mono WAV.

The reference clip is what every take gets compared against by the wav2vec2
probe. Each public/songs/*.mp3 already contains exactly one sung line, so by
default we take the whole file; if a line ever grows audioStart/audioEnd
fields, pass them with --start / --end.

Usage:
    python ml/make_reference.py

Writes:
    ml/takes/reference.wav   (16 kHz, mono, PCM 16-bit)
"""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SOURCE_MP3 = REPO_ROOT / "public" / "songs" / "happy-birthday-en.mp3"
DEST_WAV = REPO_ROOT / "ml" / "takes" / "reference.wav"
TARGET_RATE = 16_000


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", type=float, default=None,
                        help="Seconds from the start of the mp3 (default: 0).")
    parser.add_argument("--end", type=float, default=None,
                        help="Seconds from the start of the mp3 (default: full clip).")
    args = parser.parse_args()

    if shutil.which("ffmpeg") is None:
        print("ffmpeg not found on PATH. Install it (brew install ffmpeg).",
              file=sys.stderr)
        return 1
    if not SOURCE_MP3.exists():
        print(f"Missing source mp3: {SOURCE_MP3}", file=sys.stderr)
        return 2

    DEST_WAV.parent.mkdir(parents=True, exist_ok=True)

    cmd: list[str] = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
    if args.start is not None:
        cmd += ["-ss", f"{args.start:.3f}"]
    cmd += ["-i", str(SOURCE_MP3)]
    if args.end is not None:
        duration = args.end - (args.start or 0.0)
        if duration <= 0:
            print("--end must be greater than --start", file=sys.stderr)
            return 2
        cmd += ["-t", f"{duration:.3f}"]
    # 16 kHz mono PCM 16-bit WAV — what the wav2vec2 probe expects.
    cmd += ["-ac", "1", "-ar", str(TARGET_RATE), "-c:a", "pcm_s16le",
            str(DEST_WAV)]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print("ffmpeg failed:", result.stderr.strip(), file=sys.stderr)
        return 3

    print(f"Wrote {DEST_WAV}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
