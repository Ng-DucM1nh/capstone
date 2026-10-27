from __future__ import annotations

import contextlib
import logging
import os
import re
from typing import Any, Generator

import psycopg2
import psycopg2.extras
from psycopg2.pool import SimpleConnectionPool

from app.config import get_settings

logger = logging.getLogger(__name__)

_pool: SimpleConnectionPool | None = None
_serverless_conn = None
_duckdb_raw_conn = None
_active_engine: str | None = None
IS_SERVERLESS = bool(os.environ.get("VERCEL") or os.environ.get("AWS_LAMBDA_FUNCTION_NAME"))

# Written by app/services/forecast_service.py, read by the Prediction page. Valid in DuckDB and PostgreSQL.
# The ALTER upgrades tables made before validated_days existed; their old rows stay NULL there until
# the farm's forecasts are refreshed.
FORECASTS_DDL = """
    CREATE TABLE IF NOT EXISTS forecasts (
        farm_id VARCHAR(50) NOT NULL,
        eid VARCHAR(50) NOT NULL,
        target VARCHAR(50) NOT NULL,
        date DATE NOT NULL,
        pred DOUBLE PRECISION NOT NULL,
        horizon INTEGER NOT NULL,
        tier VARCHAR(10) NOT NULL,
        history_days INTEGER NOT NULL,
        data_through DATE NOT NULL,
        model_version VARCHAR(50) NOT NULL,
        validated_days INTEGER,
        generated_at TIMESTAMP NOT NULL,
        PRIMARY KEY (farm_id, eid, target, date)
    );
    ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS validated_days INTEGER;
"""

# The upload bookkeeping tables Supabase has (POST /api/admin/farms/{farm_id}/upload writes them),
# for the dev DuckDB only.
DUCKDB_UPLOAD_TABLES_DDL = """
    CREATE SEQUENCE IF NOT EXISTS animal_data_snapshots_id_seq START 1;
    CREATE TABLE IF NOT EXISTS animal_data_snapshots (
        id BIGINT PRIMARY KEY DEFAULT nextval('animal_data_snapshots_id_seq'),
        farm_id VARCHAR(50) NOT NULL,
        snapshot_name VARCHAR NOT NULL,
        record_count INTEGER NOT NULL,
        storage_path VARCHAR,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_by VARCHAR
    );
    CREATE SEQUENCE IF NOT EXISTS data_uploads_id_seq START 1;
    CREATE TABLE IF NOT EXISTS data_uploads (
        id BIGINT PRIMARY KEY DEFAULT nextval('data_uploads_id_seq'),
        farm_id VARCHAR(50) NOT NULL,
        filename VARCHAR NOT NULL,
        rows_inserted INTEGER DEFAULT 0,
        rows_skipped INTEGER DEFAULT 0,
        rows_overwritten INTEGER DEFAULT 0,
        duplicate_mode VARCHAR,
        storage_path VARCHAR,
        uploaded_by VARCHAR,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
"""


def _convert_pg_to_duckdb_sql(query: str) -> str:
    """Convert PostgreSQL %s positional placeholders and dialect quirks to DuckDB."""
    # Match %s not preceded by %
    sql = re.sub(r"(?<!%)%s", "?", query)
    sql = sql.replace("%%", "%")
    # Translate PostgreSQL to_char(col, 'YYYY-MM-DD') -> CAST(col AS VARCHAR)
    sql = re.sub(r"to_char\(([^,]+),\s*['\"]YYYY-MM-DD['\"]\)", r"CAST(\1 AS VARCHAR)", sql, flags=re.IGNORECASE)
    return sql


class _DuckDBCursorWrapper:
    def __init__(self, raw_cursor: Any) -> None:
        self._cur = raw_cursor

    def execute(self, query: str, params: tuple | list | None = None) -> Any:
        sql = _convert_pg_to_duckdb_sql(query)
        return self._cur.execute(sql, params or ())

    def fetchone(self) -> dict | None:
        if not self._cur.description:
            return None
        cols = [d[0] for d in self._cur.description]
        row = self._cur.fetchone()
        return dict(zip(cols, row)) if row else None

    def fetchall(self) -> list[dict]:
        if not self._cur.description:
            return []
        cols = [d[0] for d in self._cur.description]
        return [dict(zip(cols, row)) for row in self._cur.fetchall()]

    @property
    def rowcount(self) -> int:
        return getattr(self._cur, "rowcount", -1)

    def __enter__(self) -> _DuckDBCursorWrapper:
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        pass

    def __getattr__(self, name: str) -> Any:
        return getattr(self._cur, name)


class _DuckDBConnectionWrapper:
    def __init__(self, raw_conn: Any) -> None:
        self._conn = raw_conn

    def cursor(self, *args: Any, **kwargs: Any) -> _DuckDBCursorWrapper:
        return _DuckDBCursorWrapper(self._conn.cursor())

    def commit(self) -> None:
        pass

    def rollback(self) -> None:
        pass

    def __getattr__(self, name: str) -> Any:
        return getattr(self._conn, name)


def _connect_postgres():
    settings = get_settings()
    return psycopg2.connect(
        settings.database_url,
        connect_timeout=3,
        keepalives=1,
        keepalives_idle=30,
        keepalives_interval=10,
        keepalives_count=3,
    )


