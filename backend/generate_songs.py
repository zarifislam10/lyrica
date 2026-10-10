"""Offline song pipeline: original lyrics in, playable clips and scoring targets out.

Run once per song before the demo and commit the outputs. The API server never
calls this. Compose and stem calls spend ElevenLabs credits, so audio that
already exists is reused unless --force is passed.

    python generate_songs.py              # every song in songs/lyrics.json
    python generate_songs.py ko-1         # one song
    python generate_songs.py --force en-1 # regenerate audio from scratch

Per song:
  1. Compose a clip from the lyrics      -> public/songs/<id>.mp3
  2. Split out the vocals stem           -> public/songs/<id>-vocals.mp3
  3. Force-align the lyrics to the stem  -> per-syllable start/end
  4. Detect pitch on the stem            -> per-syllable semitones
  5. Write src/data/songs.generated.ts, which src/data/songs.ts reads.
"""

import argparse
import io
import json
import os
import re
import statistics
import sys
import unicodedata
import zipfile
from dataclasses import dataclass
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent
REPO_DIR = BACKEND_DIR.parent
SPEC_PATH = BACKEND_DIR / "songs" / "lyrics.json"
CACHE_DIR = BACKEND_DIR / "songs" / "generated"
AUDIO_DIR = REPO_DIR / "public" / "songs"
TS_OUT_PATH = REPO_DIR / "src" / "data" / "songs.generated.ts"

LANGUAGE_NAMES = {"en": "English", "ko": "Korean", "es": "Spanish"}
LINES_PER_SONG = 3
# Breathing room before the first and after the last syllable of the clip.
LINE_PAD_SECONDS = 0.15
SYLLABLE_PART = re.compile(r"^[^\W_]+(?:'[^\W_]+)*$")


class SpecError(ValueError):
    """lyrics.json is malformed. Fix the file; no credits were spent."""


class PipelineError(RuntimeError):
    """A generation step produced something we can't score against."""


@dataclass(frozen=True)
class Syllable:
    text: str
    romanization: str | None = None


# A line is a list of words; a word is a list of syllables.
Line = list[list[Syllable]]


def is_hangul_syllable(char: str) -> bool:
    return "가" <= char <= "힣"


def split_line(language: str, text: str, romanization: str | None) -> Line:
    """Split one lyric line into sung units.

    Korean: each Hangul block is a syllable; romanization mirrors it with
    hyphens ("byeol-bit a-rae-seo"). English/Spanish: hyphens mark syllable
    breaks ("can-ta con-mi-go"); a word without hyphens is one unit.
    """
    words = text.split()
    if not words:
        raise SpecError("Empty lyric line")
    if language == "ko":
        roman_words = (romanization or "").split()
        if len(roman_words) != len(words):
            raise SpecError(f"{text!r}: romanization needs one word per Korean word")
        line: Line = []
        for word, roman_word in zip(words, roman_words):
            if not all(is_hangul_syllable(c) for c in word):
                raise SpecError(f"{word!r}: Korean words may only contain Hangul syllables")
            romans = roman_word.split("-")
            if len(romans) != len(word) or not all(romans):
                raise SpecError(f"{word!r}: romanization {roman_word!r} needs one part per syllable")
            line.append([Syllable(c, r) for c, r in zip(word, romans)])
        return line
    if romanization:
        raise SpecError(f"{text!r}: romanization is only for Korean")
    line = []
    for word in words:
        parts = word.split("-")
        if not all(SYLLABLE_PART.match(p) for p in parts):
            raise SpecError(f"{word!r}: use letters, apostrophes, and hyphens between syllables only")
        line.append([Syllable(p) for p in parts])
    return line


def display_text(line: Line) -> str:
    return " ".join("".join(s.text for s in word) for word in line)


def display_romanization(line: Line) -> str | None:
    if line[0][0].romanization is None:
        return None
    return " ".join("-".join(s.romanization or "" for s in word) for word in line)


