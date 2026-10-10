# Song audio

One spoken "Hear it" clip per language, rendered by us with ElevenLabs TTS.
No audio from any other recording.

```
happy-birthday-en.mp3
happy-birthday-ko.mp3
happy-birthday-ar.mp3
```

Each clip speaks the song's three battle lines in order. The time range of each
line goes into `audioStart` / `audioEnd` on that line in `src/data/songs.ts`.

Target notes are **not** measured from these files. They are typed by hand in
`src/data/songs.ts` as semitones.
