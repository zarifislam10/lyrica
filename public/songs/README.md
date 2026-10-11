# Song audio

One spoken "Hear it" clip per language, rendered by us with ElevenLabs TTS.
No audio from any other recording.

```
happy-birthday-en.mp3
happy-birthday-ko.mp3
happy-birthday-ar.mp3
```

All three battle lines share the same words, so each clip speaks the line
**once** and "Hear it" plays the whole clip. Lines leave `audioStart` /
`audioEnd` unset; set them only if a future song has different words per line.

Target notes are **not** measured from these files. They are typed by hand in
`src/data/songs.ts` as semitones.
