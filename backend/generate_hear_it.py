"""Render each song's spoken "Hear it" clip with ElevenLabs text-to-speech.

Run once from this folder, listen to the clips, and commit public/songs/*.mp3.
The API server never calls this. Each clip spends credits, so existing files
are kept unless --force is passed.

    python generate_hear_it.py                      # every song
    python generate_hear_it.py happy-birthday-ar    # one song
    python generate_hear_it.py --force happy-birthday-ko

The text comes straight from src/data/songs.ts (read with Node, which the
frontend already needs), so the clip always says exactly what players sing.
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent
REPO_DIR = BACKEND_DIR.parent
OUT_DIR = REPO_DIR / "public" / "songs"
DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb"
# Lists Korean and Arabic among its supported languages.
DEFAULT_MODEL_ID = "eleven_multilingual_v2"
# A little slower than conversational speech, so learners can follow each syllable.
SPEAKING_SPEED = 0.85
MAX_CLIP_BYTES = 2_000_000

# Node strips the TypeScript types; songs.ts only imports types, so it runs as-is.
READ_SONGS_JS = """
const { songs } = await import("./src/data/songs.ts")
console.log(JSON.stringify(songs.map((song) => ({
  id: song.id,
  language: song.language,
  texts: song.lines.map((line) => line.text),
}))))
"""


class SongsError(RuntimeError):
    """songs.ts couldn't be read, or a song can't be spoken as one clip."""


def load_songs() -> list[dict]:
    try:
        result = subprocess.run(
            ["node", "--experimental-strip-types", "--no-warnings", "--input-type=module",
             "-e", READ_SONGS_JS],
            cwd=REPO_DIR, capture_output=True, text=True, check=True, timeout=30,
        )
    except FileNotFoundError:
        raise SongsError("Node is needed to read src/data/songs.ts; run `mise install`") from None
    except subprocess.CalledProcessError as exc:
        raise SongsError(f"Couldn't read src/data/songs.ts:\n{exc.stderr.strip()}") from None
    songs = []
    for song in json.loads(result.stdout):
        texts = set(song["texts"])
        # One clip per song works because every round sings the same words.
        # A song with different words per line (e.g. First Snow) uses
        # per-line audioStart/audioEnd windows into a longer clip, so it
        # doesn't need a single-text "hear it" render — skip it quietly.
        if len(texts) != 1:
            continue
        songs.append({"id": song["id"], "language": song["language"], "text": texts.pop()})
    return songs


def make_client(api_key: str):
    from elevenlabs.client import ElevenLabs

    return ElevenLabs(api_key=api_key, timeout=60)


def render(client, text: str, voice_id: str, model_id: str) -> bytes:
    from elevenlabs import VoiceSettings

    audio = b"".join(client.text_to_speech.convert(
        text=text,
        voice_id=voice_id,
        model_id=model_id,
        output_format="mp3_44100_128",
        voice_settings=VoiceSettings(speed=SPEAKING_SPEED),
        request_options={"max_retries": 0},
    ))
    if not audio or len(audio) > MAX_CLIP_BYTES:
        raise ValueError(f"unexpected clip size ({len(audio)} bytes)")
    return audio


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("ids", nargs="*", help="song ids from src/data/songs.ts (default: all)")
    parser.add_argument("--force", action="store_true", help="re-render clips that already exist")
    args = parser.parse_args(argv)

    from dotenv import load_dotenv

    load_dotenv(BACKEND_DIR / ".env")
    api_key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    if not api_key:
        print("ELEVENLABS_API_KEY is missing from backend/.env", file=sys.stderr)
        return 1
    voice_id = os.getenv("ELEVENLABS_HEAR_IT_VOICE_ID") or os.getenv("ELEVENLABS_VOICE_ID") or DEFAULT_VOICE_ID
    model_id = os.getenv("ELEVENLABS_HEAR_IT_MODEL_ID") or DEFAULT_MODEL_ID

    try:
        songs = load_songs()
    except SongsError as exc:
        print(exc, file=sys.stderr)
        return 1
    unknown = set(args.ids) - {s["id"] for s in songs}
    if unknown:
        print(f"Unknown song ids: {', '.join(sorted(unknown))}", file=sys.stderr)
        return 1

    from elevenlabs.core.api_error import ApiError

    client = make_client(api_key)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    failed = False
    for song in songs:
        if args.ids and song["id"] not in args.ids:
            continue
        path = OUT_DIR / f"{song['id']}.mp3"
        if path.exists() and not args.force:
            print(f"[{song['id']}] kept existing {path.name} (use --force to re-render)")
            continue
        print(f"[{song['id']}] speaking {song['text']!r} (spends credits)")
        try:
            path.write_bytes(render(client, song["text"], voice_id, model_id))
        except ApiError as exc:
            # Status only: the body can echo request details we don't need in logs.
            print(f"[{song['id']}] ElevenLabs returned {exc.status_code}", file=sys.stderr)
            failed = True
        except ValueError as exc:
            print(f"[{song['id']}] {exc}", file=sys.stderr)
            failed = True
        else:
            print(f"[{song['id']}] wrote public/songs/{path.name}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
