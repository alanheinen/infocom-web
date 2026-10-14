"""Just enough of the Z-machine to read a story's rooms, exits and state.

Used by the automap (mapper.py). It reads, never runs: the object table and
dictionary come from the story file, and the current state (where the player
is) from a Quetzal save that dfrotz writes at the end of a replay.

References: the Z-Machine Standards Document 1.1 (sections 1, 3, 12, 13) and
the Quetzal 1.4 save-file standard.
"""

from __future__ import annotations

ALPHABETS = (
    "abcdefghijklmnopqrstuvwxyz",
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    " \n0123456789.,!?_#'\"/\\-:()",
)


class Story:
    def __init__(self, data: bytes, memory: bytes | None = None):
        self.static = data
        self.mem = bytearray(memory if memory is not None else data)
        self.version = data[0]
        self.objects_addr = self.word(0x0A)
        self.globals_addr = self.word(0x0C)
        self.abbrev_addr = self.word(0x18)
        self.dict_addr = self.word(0x08)
        self.release = self.word(0x02)
        self.serial = bytes(data[0x12:0x18])
        self.checksum = self.word(0x1C)
        small = self.version <= 3
        self.max_props = 31 if small else 63
        self.entry_size = 9 if small else 14
        self.tree_base = self.objects_addr + self.max_props * 2

    # --- memory ---------------------------------------------------------------

    def byte(self, a: int) -> int:
        return self.mem[a]

    def word(self, a: int) -> int:
        return (self.mem[a] << 8) | self.mem[a + 1]

    def global_var(self, n: int) -> int:
        return self.word(self.globals_addr + 2 * n)

    # --- objects --------------------------------------------------------------

    def _entry(self, obj: int) -> int:
        return self.tree_base + (obj - 1) * self.entry_size

    def object_count(self) -> int:
        # The property tables start right after the object entries, so the
        # lowest property-table address bounds the number of objects.
        first_props = self._props_addr(1)
        return max(0, min((first_props - self.tree_base) // self.entry_size, 65535))

    def parent(self, obj: int) -> int:
        e = self._entry(obj)
        return self.byte(e + 4) if self.version <= 3 else self.word(e + 6)

    def attribute(self, obj: int, attr: int) -> bool:
        return bool(self.byte(self._entry(obj) + attr // 8) & (0x80 >> (attr % 8)))

    def _props_addr(self, obj: int) -> int:
        e = self._entry(obj)
        return self.word(e + 7) if self.version <= 3 else self.word(e + 12)

    def name(self, obj: int) -> str:
        a = self._props_addr(obj)
        if self.byte(a) == 0:
            return ""
        return self.zstring(a + 1)[0]

    def properties(self, obj: int) -> dict[int, bytes]:
        """{property number: data} for one object."""
        a = self._props_addr(obj)
        a += 1 + 2 * self.byte(a)
        out = {}
        while True:
            size_byte = self.byte(a)
            if size_byte == 0:
                return out
            if self.version <= 3:
                num, size, a = size_byte & 0x1F, (size_byte >> 5) + 1, a + 1
            elif size_byte & 0x80:
                num = size_byte & 0x3F
                size = self.byte(a + 1) & 0x3F or 64
                a += 2
            else:
                num, size, a = size_byte & 0x3F, 2 if size_byte & 0x40 else 1, a + 1
            out[num] = bytes(self.mem[a:a + size])
            a += size

    # --- text -----------------------------------------------------------------

    def zstring(self, a: int, depth: int = 0) -> tuple[str, int]:
        zchars = []
        while True:
            w = self.word(a)
            a += 2
            zchars += [(w >> 10) & 31, (w >> 5) & 31, w & 31]
            if w & 0x8000:
                break
        out, alpha, i = [], 0, 0
        while i < len(zchars):
            c = zchars[i]
            if c == 0:
                out.append(" ")
            elif c in (1, 2, 3) and depth == 0 and self.version >= 2 and i + 1 < len(zchars):
                idx = 32 * (c - 1) + zchars[i + 1]
                out.append(self.zstring(self.word(self.abbrev_addr + 2 * idx) * 2, 1)[0])
                i += 1
            elif c in (4, 5):
                alpha = c - 3
                i += 1
                continue
            elif c == 6 and alpha == 2:
                if i + 2 < len(zchars):
                    out.append(chr((zchars[i + 1] << 5) | zchars[i + 2]))
                i += 2
            elif c >= 6:
                out.append(ALPHABETS[alpha][c - 6])
            alpha = 0
            i += 1
        return "".join(out), a

    def dictionary(self) -> list[tuple[str, bytes]]:
        """[(word, data bytes after the encoded text)] in dictionary order."""
        a = self.dict_addr
        a += 1 + self.byte(a)
        entry_len = self.byte(a)
        count = self.word(a + 1)
        if count >= 0x8000:
            count = 0x10000 - count
        a += 3
        text_len = 4 if self.version <= 3 else 6
        out = []
        for i in range(count):
            e = a + i * entry_len
            out.append((self.zstring(e)[0], bytes(self.static[e + text_len:e + entry_len])))
        return out


def quetzal_memory(save: bytes, story: bytes) -> bytes | None:
    """Dynamic memory from a Quetzal save, or None if it isn't for this story."""
    if save[:4] != b"FORM" or save[8:12] != b"IFZS":
        return None
    dyn_size = (story[0x0E] << 8) | story[0x0F]
    a, end, mem, header = 12, min(len(save), 8 + int.from_bytes(save[4:8], "big")), None, None
    while a + 8 <= end:
        cid, size = save[a:a + 4], int.from_bytes(save[a + 4:a + 8], "big")
        body = save[a + 8:a + 8 + size]
        if cid == b"IFhd":
            header = body
        elif cid == b"UMem":
            mem = bytes(body[:dyn_size])
        elif cid == b"CMem":
            out, i = bytearray(story[:dyn_size]), 0
            pos = 0
            while i < len(body) and pos < dyn_size:
                b = body[i]
                if b == 0:
                    pos += body[i + 1] + 1 if i + 1 < len(body) else 1
                    i += 2
                else:
                    out[pos] ^= b
                    pos += 1
                    i += 1
            mem = bytes(out)
        a += 8 + size + (size & 1)
    if header is None or mem is None:
        return None
    # IFhd: release(2) serial(6) checksum(2) ... must match the story.
    if header[:8] != story[2:4] + story[0x12:0x18]:
        return None
    return mem + story[len(mem):]
