"""Idempotent schema setup for the Tiger Data leaderboard.

Run once from the repo root:

    python -m backend.migrate

Reads DATABASE_URL from backend/.env. Safe to run again — every statement is
guarded by IF NOT EXISTS or Tiger Data's if_not_exists parameter.
"""

import asyncio
import logging
import os
import sys
from pathlib import Path

import asyncpg
from dotenv import load_dotenv

load_dotenv(Path(__file__).with_name(".env"))

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(message)s")

# Plain table first; Tiger Data converts it to a hypertable in the second step.
CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS turns (
    time         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    match_id     TEXT        NOT NULL,
    mode         TEXT        NOT NULL CHECK (mode IN ('solo', 'battle')),
    player       TEXT        NOT NULL,
    language     TEXT,
    song_id      TEXT        NOT NULL,
    line_id      TEXT        NOT NULL,
    tune         INTEGER     NOT NULL CHECK (tune BETWEEN 0 AND 100),
    words        INTEGER              CHECK (words BETWEEN 0 AND 100),
    missed       JSONB       NOT NULL DEFAULT '[]'::jsonb
);
"""

# Current Tiger Data syntax: by_range() dimension builder + if_not_exists.
# See https://www.tigerdata.com/docs/reference/timescaledb/hypertables/create_hypertable/
CREATE_HYPERTABLE = """
SELECT create_hypertable(
    'turns',
    by_range('time'),
    if_not_exists => TRUE
);
"""

# Supporting indexes for the two read queries. Plain btree is enough: the
# hypertable already indexes `time` for range scans.
CREATE_INDEXES = [
    "CREATE INDEX IF NOT EXISTS turns_language_tune_idx ON turns (language, tune DESC);",
    "CREATE INDEX IF NOT EXISTS turns_language_time_idx ON turns (language, time DESC);",
]


async def run() -> int:
    url = os.getenv("DATABASE_URL", "").strip()
    if not url:
        logger.error("DATABASE_URL is not set in backend/.env.")
        return 1

    try:
        conn = await asyncpg.connect(dsn=url, command_timeout=15.0)
    except (asyncpg.PostgresError, OSError, ValueError) as exc:
        logger.error("Could not connect to Tiger Data: %s", type(exc).__name__)
        return 2

    try:
        await conn.execute(CREATE_TABLE)
        logger.info("turns table ready")
        await conn.execute(CREATE_HYPERTABLE)
        logger.info("turns is a hypertable (by_range on time, if_not_exists => TRUE)")
        for sql in CREATE_INDEXES:
            await conn.execute(sql)
        logger.info("supporting indexes ready")
    except asyncpg.PostgresError as exc:
        logger.error("Migration failed: %s", type(exc).__name__)
        return 3
    finally:
        await conn.close()

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(run()))
