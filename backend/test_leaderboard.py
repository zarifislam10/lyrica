"""Leaderboard unit tests. Zero real database calls; db.get_pool is patched."""

import json
import os
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi.testclient import TestClient

import db
import leaderboard
import main


class FakePool:
    """A minimal asyncpg.Pool stand-in: records calls, returns scripted rows."""

    def __init__(self, rows=None, executemany_raises=None, fetch_raises=None):
        self.rows = rows or []
        self.executemany_raises = executemany_raises
        self.fetch_raises = fetch_raises
        self.executemany_calls = []
        self.fetch_calls = []

    def acquire(self):
        pool = self

        class _Ctx:
            async def __aenter__(self_inner):
                conn = MagicMock()

                async def executemany(sql, records):
                    pool.executemany_calls.append((sql, records))
                    if pool.executemany_raises:
                        raise pool.executemany_raises

                async def fetch(sql, *args):
                    pool.fetch_calls.append((sql, args))
                    if pool.fetch_raises:
                        raise pool.fetch_raises
                    return pool.rows

                conn.executemany = executemany
                conn.fetch = fetch
                return conn

            async def __aexit__(self_inner, *args):
                return False

        return _Ctx()


class LeaderboardTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self.addCleanup(self.client.close)
        db.reset_for_tests()
        self.addCleanup(db.reset_for_tests)

    # --- save_turns -----------------------------------------------------

    def test_save_turns_is_a_no_op_when_database_url_is_missing(self):
        with patch.dict(os.environ, {"DATABASE_URL": ""}, clear=False):
            # No pool is created; nothing raises.
            import asyncio
            asyncio.run(leaderboard.save_turns([{"match_id": "m", "mode": "battle",
                "player": "Ava", "song_id": "s", "line_id": "1", "tune": 80,
                "missed": []}]))

    def test_save_turns_trims_nicknames_and_drops_blank_ones(self):
        pool = FakePool()
        with patch.object(db, "get_pool", AsyncMock(return_value=pool)):
            import asyncio
            asyncio.run(leaderboard.save_turns([
                {"match_id": "m", "mode": "battle",
                 "player": "   " + "A" * 50 + "   ",
                 "language": "en", "song_id": "s", "line_id": "1",
                 "tune": 80, "words": None, "missed": ["birth"]},
                {"match_id": "m", "mode": "battle", "player": "   ",  # blank → dropped
                 "language": "en", "song_id": "s", "line_id": "1",
                 "tune": 20, "words": None, "missed": []},
            ]))
        self.assertEqual(len(pool.executemany_calls), 1)
        _, records = pool.executemany_calls[0]
        self.assertEqual(len(records), 1)  # the blank one was dropped
        nickname = records[0][2]
        self.assertEqual(nickname, "A" * leaderboard.MAX_NICKNAME)
        # missed is passed as a JSON string so asyncpg can bind it to jsonb.
        self.assertEqual(json.loads(records[0][8]), ["birth"])

    def test_save_turns_swallows_database_errors(self):
        import asyncpg
        pool = FakePool(executemany_raises=asyncpg.PostgresError("boom"))
        with patch.object(db, "get_pool", AsyncMock(return_value=pool)):
            import asyncio
            # Must not raise.
            asyncio.run(leaderboard.save_turns([{"match_id": "m", "mode": "battle",
                "player": "Ava", "language": "en", "song_id": "s", "line_id": "1",
                "tune": 80, "words": None, "missed": []}]))

    # --- GET /leaderboard -----------------------------------------------

    def test_leaderboard_returns_empty_when_db_is_down(self):
        with patch.object(db, "get_pool", AsyncMock(return_value=None)):
            response = self.client.get("/leaderboard")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [])

    def test_leaderboard_returns_empty_when_fetch_errors(self):
        import asyncpg
        pool = FakePool(fetch_raises=asyncpg.PostgresError("down"))
        with patch.object(db, "get_pool", AsyncMock(return_value=pool)):
            response = self.client.get("/leaderboard")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [])

    def test_leaderboard_language_filter_is_passed_as_bound_param(self):
        pool = FakePool(rows=[{"player": "Ava", "best_tune": 95, "turns": 3}])
        with patch.object(db, "get_pool", AsyncMock(return_value=pool)):
            response = self.client.get("/leaderboard?language=ko")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(),
                         [{"player": "Ava", "bestTune": 95, "turns": 3}])
        sql, args = pool.fetch_calls[0]
        self.assertIn("WHERE language = $1", sql)
        self.assertEqual(args, ("ko",))

    def test_leaderboard_rejects_unknown_language(self):
        # Pydantic's Literal validation on the Query parameter.
        self.assertEqual(self.client.get("/leaderboard?language=fr").status_code, 422)

    def test_leaderboard_no_language_means_no_where_clause(self):
        pool = FakePool(rows=[])
        with patch.object(db, "get_pool", AsyncMock(return_value=pool)):
            self.client.get("/leaderboard")
        sql, args = pool.fetch_calls[0]
        self.assertNotIn("WHERE", sql)
        self.assertEqual(args, ())

    # --- GET /leaderboard/hardest ---------------------------------------

    def test_hardest_returns_empty_when_db_is_down(self):
        with patch.object(db, "get_pool", AsyncMock(return_value=None)):
            response = self.client.get("/leaderboard/hardest")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [])

    def test_hardest_returns_rows_in_order(self):
        pool = FakePool(rows=[
            {"syllable": "birth", "misses": 7},
            {"syllable": "day", "misses": 3},
        ])
        with patch.object(db, "get_pool", AsyncMock(return_value=pool)):
            response = self.client.get("/leaderboard/hardest?language=en")
        self.assertEqual(response.json(), [
            {"syllable": "birth", "misses": 7},
            {"syllable": "day", "misses": 3},
        ])
        sql, args = pool.fetch_calls[0]
        self.assertIn("jsonb_array_elements_text(missed)", sql)
        self.assertEqual(args, ("en",))


if __name__ == "__main__":
    unittest.main()
