# Lyrica backend

FastAPI provides the welcome speech and round-result commentary. The browser owns
scoring and match outcomes; this backend generates commentary and audio, with no database.

## Local setup

From this backend folder, with Python 3.11 or newer (the pinned packages don't
install on 3.9). If `python3 --version` is older, `uv venv --python 3.12 .venv`
downloads a ready-made Python instead of building one.

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
cp -n .env.example .env
```

Open `.env` locally and fill in `ELEVENLABS_API_KEY`. Do not paste the key into chat
or put it in a frontend `VITE_` variable. Environment variables set by your host
override values in `.env`. Restart after changing settings.

```sh
python -m uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

1. Open http://127.0.0.1:8000/health. It returns `{"status":"ok"}` without API keys.
2. Open http://127.0.0.1:8000/docs.
3. Expand `POST /announcer/welcome`, choose **Try it out**, then **Execute**.
4. Download the returned MP3 and play it.

Each execution makes a paid/credit-consuming ElevenLabs request. The voice and
model can be changed in `.env` to ones available to your account. The defaults
follow https://elevenlabs.io/docs/eleven-api/quickstart.

The endpoint returns 503 for a missing key, 504 for a provider timeout, and 502
for provider failure or empty audio. It never returns the provider's error body.
The welcome text is sent to ElevenLabs; no player recording is involved.

Before public deployment, add appropriate access/rate limits to paid endpoints.
CORS controls which browser origins can read responses; it is not authentication.

## POST /round-result — frontend handoff

Add `GEMINI_API_KEY` to your existing local `.env`. Use `.env.example` for the new
optional settings; do not overwrite an existing `.env`. Restart the backend.
`GEMINI_MODEL` defaults to `gemini-3.5-flash-lite`. `gemini-2.5-flash` now returns
404 for new keys, and full-size Flash models spend the 256-token budget on thinking,
so their replies come back incomplete and the round falls back. Round speech uses
`ELEVENLABS_ROUND_MODEL_ID=eleven_flash_v2_5` for low latency; the welcome keeps its
existing model and `ELEVENLABS_VOICE_ID`. Round speech (Aux) uses
`ELEVENLABS_ANNOUNCER_VOICE_ID`, which defaults to Jessica
(`cgSgspJ2msm6clMCkdW9`, young, bright and playful) when unset; it is separate so
changing Aux's voice never changes the "Hear it" clips.

The following is the initial API contract; the current checked-out frontend does
not yet call it. Coordinate the field names with Jasleen before integrating.
`round-result.example.json` contains a complete request:

```json
{
  "round": 1,
  "lineId": "1",
  "players": [
    {"id": "p1", "name": "Laiba", "score": 85, "missedSyllables": []},
    {"id": "p2", "name": "Zarif", "score": 72, "missedSyllables": ["녕"]}
  ],
  "winnerId": "p1"
}
```

Exactly two distinct player IDs are required. Scores must be finite numbers from
0 to 100. Round is 1–3. Send line IDs as strings (`String(line.id)`). `winnerId` is
required and must reference a supplied player, or be `null` for a tie. The backend
accepts the supplied outcome and does not rank players or modify scores.
`missedSyllables` contains text, not array indexes: map each `result.missed` index
to the relevant Hangul/romanization before sending. No microphone audio is needed.

Successful response (`200`):

```json
{
  "commentary": "Laiba wins round 1! Great effort from both singers!",
  "audioUrl": "data:audio/mpeg;base64,<MP3 bytes encoded as base64>",
  "fallback": false,
  "coaching": {"p2": "Practice saying chu and ka slowly, or tap Hear it to repeat."}
}
```

**Coaching (optional).** Send `language` (`en`, `ko` or `ar`) and, per player,
`missedDetails: [{"text": "축", "romanization": "chu"}]`. Gemini then words one
practice tip per player who missed syllables, in parallel with the announcer, so
it adds no wait. It only rephrases the syllables our scorer marked; it never hears
the take. `coaching` is `{}` when nobody missed anything, on fallback, or if the
coaching call fails — the announcer is unaffected either way.

`audioUrl` is a self-contained MP3 data URL: pass it directly to `new Audio(audioUrl)`.
It needs no second download endpoint, public storage, or database. If the frontend
sets a Content Security Policy, its `media-src` must allow `data:`.

Missing keys, blocked/empty Gemini responses, provider errors, and generation that
exceeds **five seconds total** return `200` with deterministic text, `audioUrl: null`,
and `fallback: true`. This cancels unfinished requests locally, but providers may
already have consumed credits. Invalid input returns `422` before calling providers.
No provider response bodies or secrets are returned to the frontend.

### Jasleen's six-second fallback

The backend budget cannot cover network delays or a server that is unreachable.
The frontend must use its own six-second timeout, retain its built-in commentary,
and never wait for this endpoint before showing scores or enabling the next round.

Example integration (illustrative, not yet wired into the frontend):

```ts
async function loadAnnouncement(payload, showBuiltIn, showCommentary) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(`${API_BASE_URL}/round-result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("Announcer unavailable");
    const result = await response.json();
    if (result.fallback || !result.audioUrl) {
      showBuiltIn();
      return null;
    }
    showCommentary(result.commentary);
    const audio = new Audio(result.audioUrl);
    // Browsers may require a user tap. Keep the text and offer a Play button.
    void audio.play().catch(() => { /* show a Play announcement button */ });
    return audio;
  } catch {
    showBuiltIn();
    return null;
  } finally {
    clearTimeout(timer);
  }
}
```

Call once per completed round. In the actual React integration, also abort on
unmount/round change, ignore stale responses, and pause old audio before continuing.
Do not automatically retry paid generation. Add the exact frontend origin to
`FRONTEND_ORIGINS` for deployment (comma-separated; local Vite origins are defaults).

### Test locally

From the backend folder:

```sh
python -m unittest discover -v
curl -X POST http://127.0.0.1:8000/round-result \
  -H 'Content-Type: application/json' \
  --data-binary @round-result.example.json
```

The automated tests mock provider HTTP responses and consume no credits. The curl
request uses live providers when both keys are configured. `/docs` also exposes the
request/response schema. Test missing keys and the browser's six-second fallback
before the demo. A full live Gemini + ElevenLabs call requires both valid keys.

Provider references: [Gemini](https://ai.google.dev/api) and
[ElevenLabs](https://elevenlabs.io/docs/api-reference/text-to-speech/convert).

## "Hear it" clips (offline, before the demo)

`generate_hear_it.py` asks ElevenLabs text-to-speech to speak each song's line and
saves it as `public/songs/<song id>.mp3`. The "Hear it" button plays that file.
It runs on your machine, not on the server; commit the mp3s it writes.

```sh
python generate_hear_it.py                     # every song
python generate_hear_it.py happy-birthday-ar   # one song
python generate_hear_it.py --force happy-birthday-ko   # re-render
```

- The text is read from `src/data/songs.ts` with Node, so a clip always says exactly
  what players sing. Every round of a song has the same words, so one clip per song.
- Speech is slowed to 0.85× so learners can follow each syllable.
- Each clip spends credits. Existing files are kept unless you pass `--force`.
- Optional settings in `.env`: `ELEVENLABS_HEAR_IT_VOICE_ID` (falls back to
  `ELEVENLABS_VOICE_ID`) and `ELEVENLABS_HEAR_IT_MODEL_ID` (default
  `eleven_multilingual_v2`, which supports Korean and Arabic).

Listen to every clip before committing, especially Korean and Arabic. If the
pronunciation is off, try another voice or model and re-run with `--force`.
