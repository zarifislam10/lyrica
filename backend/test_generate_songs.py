import io
import json
import math
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import generate_songs as gs

try:
    import numpy as np
except ImportError:  # song tooling deps are optional for the API server
    np = None


def tone(midis_and_seconds, sample_rate=22050):
    chunks = []
    for midi, seconds in midis_and_seconds:
        n = int(seconds * sample_rate)
        if midi is None:
            chunks.append(np.zeros(n))
        else:
            hz = 440 * 2 ** ((midi - 69) / 12)
            chunks.append(0.5 * np.sin(2 * math.pi * hz * np.arange(n) / sample_rate))
    return np.concatenate(chunks), sample_rate


class SplitLineTests(unittest.TestCase):
    def test_korean_uses_one_syllable_per_hangul_block(self):
        line = gs.split_line("ko", "별빛 아래서", "byeol-bit a-rae-seo")
        self.assertEqual([[s.text for s in w] for w in line], [["별", "빛"], ["아", "래", "서"]])
        self.assertEqual(line[1][2].romanization, "seo")
        self.assertEqual(gs.display_text(line), "별빛 아래서")
        self.assertEqual(gs.display_romanization(line), "byeol-bit a-rae-seo")

    def test_spanish_hyphens_mark_syllables_and_are_hidden(self):
        line = gs.split_line("es", "can-ta con-mi-go", None)
        self.assertEqual([s.text for w in line for s in w], ["can", "ta", "con", "mi", "go"])
        self.assertEqual(gs.display_text(line), "canta conmigo")
        self.assertIsNone(gs.display_romanization(line))

    def test_english_word_without_hyphens_is_one_unit(self):
        line = gs.split_line("en", "we're gold", None)
        self.assertEqual([s.text for w in line for s in w], ["we're", "gold"])

    def test_rejects_bad_specs(self):
        cases = [
            ("ko", "별빛", "byeol"),            # romanization count
            ("ko", "별빛 아래서", "byeol-bit"),  # word count
            ("ko", "별-빛", "byeol-bit"),        # hyphen in Hangul
            ("en", "hold the light", "x"),      # romanization outside Korean
            ("en", "hold, the light", None),    # punctuation
            ("es", "can--ta", None),            # empty syllable
            ("en", "   ", None),
        ]
        for language, text, roman in cases:
            with self.subTest(text=text), self.assertRaises(gs.SpecError):
                gs.split_line(language, text, roman)

    def test_checked_in_lyrics_parse(self):
        clip, songs = gs.load_spec()
        self.assertEqual(clip, 10)
        self.assertEqual(sorted(s["language"] for s in songs), ["en", "es", "ko"])


class CompositionPlanTests(unittest.TestCase):
    def setUp(self):
        _, songs = gs.load_spec()
        self.song = next(s for s in songs if s["id"] == "es-1")

    def test_v1_plan_has_one_section_with_display_lyrics(self):
        plan = gs.composition_plan(self.song, 10000, "music_v1")
        section = plan["sections"][0]
        self.assertEqual(section["duration_ms"], 10000)
        self.assertEqual(section["lines"], ["canta conmigo", "brilla la luz", "somos el mar"])
        self.assertIn("Spanish lyrics", plan["positive_global_styles"])

    def test_v2_plan_uses_chunks(self):
        plan = gs.composition_plan(self.song, 10000, "music_v2_5")
        chunk = plan["chunks"][0]
        self.assertTrue(chunk["text"].startswith("[Verse]\ncanta conmigo"))
        self.assertEqual(chunk["duration_ms"], 10000)


class StemTests(unittest.TestCase):
    def zip_of(self, *names):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            for name in names:
                archive.writestr(name, name.encode())
        return buffer.getvalue()

    def test_picks_vocals(self):
        data = self.zip_of("song/vocals.mp3", "song/instrumental.mp3")
        self.assertEqual(gs.pick_vocals_stem(data), b"song/vocals.mp3")

    def test_refuses_to_guess(self):
        with self.assertRaises(gs.PipelineError):
            gs.pick_vocals_stem(self.zip_of("a.mp3", "b.mp3"))


