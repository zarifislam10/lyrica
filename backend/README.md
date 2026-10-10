# Lyrica backend: first announcement

This first step exposes a health check and generates one fixed spoken welcome.
Scores, Gemini commentary, database storage, and frontend integration are later steps.

## Local setup

From this backend folder:

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

This is a local development milestone. Before public deployment, we will add
appropriate access/rate limits to the paid endpoint and connect the frontend.
