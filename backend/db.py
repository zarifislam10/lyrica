"""Tiger Data connection pool. DATABASE_URL is read once and never logged."""

import logging
import os
from typing import Optional

import asyncpg

logger = logging.getLogger(__name__)

_pool: Optional[asyncpg.Pool] = None
_disabled = False


def database_configured() -> bool:
    return bool(os.getenv("DATABASE_URL", "").strip())


async def get_pool() -> Optional[asyncpg.Pool]:
    """Return the shared pool, or None when DATABASE_URL is missing or unreachable.

    Callers must treat None as "no leaderboard today" and continue. The URL is
    never printed, even on failure — only the exception type goes to the log.
    """
    global _pool, _disabled
    if _disabled:
        return None
    if _pool is not None:
        return _pool
    url = os.getenv("DATABASE_URL", "").strip()
    if not url:
        return None
    try:
        _pool = await asyncpg.create_pool(dsn=url, min_size=1, max_size=4,
                                          command_timeout=5.0)
    except (asyncpg.PostgresError, OSError, ValueError) as exc:
        # Disable for the rest of the process so we don't retry on every request.
        _disabled = True
        logger.warning("Leaderboard pool unavailable: %s", type(exc).__name__)
        return None
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def reset_for_tests() -> None:
    """Tests patch get_pool directly; this clears any cached state between runs."""
    global _pool, _disabled
    _pool = None
    _disabled = False
