"""The game library: story files on disk, matched to catalog metadata.

Stories are found by scanning the game directories (the built-in Zork trilogy
plus whatever is mounted at /games). Each one is identified by a hash of its
contents, so progress stays attached to the exact file it was played on: a
different release of the same game is a different game, because replaying one
release's commands against another would not reproduce the same story.

Titles come from catalog.json, matched on the file name ("zork1.z3",
"HITCHHIK.DAT", "lurkinghorror-r221.z3" all work). A catalog.json next to the
story files can add or override entries; see the README.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
from pathlib import Path

from engine import story_header

HERE = Path(__file__).resolve().parent
EXTENSIONS = {".z1", ".z2", ".z3", ".z4", ".z5", ".z6", ".z7", ".z8", ".dat", ".zcode"}


def _norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def _load(path: Path) -> list[dict]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as e:
        print(f"ignoring {path}: {e}", flush=True)
        return []
    return [e for e in data if isinstance(e, dict)] if isinstance(data, list) else []


class Library:
    def __init__(self, dirs: list[Path]):
        self.dirs = dirs
        self.lock = threading.Lock()
        self.games: dict[str, dict] = {}
        self._seen: dict[tuple, dict] = {}   # (path, size, mtime) -> game, so rescans don't rehash
        self._fingerprint = None

    def _catalog(self, d: Path) -> tuple[list[tuple[str, dict]], dict[str, dict]]:
        """(alias, entry) longest alias first, plus per-file overrides from d/catalog.json."""
        entries = _load(HERE / "catalog.json")
        overrides = {}
        for e in _load(d / "catalog.json"):
            if "file" in e:
                overrides[e["file"]] = e
            else:
                entries = [x for x in entries if x.get("key") != e.get("key")] + [e]
        aliases = [(_norm(a), e) for e in entries for a in e.get("aliases", []) + [e.get("key", "")] if _norm(a)]
        aliases.sort(key=lambda p: -len(p[0]))
        return aliases, overrides

    def _match(self, path: Path, aliases, overrides) -> dict:
        if path.name in overrides:
            return overrides[path.name]
        stem = _norm(path.stem)
        for alias, entry in aliases:
            if stem == alias:
                return entry
        for alias, entry in aliases:
            if len(alias) >= 4 and stem.startswith(alias):
                return entry
        return {"title": path.stem}

    def scan(self) -> dict[str, dict]:
        """Rescan when any game directory's listing has changed."""
        stats = []
        for d in self.dirs:
            for p in sorted(d.iterdir()) if d.is_dir() else []:
                if p.suffix.lower() in EXTENSIONS and p.is_file():
                    st = p.stat()
                    stats.append((p, st.st_size, st.st_mtime_ns))
            cat = d / "catalog.json"
            if cat.is_file():
                stats.append((cat, cat.stat().st_size, cat.stat().st_mtime_ns))
        with self.lock:
            if stats == self._fingerprint:
                return self.games
            games, seen = {}, {}
            for d in self.dirs:
                aliases, overrides = self._catalog(d)
                for p, size, mtime in (s for s in stats if s[0].parent == d and s[0].name != "catalog.json"):
                    key = (p, size, mtime)
                    g = self._seen.get(key)
                    if g is None:
                        hdr = story_header(p)
                        if hdr is None:
                            continue
                        gid = hashlib.sha256(p.read_bytes()).hexdigest()[:16]
                        g = {"id": gid, "path": p, "file": p.name, **hdr}
                    meta = self._match(p, aliases, overrides)
                    g = {**g, **{k: meta.get(k) for k in
                                 ("key", "title", "subtitle", "year", "authors", "genre", "blurb", "notes")}}
                    g["builtin"] = d == self.dirs[0]
                    seen[key] = g
                    games.setdefault(g["id"], g)   # identical copies in two dirs: first wins
            self.games, self._seen, self._fingerprint = games, seen, stats
            return games

    def get(self, gid: str) -> dict | None:
        return self.scan().get(gid)
