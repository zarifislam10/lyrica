"""Throwaway probe: does this ElevenLabs account support instant voice cloning,
and is there a multilingual model that covers English, Korean, and Arabic?

Run from the repo root with the backend venv:

    ./backend/.venv/bin/python scripts/probe_voice_clone.py

Reads ELEVENLABS_API_KEY from backend/.env. Never prints the key. If the
account can't clone, prints a clear STOP and exits non-zero so a caller
script can gate feature work on this result.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = ROOT / "backend" / ".env"
API_BASE = "https://api.elevenlabs.io"

REQUIRED_LANGUAGES = {"en", "ko", "ar"}


def _get(client: httpx.Client, path: str) -> dict:
    r = client.get(f"{API_BASE}{path}")
    r.raise_for_status()
    return r.json()


def main() -> int:
    load_dotenv(ENV_PATH)
    api_key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    if not api_key:
        print("STOP: ELEVENLABS_API_KEY is missing in backend/.env.")
        return 2

    print(
        f"Key loaded: prefix={api_key[:3]!r}, length={len(api_key)} "
        "(not printing the key itself).\n"
    )

    with httpx.Client(
        timeout=15.0, headers={"xi-api-key": api_key, "accept": "application/json"}
    ) as client:
        # 1. Try the broadest-scope read first. If this works we also learn
        # the account's clone capability. If it 401s with "missing_permissions"
        # the key is scoped — we fall back to the clone-specific checks.
        user_ok = False
        clone_flag: object | None = None
        try:
            user_resp = client.get(f"{API_BASE}/v1/user")
            if user_resp.status_code == 200:
                user = user_resp.json()
                user_ok = True
                clone_flag = (
                    user.get("can_use_instant_voice_cloning")
                    or user.get("subscription", {}).get(
                        "can_use_instant_voice_cloning"
                    )
                )
                sub = user.get("subscription", {})
                print("Account read via /v1/user:")
                print(f"  can_use_instant_voice_cloning = {bool(clone_flag)}")
                if "voice_limit" in sub:
                    print(f"  voice_limit = {sub['voice_limit']}")
                if "voice_slots_used" in sub:
                    print(f"  voice_slots_used = {sub['voice_slots_used']}")
            else:
                detail = ""
                try:
                    detail = user_resp.json().get("detail", {}).get(
                        "message", ""
                    ) or user_resp.text[:200]
                except Exception:  # noqa: BLE001 - best-effort surface
                    detail = user_resp.text[:200]
                print(
                    f"/v1/user returned {user_resp.status_code}: {detail!r}\n"
                    "Key may be scoped; trying lower-privilege probes.\n"
                )
        except httpx.HTTPError as err:
            print(f"STOP: could not reach ElevenLabs: {type(err).__name__}.")
            return 3

        # 2. Confirm the key can at least list TTS models. If this 401s too,
        # the key really is invalid / revoked and we should stop.
        try:
            models_resp = client.get(f"{API_BASE}/v1/models")
            if models_resp.status_code != 200:
                print(
                    f"STOP: /v1/models returned {models_resp.status_code}. "
                    "The key is invalid or revoked — rotate it again."
                )
                return 1
            models = models_resp.json()
        except httpx.HTTPError as err:
            print(f"STOP: could not list models: {type(err).__name__}.")
            return 3

        print(f"\n/v1/models works (listed {len(models) if isinstance(models, list) else 0} models).")

        # 3. If /v1/user didn't tell us, probe cloning directly by listing voices
        # (voices:read permission is implicit for cloning scopes).
        if not user_ok:
            voices_resp = client.get(f"{API_BASE}/v1/voices")
            if voices_resp.status_code == 200:
                print(
                    "/v1/voices works — the key has at least voices:read, which\n"
                    "is a prerequisite for cloning. If cloning calls still 401,\n"
                    "re-issue the key with voices:write + voices:read scope."
                )
                clone_flag = True
            else:
                print(
                    f"STOP: /v1/voices returned {voices_resp.status_code}. The key\n"
                    "doesn't have the voices scope; cloning won't work. Re-issue\n"
                    "with voices:write (and voices:read) scope."
                )
                return 1

        if not clone_flag:
            print(
                "\nSTOP: this ElevenLabs plan cannot create instant voice clones.\n"
                "Upgrade or use a different account before building the UI."
            )
            return 1

        candidates: list[tuple[str, str, set[str]]] = []
        for m in models if isinstance(models, list) else []:
            langs = {
                (lang.get("language_id") or "").lower()
                for lang in m.get("languages", [])
                if isinstance(lang, dict)
            }
            if m.get("can_do_text_to_speech") and REQUIRED_LANGUAGES.issubset(langs):
                candidates.append(
                    (
                        str(m.get("model_id", "")),
                        str(m.get("name", "")),
                        langs,
                    )
                )

        print("\nMultilingual TTS models that cover en + ko + ar:")
        if not candidates:
            print(
                "  (none)\n\nSTOP: no model covers all three languages. Pick a\n"
                "different language set or use a model per language."
            )
            return 1
        for model_id, name, _langs in candidates:
            print(f"  - {model_id}  ({name})")

        print("\nOK: this account can clone and a multilingual model is available.")
        return 0


if __name__ == "__main__":
    sys.exit(main())
