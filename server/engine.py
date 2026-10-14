"""Runs Z-machine stories through dfrotz by replaying a command log.

A game in progress is stored as nothing more than (story, seed, commands).
dfrotz with a fixed random seed is deterministic, so feeding it the same
commands always produces byte-identical output, and the output after N
commands is a prefix of the output after N+1. Each turn therefore replays the
whole log plus the new command in a fresh, short-lived process, and the new
text is whatever follows the previous output.

That gives us, for free:
  - autosave after every turn (the log is the save)
  - unlimited undo, even in version 3 games that have none (drop the last line)
  - save slots that are just copies of a log
  - no interpreter processes to keep alive, lose on restart, or leak

Replaying is fast: ~3000 Zork commands take about half a second, and a full
playthrough is a few hundred. dfrotz never touches our files: it runs with -R
pointed at an empty scratch directory, and the game's own SAVE and RESTORE are
replaced by the app's (see INTERCEPTED).
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

DFROTZ = os.environ.get("DFROTZ", shutil.which("dfrotz") or "/usr/local/bin/dfrotz")
# As wide as the Z-machine allows (the header holds the width in one byte),
# so dfrotz rarely wraps and the browser does, and text reflows on a phone.
# The rare longer paragraph is rejoined by unwrap(). The status line is
# right-aligned to this width, which parse_status() undoes.
WIDTH = 255
TIMEOUT = 20
MAX_OUTPUT = 16 * 1024 * 1024
MAX_COMMAND = 200

# Typed commands the app handles itself rather than passing to the game.
# The game's SAVE/RESTORE would write files outside the log and break replay.
INTERCEPTED = {"save", "restore", "undo"}

_CONTROL = re.compile(r"[\x00-\x1f\x7f-\xff\\]")
_STATUS = re.compile(r"^ ?(\S.*?\S|\S) {3,}(\S.*\S|\S)\s*$")


class EngineError(Exception):
    pass


def clean_command(text: str) -> str:
    """Strip what dfrotz would treat as more than a typed line.

    Backslash starts dfrotz's own runtime escapes (screen modes, hotkeys), and
    control characters or newlines would inject extra input lines into the log.
    """
    return _CONTROL.sub("", text).strip()[:MAX_COMMAND]


@dataclass
class Run:
    output: str      # everything the game printed, latin-1 so len() == bytes
    ended: bool      # the story exited (QUIT, or the game finished) before input ran out


def run(story: Path, seed: int, commands: list[str]) -> Run:
    feed = "".join(c + "\n" for c in commands).encode("latin-1", "replace")
    with tempfile.TemporaryDirectory(prefix="dfrotz-") as scratch:
        try:
            p = subprocess.run(
                [DFROTZ, "-q", "-m", "-p", "-w", str(WIDTH), "-h", "999",
                 "-s", str(seed), "-R", scratch, str(story)],
                input=feed, capture_output=True, timeout=TIMEOUT, cwd=scratch,
            )
        except subprocess.TimeoutExpired as e:
            raise EngineError("the interpreter took too long to answer") from e
    if len(p.stdout) > MAX_OUTPUT:
        raise EngineError("the story produced too much output")
    # dfrotz writes "EOT" to stderr when it runs out of input while waiting for
    # more. Without it, the story stopped on its own.
    ended = b"EOT" not in p.stderr
    if ended and p.returncode != 0 and not p.stdout:
        raise EngineError(p.stderr.decode("latin-1").strip() or "the interpreter failed")
    return Run(p.stdout.decode("latin-1"), ended)


def snapshot(story: Path, seed: int, commands: list[str]) -> bytes | None:
    """The game's memory after `commands`, as a Quetzal save, for the automap.

    A separate replay that ends with the game's own SAVE, so the turn's real
    output is never touched. Returns None when the game didn't save (it ended,
    or was waiting for something other than a command).
    """
    feed = "".join(c + "\n" for c in commands + ["save", "map.qzl"]).encode("latin-1", "replace")
    with tempfile.TemporaryDirectory(prefix="dfrotz-") as scratch:
        try:
            subprocess.run(
                [DFROTZ, "-q", "-m", "-p", "-w", str(WIDTH), "-h", "999",
                 "-s", str(seed), "-R", scratch, str(story)],
                input=feed, capture_output=True, timeout=TIMEOUT, cwd=scratch,
            )
        except subprocess.TimeoutExpired:
            return None
        try:
            return (Path(scratch) / "map.qzl").read_bytes()
        except OSError:
            return None


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("latin-1")).hexdigest()


def parse_status(chunk: str) -> tuple[str | None, str]:
    """Split the status line dfrotz prints at the top of each turn.

    dfrotz has no separate status window, so it prints the status bar as the
    first line of every turn's output (" West of House   ...   Score: 0  Moves: 1"),
    followed by a blank line. Returns (status, rest).
    """
    first, nl, rest = chunk.partition("\n")
    if nl and len(first) >= WIDTH * 3 // 4:   # right-aligned to WIDTH, trailing blanks trimmed
        m = _STATUS.match(first)
        if m:
            if rest.startswith("\n"):
                rest = rest[1:]
            return f"{m.group(1)}\t{m.group(2)}", rest
    return None, chunk


def unwrap(text: str) -> str:
    """Rejoin lines dfrotz broke at the right margin (paragraphs over WIDTH)."""
    lines = text.split("\n")
    out = [lines[0]]
    for line in lines[1:]:
        prev = out[-1]
        if len(prev) >= WIDTH - 40 and line.strip():
            out[-1] = prev + ("" if prev.endswith("-") else " ") + line
        else:
            out.append(line)
    return "\n".join(out)


def split_prompt(text: str) -> tuple[str, str]:
    """Separate the trailing prompt (usually ">") from the body of a turn."""
    body, nl, prompt = text.rpartition("\n")
    if not nl:
        return "", text
    return body + "\n", prompt


def segments(output: str, marks: list[int], commands: list[str]) -> list[dict]:
    """Rebuild the transcript as [{cmd, text}] from a replay and the turn marks.

    marks are the output lengths after each of the last len(marks) - 1
    commands, preceded by the length before them. Normally that is every
    command (len(marks) == len(commands) + 1). After replay drift (an
    interpreter upgrade changed the output) the turns before the drift fold
    into one opening block without their typed commands; it is still the whole
    story text.
    """
    if not marks or marks[-1] != len(output) or len(marks) > len(commands) + 1:
        return [{"cmd": None, "text": output}]
    folded = len(commands) + 1 - len(marks)
    out = [{"cmd": None, "text": output[:marks[0]]}]
    for i in range(1, len(marks)):
        out.append({"cmd": commands[folded + i - 1], "text": output[marks[i - 1]:marks[i]]})
    return out


def render(segs: list[dict]) -> tuple[list[dict], str | None, str]:
    """Strip status lines and prompts; return (turns, last status, prompt).

    Each turn's text ends with the prompt the next command answers, so the
    prompt moves to the following turn as `prompt`, which the page shows in
    front of the echoed command.
    """
    status, prompt, turns = None, "", []
    for s in segs:
        st, text = parse_status(s["text"])
        if st:
            status = st
        if s["cmd"] is None and len(segs) == 1:
            # Folded after drift: several turns' status lines are inline, each
            # just after a prompt. Keep the prompt, lift out the status.
            kept = []
            for line in text.split("\n"):
                head = line[:len(line) - len(line.lstrip(">"))]
                if len(line) >= WIDTH * 3 // 4 and (m := _STATUS.match(line[len(head):])):
                    status = f"{m.group(1)}\t{m.group(2)}"
                    line = head
                kept.append(line)
            text = "\n".join(kept)
        body, next_prompt = split_prompt(text)
        turns.append({"prompt": prompt, "cmd": s["cmd"], "text": unwrap(body)})
        prompt = next_prompt
    return turns, status, prompt


def story_header(path: Path) -> dict | None:
    """Read the Z-machine header; None if this isn't a story file we can run."""
    try:
        with path.open("rb") as f:
            h = f.read(64)
    except OSError:
        return None
    if len(h) < 64 or h[0] not in range(1, 9):
        return None
    serial = h[0x12:0x18]
    return {
        "version": h[0],
        "release": int.from_bytes(h[2:4], "big"),
        "serial": serial.decode("ascii") if serial.isdigit() else "",
    }