class TimingTests(unittest.TestCase):
    lines = [gs.split_line("es", "bri-lla luz", None)]

    def test_character_alignment_groups_into_syllables(self):
        chars = [{"text": c, "start": i * 0.1, "end": i * 0.1 + 0.1} for i, c in enumerate("brilla luz")]
        times = gs.syllable_times_from_chars(self.lines, chars)
        self.assertEqual(len(times[0]), 3)
        self.assertAlmostEqual(times[0][0][0], 0.0)
        self.assertAlmostEqual(times[0][0][1], 0.3)  # b-r-i
        self.assertAlmostEqual(times[0][2][0], 0.7)  # l of luz after the space

    def test_character_mismatch_returns_none(self):
        chars = [{"text": c, "start": 0, "end": 0.1} for c in "brila luz"]
        self.assertIsNone(gs.syllable_times_from_chars(self.lines, chars))

    def test_word_fallback_splits_by_letters(self):
        words = [{"text": "brilla", "start": 1.0, "end": 1.6}, {"text": " ", "start": 1.6, "end": 1.6},
                 {"text": "luz", "start": 2.0, "end": 2.3}]
        times = gs.syllable_times_from_words(self.lines, words)
        self.assertAlmostEqual(times[0][0][1], 1.3)
        self.assertEqual(times[0][2], (2.0, 2.3))

    def test_word_count_mismatch_raises(self):
        with self.assertRaises(gs.PipelineError):
            gs.syllable_times_from_words(self.lines, [{"text": "brilla", "start": 0, "end": 1}])

    def test_line_windows_cut_halfway_between_lines(self):
        times = [[(1.0, 2.0)], [(3.0, 4.0)], [(6.0, 7.0)]]
        self.assertEqual(gs.line_windows(times, 10), [(0.85, 2.5), (2.5, 5.0), (5.0, 7.15)])

    def test_lyrics_past_clip_raise(self):
        with self.assertRaises(gs.PipelineError):
            gs.line_windows([[(1, 2)], [(3, 4)], [(9, 10.5)]], 10)

    def test_tidy_times_removes_overlap(self):
        tidied = gs.tidy_times([[(0.0, 1.0), (0.9, 0.9)]])
        self.assertEqual(tidied[0][1][0], 1.0)
        self.assertGreater(tidied[0][1][1], tidied[0][1][0])


