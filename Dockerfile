# syntax=docker/dockerfile:1
# Infocom Library: a small Python server (standard library only) plus dfrotz,
# the dumb-terminal build of the Frotz Z-machine interpreter, and the three
# Zork games Microsoft released under the MIT licence.
#
# Base pinned by tag and digest; bump both together.
ARG BASE=python:3.12.15-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1

# --- dfrotz and the Zork trilogy --------------------------------------------
FROM ${BASE} AS fetch

# dfrotz comes from Debian's frotz package (apt verifies the archive
# signature). Only the dfrotz binary and its copyright file are kept: it links
# against libc alone, so none of the package's audio dependencies come along.
RUN apt-get update \
 && cd /tmp && apt-get download frotz \
 && dpkg-deb -x frotz_*.deb /tmp/frotz \
 && /tmp/frotz/usr/games/dfrotz -v | head -1 \
 && rm -rf /var/lib/apt/lists/*

# Zork I-III story files from github.com/historicalsource, pinned to a commit
# and checked against known hashes. These are the only Infocom games under an
# open licence (MIT, Microsoft, November 2025); every other title is mounted
# from your own copies at /games.
ADD --checksum=sha256:37084966477dff679282de42974b2077156b1bd68fad92a65d4ea94d8eb64d79 \
    https://raw.githubusercontent.com/historicalsource/zork1/97b7b3d68c075dd9af7da499c3e9690ada3471fd/COMPILED/zork1.z3 /games/zork1.z3
ADD --checksum=sha256:3ae7d5558943e9721f3e4b273c8a7faec1a03a604e1ae4ee1cde472c21cb24ac \
    https://raw.githubusercontent.com/historicalsource/zork2/3da9661098809788a99cef00f00c865c6c204f96/COMPILED/zork2.z3 /games/zork2.z3
ADD --checksum=sha256:b637a242865d059890184164ce8dec28554cc80901dcbf26c740b2d1ed0d4eb8 \
    https://raw.githubusercontent.com/historicalsource/zork3/3ec9ed412b5f3cafe65d83c727d07db1fe4a86a8/COMPILED/zork3.z3 /games/zork3.z3
ADD https://raw.githubusercontent.com/historicalsource/zork1/97b7b3d68c075dd9af7da499c3e9690ada3471fd/LICENSE /games/LICENSE-zork
# ADD from a URL leaves files 0600; the app runs as another user.
RUN chmod 755 /games && chmod 444 /games/*

# --- the app ----------------------------------------------------------------
FROM ${BASE}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data \
    GAMES_DIRS=/app/games:/games \
    TMPDIR=/tmp

COPY --from=fetch /tmp/frotz/usr/games/dfrotz /usr/local/bin/dfrotz
COPY --from=fetch /tmp/frotz/usr/share/doc/frotz/copyright /usr/share/doc/frotz/copyright
COPY --from=fetch /games/ /app/games/

WORKDIR /app
COPY server/ server/
COPY web/ web/
COPY LICENSE THIRD-PARTY.md ./

# Owned by the app user, so a named volume mounted here starts out writable.
# /games is where your own story files go (read-only is fine).
RUN install -d -o 1000 -g 1000 /data && install -d /games

# Unprivileged, and the root filesystem can be read-only: the database goes to
# /data, and dfrotz's scratch directories to /tmp (mount a tmpfs/emptyDir).
USER 1000:1000
EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python3", "-c", "import urllib.request as u; u.urlopen('http://127.0.0.1:8080/healthz', timeout=4)"]

CMD ["python3", "server/serve.py"]
