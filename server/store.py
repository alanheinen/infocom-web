"""SQLite storage: accounts, sessions, autosaves and save slots.

One file in the data directory. The connection is shared and serialised by a
lock: traffic is a few requests a minute, and it keeps SQLite safe on network
storage (an NFS-backed volume), where WAL mode must not be used. The rollback
journal is the default and is what we keep.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import threading
import time
from pathlib import Path

SESSION_DAYS = 30
SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id        INTEGER PRIMARY KEY,
    username  TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pw_hash   TEXT NOT NULL,
    created   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires    INTEGER NOT NULL
);
-- The autosave: one game in progress per user and story file.
CREATE TABLE IF NOT EXISTS progress (
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_id  TEXT NOT NULL,
    seed     INTEGER NOT NULL,
    commands TEXT NOT NULL,   -- JSON list of typed lines
    marks    TEXT NOT NULL,   -- JSON list: output length after each command
    digest   TEXT NOT NULL,   -- sha256 of the output, to notice replay drift
    status   TEXT,            -- last status line, for the library card
    ended    INTEGER NOT NULL DEFAULT 0,
    updated  INTEGER NOT NULL,
    PRIMARY KEY (user_id, game_id)
);
CREATE TABLE IF NOT EXISTS saves (
    id       INTEGER PRIMARY KEY,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_id  TEXT NOT NULL,
    name     TEXT NOT NULL,
    seed     INTEGER NOT NULL,
    commands TEXT NOT NULL,
    marks    TEXT NOT NULL,
    digest   TEXT NOT NULL,
    status   TEXT,
    created  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS saves_by_game ON saves(user_id, game_id);
"""
# Columns added after the first release, applied to existing databases.
MIGRATIONS = [
    "ALTER TABLE progress ADD COLUMN map TEXT",   # automap (mapper.py), JSON
    "ALTER TABLE saves ADD COLUMN map TEXT",
]

# scrypt, N=2^15 r=8 p=1: 32 MiB and ~50 ms per hash. OWASP suggests N=2^17,
# but that is 128 MiB per concurrent login, too much for a small pod.
_N, _R, _P = 2 ** 15, 8, 1


def hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=_N, r=_R, p=_P, maxmem=64 * 1024 * 1024)
    return f"scrypt${_N}${_R}${_P}${salt.hex()}${h.hex()}"


def check_password(pw: str, stored: str) -> bool:
    try:
        _, n, r, p, salt, h = stored.split("$")
        got = hashlib.scrypt(pw.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p),
                             maxmem=64 * 1024 * 1024)
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(got.hex(), h)


