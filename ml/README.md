# ml/ — pronunciation similarity probe

Standalone Python experiment. Does **not** touch `src/` or `backend/`. The
question it answers: can a frozen pre-trained speech model separate "good"
takes of a reference line from "bad" ones, using only frame-embedding
similarity aligned with dynamic time warping?

## Setup

From the repo root:

```sh
cd ml
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```

The first run of `sound_match_test.py` downloads
`facebook/wav2vec2-xls-r-300m` (~1.2 GB) into `~/.cache/huggingface/`. CPU
is fine for this experiment; a run of ~10 short takes finishes in minutes.

## Record takes

Everything under `ml/takes/` is gitignored. Voice recordings must never
be committed.

```
ml/takes/
  reference.wav          (or .m4a / .mp3)   — the target pronunciation
  good/
    take-01.wav                               — tries sounding like the reference
    take-02.wav
    ...
  bad/
    take-01.wav                               — deliberately off (wrong vowel,
    take-02.wav                                  wrong word, mumbled, etc.)
    ...
```

Tips:
- Keep each clip to the same single line/phrase as the reference.
- 1–5 seconds each is plenty.
- Record in a quiet room, same mic, same distance when you can — the
  experiment is about pronunciation, not acoustics.
- At least 3 of each (good/bad) makes the gap statistic more meaningful.
- Any mix of `.wav`, `.m4a`, `.mp3` is accepted; everything gets converted
  to 16 kHz mono internally.

## Run

```sh
python sound_match_test.py
```

If anything is missing you'll get a clear "nothing to score" message
listing what's expected — no crash, no model download.

## Read the output

For each of hidden layers 6, 9, and 12, the script prints:

- a table of every take and its score (mean cosine similarity along the
  DTW path, in [-1, 1] — higher = more pronunciation-similar to the
  reference)
- `lowest good` and `highest bad` scores
- `gap = lowest_good - highest_bad`
- `PASS` if the gap is positive (every good take beat every bad take at
  that layer), otherwise `FAIL`

A layer that `PASS`es is a candidate for powering a pronunciation score
inside Lyrica without any training.
