"""Render each syllable of each song as a short ElevenLabs TTS clip.

Run once per song (or per edit to src/data/songs.ts), review the clips, and
commit public/songs/syllables/<song-id>/. The frontend's SyllableBreakdown
reads the per-song manifest.json to find each clip when the user taps a
syllable on the round-result screen.

The API server never calls this. Every clip spends credits, so existing
files are kept unless --force is passed. Duplicate syllables inside a song
are rendered once and reused in the manifest.

    python generate_syllables.py                     # every song
    python generate_syllables.py first-snow-ko       # one song
    python generate_syllables.py --force first-snow-ko
    python generate_syllables.py --dry-run           # print cost estimate only

Syllable text comes straight from src/data/songs.ts (read with Node, which
the frontend already needs), so the clips match what players actually sing.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent
REPO_DIR = BACKEND_DIR.parent
OUT_ROOT = REPO_DIR / "public" / "songs" / "syllables"
DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb"
DEFAULT_MODEL_ID = "eleven_multilingual_v2"
# Slower than the full-line "hear it" clip. Each syllable is a tiny lesson,
# so we trade naturalness for clarity on the vowel and the final consonant.
SPEAKING_SPEED = 0.75
# A single syllable at this voice/model is well under 60 KB. Anything larger
# is almost certainly wrong (TTS hallucinating a full phrase).
MAX_CLIP_BYTES = 200_000

# Node strips the TypeScript types; songs.ts only imports types, so it runs
# as-is. We pull the per-syllable breakdown so the generator mirrors the
# exact text the scorer sees in the frontend.
READ_SONGS_JS = """
const { songs } = await import("./src/data/songs.ts")
console.log(JSON.stringify(songs.map((song) => ({
  id: song.id,
  language: song.language,
  lines: song.lines.map((line) => ({
    id: line.id,
    syllables: line.syllables.map((s) => ({
      text: s.text,
      romanization: s.romanization ?? null,
      end: s.end,
      start: s.start,
    })),
  })),
}))))
"""


class SongsError(RuntimeError):
    """songs.ts couldn't be read."""


def load_songs() -> list[dict]:
    try:
        result = subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                "--no-warnings",
                "--input-type=module",
                "-e",
                READ_SONGS_JS,
            ],
            cwd=REPO_DIR,
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        )
    except FileNotFoundError:
        raise SongsError(
            "Node is needed to read src/data/songs.ts; run `mise install`"
        ) from None
    except subprocess.CalledProcessError as exc:
        raise SongsError(
            f"Couldn't read src/data/songs.ts:\n{exc.stderr.strip()}"
        ) from None
    return json.loads(result.stdout)


SLUG_RE = re.compile(r"[^a-z0-9]+")


def slugify(value: str, fallback: str) -> str:
    """ASCII slug for the output filename. Falls back to a stable fallback
    (e.g. the line + syllable index) when the input slug would be empty,
    which happens for Hangul or Arabic text with no romanization."""
    normalized = unicodedata.normalize("NFKD", value)
    ascii_only = normalized.encode("ascii", "ignore").decode("ascii").lower()
    slug = SLUG_RE.sub("-", ascii_only).strip("-")
    return slug or fallback


def make_client(api_key: str):
    from elevenlabs.client import ElevenLabs

    return ElevenLabs(api_key=api_key, timeout=60)


def render(client, text: str, voice_id: str, model_id: str) -> bytes:
    from elevenlabs import VoiceSettings

    audio = b"".join(
        client.text_to_speech.convert(
            text=text,
            voice_id=voice_id,
            model_id=model_id,
            output_format="mp3_44100_128",
            voice_settings=VoiceSettings(speed=SPEAKING_SPEED),
            request_options={"max_retries": 0},
        )
    )
    if not audio or len(audio) > MAX_CLIP_BYTES:
        raise ValueError(f"unexpected clip size ({len(audio)} bytes)")
    return audio