@unittest.skipIf(np is None, "numpy not installed (pip install -r requirements-songs.txt)")
class PitchTests(unittest.TestCase):
    def test_yin_finds_a440(self):
        samples, rate = tone([(69, 1.0)])
        voiced = [m for _, m in gs.pitch_track(samples, rate) if m is not None]
        self.assertGreater(len(voiced), 50)
        self.assertAlmostEqual(sorted(voiced)[len(voiced) // 2], 69, delta=0.3)

    def test_silence_is_unvoiced(self):
        samples, rate = tone([(None, 0.5), (60, 0.5)])
        track = gs.pitch_track(samples, rate)
        self.assertTrue(all(m is None for t, m in track if t < 0.4))

    def test_relative_semitones_centre_and_fill(self):
        semis, missing = gs.relative_semitones([60.0, None, 64.0, 67.0], "x")
        self.assertEqual(missing, [1])
        self.assertEqual(semis, [-2.0, -2.0, 2.0, 5.0])

    def test_all_unvoiced_raises(self):
        with self.assertRaises(gs.PipelineError):
            gs.relative_semitones([None, None], "x")


@unittest.skipIf(np is None, "numpy not installed (pip install -r requirements-songs.txt)")
class RunSongTests(unittest.TestCase):
    """Full pipeline with a fake client: no network, no credits."""

    def setUp(self):
        _, songs = gs.load_spec()
        self.song = next(s for s in songs if s["id"] == "ko-1")
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        patches = [
            mock.patch.object(gs, "AUDIO_DIR", root / "public" / "songs"),
            mock.patch.object(gs, "CACHE_DIR", root / "generated"),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        self.addCleanup(self.tmp.cleanup)

        # Three lines of five syllables, 0.3s each, with a gap between lines.
        self.melody = [[60, 62, 64, 62, 60], [64, 65, 67, 65, 64], [67, 65, 64, 62, 60]]
        segments, chars, t = [(None, 0.5)], [], 0.5
        for line, notes in zip(self.song["parsed"], self.melody):
            syllables = [s for w in line for s in w]
            for word_index, word in enumerate(line):
                if word_index:
                    chars.append({"text": " ", "start": t, "end": t})
                for syllable in word:
                    note = notes[syllables.index(syllable)]
                    segments.append((note, 0.3))
                    chars.append({"text": syllable.text, "start": t, "end": t + 0.3})
                    t += 0.3
            chars.append({"text": "\n", "start": t, "end": t})
            segments.append((None, 1.0))
            t += 1.0
        self.samples, self.rate = tone(segments)

        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w") as archive:
            archive.writestr("vocals.mp3", b"vocals")
            archive.writestr("instrumental.mp3", b"inst")
        self.client = SimpleNamespace(
            music=SimpleNamespace(
                compose_detailed=mock.Mock(return_value=SimpleNamespace(audio=b"mix", json={"song_metadata": {}})),
                separate_stems=mock.Mock(return_value=iter([zip_buffer.getvalue()])),
            ),
            forced_alignment=SimpleNamespace(create=mock.Mock(return_value=SimpleNamespace(
                characters=[SimpleNamespace(**c) for c in chars],
                words=[],
            ))),
        )

    def test_generates_files_and_scoring_targets(self):
        with mock.patch.object(gs, "read_mono", return_value=(self.samples, self.rate)):
            warnings = gs.run_song(self.client, self.song, 10.0, "music_v1", force=False)

        self.assertEqual(warnings, [])
        self.assertEqual((gs.AUDIO_DIR / "ko-1.mp3").read_bytes(), b"mix")
        self.assertEqual((gs.AUDIO_DIR / "ko-1-vocals.mp3").read_bytes(), b"vocals")
        plan = self.client.music.compose_detailed.call_args.kwargs["composition_plan"]
        self.assertEqual(plan["sections"][0]["lines"][0], "별빛 아래서")

        song = json.loads((gs.CACHE_DIR / "ko-1.song.json").read_text(encoding="utf-8"))
        self.assertEqual(song["audioUrl"], "/songs/ko-1.mp3")
        self.assertEqual(len(song["lines"]), 3)
        first = song["lines"][0]
        self.assertEqual(first["romanization"], "byeol-bit a-rae-seo")
        self.assertAlmostEqual(first["audioStart"], 0.35, places=3)
        self.assertEqual([s["text"] for s in first["syllables"]], list("별빛아래서"))
        self.assertAlmostEqual(first["syllables"][0]["start"], 0.15, places=3)
        for line, notes in zip(song["lines"], self.melody):
            centre = sorted(notes)[2]
            for syllable, note in zip(line["syllables"], notes):
                self.assertAlmostEqual(syllable["semitones"], note - centre, delta=0.3)

    def test_reuses_existing_audio_without_spending_credits(self):
        gs.AUDIO_DIR.mkdir(parents=True)
        (gs.AUDIO_DIR / "ko-1.mp3").write_bytes(b"mine")
        (gs.AUDIO_DIR / "ko-1-vocals.mp3").write_bytes(b"my vocals")
        with mock.patch.object(gs, "read_mono", return_value=(self.samples, self.rate)):
            gs.run_song(self.client, self.song, 10.0, "music_v1", force=False)
        self.client.music.compose_detailed.assert_not_called()
        self.client.music.separate_stems.assert_not_called()
        self.assertEqual((gs.AUDIO_DIR / "ko-1.mp3").read_bytes(), b"mine")

    def test_typescript_output_is_ordered_by_spec(self):
        out = Path(self.tmp.name) / "songs.generated.ts"
        gs.write_typescript([{"id": "es-1"}, {"id": "en-1"}], ["en-1", "ko-1", "es-1"], out)
        text = out.read_text(encoding="utf-8")
        self.assertIn("export const generatedSongs: Song[] = [", text)
        self.assertLess(text.index('"en-1"'), text.index('"es-1"'))


if __name__ == "__main__":
    unittest.main()