def get_pool() -> SimpleConnectionPool:
    global _pool
    if _pool is None:
        settings = get_settings()
        _pool = SimpleConnectionPool(1, 5, settings.database_url, connect_timeout=5)
    return _pool


def _ensure_duckdb_schema(raw_conn: Any) -> None:
    try:
        cur = raw_conn.cursor()
        tables = [r[0] for r in cur.execute("SHOW TABLES").fetchall()]
        if "email_schedules" in tables:
            cols = {r[0].lower() for r in cur.execute("DESCRIBE email_schedules").fetchall()}
            required_cols = {
                "farm_id": "VARCHAR(50)",
                "next_send_at": "TIMESTAMP",
                "report_charts": "VARCHAR(500)",
                "report_format": "VARCHAR(50) DEFAULT 'pdf'",
            }
            for col_name, col_type in required_cols.items():
                if col_name not in cols:
                    try:
                        cur.execute(f"ALTER TABLE email_schedules ADD COLUMN {col_name} {col_type}")
                    except Exception as err:
                        logger.warning("Could not add column %s to email_schedules: %s", col_name, err)
        cur.execute(FORECASTS_DDL)
        cur.execute(DUCKDB_UPLOAD_TABLES_DDL)
    except Exception as exc:
        logger.warning("Error verifying DuckDB schema: %s", exc)


def _get_duckdb_conn() -> _DuckDBConnectionWrapper:
    global _duckdb_raw_conn
    if _duckdb_raw_conn is None:
        import duckdb

        settings = get_settings()
        db_path = settings.resolved_duckdb_path
        db_path.parent.mkdir(parents=True, exist_ok=True)
        _duckdb_raw_conn = duckdb.connect(str(db_path), read_only=False)
        _ensure_duckdb_schema(_duckdb_raw_conn)
    return _DuckDBConnectionWrapper(_duckdb_raw_conn)


def get_active_engine() -> str:
    """Resolve the active database backend ('postgres' or 'duckdb')."""
    global _active_engine
    if _active_engine is not None:
        return _active_engine

    settings = get_settings()

    # Strict Production Guard: DuckDB prohibited in production/serverless
    if settings.is_production:
        if settings.database_backend == "duckdb":
            raise RuntimeError(
                "CRITICAL: DuckDB embedded database is prohibited in production/serverless environments. "
                "Configure DATABASE_URL with a valid remote PostgreSQL/Supabase connection."
            )
        _active_engine = "postgres"
        return _active_engine

    if settings.database_backend in ("duckdb", "postgres"):
        _active_engine = settings.database_backend
        return _active_engine

    # Auto mode in development: attempt PostgreSQL first, fall back to DuckDB on failure
    try:
        test_conn = _connect_postgres()
        test_conn.close()
        _active_engine = "postgres"
    except Exception as exc:
        logger.warning(
            "PostgreSQL/Supabase unavailable (%s). Falling back to local embedded DuckDB (%s).",
            exc,
            settings.resolved_duckdb_path,
        )
        _active_engine = "duckdb"

    return _active_engine


def reset_active_engine() -> None:
    """Reset cached active engine for dynamic environment switching in tests."""
    global _active_engine, _duckdb_raw_conn
    _active_engine = None
    if _duckdb_raw_conn is not None:
        with contextlib.suppress(Exception):
            _duckdb_raw_conn.close()
        _duckdb_raw_conn = None


def _reset_serverless_conn() -> None:
    global _serverless_conn
    if _serverless_conn is not None:
        with contextlib.suppress(Exception):
            _serverless_conn.close()
        _serverless_conn = None


@contextlib.contextmanager
def get_conn() -> Generator[Any, None, None]:
    engine = get_active_engine()
    if engine == "duckdb":
        yield _get_duckdb_conn()
        return

    if IS_SERVERLESS:
        global _serverless_conn
        if _serverless_conn is None or _serverless_conn.closed:
            _serverless_conn = _connect_postgres()
        conn = _serverless_conn
        try:
            yield conn
            conn.commit()
        except Exception:
            with contextlib.suppress(Exception):
                conn.rollback()
            _reset_serverless_conn()
            raise
        return

    pool = get_pool()
    conn = pool.getconn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        pool.putconn(conn)


def fetch_all(query: str, params: tuple | list | dict | None = None) -> list[dict]:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(query, params)
            return [dict(row) for row in cur.fetchall()]


def fetch_one(query: str, params: tuple | list | dict | None = None) -> dict | None:
    rows = fetch_all(query, params)
    return rows[0] if rows else None


def execute(query: str, params: tuple | list | dict | None = None) -> int:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(query, params)
            return getattr(cur, "rowcount", 1)


def execute_returning(query: str, params: tuple | list | dict | None = None) -> dict | None:
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(query, params)
            row = cur.fetchone()
            return dict(row) if row else None


def user_has_farm(user_id: int, farm_id: str) -> bool:
    row = fetch_one(
        "SELECT 1 FROM user_farm_access WHERE user_id = %s AND farm_id = %s",
        (user_id, farm_id),
    )
    return row is not None


def get_user_farms(user_id: int) -> list[dict]:
    return fetch_all(
        """
        SELECT f.farm_id, f.farm_name, f.slug
        FROM farms f
        JOIN user_farm_access ufa ON ufa.farm_id = f.farm_id
        WHERE ufa.user_id = %s AND f.is_active = TRUE
        ORDER BY f.farm_name
        """,
        (user_id,),
    )