def load_spec(path: Path = SPEC_PATH) -> tuple[float, list[dict]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    clip_seconds = float(data["clipSeconds"])
    songs = data["songs"]
    ids = [song["id"] for song in songs]
    if len(set(ids)) != len(ids):
        raise SpecError("Song ids must be unique")
    for song in songs:
        if song["language"] not in LANGUAGE_NAMES:
            raise SpecError(f"{song['id']}: unknown language {song['language']!r}")
        if len(song["lines"]) != LINES_PER_SONG:
            raise SpecError(f"{song['id']}: needs exactly {LINES_PER_SONG} lines, one per round")
        song["parsed"] = [
            split_line(song["language"], line["text"], line.get("romanization"))
            for line in song["lines"]
        ]
    return clip_seconds, songs


def composition_plan(song: dict, clip_ms: int, model_id: str) -> dict:
    lyrics = [display_text(line) for line in song["parsed"]]
    positive = [*song["positiveStyles"], f"{LANGUAGE_NAMES[song['language']]} lyrics"]
    negative = song.get("negativeStyles", [])
    if model_id.startswith("music_v2"):
        return {"chunks": [{
            "text": "[Verse]\n" + "\n".join(lyrics),
            "duration_ms": clip_ms,
            "positive_styles": positive,
            "negative_styles": negative,
        }]}
    return {
        "positive_global_styles": positive,
        "negative_global_styles": negative,
        "sections": [{
            "section_name": "Verse",
            "positive_local_styles": [],
            "negative_local_styles": [],
            "duration_ms": clip_ms,
            "lines": lyrics,
        }],
    }


def pick_vocals_stem(zip_bytes: bytes) -> bytes:
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
        names = archive.namelist()
        vocals = [n for n in names if "vocal" in Path(n).name.lower()]
        if len(vocals) != 1:
            raise PipelineError(f"Expected one vocals stem in the ZIP, found: {names}")
        return archive.read(vocals[0])


def _norm(text: str) -> str:
    return unicodedata.normalize("NFC", text).casefold()


def syllable_times_from_chars(lines: list[Line], chars: list[dict]) -> list[list[tuple[float, float]]] | None:
    """Character-level alignment gives each syllable its own window.

    Returns None when the aligner's characters don't line up with the lyrics,
    so the caller can fall back to word timings.
    """
    expected: list[tuple[str, int, int]] = []
    for li, line in enumerate(lines):
        index = 0
        for word in line:
            for syllable in word:
                expected.extend((c, li, index) for c in syllable.text)
                index += 1
    timed = [c for c in chars if c["text"].strip()]
    if len(timed) != len(expected):
        return None
    windows: dict[tuple[int, int], list[float]] = {}
    for (char, li, si), got in zip(expected, timed):
        if _norm(got["text"]) != _norm(char):
            return None
        window = windows.setdefault((li, si), [got["start"], got["end"]])
        window[0] = min(window[0], got["start"])
        window[1] = max(window[1], got["end"])
    return [
        [tuple(windows[(li, si)]) for si in range(sum(len(w) for w in line))]
        for li, line in enumerate(lines)
    ]


def syllable_times_from_words(lines: list[Line], words: list[dict]) -> list[list[tuple[float, float]]]:
    """Fallback: split each aligned word across its syllables by letter count."""
    expected = [word for line in lines for word in line]
    timed = [w for w in words if w["text"].strip()]
    if len(timed) != len(expected):
        raise PipelineError(
            f"Aligner returned {len(timed)} words for {len(expected)} lyric words; "
            "check that the clip sings the lyrics as written"
        )
    per_word = iter(timed)
    result = []
    for line in lines:
        line_times = []
        for word in line:
            got = next(per_word)
            total = sum(len(s.text) for s in word)
            cursor = got["start"]
            for syllable in word:
                end = cursor + (got["end"] - got["start"]) * len(syllable.text) / total
                line_times.append((cursor, end))
                cursor = end
        result.append(line_times)
    return result


def tidy_times(times: list[list[tuple[float, float]]]) -> list[list[tuple[float, float]]]:
    """Make windows strictly ordered; aligners occasionally overlap neighbours."""
    tidied = []
    previous_end = 0.0
    for line in times:
        out = []
        for start, end in line:
            start = max(start, previous_end)
            end = max(end, start + 0.05)
            out.append((start, end))
            previous_end = end
        tidied.append(out)
    return tidied


def line_windows(times: list[list[tuple[float, float]]], clip_seconds: float) -> list[tuple[float, float]]:
    """Cut the clip between lines, halfway through each gap."""
    firsts = [line[0][0] for line in times]
    lasts = [line[-1][1] for line in times]
    if lasts[-1] > clip_seconds:
        raise PipelineError(f"Lyrics run to {lasts[-1]:.2f}s, past the {clip_seconds:.2f}s clip")
    bounds = [max(0.0, firsts[0] - LINE_PAD_SECONDS)]
    bounds += [(lasts[i] + firsts[i + 1]) / 2 for i in range(len(times) - 1)]
    bounds.append(min(clip_seconds, lasts[-1] + LINE_PAD_SECONDS))
    return list(zip(bounds[:-1], bounds[1:]))


def pitch_track(samples, sample_rate: int, fmin: float = 70.0, fmax: float = 1000.0,
                threshold: float = 0.15, hop_seconds: float = 0.01) -> list[tuple[float, float | None]]:
    """YIN pitch detection. Returns (seconds, midi or None when unvoiced)."""
    import numpy as np

    x = np.asarray(samples, dtype=np.float64)
    # Vocals sit well under 2 kHz; decimating keeps the YIN loop cheap.
    factor = max(1, sample_rate // 11025)
    if factor > 1:
        x = x[: len(x) // factor * factor].reshape(-1, factor).mean(axis=1)
        sample_rate //= factor
    tau_min = int(sample_rate / fmax)
    tau_max = int(sample_rate / fmin)
    width = int(sample_rate * 0.025)
    hop = int(sample_rate * hop_seconds)
    gate = 0.05 * float(np.sqrt(np.mean(x ** 2)) or 1.0)
    track: list[tuple[float, float | None]] = []
    for start in range(0, len(x) - width - tau_max, hop):
        frame = x[start: start + width + tau_max]
        seconds = (start + width / 2) / sample_rate
        if float(np.sqrt(np.mean(frame[:width] ** 2))) < gate:
            track.append((seconds, None))
            continue
        diff = np.array([np.sum((frame[:width] - frame[t: t + width]) ** 2) for t in range(tau_max + 1)])
        cmnd = np.ones_like(diff)
        running = np.cumsum(diff[1:])
        cmnd[1:] = diff[1:] * np.arange(1, tau_max + 1) / np.maximum(running, 1e-12)
        below = np.nonzero(cmnd[tau_min:] < threshold)[0]
        if below.size == 0:
            track.append((seconds, None))
            continue
        tau = tau_min + int(below[0])
        while tau + 1 <= tau_max and cmnd[tau + 1] < cmnd[tau]:
            tau += 1
        if 0 < tau < tau_max:
            a, b, c = cmnd[tau - 1], cmnd[tau], cmnd[tau + 1]
            denom = a - 2 * b + c
            refined = tau + (0.5 * (a - c) / denom if denom else 0.0)
        else:
            refined = float(tau)
        hz = sample_rate / refined
        track.append((seconds, 69 + 12 * float(np.log2(hz / 440.0))))
    return track


def syllable_midis(track: list[tuple[float, float | None]], windows: list[tuple[float, float]]) -> list[float | None]:
    """Median pitch over the middle 60% of each syllable, skipping glides."""
    out = []
    for start, end in windows:
        trim = (end - start) * 0.2
        core = [m for t, m in track if m is not None and start + trim <= t <= end - trim]
        full = core or [m for t, m in track if m is not None and start <= t <= end]
        out.append(statistics.median(full) if full else None)
    return out


def relative_semitones(midis: list[float | None], label: str) -> tuple[list[float], list[int]]:
    """Fill unvoiced syllables from the nearest neighbour, then centre on the median."""
    known = [i for i, m in enumerate(midis) if m is not None]
    if not known:
        raise PipelineError(f"{label}: no sung pitch detected; is the vocals stem silent?")
    filled = [m if m is not None else midis[min(known, key=lambda k: abs(k - i))] for i, m in enumerate(midis)]
    centre = statistics.median(filled)
    missing = [i for i, m in enumerate(midis) if m is None]
    return [round(m - centre, 2) for m in filled], missing


def build_song(song: dict, clip_seconds: float, times: list[list[tuple[float, float]]],
               track: list[tuple[float, float | None]]) -> tuple[dict, list[str]]:
    times = tidy_times(times)
    windows = line_windows(times, clip_seconds)
    warnings = []
    lines = []
    for li, (line, line_times, (line_start, line_end)) in enumerate(zip(song["parsed"], times, windows)):
        syllables = [s for word in line for s in word]
        semitones, missing = relative_semitones(syllable_midis(track, line_times), f"{song['id']} line {li + 1}")
        for i in missing:
            warnings.append(f"{song['id']} line {li + 1}: no pitch on {syllables[i].text!r}, borrowed a neighbour's")
        entry: dict = {"id": li + 1, "text": display_text(line)}
        if (roman := display_romanization(line)) is not None:
            entry["romanization"] = roman
        entry["audioStart"] = round(line_start, 3)
        entry["audioEnd"] = round(line_end, 3)
        entry["syllables"] = []
        for syllable, (start, end), semi in zip(syllables, line_times, semitones):
            out: dict = {"text": syllable.text}
            if syllable.romanization is not None:
                out["romanization"] = syllable.romanization
            out.update(start=round(start - line_start, 3), end=round(end - line_start, 3), semitones=semi)
            entry["syllables"].append(out)
        lines.append(entry)
    return {
        "id": song["id"],
        "title": song["title"],
        "language": song["language"],
        "audioUrl": f"/songs/{song['id']}.mp3",
        "vocalsUrl": f"/songs/{song['id']}-vocals.mp3",
        "clipSeconds": round(clip_seconds, 3),
        "lines": lines,
    }, warnings


def write_typescript(songs: list[dict], spec_order: list[str], path: Path = TS_OUT_PATH) -> None:
    ordered = sorted(songs, key=lambda s: spec_order.index(s["id"]) if s["id"] in spec_order else len(spec_order))
    body = json.dumps(ordered, ensure_ascii=False, indent=2)
    path.write_text(
        "// Generated by backend/generate_songs.py from backend/songs/lyrics.json.\n"
        "// Do not edit by hand; edit the lyrics and re-run the script.\n"
        'import type { Song } from "@/domain/types"\n\n'
        f"export const generatedSongs: Song[] = {body}\n",
        encoding="utf-8",
    )


def read_mono(path: Path):
    import soundfile

    data, sample_rate = soundfile.read(path, dtype="float32", always_2d=True)
    return data.mean(axis=1), sample_rate


def run_song(client, song: dict, spec_clip: float, model_id: str, force: bool) -> list[str]:
    song_id = song["id"]
    mix_path = AUDIO_DIR / f"{song_id}.mp3"
    vocals_path = AUDIO_DIR / f"{song_id}-vocals.mp3"
    align_path = CACHE_DIR / f"{song_id}.alignment.json"
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    if force or not mix_path.exists():
        print(f"[{song_id}] composing {spec_clip:.0f}s clip with {model_id} (spends credits)")
        result = client.music.compose_detailed(
            composition_plan=composition_plan(song, int(spec_clip * 1000), model_id),
            model_id=model_id,
            output_format="mp3_44100_128",
        )
        mix_path.write_bytes(result.audio)
        (CACHE_DIR / f"{song_id}.compose.json").write_text(
            json.dumps(result.json, ensure_ascii=False, indent=2), encoding="utf-8")
        force = True  # new mix invalidates the stem and alignment
    if force or not vocals_path.exists():
        print(f"[{song_id}] separating vocals (spends credits)")
        zip_bytes = b"".join(client.music.separate_stems(
            file=(mix_path.name, mix_path.read_bytes(), "audio/mpeg"),
            stem_variation_id="two_stems_v1",
            output_format="mp3_44100_128",
        ))
        vocals_path.write_bytes(pick_vocals_stem(zip_bytes))
        force = True
    if force or not align_path.exists():
        print(f"[{song_id}] aligning lyrics to vocals")
        aligned = client.forced_alignment.create(
            file=(vocals_path.name, vocals_path.read_bytes(), "audio/mpeg"),
            text="\n".join(display_text(line) for line in song["parsed"]),
        )
        align_path.write_text(json.dumps({
            "characters": [{"text": c.text, "start": c.start, "end": c.end} for c in aligned.characters],
            "words": [{"text": w.text, "start": w.start, "end": w.end} for w in aligned.words],
        }, ensure_ascii=False, indent=2), encoding="utf-8")

    alignment = json.loads(align_path.read_text(encoding="utf-8"))
    times = syllable_times_from_chars(song["parsed"], alignment["characters"])
    warnings = []
    if times is None:
        warnings.append(f"{song_id}: character alignment didn't match the lyrics; split word timings instead")
        times = syllable_times_from_words(song["parsed"], alignment["words"])

    print(f"[{song_id}] detecting pitch")
    samples, sample_rate = read_mono(vocals_path)
    clip_seconds = min(spec_clip, len(samples) / sample_rate)
    built, pitch_warnings = build_song(song, clip_seconds, times, pitch_track(samples, sample_rate))
    (CACHE_DIR / f"{song_id}.song.json").write_text(
        json.dumps(built, ensure_ascii=False, indent=2), encoding="utf-8")
    return warnings + pitch_warnings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("ids", nargs="*", help="song ids from songs/lyrics.json (default: all)")
    parser.add_argument("--force", action="store_true", help="regenerate audio even if files exist")
    args = parser.parse_args(argv)

    from dotenv import load_dotenv
    from elevenlabs.client import ElevenLabs
    from elevenlabs.core.api_error import ApiError

    load_dotenv(BACKEND_DIR / ".env")
    api_key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    if not api_key:
        print("ELEVENLABS_API_KEY is missing from backend/.env", file=sys.stderr)
        return 1
    model_id = os.getenv("ELEVENLABS_MUSIC_MODEL_ID", "music_v1")

    try:
        spec_clip, songs = load_spec()
    except (SpecError, KeyError) as exc:
        print(f"lyrics.json: {exc}", file=sys.stderr)
        return 1
    spec_order = [s["id"] for s in songs]
    unknown = set(args.ids) - set(spec_order)
    if unknown:
        print(f"Unknown song ids: {', '.join(sorted(unknown))}", file=sys.stderr)
        return 1
    selected = [s for s in songs if not args.ids or s["id"] in args.ids]

    client = ElevenLabs(api_key=api_key, timeout=300)
    warnings: list[str] = []
    failed = False
    for song in selected:
        try:
            warnings += run_song(client, song, spec_clip, model_id, args.force)
        except ApiError as exc:
            print(f"[{song['id']}] ElevenLabs returned {exc.status_code}: {exc.body}", file=sys.stderr)
            failed = True
        except PipelineError as exc:
            print(f"[{song['id']}] {exc}", file=sys.stderr)
            failed = True

    built = [json.loads(p.read_text(encoding="utf-8")) for p in sorted(CACHE_DIR.glob("*.song.json"))]
    write_typescript([s for s in built if s["id"] in spec_order], spec_order)
    print(f"Wrote {TS_OUT_PATH.relative_to(REPO_DIR)} with {len(built)} song(s)")
    for warning in warnings:
        print(f"warning: {warning}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
