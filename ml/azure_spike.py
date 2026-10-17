"""Azure Pronunciation Assessment spike.

Standalone experiment — this script does NOT touch backend/ or src/.
It scores every take in ml/takes/{good,bad}/ with Microsoft Azure's
Pronunciation Assessment and writes a CSV + a summary JSON next to it.

The point is to answer, with real numbers:

  1. Can Azure recognize our sung Happy Birthday takes at all?
  2. Does its accuracy score separate good takes from bad takes?
  3. How detailed is the per-word / per-phoneme feedback?

Nothing here is wired into production. Decide after reading the report.

How to run (first time)
-----------------------
1. Create an Azure Speech resource (free F0 tier: 5 h audio/month).
     https://portal.azure.com → "Speech service" → "Create".
   Copy KEY 1 and the Location/Region (e.g. "eastus").

2. Append to backend/.env (never commit real values):
     AZURE_SPEECH_KEY=<your key>
     AZURE_SPEECH_REGION=<your region>

3. From ml/.venv, install the SDK:
     pip install azure-cognitiveservices-speech python-dotenv soundfile

4. Run:
     python ml/azure_spike.py

Outputs
-------
  ml/azure_spike_results.csv      per-recording details
  ml/azure_spike_summary.json     per-group aggregates + headline numbers
  stdout                          human-readable table + verdict

Costs
-----
Pronunciation Assessment is billed as standard STT. On the F0 free tier the
~18 takes here (<2 min total audio) are free; on S0 it is ~$1 / audio hour.
"""

from __future__ import annotations

import csv
import json
import os
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from statistics import mean, median
from typing import Any, Optional

# Dependencies we check for and import lazily so the help text still prints
# cleanly if the SDK isn't installed yet.
ML_ROOT = Path(__file__).resolve().parent
REPO_ROOT = ML_ROOT.parent
TAKES_DIR = ML_ROOT / "takes"
GOOD_DIR = TAKES_DIR / "good"
BAD_DIR = TAKES_DIR / "bad"
RESULTS_CSV = ML_ROOT / "azure_spike_results.csv"
SUMMARY_JSON = ML_ROOT / "azure_spike_summary.json"

# For the English spike only. The exact text Azure will grade pronunciation
# against — must match what the user actually sang/spoke in each take.
REFERENCE_TEXT = "happy birthday to you"
LOCALE = "en-US"

# Filename → performance style. Used in the report so we can see if sung and
# spoken takes behave differently. "unknown" means we didn't tag it.
SPOKEN_FILES = {"talking.wav", "mumbled.wav", "wrongwords.wav"}
NONVOCAL_FILES = {"hum.wav", "lala.wav", "noise.wav", "whistle.wav"}


def classify_audio_type(name: str) -> str:
    if name in SPOKEN_FILES:
        return "spoken"
    if name in NONVOCAL_FILES:
        return "non-vocal"
    return "sung"


@dataclass
class WordResult:
    word: str
    accuracy: Optional[float]
    error_type: Optional[str]
    phonemes: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class RecordingResult:
    filename: str
    label: str  # "good" or "bad"
    audio_type: str  # "sung", "spoken", "non-vocal"
    sample_rate: Optional[int]
    channels: Optional[int]
    duration_s: Optional[float]
    peak_amplitude: Optional[float]
    recognized_text: Optional[str]
    recognition_status: str  # "ok", "no-match", "canceled", "error"
    error_detail: Optional[str]
    accuracy: Optional[float]
    completeness: Optional[float]
    fluency: Optional[float]
    prosody: Optional[float]
    pronunciation: Optional[float]  # Azure's overall pron score (0-100)
    words: list[WordResult] = field(default_factory=list)
    latency_s: Optional[float] = None


def _load_env() -> tuple[Optional[str], Optional[str]]:
    """Pull AZURE_SPEECH_KEY/REGION from backend/.env without logging them."""
    try:
        from dotenv import load_dotenv
    except ImportError:
        print("python-dotenv not installed. Run: pip install python-dotenv",
              file=sys.stderr)
        return None, None
    load_dotenv(REPO_ROOT / "backend" / ".env")
    key = os.getenv("AZURE_SPEECH_KEY", "").strip() or None
    region = os.getenv("AZURE_SPEECH_REGION", "").strip() or None
    return key, region


def _probe_wav(path: Path) -> dict[str, Any]:
    """Read sample rate, channels, duration, peak amplitude. Never fatal."""
    try:
        import soundfile as sf
        with sf.SoundFile(str(path)) as f:
            frames = len(f)
            sr = f.samplerate
            ch = f.channels
            duration = frames / sr if sr else None
        data, _ = sf.read(str(path), always_2d=True)
        peak = float(abs(data).max()) if data.size else 0.0
        return {
            "sample_rate": sr,
            "channels": ch,
            "duration_s": duration,
            "peak_amplitude": peak,
        }
    except Exception as exc:
        return {
            "sample_rate": None,
            "channels": None,
            "duration_s": None,
            "peak_amplitude": None,
            "probe_error": f"{type(exc).__name__}: {exc}",
        }


