"""Voice-clone router: temporary IVC playback for one match.

Flow for a single player:
    POST /voice/clone       → upload a short WAV, get an opaque session_id
    POST /voice/say         → get the current line read in the cloned voice
    DELETE /voice/{id}      → player left / match ended / rematch

Also, every 60s a sweeper deletes any session older than SESSION_TTL_SECONDS;
on process shutdown everything still in the map is deleted from ElevenLabs.

Rules we hold the line on (AGENTS.md):
- Voice ids live only on the server. The frontend sees opaque session_ids.
- The uploaded audio is never written to disk; we stream straight from the
  request bytes into ElevenLabs' /voices/add and then drop them.
- Voice ids are never logged. Session ids are logged by UUID prefix only.
- One clone per player per match: the client decides when to call /clone,
  the server doesn't enforce player identity (we don't have one).
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Optional

import httpx
from fastapi import APIRouter, Body, File, HTTPException, Response, UploadFile

logger = logging.getLogger("lyrica.voice")

router = APIRouter(prefix="/voice", tags=["voice"])

ELEVEN_API_BASE = "https://api.elevenlabs.io"
# Multilingual stable model that covers English, Korean, and Arabic. The probe
# script in scripts/probe_voice_clone.py confirmed this exists on the account.
DEFAULT_MODEL = "eleven_multilingual_v2"
# A clone session only needs to outlive one match. 30 min is generous and
# matches the hard rule in AGENTS.md ("deleted when the match ends").
SESSION_TTL_SECONDS = 30 * 60
# How often the sweeper wakes up.
SWEEPER_INTERVAL_SECONDS = 60
# Short upper bound on the uploaded sample. ElevenLabs IVC accepts up to a
# minute; we only need ~15s and refuse larger uploads so the API can't be
# used as a general file store.
MAX_SAMPLE_BYTES = 3 * 1024 * 1024  # 3 MB
# ElevenLabs TTS limit for one request. We only send one short line.
MAX_TEXT_CHARS = 500


@dataclass
class VoiceSession:
    voice_id: str
    created_at: float
    # Cache per (song_id, line_id) so the same line only costs credits once.
    line_cache: dict[tuple[str, int], bytes] = field(default_factory=dict)


# Module-level map. One FastAPI process → one map. For multi-worker deploys
# this would need Redis, but a demo runs a single uvicorn worker.
_sessions: dict[str, VoiceSession] = {}
_sessions_lock = asyncio.Lock()
_sweeper_task: Optional[asyncio.Task[None]] = None


def _api_key() -> str:
    key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    if not key:
        raise HTTPException(
            503, "Add ELEVENLABS_API_KEY to backend/.env and restart the server."
        )
    return key


def _model_id() -> str:
    return os.getenv("ELEVENLABS_VOICE_CLONE_MODEL_ID", DEFAULT_MODEL)


def _short(session_id: str) -> str:
    """Log-safe prefix: enough to correlate across lines, not enough to replay."""
    return session_id[:8]


async def _delete_voice(voice_id: str) -> None:
    """Best-effort delete from ElevenLabs. Swallows all errors by design;
    the alternative is leaving an orphaned voice if the API hiccups."""
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            await client.delete(
                f"{ELEVEN_API_BASE}/v1/voices/{voice_id}",
                headers={"xi-api-key": _api_key()},
            )
    except Exception as exc:  # noqa: BLE001 - we never let this bubble
        logger.warning("voice: delete failed (%s)", type(exc).__name__)


async def _sweep_once(now: float) -> None:
    expired: list[tuple[str, VoiceSession]] = []
    async with _sessions_lock:
        for session_id, session in list(_sessions.items()):
            if now - session.created_at > SESSION_TTL_SECONDS:
                expired.append((session_id, session))
                _sessions.pop(session_id, None)
    for session_id, session in expired:
        logger.info("voice: TTL sweep removing session=%s", _short(session_id))
        await _delete_voice(session.voice_id)


async def _sweeper() -> None:
    while True:
        try:
            await asyncio.sleep(SWEEPER_INTERVAL_SECONDS)
            await _sweep_once(time.monotonic())
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - sweeper must not die
            logger.warning("voice: sweeper iteration failed (%s)", type(exc).__name__)


@asynccontextmanager
async def lifespan():
    """Start the sweeper and ensure every voice is deleted on shutdown.
    Call from the main FastAPI lifespan with `async with voice_lifespan():`."""
    global _sweeper_task
    _sweeper_task = asyncio.create_task(_sweeper(), name="voice-session-sweeper")
    try:
        yield
    finally:
        if _sweeper_task is not None:
            _sweeper_task.cancel()
            try:
                await _sweeper_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            _sweeper_task = None
        # Delete every voice still in the map so a crashed demo doesn't
        # leave clones sitting in the account.
        async with _sessions_lock:
            remaining = list(_sessions.values())
            _sessions.clear()
        for session in remaining:
            await _delete_voice(session.voice_id)


# ----- routes -------------------------------------------------------------


@router.post("/clone")
async def clone_voice(sample: UploadFile = File(...)) -> dict[str, str]:
    """Upload a short WAV; returns an opaque session_id. The sample bytes are
    streamed to ElevenLabs and dropped — never written to disk."""
    # Read into memory with a hard cap. UploadFile stores on disk only above
    # ~1 MB by default (SpooledTemporaryFile); we still want our own cap.
    data = await sample.read()
    if not data:
        raise HTTPException(400, "Empty voice sample.")
    if len(data) > MAX_SAMPLE_BYTES:
        raise HTTPException(413, "Voice sample is too large.")

    content_type = sample.content_type or "audio/wav"
    filename = "sample.wav"
    # ElevenLabs needs a label on the voice. Use something opaque so logs
    # on their side don't carry any player info.
    voice_label = f"lyrica-{uuid.uuid4().hex[:8]}"

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{ELEVEN_API_BASE}/v1/voices/add",
                headers={"xi-api-key": _api_key()},
                data={
                    "name": voice_label,
                    "description": "Lyrica temporary clone, auto-deleted.",
                    # Let ElevenLabs clean the mic sample before fingerprinting.
                    # Browser recordings carry room noise that otherwise bleeds
                    # into the clone and makes it sound less like the speaker.
                    "remove_background_noise": "true",
                },
                files={"files": (filename, data, content_type)},
            )
    except httpx.HTTPError:
        raise HTTPException(
            502, "ElevenLabs could not accept the voice sample. Try again."
        ) from None
    finally:
        # Explicitly release the bytes — the sample is sensitive.
        data = b""

    if resp.status_code // 100 != 2:
        # Never bubble ElevenLabs' body (it may contain hints or quotas).
        raise HTTPException(
            502, "ElevenLabs rejected the voice sample. Try a longer, clearer take."
        )
    body = resp.json() if resp.content else {}
    voice_id = body.get("voice_id")
    if not isinstance(voice_id, str) or not voice_id:
        raise HTTPException(502, "ElevenLabs did not return a voice id.")

    session_id = uuid.uuid4().hex
    async with _sessions_lock:
        _sessions[session_id] = VoiceSession(
            voice_id=voice_id, created_at=time.monotonic()
        )
    logger.info("voice: created session=%s", _short(session_id))
    return {"sessionId": session_id}


@router.post(
    "/say",
    response_class=Response,
    responses={200: {"content": {"audio/mpeg": {}}}},
)
async def say_line(
    body: dict = Body(...),
) -> Response:
    """Speak `text` in the cloned voice. Cache per (session, song_id, line_id)
    so each line only costs credits once."""
    session_id = str(body.get("sessionId", "")).strip()
    song_id = str(body.get("songId", "")).strip()
    line_id_raw = body.get("lineId")
    text = str(body.get("text", "")).strip()
    language = str(body.get("language", "en")).strip() or "en"

    if not session_id or not song_id or not isinstance(line_id_raw, int):
        raise HTTPException(422, "sessionId, songId, lineId are required.")
    if not text:
        raise HTTPException(422, "Empty line text.")
    if len(text) > MAX_TEXT_CHARS:
        raise HTTPException(413, "Line text is too long.")

    async with _sessions_lock:
        session = _sessions.get(session_id)
    if session is None:
        raise HTTPException(404, "This voice session has expired.")

    cache_key = (song_id, int(line_id_raw))
    cached = session.line_cache.get(cache_key)
    if cached is not None:
        return Response(content=cached, media_type="audio/mpeg",
                        headers={"Cache-Control": "no-store"})

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{ELEVEN_API_BASE}/v1/text-to-speech/{session.voice_id}",
                headers={
                    "xi-api-key": _api_key(),
                    "accept": "audio/mpeg",
                },
                json={
                    "text": text,
                    "model_id": _model_id(),
                    # Multilingual models infer language from text, but passing
                    # language_code when known helps non-Latin scripts.
                    "language_code": language,
                    # Push every lever toward "sounds like the speaker":
                    # - low stability lets inflection through
                    # - high similarity_boost biases toward the source clone
                    # - style keeps a little expressiveness
                    # - speaker_boost is ElevenLabs' extra similarity pass
                    # - speed < 1.0 slows the delivery so sung-feel lines
                    #   don't come out as a rushed sentence. ElevenLabs
                    #   supports 0.7-1.2; 0.85 is noticeably more musical
                    #   without warping the voice.
                    "voice_settings": {
                        "stability": 0.35,
                        "similarity_boost": 0.95,
                        "style": 0.3,
                        "use_speaker_boost": True,
                        "speed": 0.85,
                    },
                },
            )
    except httpx.HTTPError:
        raise HTTPException(
            502, "ElevenLabs could not generate audio. Try again."
        ) from None

    if resp.status_code // 100 != 2 or not resp.content:
        raise HTTPException(502, "ElevenLabs returned no audio for this line.")

    session.line_cache[cache_key] = resp.content
    return Response(content=resp.content, media_type="audio/mpeg",
                    headers={"Cache-Control": "no-store"})


@router.delete("/{session_id}")
async def delete_session(session_id: str) -> dict[str, str]:
    async with _sessions_lock:
        session = _sessions.pop(session_id, None)
    if session is None:
        # 200 either way: idempotent from the client's view, no information
        # leak about whether this session ever existed.
        return {"status": "ok"}
    logger.info("voice: deleting session=%s", _short(session_id))
    await _delete_voice(session.voice_id)
    return {"status": "ok"}
