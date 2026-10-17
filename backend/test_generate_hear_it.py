"""Tests for generate_hear_it.py. Uses a fake client: no network, no credits."""

import io
import os
import shutil
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import generate_hear_it as hear_it

SONGS = [
    {"id": "happy-birthday-en", "language": "en", "text": "Happy birthday to you"},
    {"id": "happy-birthday-ar", "language": "ar", "text": "عِيدْ مِيلادٍ سَعِيدْ"},
]


def fake_client(audio=b"ID3 fake mp3"):
    convert = mock.Mock(side_effect=lambda **kwargs: iter([audio]))
    return SimpleNamespace(text_to_speech=SimpleNamespace(convert=convert))


@unittest.skipIf(shutil.which("node") is None, "node not installed")
class LoadSongsTests(unittest.TestCase):
    def test_reads_one_line_of_text_per_song_from_songs_ts(self):
        songs = hear_it.load_songs()
        self.assertEqual(sorted(s["language"] for s in songs), ["ar", "en", "ko"])
        english = next(s for s in songs if s["language"] == "en")
        self.assertEqual(english["text"], "Happy birthday to you")

    def test_skips_a_song_whose_lines_differ(self):
        out = '[{"id": "x", "language": "en", "texts": ["one", "two", "one"]}]'
        done = subprocess.CompletedProcess([], 0, stdout=out, stderr="")
        with mock.patch.object(hear_it.subprocess, "run", return_value=done):
            self.assertEqual(hear_it.load_songs(), [])


class RenderTests(unittest.TestCase):
    def test_asks_for_slow_mp3_speech(self):
        client = fake_client()
        self.assertEqual(hear_it.render(client, "hi", "voice", "model"), b"ID3 fake mp3")
        kwargs = client.text_to_speech.convert.call_args.kwargs
        self.assertEqual(kwargs["output_format"], "mp3_44100_128")
        self.assertEqual(kwargs["voice_settings"].speed, hear_it.SPEAKING_SPEED)
        self.assertEqual((kwargs["voice_id"], kwargs["model_id"]), ("voice", "model"))

    def test_rejects_empty_audio(self):
        with self.assertRaises(ValueError):
            hear_it.render(fake_client(b""), "hi", "voice", "model")


class MainTests(unittest.TestCase):
    def setUp(self):
        self.out = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.out)
        self.client = fake_client()
        for patch in [
            mock.patch.object(hear_it, "OUT_DIR", self.out),
            mock.patch.object(hear_it, "load_songs", return_value=[dict(s) for s in SONGS]),
            mock.patch.object(hear_it, "make_client", return_value=self.client),
            mock.patch("dotenv.load_dotenv"),
            mock.patch.dict(os.environ, {"ELEVENLABS_API_KEY": "test-key"}, clear=True),
        ]:
            patch.start()
            self.addCleanup(patch.stop)

    def run_main(self, *argv):
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()) as err:
            code = hear_it.main(list(argv))
        return code, err.getvalue()

    def test_writes_one_clip_per_song_with_the_default_model(self):
        code, _ = self.run_main()
        self.assertEqual(code, 0)
        self.assertEqual(sorted(p.name for p in self.out.iterdir()),
                         ["happy-birthday-ar.mp3", "happy-birthday-en.mp3"])
        texts = [c.kwargs["text"] for c in self.client.text_to_speech.convert.call_args_list]
        self.assertIn("عِيدْ مِيلادٍ سَعِيدْ", texts)
        self.assertEqual(self.client.text_to_speech.convert.call_args.kwargs["model_id"],
                         hear_it.DEFAULT_MODEL_ID)

    def test_keeps_existing_clips_unless_forced(self):
        (self.out / "happy-birthday-en.mp3").write_bytes(b"mine")
        self.run_main()
        self.assertEqual((self.out / "happy-birthday-en.mp3").read_bytes(), b"mine")
        self.assertEqual(self.client.text_to_speech.convert.call_count, 1)

        self.run_main("--force", "happy-birthday-en")
        self.assertEqual((self.out / "happy-birthday-en.mp3").read_bytes(), b"ID3 fake mp3")

    def test_only_renders_requested_ids(self):
        self.run_main("happy-birthday-ar")
        self.assertEqual([p.name for p in self.out.iterdir()], ["happy-birthday-ar.mp3"])

    def test_unknown_id_spends_nothing(self):
        code, err = self.run_main("happy-birthday-xx")
        self.assertEqual(code, 1)
        self.assertIn("Unknown song ids", err)
        self.client.text_to_speech.convert.assert_not_called()

    def test_missing_key_spends_nothing(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            code, err = self.run_main()
        self.assertEqual(code, 1)
        self.assertIn("ELEVENLABS_API_KEY", err)
        self.client.text_to_speech.convert.assert_not_called()

    def test_hear_it_settings_override_the_shared_ones(self):
        env = {"ELEVENLABS_API_KEY": "k", "ELEVENLABS_VOICE_ID": "shared",
               "ELEVENLABS_HEAR_IT_VOICE_ID": "teacher", "ELEVENLABS_HEAR_IT_MODEL_ID": "m2"}
        with mock.patch.dict(os.environ, env, clear=True):
            self.run_main("happy-birthday-en")
        kwargs = self.client.text_to_speech.convert.call_args.kwargs
        self.assertEqual((kwargs["voice_id"], kwargs["model_id"]), ("teacher", "m2"))

    def test_provider_error_reports_status_and_continues(self):
        from elevenlabs.core.api_error import ApiError

        calls = iter([ApiError(status_code=401, body={"detail": "secret-ish"}), iter([b"ok"])])

        def convert(**kwargs):
            result = next(calls)
            if isinstance(result, Exception):
                raise result
            return result

        self.client.text_to_speech.convert.side_effect = convert
        code, err = self.run_main()
        self.assertEqual(code, 1)
        self.assertIn("401", err)
        self.assertNotIn("secret-ish", err)
        self.assertEqual([p.name for p in self.out.iterdir()], ["happy-birthday-ar.mp3"])


if __name__ == "__main__":
    unittest.main()