# Spent on unknown usernames so a login takes as long whether or not the name exists.
_DUMMY = hash_password(secrets.token_hex(8))


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        with self.lock:
            self.db.execute("PRAGMA foreign_keys = ON")
            self.db.executescript(SCHEMA)
            for sql in MIGRATIONS:
                try:
                    self.db.execute(sql)
                except sqlite3.OperationalError as e:   # already applied
                    if "duplicate column" not in str(e):
                        raise
        os.chmod(path, 0o600)

    def _q(self, sql: str, args=()) -> list[sqlite3.Row]:
        with self.lock:
            return self.db.execute(sql, args).fetchall()

    def _x(self, sql: str, args=()) -> sqlite3.Cursor:
        with self.lock:
            return self.db.execute(sql, args)

    # --- accounts -----------------------------------------------------------

    def user_count(self) -> int:
        return self._q("SELECT count(*) FROM users")[0][0]

    def add_user(self, username: str, password: str) -> int:
        cur = self._x("INSERT INTO users (username, pw_hash, created) VALUES (?, ?, ?)",
                      (username, hash_password(password), int(time.time())))
        return cur.lastrowid

    def set_password(self, user_id: int, password: str) -> None:
        self._x("UPDATE users SET pw_hash = ? WHERE id = ?", (hash_password(password), user_id))
        self._x("DELETE FROM sessions WHERE user_id = ?", (user_id,))

    def delete_user(self, user_id: int) -> None:
        self._x("DELETE FROM users WHERE id = ?", (user_id,))

    def find_user(self, username: str) -> sqlite3.Row | None:
        rows = self._q("SELECT * FROM users WHERE username = ?", (username,))
        return rows[0] if rows else None

    def authenticate(self, username: str, password: str) -> sqlite3.Row | None:
        user = self.find_user(username)
        ok = check_password(password, user["pw_hash"] if user else _DUMMY)
        return user if ok and user else None

    # --- sessions -----------------------------------------------------------

    def new_session(self, user_id: int) -> str:
        token = secrets.token_urlsafe(32)
        now = int(time.time())
        self._x("DELETE FROM sessions WHERE expires < ?", (now,))
        self._x("INSERT INTO sessions VALUES (?, ?, ?)",
                (_token_hash(token), user_id, now + SESSION_DAYS * 86400))
        return token

    def session_user(self, token: str) -> sqlite3.Row | None:
        now = int(time.time())
        rows = self._q("""SELECT u.*, s.expires FROM sessions s JOIN users u ON u.id = s.user_id
                          WHERE s.token_hash = ? AND s.expires > ?""", (_token_hash(token), now))
        if not rows:
            return None
        if rows[0]["expires"] - now < (SESSION_DAYS - 1) * 86400:   # slide, at most daily
            self._x("UPDATE sessions SET expires = ? WHERE token_hash = ?",
                    (now + SESSION_DAYS * 86400, _token_hash(token)))
        return rows[0]

    def end_session(self, token: str) -> None:
        self._x("DELETE FROM sessions WHERE token_hash = ?", (_token_hash(token),))

    # --- games --------------------------------------------------------------

    @staticmethod
    def _game(row: sqlite3.Row | None) -> dict | None:
        if row is None:
            return None
        g = dict(row)
        g["commands"] = json.loads(g["commands"])
        g["marks"] = json.loads(g["marks"])
        g["map"] = json.loads(g["map"]) if g.get("map") else None
        return g

    def progress(self, user_id: int, game_id: str) -> dict | None:
        rows = self._q("SELECT * FROM progress WHERE user_id = ? AND game_id = ?", (user_id, game_id))
        return self._game(rows[0] if rows else None)

    def all_progress(self, user_id: int) -> dict[str, dict]:
        rows = self._q("SELECT game_id, status, ended, updated, json_array_length(commands) AS moves "
                       "FROM progress WHERE user_id = ?", (user_id,))
        return {r["game_id"]: dict(r) for r in rows}

    def put_progress(self, user_id: int, game_id: str, g: dict) -> None:
        self._x("""INSERT OR REPLACE INTO progress
                   (user_id, game_id, seed, commands, marks, digest, status, ended, updated, map)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (user_id, game_id, g["seed"], json.dumps(g["commands"]), json.dumps(g["marks"]),
                 g["digest"], g.get("status"), int(bool(g.get("ended"))), int(time.time()),
                 json.dumps(g["map"]) if g.get("map") else None))

    def saves(self, user_id: int, game_id: str) -> list[dict]:
        rows = self._q("""SELECT id, name, status, created, json_array_length(commands) AS moves
                          FROM saves WHERE user_id = ? AND game_id = ? ORDER BY created DESC, id DESC""",
                       (user_id, game_id))
        return [dict(r) for r in rows]

    def save_slot(self, user_id: int, game_id: str, sid: int) -> dict | None:
        rows = self._q("SELECT * FROM saves WHERE id = ? AND user_id = ? AND game_id = ?",
                       (sid, user_id, game_id))
        return self._game(rows[0] if rows else None)

    def add_save(self, user_id: int, game_id: str, name: str, g: dict) -> int:
        cur = self._x("""INSERT INTO saves (user_id, game_id, name, seed, commands, marks, digest, status, created, map)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                      (user_id, game_id, name, g["seed"], json.dumps(g["commands"]),
                       json.dumps(g["marks"]), g["digest"], g.get("status"), int(time.time()),
                       json.dumps(g["map"]) if g.get("map") else None))
        return cur.lastrowid

    def delete_save(self, user_id: int, game_id: str, sid: int) -> bool:
        cur = self._x("DELETE FROM saves WHERE id = ? AND user_id = ? AND game_id = ?", (sid, user_id, game_id))
        return cur.rowcount > 0
