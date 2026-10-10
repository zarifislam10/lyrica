"""First backend milestone: turn one fixed announcement into speech."""

import os
from pathlib import Path

import httpx
from dotenv import load_dotenv
from elevenlabs.client import ElevenLabs
from elevenlabs.core.api_error import ApiError
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware

from round_result import router as round_result_router

load_dotenv(Path(__file__).with_name(".env"))

app = FastAPI(title="Lyrica Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in os.getenv(
        "FRONTEND_ORIGINS",
        "http://localhost:8443,http://127.0.0.1:8443,http://localhost:5173,http://127.0.0.1:5173",
    ).split(",") if origin.strip()],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)
app.include_router(round_result_router)
WELCOME_TEXT = "Welcome to Lyrica! Round one starts now!"


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/announcer/welcome", response_class=Response,
          responses={200: {"content": {"audio/mpeg": {}}}})
def welcome() -> Response:
    """Generate an MP3. Each request uses ElevenLabs credits."""
    api_key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(503, "Add ELEVENLABS_API_KEY to backend/.env and restart the server.")

    # Buffer this short line so provider failures return a clear error before audio starts.
    try:
        with httpx.Client(timeout=30.0) as http_client:
            client = ElevenLabs(api_key=api_key, httpx_client=http_client)
            audio = b"".join(client.text_to_speech.convert(
                text=WELCOME_TEXT,
                voice_id=os.getenv("ELEVENLABS_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb"),
                model_id=os.getenv("ELEVENLABS_MODEL_ID", "eleven_v4"),
                output_format="mp3_44100_128",
                request_options={"max_retries": 0},
            ))
    except httpx.TimeoutException:
        raise HTTPException(504, "The announcer timed out. Please try again.") from None
    except (ApiError, httpx.HTTPError):
        # Never expose provider response bodies or credentials to the browser.
        raise HTTPException(502, "ElevenLabs could not generate audio. Check your key, credits, voice and model settings.") from None

    if not audio:
        raise HTTPException(502, "ElevenLabs returned no audio. Please try again.")
    return Response(content=audio, media_type="audio/mpeg", headers={
        "Content-Disposition": 'attachment; filename="lyrica-welcome.mp3"',
        "Cache-Control": "no-store",
    })
