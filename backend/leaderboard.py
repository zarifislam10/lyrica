"""Leaderboard reads and writes against Tiger Data.

Every function here is best-effort: a DB outage returns an empty list, never a
5xx. The frontend treats an empty response as "no leaderboard today."
"""

import json
import logging
import uuid
from typing import Annotated, Any, Literal, Optional

import asyncpg
from fastapi import APIRouter, Query

import db

router = APIRouter()
logger = logging.getLogger(__name__)

MAX_NICKNAME = 20
Language = Literal["en", "ko", "ar"]
LanguageQuery = Annotated[Optional[Language], Query()]


def _clean_nickname(name: str) -> str:
    return (name or "").strip()[:MAX_NICKNAME]


async def save_turns(rows: list[dict[str, Any]]) -> None:
    """Insert finished turns. Any failure is logged by type and swallowed."""
    if not rows:
        return
    pool = await db.get_pool()
    if pool is None:
        return
    records = []
    for row in rows:
        nickname = _clean_nickname(row.get("player", ""))
        if not nickname:
            continue
        records.append((
            row["match_id"],
            row["mode"],
            nickname,
            row.get("language"),
            row["song_id"],
            row["line_id"],
            int(row["tune"]),
            row.get("words"),
            json.dumps(row.get("missed", []), ensure_ascii=False),
        ))
    if not records:
        return
    try:
        async with pool.acquire() as conn:
            await conn.executemany(
                """INSERT INTO turns
                   (match_id, mode, player, language, song_id, line_id, tune, words, missed)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)""",
                records,
            )
    except (asyncpg.PostgresError, OSError, ValueError, KeyError, TypeError) as exc:
        logger.warning("Leaderboard write skipped: %s", type(exc).__name__)


def new_match_id() -> str:
    return uuid.uuid4().hex


@router.get("/leaderboard")
async def leaderboard(language: LanguageQuery = None) -> list[dict[str, Any]]:
    """Top 10 players by their best Tune score. Optional language filter."""
    pool = await db.get_pool()
    if pool is None:
        return []
    sql = """
        SELECT player, MAX(tune) AS best_tune, COUNT(*) AS turns
        FROM turns
        {where}
        GROUP BY player
        ORDER BY best_tune DESC, turns DESC, player ASC
        LIMIT 10
    """
    args: list[Any] = []
    where = ""
    if language is not None:
        where = "WHERE language = $1"
        args.append(language)
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(sql.format(where=where), *args)
    except (asyncpg.PostgresError, OSError, ValueError) as exc:
        logger.warning("Leaderboard read skipped: %s", type(exc).__name__)
        return []
    return [{"player": r["player"], "bestTune": int(r["best_tune"]),
             "turns": int(r["turns"])} for r in rows]


@router.get("/leaderboard/hardest")
async def hardest(language: LanguageQuery = None) -> list[dict[str, Any]]:
    """Three most-missed syllables across stored turns. Needs time-stamped data."""
    pool = await db.get_pool()
    if pool is None:
        return []
    sql = """
        SELECT syllable, COUNT(*) AS misses
        FROM turns, jsonb_array_elements_text(missed) AS syllable
        {where}
        GROUP BY syllable
        ORDER BY misses DESC, syllable ASC
        LIMIT 3
    """
    args: list[Any] = []
    where = ""
    if language is not None:
        where = "WHERE language = $1"
        args.append(language)
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(sql.format(where=where), *args)
    except (asyncpg.PostgresError, OSError, ValueError) as exc:
        logger.warning("Hardest-syllable read skipped: %s", type(exc).__name__)
        return []
    return [{"syllable": r["syllable"], "misses": int(r["misses"])} for r in rows]
