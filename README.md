# Infocom Library

Play Infocom's interactive fiction (and any other Z-machine story) in a
browser. Each player has an account. Progress is saved on the server after
every move, so you can close the tab and continue later on any device.

- **Zork I, II and III built in.** Microsoft released them under the MIT
  licence in November 2025. Any other story files you own (`.z3`, `.z5`,
  `.dat`, …) go in a directory you mount, and the library recognises all 35
  Infocom titles by file name.
- **Autosave after every move**, plus named save slots, **unlimited undo**
  (even in the 1980s games that never had it) and restart.
- **An automap** that draws the rooms you've visited as you move, centred on
  where you are, with stubs for the exits you haven't tried yet. In 3D (the
  default) every way up or down leads to its own level, stacked like floors;
  drag to turn it, tap the compass for north-up, or switch to the flat map.
- **Accounts with passwords**, scrypt-hashed, with rate-limited sign-in.
  Sign-up can be open, first-account-only, or closed (admin-created).
- **Runs anywhere Docker does.** One small, non-root, read-only container. The
  server is Python standard library only; games run in
  [Frotz](https://gitlab.com/DavidGriffith/frotz)'s `dfrotz`.

## Run it

### Docker Compose

```sh
docker compose up -d        # then open http://localhost:8080
```

Put your own story files in `./games` (created next to `docker-compose.yml`).
They appear on the next page load. Accounts and saves live in the `data` volume.

### Docker

```sh
docker run -d --name infocom -p 8080:8080 \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  -v infocom-data:/data -v "$PWD/games:/games:ro" \
  ghcr.io/alanheinen/infocom-web:latest
```

### Kubernetes

```sh
# set your hostname in deploy/kubernetes/ingress.yaml first
kubectl apply -k deploy/kubernetes
```

That creates an `infocom` namespace with one Deployment, a 1 Gi PVC, a Service
and an Ingress. Copy your own story files onto the volume:

```sh
pod=$(kubectl -n infocom get pod -l app=infocom -o name | cut -d/ -f2)
kubectl -n infocom cp ./mygames/. "$pod":/data/games/
```

Keep it at **one replica**: the database is a single SQLite file.

### Without a container

You need Python 3.10+ and `dfrotz` on the `PATH` (Debian/Ubuntu: `apt install
frotz`; macOS: `brew install frotz`).

```sh
mkdir -p games && cp /path/to/*.z3 games/
python3 server/serve.py            # http://127.0.0.1:8080
```

## Settings

| Environment | Flag | Default | |
|---|---|---|---|
| `SIGNUP` | `--signup` | `open` | `open`: anyone can make an account. `first`: only the first account. `closed`: accounts are made with `useradd` only. |
| `DATA_DIR` | `--data` | `/data` | Where `infocom.db` lives. |
| `GAMES_DIRS` | `--games` | `/app/games:/games` | Story directories, `:`-separated. The first is treated as the built-in one. |
| `TRUST_PROXY` | `--trust-proxy` | off | Trust `X-Forwarded-For`/`-Proto`/`-Host`. Turn it on behind a reverse proxy, and never when the port is reachable directly. |
| `SECURE_COOKIE` | `--secure-cookie` | off | Always mark the session cookie `Secure` (when TLS ends at a proxy that doesn't send `X-Forwarded-Proto`). |
| `HOST`, `PORT` | `--host`, `--port` | `0.0.0.0`, `8080` in the image | |

Managing accounts (in the container: `docker exec -it infocom …` or
`kubectl -n infocom exec -it deploy/infocom -- …`):

```sh
python3 server/serve.py users
python3 server/serve.py useradd NAME     # prompts for the password
python3 server/serve.py passwd NAME      # also signs NAME out everywhere
python3 server/serve.py userdel NAME     # deletes their saves too
```

Add `--password-stdin` to `useradd` and `passwd` for scripting.

**On the internet:** serve it over HTTPS, set `SIGNUP=first` or `closed`, and
set `TRUST_PROXY=1` behind your proxy. On a home LAN the defaults are fine.

## Your own games

Any Z-machine story file of version 1–8 works. Files are matched to the catalog
(title, year, authors, blurb) by name, so `zork1.z3`, `ZORK1.DAT`,
`HITCHHIK.DAT` and `lurkinghorror-r221-s870918.z3` are all recognised. To name
something the catalog doesn't know, or to correct a match, add a
`catalog.json` to the games directory:

```json
[
  {"file": "mystery.z5", "title": "My Mystery", "year": 1999, "authors": "Me",
   "genre": "Mystery", "blurb": "One sentence for the card."}
]
```

An entry with a `key` instead of a `file` replaces that built-in catalog entry
(see `server/catalog.json`).

Progress is tied to the exact story file (by content hash). Replacing a file
with a different release starts that game fresh; the old progress stays in the
database, attached to the old file.

**Limits:** this is a text-only player. The graphical v6 games (Zork Zero,
Shōgun, Journey, Arthur) run without their pictures, and Journey's menu-driven
interface may not be usable. Beyond Zork's map window doesn't show. Border Zone's
real-time sections wait for you. Blorb-packaged stories (`.zblorb`) aren't
recognised. Use the bare story file.

## How it works

The interesting part is in [`server/engine.py`](server/engine.py). A game in
progress is stored as nothing but `(story file, random seed, list of commands)`.
`dfrotz` with a fixed seed is deterministic, so each move replays the whole
list plus the new command in a fresh, short-lived process, and the reply is
whatever text follows the previous output. That gives:

- autosave for free: the command list *is* the save,
- undo for every game: drop the last command,
- save slots that are just copies of a list,
- no long-running interpreter processes to keep alive or lose on a restart.

Replay is fast: about half a second for 3,000 Zork moves, and a whole
playthrough is a few hundred. The game's own `SAVE` and `RESTORE` would write
files outside the log, so typing `save`, `restore` or `undo` opens the app's
versions instead. `dfrotz` runs with `-R` pointed at an empty scratch
directory, and its backslash escape commands are stripped from input.

The automap ([`server/mapper.py`](server/mapper.py)) runs a second replay each
move that ends with the game's own `SAVE`, then reads the player's room out of
that save file ([`server/zmachine.py`](server/zmachine.py)). Rooms are
identified by their Z-machine object, so identically named rooms (Zork's
forests, its maze) stay distinct. Exits are read from the room objects using
Infocom's ZIL conventions. Plain exits and doors are drawn as unexplored
stubs. Conditional and scripted ones (secret passages, trap doors) appear only
once you've gone through them, so the map never gives a puzzle away. Games not
written in ZIL get the map of where you've been, without exit stubs. The map is
kept with the autosave and with each save slot. Undo keeps what you've learned,
and restart clears it.

If an interpreter upgrade ever changes the output, saved games still replay
correctly. Only the earlier part of the transcript loses its echoed commands.

Layout:

```
server/serve.py      HTTP server, auth, routing, admin commands
server/engine.py     dfrotz replay, transcript rebuilding, status line
server/store.py      SQLite: users, sessions, autosaves, save slots
server/catalog.py    finds story files and matches them to catalog.json
server/mapper.py     the automap: location, passages, exits
server/zmachine.py   reads the object table, dictionary and Quetzal saves
web/                 the page (vanilla JS, no build step); map.js and
                     map3d.js are the flat and 3D automaps
tests/smoke.py       end-to-end test against a running server (CI runs it)
```

## Licence

MIT for this repository. The image also contains the Zork I–III story files
(MIT, Microsoft) and `dfrotz` (GPL-2.0-or-later, run as a separate program).
See [THIRD-PARTY.md](THIRD-PARTY.md). No other Infocom game is included or
downloaded.
