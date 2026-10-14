# Third-party components in the container image

This repository's own code is MIT-licensed (see `LICENSE`). The image also
contains:

| Component | Where in the image | Licence | Source |
|---|---|---|---|
| Zork I, Zork II, Zork III story files | `/app/games/zork{1,2,3}.z3` | MIT, © 2025 Microsoft (`/app/games/LICENSE-zork`) | [historicalsource/zork1](https://github.com/historicalsource/zork1), [zork2](https://github.com/historicalsource/zork2), [zork3](https://github.com/historicalsource/zork3) |
| dfrotz (Frotz 2.55, dumb interface) | `/usr/local/bin/dfrotz` | GPL-2.0-or-later (`/usr/share/doc/frotz/copyright`) | Debian package `frotz` ([source](https://sources.debian.org/src/frotz/)), upstream [gitlab.com/DavidGriffith/frotz](https://gitlab.com/DavidGriffith/frotz) |
| Python | base image | PSF-2.0 | [python](https://hub.docker.com/_/python) |

dfrotz is run as a separate program; the server talks to it over pipes.

No other Infocom game is included. Those titles are still under copyright;
mount your own copies at `/games`.
