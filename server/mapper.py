"""The automap: rooms you've visited, how they connect, and the exits you can see.

After each move the game is replayed once more with a SAVE at the end, and the
player's room is read out of that save (see zmachine.py). Rooms are therefore
identified by their Z-machine object number, not their name, so the four
"Forest" rooms in Zork I or a maze of identical "Maze" rooms stay distinct.

Exits come from the room objects themselves. Infocom's ZIL stores each exit
as a property numbered after its direction, and the property's size says what
kind of exit it is:

    v1-3 size  v4+ size  kind
    1          2         UEXIT  plain exit to a room
    2          3         NEXIT  no exit, just a message ("The door is boarded")
    3          4         FEXIT  a routine decides
    4          5         CEXIT  open only while a global flag is set
    5          6         DEXIT  through a door object

Which property belongs to which direction is read from the dictionary, where
each direction word carries its property number. The map shows plain exits
and doors as unexplored stubs; conditional and routine exits (secret
passages, trap doors) only appear once you've gone through them, so the map
never gives a puzzle away. Games not written in ZIL (Inform games, say) still
get a map of where you've been, without exit stubs.
"""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

from zmachine import Story, quetzal_memory

# Canonical direction, then the dictionary words that may carry it (v1-3
# dictionaries keep only six letters).
DIRECTIONS = [
    ("n", ("north", "n")), ("s", ("south", "s")), ("e", ("east", "e")), ("w", ("west", "w")),
    ("ne", ("northeast", "northe", "ne")), ("nw", ("northwest", "northw", "nw")),
    ("se", ("southeast", "southe", "se")), ("sw", ("southwest", "southw", "sw")),
    ("u", ("up", "u")), ("d", ("down", "d")), ("in", ("in", "inside")), ("out", ("out", "outside")),
    ("land", ("land",)),
]
WORDS = {w: d for d, ws in DIRECTIONS for w in ws}
_GO = re.compile(r"^(?:go |walk |run |head |climb |move )?(?:to (?:the )?)?([a-z]+)$")


class StoryInfo:
    """Static facts about one story file: direction properties and room exits."""

    def __init__(self, data: bytes):
        self.data = data
        self.story = Story(data)
        self.count = self.story.object_count()
        self.dir_props = self._direction_props()

    def _direction_props(self) -> dict[int, str]:
        s = self.story
        words = dict(s.dictionary())
        props: dict[int, str] = {}
        for d, ws in DIRECTIONS:
            for w in ws:
                b = words.get(w[: 6 if s.version <= 3 else 9])
                if not b or len(b) < 3 or not b[0] & 0x10:   # PS?DIRECTION
                    continue
                num = b[1] if b[0] & 3 == 3 else b[2]   # P1?DIRECTION: first part of speech
                if s.max_props - 16 < num <= s.max_props and num not in props:
                    props[num] = d
                    break
        # Real ZIL games have at least the four compass points.
        return props if {"n", "s", "e", "w"} <= set(props.values()) else {}

    def exits(self, room: int) -> dict[str, dict]:
        """{direction: {"to": room or None, "kind": "open"|"door"|"cond"|"func"}}."""
        if not self.dir_props or not 0 < room <= self.count:
            return {}
        s, small = self.story, self.story.version <= 3
        out = {}
        for num, data in s.properties(room).items():
            d = self.dir_props.get(num)
            if d is None:
                continue
            size = len(data) if small else len(data) - 1
            to = data[0] if small else (data[0] << 8 | data[1]) if len(data) >= 2 else 0
            kind = {1: "open", 3: "func", 4: "cond", 5: "door"}.get(size)
            if kind is None:      # NEXIT: a message, not a way out
                continue
            out[d] = {"to": to if kind != "func" and 0 < to <= self.count else None, "kind": kind}
        return out

    def name(self, obj: int) -> str:
        return self.story.name(obj) if 0 < obj <= self.count else ""


@lru_cache(maxsize=64)
def info(path: str, mtime: int) -> StoryInfo:
    return StoryInfo(Path(path).read_bytes())


def story_info(path: Path) -> StoryInfo:
    return info(str(path), path.stat().st_mtime_ns)


def locate(si: StoryInfo, save: bytes, status_room: str | None, hint: int | None) -> tuple[int | None, int | None]:
    """(room object, global index holding it) from a save, or (None, hint).

    Versions 1-3 keep the location in global 0 by definition (the interpreter
    draws the status line from it). Later games draw their own status line, so
    the global is found by matching the room name on the status line, and
    remembered for turns when the name doesn't help (darkness).
    """
    mem = quetzal_memory(save, si.data)
    if mem is None:
        return None, hint
    s = Story(si.data, mem)
    if s.version <= 3:
        return s.global_var(0) or None, 0
    want = (status_room or "").strip().lower()
    if want:
        for g in range(240):
            v = s.global_var(g)
            if 0 < v <= si.count and si.name(v).strip().lower() == want:
                return v, g
    if hint is not None:
        v = s.global_var(hint)
        if 0 < v <= si.count:
            return v, hint
    return None, hint


def command_direction(cmd: str) -> str | None:
    m = _GO.match(cmd.strip().lower())
    return WORDS.get(m.group(1)) if m else None


def empty() -> dict:
    return {"rooms": {}, "edges": [], "here": None, "g": None}


def update(m: dict | None, si: StoryInfo, save: bytes | None, status: str | None, cmd: str | None,
           moved: bool = True) -> dict:
    """Fold one move into the map. m is the stored map (JSON-shaped).

    With moved=False (undo, restore, opening a game) the player's position is
    updated but no passage is recorded: they didn't walk there.
    """
    m = m or empty()
    if save is None:
        return m
    status_room = (status or "").split("\t")[0].strip() or None
    room, g = locate(si, save, status_room, m.get("g"))
    m["g"] = g
    if room is None:
        return m
    key = str(room)
    real = si.name(room)
    seen = m["rooms"].setdefault(key, {"name": None})
    if status_room is None or status_room.lower() == real.strip().lower():
        seen["name"] = real            # lit (or no status line): the room is known
    prev = m.get("here")
    if moved and prev is not None and prev != room:
        d = None
        static = si.exits(prev)
        said = command_direction(cmd or "")
        if said and static.get(said, {}).get("to") == room:
            d = said
        else:
            d = next((k for k, v in static.items() if v["to"] == room), None) or said
        edge = [prev, d, room]
        if edge not in m["edges"]:
            m["edges"].append(edge)
    m["here"] = room
    return m


def view(m: dict | None, si: StoryInfo) -> dict | None:
    """What the page draws: rooms, edges, and exits of rooms whose name is known."""
    if not m or m.get("here") is None:
        return None
    used = {(a, d) for a, d, _ in m["edges"]}
    rooms = []
    for key, r in m["rooms"].items():
        rid = int(key)
        exits = []
        if r["name"]:
            for d, x in si.exits(rid).items():
                if x["kind"] in ("open", "door") or (rid, d) in used:
                    exits.append({"dir": d, "door": x["kind"] == "door", "known": (rid, d) in used})
        rooms.append({"id": rid, "name": r["name"], "exits": exits})
    return {"rooms": rooms, "edges": m["edges"], "here": m["here"]}