def _score_one(
    speechsdk: Any,
    speech_config: Any,
    path: Path,
    label: str,
) -> RecordingResult:
    """Run one Pronunciation Assessment pass against a single WAV file."""
    name = path.name
    probe = _probe_wav(path)
    base = RecordingResult(
        filename=name,
        label=label,
        audio_type=classify_audio_type(name),
        sample_rate=probe.get("sample_rate"),
        channels=probe.get("channels"),
        duration_s=probe.get("duration_s"),
        peak_amplitude=probe.get("peak_amplitude"),
        recognized_text=None,
        recognition_status="error",
        error_detail=probe.get("probe_error"),
        accuracy=None,
        completeness=None,
        fluency=None,
        prosody=None,
        pronunciation=None,
    )

    # Guard against silent / clipped files — still send them, but flag it.
    peak = probe.get("peak_amplitude") or 0.0
    duration = probe.get("duration_s") or 0.0
    if duration <= 0.2:
        base.error_detail = (base.error_detail or "") + " [audio too short]"
    if peak < 0.01:
        base.error_detail = (base.error_detail or "") + " [near-silent audio]"
    if peak >= 0.999:
        base.error_detail = (base.error_detail or "") + " [possibly clipped]"

    audio_config = speechsdk.audio.AudioConfig(filename=str(path))

    pa_config = speechsdk.PronunciationAssessmentConfig(
        reference_text=REFERENCE_TEXT,
        grading_system=speechsdk.PronunciationAssessmentGradingSystem.HundredMark,
        granularity=speechsdk.PronunciationAssessmentGranularity.Phoneme,
        enable_miscue=True,
    )
    # Prosody is a newer dimension; enable where supported.
    try:
        pa_config.enable_prosody_assessment()
    except AttributeError:
        pass

    recognizer = speechsdk.SpeechRecognizer(
        speech_config=speech_config,
        audio_config=audio_config,
        language=LOCALE,
    )
    pa_config.apply_to(recognizer)

    t0 = time.time()
    try:
        result = recognizer.recognize_once()
    except Exception as exc:
        base.error_detail = f"SDK raised {type(exc).__name__}: {exc}"
        base.recognition_status = "error"
        base.latency_s = time.time() - t0
        return base
    base.latency_s = time.time() - t0

    reason = result.reason
    if reason == speechsdk.ResultReason.NoMatch:
        base.recognition_status = "no-match"
        base.error_detail = "Azure could not recognize any speech."
        return base
    if reason == speechsdk.ResultReason.Canceled:
        cancellation = result.cancellation_details
        base.recognition_status = "canceled"
        base.error_detail = (
            f"Canceled: {cancellation.reason}. {cancellation.error_details}"
        )
        return base
    if reason != speechsdk.ResultReason.RecognizedSpeech:
        base.recognition_status = "error"
        base.error_detail = f"Unexpected reason {reason}"
        return base

    base.recognized_text = result.text
    base.recognition_status = "ok"

    # Pull the pronunciation assessment payload. SDK exposes a helper + the
    # raw JSON; we read the JSON because it carries every per-word and
    # per-phoneme score we care about and is stable across SDK versions.
    pa = speechsdk.PronunciationAssessmentResult(result)
    base.accuracy = _f(pa.accuracy_score)
    base.pronunciation = _f(pa.pronunciation_score)
    base.completeness = _f(pa.completeness_score)
    base.fluency = _f(pa.fluency_score)
    base.prosody = _f(getattr(pa, "prosody_score", None))

    try:
        raw = json.loads(result.properties.get(
            speechsdk.PropertyId.SpeechServiceResponse_JsonResult, "{}"))
        for nbest in raw.get("NBest", [])[:1]:
            for word in nbest.get("Words", []):
                pa_w = word.get("PronunciationAssessment", {})
                base.words.append(WordResult(
                    word=word.get("Word", ""),
                    accuracy=pa_w.get("AccuracyScore"),
                    error_type=pa_w.get("ErrorType"),
                    phonemes=[
                        {
                            "phoneme": p.get("Phoneme"),
                            "accuracy": p.get("PronunciationAssessment", {})
                                .get("AccuracyScore"),
                        }
                        for p in word.get("Phonemes", [])
                    ],
                ))
    except Exception as exc:
        base.error_detail = (base.error_detail or "") + (
            f" [per-word parse failed: {type(exc).__name__}]")

    return base


def _f(x: Any) -> Optional[float]:
    try:
        if x is None:
            return None
        return float(x)
    except (TypeError, ValueError):
        return None


def _collect_files() -> list[tuple[Path, str]]:
    rows: list[tuple[Path, str]] = []
    for p in sorted(GOOD_DIR.glob("*.wav")):
        rows.append((p, "good"))
    for p in sorted(BAD_DIR.glob("*.wav")):
        rows.append((p, "bad"))
    return rows


