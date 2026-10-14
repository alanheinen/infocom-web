#!/usr/bin/env python3
"""End-to-end check against a running server (CI runs it against the image).

    python3 tests/smoke.py [http://127.0.0.1:8080]

Creates a throwaway account, plays the opening of Zork I, and exercises undo,
save, restore, restart, quitting, a cold reopen (replay from the database) and
the sign-in protections. Standard library only.
"""

import json
import secrets
import sys
import urllib.error
import urllib.request
from http.cookiejar import CookieJar

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8080").rstrip("/")


class Client:
    def __init__(self):
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))

    def call(self, method, path, body=None, expect=200, headers=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(BASE + "/api/" + path, data=data, method=method, headers=headers or {})
        if body is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with self.opener.open(req, timeout=30) as r:
                status, out = r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            status, out = e.code, json.loads(e.read() or b"{}")
        assert status == expect, f"{method} {path}: expected {expect}, got {status}: {out}"
        return out


def text(view):
    return "".join((t["cmd"] or "") + t["text"] for t in view["turns"])


def main():
    c = Client()
    name, pw = "smoke" + secrets.token_hex(3), secrets.token_urlsafe(12)
    c.call("GET", "games", expect=401)
    c.call("POST", "signup", {"username": name, "password": pw})
    c.call("POST", "signup", {"username": name, "password": pw}, expect=409)
    games = c.call("GET", "games")["games"]
    zork = next(g for g in games if g.get("key") == "zork1")
    gid = zork["id"]
    assert zork["builtin"] and zork["version"] == 3, zork

    v = c.call("GET", f"games/{gid}")
    assert "ZORK I" in text(v) and "West of House" in v["status"], v
    assert v["prompt"] == ">" and v["moves"] == 0 and not v["canUndo"]

    r = c.call("POST", f"games/{gid}/command", {"command": "open mailbox"})
    assert "leaflet" in r["turn"]["text"] and r["moves"] == 1, r
    r = c.call("POST", f"games/{gid}/command", {"command": "take leaflet"})
    assert r["turn"]["text"].strip() == "Taken.", r
    c.call("POST", f"games/{gid}/command", {"command": "save"}, expect=409)
    c.call("POST", f"games/{gid}/command", {"command": "\\x north"})   # escapes stripped: "x north"

    saves = c.call("POST", f"games/{gid}/saves", {"name": ""})["saves"]
    assert saves[0]["name"] == "West of House" and saves[0]["moves"] == 3, saves
    sid = saves[0]["id"]

    r = c.call("POST", f"games/{gid}/command", {"command": "north"})
    assert "North of House" in r["status"], r
    v = c.call("POST", f"games/{gid}/undo", {})
    assert v["moves"] == 3 and "West of House" in v["status"], v
    c.call("POST", f"games/{gid}/command", {"command": "north"})
    c.call("POST", f"games/{gid}/command", {"command": "east"})

    # Cold open: replays from the database and rebuilds the echoed commands.
    v = c.call("GET", f"games/{gid}")
    assert [t["cmd"] for t in v["turns"]] == [None, "open mailbox", "take leaflet", "x north", "north", "east"], v
    assert "Behind House" in v["status"]

    v = c.call("POST", f"games/{gid}/saves/{sid}/restore", {})
    assert v["moves"] == 3 and "West of House" in v["status"], v
    lib = {g["id"]: g for g in c.call("GET", "games")["games"]}
    assert lib[gid]["progress"]["moves"] == 3, lib[gid]

    # Quitting ends the story; commands are refused until undo/restart/restore.
    c.call("POST", f"games/{gid}/command", {"command": "quit"})
    r = c.call("POST", f"games/{gid}/command", {"command": "y"})
    assert r["ended"], r
    c.call("POST", f"games/{gid}/command", {"command": "look"}, expect=409)
    v = c.call("POST", f"games/{gid}/undo", {})
    assert not v["ended"], v
    v = c.call("POST", f"games/{gid}/restart", {})
    assert v["moves"] == 0 and not v["ended"]

    c.call("DELETE", f"games/{gid}/saves/{sid}")
    c.call("POST", f"games/{gid}/saves/{sid}/restore", {}, expect=404)
    c.call("GET", "games/0000000000000000", expect=404)

    # Cross-site and non-JSON writes are refused.
    c.call("POST", f"games/{gid}/command", {"command": "look"}, expect=403,
           headers={"Origin": "https://evil.example"})
    req = urllib.request.Request(BASE + f"/api/games/{gid}/command", data=b"command=look", method="POST")
    try:
        c.opener.open(req)
        raise AssertionError("form post accepted")
    except urllib.error.HTTPError as e:
        assert e.code == 415, e.code

    # Another user can't see this one's saves.
    other = Client()
    other.call("POST", "signup", {"username": name + "b", "password": pw})
    assert other.call("GET", f"games/{gid}/saves")["saves"] == []

    c.call("POST", "logout", {})
    c.call("GET", "games", expect=401)
    c.call("POST", "login", {"username": name, "password": "wrong-password"}, expect=401)
    c.call("POST", "login", {"username": name, "password": pw})
    print(f"ok: {len(games)} games, played and saved as {name}")


if __name__ == "__main__":
    main()
