# Song audio

One 10-second clip per language. Each song needs **two** files with the same
id, cut at the exact same timestamps so they line up:

| File | Contents | Used for |
|---|---|---|
| `<id>.mp3` | Full mix (vocals + instrumental) | Played by "Hear it" |
| `<id>-vocals.mp3` | Vocals only (stem) | Offline pitch extraction for scoring |

Expected files:

```
en-1.mp3   en-1-vocals.mp3
ko-1.mp3   ko-1-vocals.mp3
es-1.mp3   es-1-vocals.mp3
```

## Format

- MP3, mono or stereo, 44.1 kHz, ~128–192 kbps.
- Exactly 10 seconds (`CLIP_SECONDS` in `src/data/songs.ts`).
- Original ElevenLabs output with original lyrics only. No real artists, no
  existing songs.

Cutting a clip from a longer render:

```sh
ffmpeg -ss 00:00:12 -t 10 -i full.mp3 -c:a libmp3lame -q:a 4 en-1.mp3
ffmpeg -ss 00:00:12 -t 10 -i vocals.mp3 -c:a libmp3lame -q:a 4 en-1-vocals.mp3
```

## Lyrics

Alongside the audio, provide the lyrics for each clip split into **three
lines** (one per round). Those, plus the vocals stem, generate the syllable
timings and target pitches in `src/data/songs.ts`.

`src/data/songs.test.ts` checks the shape of each entry.