def _summarize(results: list[RecordingResult]) -> dict[str, Any]:
    """Compute means / medians / separation. Never fabricates: if the API
    gave nothing back, the group reports {count: n, scored: 0}."""
    def agg(subset: list[RecordingResult], metric: str) -> dict[str, Any]:
        vals = [getattr(r, metric) for r in subset
                if getattr(r, metric) is not None]
        if not vals:
            return {"n": 0}
        return {
            "n": len(vals),
            "mean": round(mean(vals), 2),
            "median": round(median(vals), 2),
            "min": round(min(vals), 2),
            "max": round(max(vals), 2),
        }

    def group(label: str) -> dict[str, Any]:
        subset = [r for r in results if r.label == label]
        recognized = [r for r in subset if r.recognition_status == "ok"]
        return {
            "count": len(subset),
            "recognized": len(recognized),
            "recognition_rate": round(len(recognized) / max(len(subset), 1), 2),
            "accuracy": agg(subset, "accuracy"),
            "pronunciation": agg(subset, "pronunciation"),
            "completeness": agg(subset, "completeness"),
            "fluency": agg(subset, "fluency"),
            "prosody": agg(subset, "prosody"),
            "by_type": {
                t: agg([r for r in subset if r.audio_type == t], "accuracy")
                for t in ("sung", "spoken", "non-vocal")
            },
        }

    good = group("good")
    bad = group("bad")
    separation: Optional[float] = None
    if good["accuracy"].get("mean") is not None and bad["accuracy"].get("mean") is not None:
        separation = round(
            good["accuracy"]["mean"] - bad["accuracy"]["mean"], 2)

    return {
        "reference_text": REFERENCE_TEXT,
        "locale": LOCALE,
        "good": good,
        "bad": bad,
        "mean_accuracy_separation": separation,
        "notes": [
            "Separation > ~20 is a positive signal that Azure can tell "
            "good from bad on sung Happy Birthday takes.",
            "Separation < ~10 means Azure's accuracy is not discriminative "
            "on this material; look at by_type to see if sung underperforms.",
            "Low recognition_rate on sung takes means Azure's STT can't "
            "even hear the words — a known hard case for sung speech.",
        ],
    }


def _print_table(results: list[RecordingResult]) -> None:
    hdr = f"{'file':<22}{'label':<6}{'type':<10}{'reco':<8}" \
          f"{'acc':>6}{'comp':>6}{'flu':>6}{'pron':>6}{'latency':>8}"
    print(hdr)
    print("-" * len(hdr))
    for r in results:
        print(f"{r.filename:<22}{r.label:<6}{r.audio_type:<10}"
              f"{r.recognition_status:<8}"
              f"{_fmt(r.accuracy):>6}{_fmt(r.completeness):>6}"
              f"{_fmt(r.fluency):>6}{_fmt(r.pronunciation):>6}"
              f"{_fmt(r.latency_s, '{:.1f}'):>8}")


def _fmt(x: Optional[float], fmt: str = "{:.0f}") -> str:
    return fmt.format(x) if x is not None else "-"


def _write_csv(results: list[RecordingResult]) -> None:
    with RESULTS_CSV.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow([
            "filename", "label", "audio_type", "sample_rate", "channels",
            "duration_s", "peak_amplitude", "recognition_status",
            "recognized_text", "accuracy", "completeness", "fluency",
            "prosody", "pronunciation", "latency_s", "error_detail",
            "words_json",
        ])
        for r in results:
            w.writerow([
                r.filename, r.label, r.audio_type, r.sample_rate, r.channels,
                r.duration_s, r.peak_amplitude, r.recognition_status,
                r.recognized_text, r.accuracy, r.completeness, r.fluency,
                r.prosody, r.pronunciation, r.latency_s, r.error_detail,
                json.dumps([asdict(w_) for w_ in r.words]),
            ])


def main() -> int:
    files = _collect_files()
    if not files:
        print(f"No .wav files in {GOOD_DIR} or {BAD_DIR}. "
              "Record takes before running the spike.", file=sys.stderr)
        return 2

    key, region = _load_env()
    if not key or not region:
        print(
            "AZURE_SPEECH_KEY / AZURE_SPEECH_REGION not set in backend/.env.\n"
            "See the header of this file for setup steps. The script is\n"
            f"ready to score {len(files)} files once credentials are added.",
            file=sys.stderr,
        )
        return 2

    try:
        import azure.cognitiveservices.speech as speechsdk
    except ImportError:
        print(
            "azure-cognitiveservices-speech not installed.\n"
            "Run: pip install azure-cognitiveservices-speech",
            file=sys.stderr,
        )
        return 2

    speech_config = speechsdk.SpeechConfig(subscription=key, region=region)
    speech_config.speech_recognition_language = LOCALE

    print(f"Reference text: {REFERENCE_TEXT!r}  locale: {LOCALE}")
    print(f"Scoring {len(files)} takes against Azure Pronunciation "
          "Assessment ...\n")
    results: list[RecordingResult] = []
    for path, label in files:
        r = _score_one(speechsdk, speech_config, path, label)
        results.append(r)
    print()
    _print_table(results)
    print()
    summary = _summarize(results)
    print(json.dumps(summary, indent=2))

    _write_csv(results)
    SUMMARY_JSON.write_text(json.dumps(summary, indent=2) + "\n")
    print(f"\nWrote {RESULTS_CSV.name} and {SUMMARY_JSON.name} in ml/.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
