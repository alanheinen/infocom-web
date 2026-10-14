#!/usr/bin/env python3
"""Infocom Library: play Z-machine stories in a browser, with accounts and saves.

    python3 server/serve.py [--host 127.0.0.1] [--port 8080] [--data DIR] [--games DIR ...]
    python3 server/serve.py useradd NAME      (also: passwd NAME, userdel NAME, users)

Serves the page in web/ and a JSON API under /api. Every game is run by dfrotz,
replaying the player's command log (see engine.py), so progress is saved after
every turn and survives restarts with nothing but the database.

Settings, as flags or environment variables:
  --data / DATA_DIR        where infocom.db lives (default ./data)
  --games / GAMES_DIRS     story directories, ':'-separated; the first is the
                           built-in one (default ./games:/games)
  --signup / SIGNUP        open: anyone can create an account (default)
                           first: only the very first account, then closed
                           closed: accounts are made with `useradd` only
  --trust-proxy / TRUST_PROXY=1
                           believe X-Forwarded-For / X-Forwarded-Proto (set it
                           behind an ingress, never when exposed directly)
Standard library only.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import random
import re
import sqlite3
import sys
import threading
import time
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import engine  # noqa: E402
import mapper  # noqa: E402
from catalog import Library  # noqa: E402
from store import Store  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
STATIC = {"/": ("index.html", "text/html; charset=utf-8"),
          "/app.css": ("app.css", "text/css; charset=utf-8"),
          "/app.js": ("app.js", "text/javascript; charset=utf-8"),
          "/map.js": ("map.js", "text/javascript; charset=utf-8"),
          "/icon.svg": ("icon.svg", "image/svg+xml")}
USERNAME = re.compile(r"^[A-Za-z0-9_.-]{2,32}$")
MAX_BODY = 16 * 1024
MAX_TURNS = 20000
MAX_SAVES = 100
SHOWN_TURNS = 400       # turns of scrollback sent when a game is opened
COOKIE = "infocom_session"
# Runs each move's automap replay alongside the move itself.
POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="snapshot")
SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; "
                               "base-uri 'none'; form-action 'self'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
}


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class Limiter:
    """Failed logins per client and per username: 10 in 15 minutes, then wait."""

    def __init__(self, limit=10, window=900):
        self.limit, self.window = limit, window
        self.hits: dict[str, deque] = defaultdict(deque)
        self.lock = threading.Lock()

    def blocked(self, *keys: str) -> bool:
        now = time.monotonic()
        with self.lock:
            for k in keys:
                q = self.hits[k]
                while q and q[0] < now - self.window:
                    q.popleft()
                if len(q) >= self.limit:
                    return True
            return False

    def fail(self, *keys: str) -> None:
        with self.lock:
            for k in keys:
                self.hits[k].append(time.monotonic())


class Games:
    """Game state transitions. One lock per (user, game) keeps turns in order."""

    def __init__(self, store: Store, library: Library):
        self.store, self.library = store, library
        self.locks: dict[tuple, threading.Lock] = defaultdict(threading.Lock)
        self.locks_lock = threading.Lock()

    def lock(self, uid: int, gid: str) -> threading.Lock:
        with self.locks_lock:
            return self.locks[(uid, gid)]

    def story(self, gid: str) -> dict:
        g = self.library.get(gid)
        if not g:
            raise ApiError(404, "no such game")
        return g

    def _fresh(self, story: dict) -> dict:
        seed = random.randint(1, 2 ** 31 - 1)
        r = engine.run(story["path"], seed, [])
        return {"seed": seed, "commands": [], "marks": [len(r.output)], "digest": engine.digest(r.output),
                "ended": r.ended, "_output": r.output}

    def _locate(self, story: dict, g: dict, cmd: str | None = None, save: bytes | None = None) -> None:
        """Update g["map"] with where the player is now. cmd is the move that
        got them here (None for undo, restore or opening: no new passage)."""
        if g.get("ended"):
            return
        if save is None:
            save = engine.snapshot(story["path"], g["seed"], g["commands"])
        try:
            si = mapper.story_info(story["path"])
            g["map"] = mapper.update(g.get("map"), si, save, g.get("status"), cmd, moved=cmd is not None)
        except (IndexError, ValueError) as e:   # a story file we can't read: no map, still playable
            print(f"automap: {story['file']}: {e!r}", flush=True)

    def _map_view(self, story: dict, g: dict) -> dict | None:
        try:
            return mapper.view(g.get("map"), mapper.story_info(story["path"]))
        except (IndexError, ValueError):
            return None

    def _view(self, story: dict, g: dict, output: str) -> dict:
        segs = engine.segments(output, g["marks"], g["commands"])
        turns, status, prompt = engine.render(segs)
        g["status"] = status
        hidden = max(0, len(turns) - SHOWN_TURNS)
        return {"game": public_game(story), "turns": turns[hidden:], "hidden": hidden,
                "status": status, "prompt": prompt, "ended": bool(g.get("ended")),
                "moves": len(g["commands"]), "canUndo": bool(g["commands"])}

    def _replay(self, story: dict, g: dict) -> str:
        r = engine.run(story["path"], g["seed"], g["commands"])
        if engine.digest(r.output) != g["digest"]:
            # The interpreter's output changed (an upgrade?). The log still
            # replays; the old turn boundaries just no longer apply.
            g["marks"], g["digest"] = [len(r.output)], engine.digest(r.output)
        g["ended"] = r.ended
        return r.output

    def open(self, uid: int, gid: str) -> dict:
        story = self.story(gid)
        with self.lock(uid, gid):
            g = self.store.progress(uid, gid)
            if g is None:
                g = self._fresh(story)
                output = g.pop("_output")
            else:
                output = self._replay(story, g)
            view = self._view(story, g, output)
            if g.get("map") is None:
                self._locate(story, g)
            view["map"] = self._map_view(story, g)
            self.store.put_progress(uid, gid, g)
            return view

    def command(self, uid: int, gid: str, text: str) -> dict:
        story = self.story(gid)
        cmd = engine.clean_command(text)
        if cmd.lower() in engine.INTERCEPTED:
            raise ApiError(409, f"use the {cmd.lower()} button")
        with self.lock(uid, gid):
            g = self.store.progress(uid, gid)
            if g is None:
                raise ApiError(409, "open the game first")
            if g["ended"]:
                raise ApiError(409, "this story has ended; restart or restore")
            if len(g["commands"]) >= MAX_TURNS:
                raise ApiError(409, "this game has reached the turn limit; restart or restore")
            snap = POOL.submit(engine.snapshot, story["path"], g["seed"], g["commands"] + [cmd])
            r = engine.run(story["path"], g["seed"], g["commands"] + [cmd])
            prev = g["marks"][-1]
            if engine.digest(r.output[:prev]) != g["digest"]:
                prev = len(self._replay(story, g))   # drifted: marks restart from here
            g["commands"].append(cmd)
            g["marks"].append(len(r.output))
            g["digest"], g["ended"] = engine.digest(r.output), r.ended
            st, rest = engine.parse_status(r.output[prev:])
            body, prompt = engine.split_prompt(rest)
            if st:
                g["status"] = st
            self._locate(story, g, cmd, snap.result())
            self.store.put_progress(uid, gid, g)
            return {"turn": {"cmd": cmd, "text": engine.unwrap(body)}, "status": g["status"], "prompt": prompt,
                    "ended": r.ended, "moves": len(g["commands"]), "canUndo": True,
                    "map": self._map_view(story, g)}

    def undo(self, uid: int, gid: str) -> dict:
        story = self.story(gid)
        with self.lock(uid, gid):
            g = self.store.progress(uid, gid)
            if not g or not g["commands"]:
                raise ApiError(409, "nothing to undo")
            g["commands"].pop()
            if len(g["marks"]) >= 2:
                g["marks"].pop()
            r = engine.run(story["path"], g["seed"], g["commands"])
            if g["marks"][-1] != len(r.output):
                g["marks"] = [len(r.output)]
            g["digest"], g["ended"] = engine.digest(r.output), r.ended
            view = self._view(story, g, r.output)
            self._locate(story, g)          # the map keeps what you learned
            view["map"] = self._map_view(story, g)
            self.store.put_progress(uid, gid, g)
            return view

    def restart(self, uid: int, gid: str) -> dict:
        story = self.story(gid)
        with self.lock(uid, gid):
            g = self._fresh(story)
            output = g.pop("_output")
            view = self._view(story, g, output)
            self._locate(story, g)          # a fresh map
            view["map"] = self._map_view(story, g)
            self.store.put_progress(uid, gid, g)
            return view

    def save(self, uid: int, gid: str, name: str) -> dict:
        self.story(gid)
        name = re.sub(r"\s+", " ", name).strip()[:60]
        with self.lock(uid, gid):
            g = self.store.progress(uid, gid)
            if not g:
                raise ApiError(409, "nothing to save yet")
            if len(self.store.saves(uid, gid)) >= MAX_SAVES:
                raise ApiError(409, f"at most {MAX_SAVES} saves per game; delete one first")
            if not name:
                name = (g.get("status") or "").split("\t")[0].strip() or "Saved game"
            self.store.add_save(uid, gid, name, g)
        return {"saves": self.store.saves(uid, gid)}

    def restore(self, uid: int, gid: str, sid: int) -> dict:
        story = self.story(gid)
        with self.lock(uid, gid):
            slot = self.store.save_slot(uid, gid, sid)
            if not slot:
                raise ApiError(404, "no such save")
            g = {k: slot[k] for k in ("seed", "commands", "marks", "digest", "status", "map")}
            output = self._replay(story, g)
            view = self._view(story, g, output)
            self._locate(story, g)          # the save's own map (or a new one, for older saves)
            view["map"] = self._map_view(story, g)
            self.store.put_progress(uid, gid, g)
            return view


def public_game(g: dict, progress: dict | None = None) -> dict:
    out = {k: g.get(k) for k in ("id", "key", "file", "title", "subtitle", "year", "authors", "genre",
                                 "blurb", "notes", "version", "release", "serial", "builtin")}
    if progress:
        out["progress"] = {k: progress[k] for k in ("status", "ended", "updated", "moves")}
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "infocom-web"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    app: "App"  # set on the subclass in main()

    # --- plumbing -----------------------------------------------------------

    def log_message(self, fmt, *args):
        print(f"{self.client_ip()} {fmt % args}", flush=True)

    def client_ip(self) -> str:
        if self.app.trust_proxy:
            fwd = self.headers.get("X-Forwarded-For", "")
            if fwd:
                return fwd.split(",")[0].strip()
        return self.client_address[0]

    def https(self) -> bool:
        return self.app.trust_proxy and self.headers.get("X-Forwarded-Proto", "") == "https"

    def send(self, status: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in {**SECURITY_HEADERS, **(extra or {})}.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def json(self, status: int, data, extra: dict | None = None):
        self.send(status, json.dumps(data).encode(), "application/json",
                  {"Cache-Control": "no-store", **(extra or {})})

    def read_body(self) -> None:
        """Consume the request body before anything else, so an unread body
        can never be parsed as the next request on a kept-alive connection."""
        self.raw = b""
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = -1
        if n < 0 or n > MAX_BODY:
            self.close_connection = True
            raise ApiError(413, "request too large")
        if self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            raise ApiError(411, "Content-Length required")
        self.raw = self.rfile.read(n)

    def body(self) -> dict:
        if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
            raise ApiError(415, "expected application/json")
        try:
            data = json.loads(self.raw or b"{}")
        except ValueError as e:
            raise ApiError(400, "invalid JSON") from e
        if not isinstance(data, dict):
            raise ApiError(400, "expected an object")
        return data

    def token(self) -> str | None:
        c = SimpleCookie()
        try:
            c.load(self.headers.get("Cookie", ""))
        except Exception:
            return None
        return c[COOKIE].value if COOKIE in c else None

    def user(self, required=True):
        tok = self.token()
        u = self.app.store.session_user(tok) if tok else None
        if required and u is None:
            raise ApiError(401, "please sign in")
        return u

    def cookie(self, token: str | None) -> dict:
        attrs = "Path=/; HttpOnly; SameSite=Strict" + ("; Secure" if self.https() or self.app.secure_cookie else "")
        if token is None:
            return {"Set-Cookie": f"{COOKIE}=; Max-Age=0; {attrs}"}
        return {"Set-Cookie": f"{COOKIE}={token}; Max-Age={30 * 86400}; {attrs}"}

    def same_origin(self) -> bool:
        """Belt and braces against cross-site requests (the cookie is already SameSite=Strict)."""
        origin = self.headers.get("Origin")
        if not origin:
            return True
        host = self.headers.get("X-Forwarded-Host" if self.app.trust_proxy and
                                self.headers.get("X-Forwarded-Host") else "Host", "")
        return origin.split("://", 1)[-1] == host

    # --- routing ------------------------------------------------------------

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/healthz", "/api/health"):
            return self.json(200, {"ok": True, "games": len(self.app.library.scan())})
        if path in STATIC:
            name, ctype = STATIC[path]
            return self.send(200, (WEB / name).read_bytes(), ctype, {"Cache-Control": "no-cache"})
        self.api("GET", path)

    def do_POST(self):
        self.api("POST", self.path.split("?", 1)[0])

    def do_DELETE(self):
        self.api("DELETE", self.path.split("?", 1)[0])

    def api(self, method: str, path: str):
        try:
            self.read_body()
            if method != "GET" and not self.same_origin():
                raise ApiError(403, "cross-origin request refused")
            parts = path.strip("/").split("/")
            if parts[0] != "api":
                raise ApiError(404, "not found")
            status, data, extra = self.route(method, parts[1:])
            self.json(status, data, extra)
        except ApiError as e:
            self.json(e.status, {"error": str(e)})
        except engine.EngineError as e:
            self.json(502, {"error": str(e)})
        except Exception as e:  # keep the connection usable, log the detail
            print(f"error handling {method} {path}: {e!r}", flush=True)
            self.json(500, {"error": "internal error"})

    def route(self, method: str, p: list[str]):
        app = self.app
        match method, p:
            case "GET", ["me"]:
                u = self.user(required=False)
                return 200, {"user": u["username"] if u else None, "signup": app.signup_open()}, None
            case "POST", ["signup"]:
                if not app.signup_open():
                    raise ApiError(403, "sign-up is closed; ask the admin for an account")
                d = self.body()
                name, pw = str(d.get("username", "")).strip(), str(d.get("password", ""))
                if not USERNAME.match(name):
                    raise ApiError(400, "username: 2-32 letters, digits, . _ or -")
                if len(pw) < 8 or len(pw) > 256:
                    raise ApiError(400, "password: at least 8 characters")
                try:
                    uid = app.store.add_user(name, pw)
                except sqlite3.IntegrityError as e:
                    raise ApiError(409, "that username is taken") from e
                return 200, {"user": name}, self.cookie(app.store.new_session(uid))
            case "POST", ["login"]:
                d = self.body()
                name, pw = str(d.get("username", "")).strip(), str(d.get("password", ""))
                keys = (f"ip:{self.client_ip()}", f"user:{name.lower()}")
                if app.limiter.blocked(*keys):
                    raise ApiError(429, "too many failed sign-ins; try again in a few minutes")
                u = app.store.authenticate(name, pw[:256])
                if not u:
                    app.limiter.fail(*keys)
                    raise ApiError(401, "wrong username or password")
                return 200, {"user": u["username"]}, self.cookie(app.store.new_session(u["id"]))
            case "POST", ["logout"]:
                if tok := self.token():
                    app.store.end_session(tok)
                return 200, {"user": None}, self.cookie(None)
            case "POST", ["password"]:
                u = self.user()
                d = self.body()
                if not app.store.authenticate(u["username"], str(d.get("current", ""))[:256]):
                    raise ApiError(403, "current password is wrong")
                new = str(d.get("new", ""))
                if len(new) < 8 or len(new) > 256:
                    raise ApiError(400, "password: at least 8 characters")
                app.store.set_password(u["id"], new)   # signs out everywhere
                return 200, {"user": u["username"]}, self.cookie(app.store.new_session(u["id"]))
            case "GET", ["games"]:
                u = self.user()
                prog = app.store.all_progress(u["id"])
                games = sorted(app.library.scan().values(), key=lambda g: (g.get("year") or 9999, g["title"]))
                return 200, {"games": [public_game(g, prog.get(g["id"])) for g in games]}, None
            case "GET", ["games", gid]:
                return 200, app.games.open(self.user()["id"], gid), None
            case "POST", ["games", gid, "command"]:
                return 200, app.games.command(self.user()["id"], gid, str(self.body().get("command", ""))), None
            case "POST", ["games", gid, "undo"]:
                return 200, app.games.undo(self.user()["id"], gid), None
            case "POST", ["games", gid, "restart"]:
                return 200, app.games.restart(self.user()["id"], gid), None
            case "GET", ["games", gid, "saves"]:
                app.games.story(gid)
                return 200, {"saves": app.store.saves(self.user()["id"], gid)}, None
            case "POST", ["games", gid, "saves"]:
                return 200, app.games.save(self.user()["id"], gid, str(self.body().get("name", ""))), None
            case "POST", ["games", gid, "saves", sid, "restore"] if sid.isdigit():
                return 200, app.games.restore(self.user()["id"], gid, int(sid)), None
            case "DELETE", ["games", gid, "saves", sid] if sid.isdigit():
                uid = self.user()["id"]
                if not app.store.delete_save(uid, gid, int(sid)):
                    raise ApiError(404, "no such save")
                return 200, {"saves": app.store.saves(uid, gid)}, None
        raise ApiError(404, "not found")


class App:
    def __init__(self, args):
        self.store = Store(Path(args.data) / "infocom.db")
        self.library = Library([Path(d) for d in args.games if d])
        self.games = Games(self.store, self.library)
        self.limiter = Limiter()
        self.signup = args.signup
        self.trust_proxy = args.trust_proxy
        self.secure_cookie = args.secure_cookie

    def signup_open(self) -> bool:
        return self.signup == "open" or (self.signup == "first" and self.store.user_count() == 0)


def admin(args) -> int:
    store = Store(Path(args.data) / "infocom.db")
    if args.cmd == "users":
        for r in store._q("SELECT username, created FROM users ORDER BY username"):
            print(f"{r['username']}\t{time.strftime('%Y-%m-%d', time.localtime(r['created']))}")
        return 0
    user = store.find_user(args.name)
    if args.cmd == "userdel":
        if not user:
            print(f"no user {args.name}", file=sys.stderr)
            return 1
        store.delete_user(user["id"])
        print(f"deleted {args.name} and all of their saves")
        return 0
    if args.cmd == "useradd" and user:
        print(f"{args.name} already exists", file=sys.stderr)
        return 1
    if args.cmd == "passwd" and not user:
        print(f"no user {args.name}", file=sys.stderr)
        return 1
    if args.cmd == "useradd" and not USERNAME.match(args.name):
        print("username: 2-32 letters, digits, . _ or -", file=sys.stderr)
        return 1
    pw = sys.stdin.readline().rstrip("\n") if args.password_stdin else getpass.getpass("Password: ")
    if len(pw) < 8:
        print("password: at least 8 characters", file=sys.stderr)
        return 1
    if args.cmd == "useradd":
        store.add_user(args.name, pw)
    else:
        store.set_password(user["id"], pw)
    print(f"{args.cmd}: {args.name} done")
    return 0


def main() -> int:
    env = os.environ.get
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--data", default=env("DATA_DIR", str(ROOT / "data")))
    ap.add_argument("--games", nargs="+",
                    default=env("GAMES_DIRS", f"{ROOT / 'games'}:/games").split(":"))
    sub = ap.add_subparsers(dest="cmd")
    for c in ("useradd", "passwd", "userdel"):
        sp = sub.add_parser(c)
        sp.add_argument("name")
        sp.add_argument("--password-stdin", action="store_true")
    sub.add_parser("users")
    ap.add_argument("--host", default=env("HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(env("PORT", "8080")))
    ap.add_argument("--signup", choices=("open", "first", "closed"), default=env("SIGNUP", "open"))
    ap.add_argument("--trust-proxy", action="store_true", default=env("TRUST_PROXY") == "1")
    ap.add_argument("--secure-cookie", action="store_true", default=env("SECURE_COOKIE") == "1",
                    help="always mark the session cookie Secure (when TLS ends in front of us)")
    args = ap.parse_args()
    if args.cmd:
        return admin(args)

    app = App(args)
    for d in app.library.dirs:   # e.g. /data/games: make it so files can be copied in
        if Path(args.data).resolve() in d.resolve().parents:
            d.mkdir(parents=True, exist_ok=True)
    games = app.library.scan()
    print(f"{len(games)} games in {', '.join(map(str, app.library.dirs))}; sign-up {args.signup}", flush=True)
    handler = type("BoundHandler", (Handler,), {"app": app})
    srv = ThreadingHTTPServer((args.host, args.port), handler)
    srv.daemon_threads = True
    print(f"listening on http://{args.host}:{args.port}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