def plan_song(song: dict) -> dict:
    """Build the per-song render plan.

    Returns the manifest dict and a list of `(dedupe_key, filename, text)`
    tuples for the clips that still need to be rendered this run. Duplicate
    syllables (e.g. '이' showing up on multiple notes) share a filename, so
    we only spend credits once per unique sung text.
    """
    manifest = {
        "song_id": song["id"],
        "language": song["language"],
        "voice_id_placeholder": True,
        "clips": {},
    }
    dedupe: dict[str, str] = {}
    render_list: list[tuple[str, str, str]] = []
    for line in song["lines"]:
        for idx, syl in enumerate(line["syllables"]):
            text = syl["text"]
            romanization = syl.get("romanization")
            key = f"{line['id']}-{idx}"
            fallback_slug = f"{line['id']:02d}-{idx:02d}"
            # Dedupe on the sung text (same syllable → same audio). We still
            # expose a unique manifest key per (line, index) so the frontend
            # can look up by position without caring about dedup.
            if text in dedupe:
                filename = dedupe[text]
            else:
                slug_source = romanization or text
                filename = (
                    f"{fallback_slug}-{slugify(slug_source, fallback_slug)}.mp3"
                )
                dedupe[text] = filename
                render_list.append((text, filename, text))
            manifest["clips"][key] = {
                "text": text,
                "romanization": romanization,
                "file": filename,
                "duration_hint_sec": round(syl["end"] - syl["start"], 3),
            }
    return manifest, render_list


def write_manifest(manifest: dict, voice_id: str, model_id: str, path: Path) -> None:
    manifest["voice_id_placeholder"] = False
    manifest["voice_id"] = voice_id
    manifest["model_id"] = model_id
    manifest["speaking_speed"] = SPEAKING_SPEED
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "ids", nargs="*", help="song ids from src/data/songs.ts (default: all)"
    )
    parser.add_argument(
        "--force", action="store_true", help="re-render clips that already exist"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print what would be rendered, spend nothing",
    )
    args = parser.parse_args(argv)

    from dotenv import load_dotenv

    load_dotenv(BACKEND_DIR / ".env")
    api_key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    if not api_key and not args.dry_run:
        print("ELEVENLABS_API_KEY is missing from backend/.env", file=sys.stderr)
        return 1
    voice_id = (
        os.getenv("ELEVENLABS_SYLLABLE_VOICE_ID")
        or os.getenv("ELEVENLABS_HEAR_IT_VOICE_ID")
        or os.getenv("ELEVENLABS_VOICE_ID")
        or DEFAULT_VOICE_ID
    )
    model_id = (
        os.getenv("ELEVENLABS_SYLLABLE_MODEL_ID")
        or os.getenv("ELEVENLABS_HEAR_IT_MODEL_ID")
        or DEFAULT_MODEL_ID
    )

    try:
        songs = load_songs()
    except SongsError as exc:
        print(exc, file=sys.stderr)
        return 1
    known = {s["id"] for s in songs}
    unknown = set(args.ids) - known
    if unknown:
        print(f"Unknown song ids: {', '.join(sorted(unknown))}", file=sys.stderr)
        return 1

    OUT_ROOT.mkdir(parents=True, exist_ok=True)

    total_to_render = 0
    failed = False
    client = None

    for song in songs:
        if args.ids and song["id"] not in args.ids:
            continue
        song_dir = OUT_ROOT / song["id"]
        song_dir.mkdir(parents=True, exist_ok=True)
        manifest, render_list = plan_song(song)

        pending = [
            (key, filename, text)
            for key, filename, text in render_list
            if args.force or not (song_dir / filename).exists()
        ]
        total_to_render += len(pending)

        print(
            f"[{song['id']}] {len(render_list)} unique syllables, "
            f"{len(pending)} to render"
        )
        if args.dry_run:
            for _, filename, text in pending:
                print(f"  would render {filename!r:40s} <- {text!r}")
            continue

        if pending and client is None:
            client = make_client(api_key)

        from elevenlabs.core.api_error import ApiError  # local for cold path

        for _, filename, text in pending:
            path = song_dir / filename
            print(f"  [{song['id']}] speaking {text!r} -> {filename} (spends credits)")
            try:
                path.write_bytes(render(client, text, voice_id, model_id))
            except ApiError as exc:
                print(
                    f"  [{song['id']}] ElevenLabs returned {exc.status_code}",
                    file=sys.stderr,
                )
                failed = True
                break
            except ValueError as exc:
                print(f"  [{song['id']}] {exc}", file=sys.stderr)
                failed = True
                break
        else:
            # Only write the manifest if every pending clip in this song
            # rendered without an API error. A partial song is confusing
            # for the frontend — better to keep the previous manifest.
            write_manifest(manifest, voice_id, model_id, song_dir / "manifest.json")
            print(f"  [{song['id']}] wrote manifest.json")
            continue
        # If we `break`ed out of the loop above, don't write the manifest.

    if args.dry_run:
        print(
            f"\nDry run: {total_to_render} clips would be rendered. "
            "Each is ~1 syllable of TTS; actual cost is per-character on your "
            "ElevenLabs plan."
        )

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
