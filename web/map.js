// The automap: draws the rooms you've visited as an SVG grid, centred on the
// room you're in, with stubs for the exits you haven't taken yet.
//
// The server sends {rooms: [{id, name, exits: [{dir, door, known}]}],
// edges: [[from, dir, to], ...], here}. Edges arrive in the order you walked
// them, and each room is placed once, by the first passage that reached it,
// so the map grows without rearranging itself.
"use strict";

const AutoMap = (() => {
  const SVG = "http://www.w3.org/2000/svg";
  const CELL_X = 150, CELL_Y = 92, BOX_W = 118, BOX_H = 48, STUB = 20;
  const VEC = {
    n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0],
    ne: [1, -1], nw: [-1, -1], se: [1, 1], sw: [-1, 1],
  };
  const OPPOSITE = { n: "s", s: "n", e: "w", w: "e", ne: "sw", sw: "ne", nw: "se", se: "nw", u: "d", d: "u", in: "out", out: "in" };
  const LABEL = { u: "up", d: "down", in: "in", out: "out", land: "land" };
  const NAMES = { n: "N", s: "S", e: "E", w: "W", ne: "NE", nw: "NW", se: "SE", sw: "SW" };
  // Where to try putting a room reached by up/down/in/out (no compass bearing).
  const NONPLANAR_TRY = { u: ["ne", "nw", "n"], d: ["sw", "se", "s"], in: ["se", "e"], out: ["nw", "w"] };
  const RING = ["e", "s", "w", "n", "se", "sw", "nw", "ne"];

  const el = (name, attrs, parent) => {
    const e = document.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    if (parent) parent.append(e);
    return e;
  };

  // Lays the rooms out on a grid: id -> {x, y, z}. With levels (the 3D map)
  // up and down lead to the level above or below; without, they and in/out
  // only mean "nearby", and z is always 0.
  //
  // The games' geography isn't a grid (Zork's forest and the paths round
  // its house loop back on themselves), so some passages can't be drawn the
  // way they go. The aim is to draw as many as possible true, keep the rest
  // near misses and short, and not rearrange the map as it grows:
  // 1. Rooms are placed in the order you found them. Each goes where its
  //    passages to rooms already placed say it should, weighing all of them;
  //    if that spot is taken, a row or column opens to make room.
  // 2. Then a room moves, or two swap, wherever that makes more passages
  //    point true.
  const VERT = { u: 1, d: -1 };
  const LONG = 0.2;   // cost of each extra grid step a passage spans
  const THROUGH = 0.6; // cost of a passage drawn across another room

  // What one passage of the layout costs: 0 when drawn true and one step long.
  function cost(A, B, l, occupied) {
    const dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z, len = Math.max(Math.abs(dx), Math.abs(dy));
    let long = LONG * Math.max(0, len - 1);
    // A straight or diagonal line that runs through another room's box
    // looks like it leads there.
    if (occupied && len > 1 && dz === 0 && (dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy))) {
      const sx = Math.sign(dx), sy = Math.sign(dy);
      for (let i = 1; i < len; i++) if (occupied(A.x + sx * i, A.y + sy * i, A.z)) long += THROUGH;
    }
    if (l.kind === "compass") {
      if (Math.sign(dx) === l.off[0] && Math.sign(dy) === l.off[1] && dz === 0) return long;
      // Drawn the wrong way: worse the further off it points (S drawn as SE
      // is a near miss, S drawn as N is not).
      let turn = len ? Math.abs(Math.atan2(dy, dx) - Math.atan2(l.off[1], l.off[0])) : Math.PI;
      if (turn > Math.PI) turn = 2 * Math.PI - turn;
      return 0.5 + 0.5 * turn / Math.PI + long + 0.3 * Math.abs(dz);
    }
    if (l.kind === "vertical") {
      const ok = dx === 0 && dy === 0 && Math.sign(dz) === l.off[2];
      return (ok ? 0 : 1) + LONG * (len + Math.max(0, Math.abs(dz) - 1));
    }
    return long + 0.3 * Math.abs(dz);
  }

  function layout(data, levels = false) {
    const pos = new Map(), taken = new Map();
    const key = (x, y, z) => `${x},${y},${z}`;
    const put = (id, x, y, z) => { pos.set(id, { x, y, z }); taken.set(key(x, y, z), id); };
    const free = (x, y, z) => !taken.has(key(x, y, z));
    const occupied = (x, y, z) => taken.has(key(x, y, z));
    const ids = data.rooms.map((r) => r.id);
    if (!ids.length) return pos;

    // Each room's passages, as seen from that room.
    const links = new Map(ids.map((id) => [id, []]));
    const seen = new Set();
    for (const [a, d, b] of data.edges) {
      if (a === b || !links.has(a) || !links.has(b) || seen.has(`${a} ${d} ${b}`)) continue;
      seen.add(`${a} ${d} ${b}`);
      let off = null, kind = "near";
      if (VEC[d]) { off = [VEC[d][0], VEC[d][1], 0]; kind = "compass"; }
      else if (levels && VERT[d]) { off = [0, 0, VERT[d]]; kind = "vertical"; }
      links.get(a).push({ o: b, d, off, kind });
      links.get(b).push({ o: a, d: OPPOSITE[d] || null, off: off && off.map((v) => -v), kind });
    }

    const nearest = (x, y, z, prefer) => {
      for (const d of prefer || []) {
        const [dx, dy] = VEC[d];
        if (free(x + dx, y + dy, z)) return [x + dx, y + dy];
      }
      for (let r = 1; r < 50; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) === r && free(x + dx, y + dy, z)) return [x + dx, y + dy];
          }
        }
      }
      return [x, y + 50];
    };
    // Opens an empty row or column (through every level) next to (x, y) on
    // the side (dx, dy) points to, by pushing every room beyond it one step
    // further out. Every pair of rooms keeps its bearing, so no passage
    // already drawn changes direction.
    const openGap = (x, y, dx, dy) => {
      for (const q of pos.values()) {
        if (dx > 0 && q.x > x) q.x += 1;
        else if (dx < 0 && q.x < x) q.x -= 1;
        else if (dx === 0 && dy < 0 && q.y < y) q.y -= 1;
        else if (dx === 0 && dy > 0 && q.y > y) q.y += 1;
      }
      taken.clear();
      for (const [id, q] of pos) taken.set(key(q.x, q.y, q.z), id);
    };
    // Where id would like to be: one candidate per passage to a placed room,
    // scored against all of them.
    const placeRoom = (id) => {
      const placed = links.get(id).filter((l) => pos.has(l.o));
      const scoreAt = (c) => placed.reduce((s, l) => s + cost(c, pos.get(l.o), l, occupied), 0);
      let best = null;
      for (const l of placed) {
        if (!l.off) continue;
        const q = pos.get(l.o);
        const c = { x: q.x - l.off[0], y: q.y - l.off[1], z: q.z - l.off[2] };
        const s = scoreAt(c) + (free(c.x, c.y, c.z) ? 0 : 0.6);
        if (!best || s < best.s - 1e-9) best = { s, c, l, q };
      }
      if (best) {
        const { c, l, q } = best;
        if (free(c.x, c.y, c.z)) return put(id, c.x, c.y, c.z);
        if (l.kind === "compass") {
          openGap(q.x, q.y, -l.off[0], -l.off[1]);
          return put(id, q.x - l.off[0], q.y - l.off[1], q.z);
        }
        const [x, y] = nearest(q.x, q.y, c.z, RING);   // up or down, with the spot taken
        return put(id, x, y, c.z);
      }
      // Reached only by up/down/in/out (flat map) or with no direction.
      const l = placed.find((p) => p.d) || placed[0], q = pos.get(l.o);
      const [x, y] = nearest(q.x, q.y, q.z, NONPLANAR_TRY[l.d && OPPOSITE[l.d]] || RING);
      put(id, x, y, q.z);
    };

    put(ids[0], 0, 0, 0);
    let progress = true;
    while (progress) {
      progress = false;
      // Real passages first; a move with no direction (dying, a spell) places
      // a room only when nothing better reaches it, and only one at a time.
      for (const known of [true, false]) {
        for (const [a, d, b] of data.edges) {
          if (!!d !== known || progress && !known) continue;
          if (pos.has(a) !== pos.has(b) && links.has(a) && links.has(b)) {
            placeRoom(pos.has(a) ? b : a);
            progress = true;
          }
        }
        if (progress) break;
      }
      if (!progress) {
        // A room with no recorded passage (e.g. an older save): start a new island.
        const loose = ids.find((id) => !pos.has(id));
        if (loose !== undefined) {
          let maxX = -Infinity;
          for (const p of pos.values()) maxX = Math.max(maxX, p.x);
          put(loose, maxX + 2, 0, 0);
          progress = true;
        }
      }
    }

    // 2. Local search: move a room within two steps (or a level), or swap two,
    // whenever the passages they touch cost less for it.
    const at = (id, x, y, z) => { pos.get(id).x = x; pos.get(id).y = y; pos.get(id).z = z; taken.set(key(x, y, z), id); };
    const local = (id, here, other, otherAt) => {
      let c = 0;
      for (const l of links.get(id)) c += cost(here, l.o === other ? otherAt : pos.get(l.o), l, occupied);
      return c;
    };
    for (let pass = 0; pass < 40; pass++) {
      let improved = false;
      for (const id of ids) {
        const a = { ...pos.get(id) };
        const cands = [];
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (dx || dy) cands.push({ x: a.x + dx, y: a.y + dy, z: a.z });
        if (levels) cands.push({ x: a.x, y: a.y, z: a.z - 1 }, { x: a.x, y: a.y, z: a.z + 1 });
        let best = null, bestDelta = -0.3;  // only moves that clearly help: the map shouldn't fidget
        for (const c of cands) {
          const other = taken.get(key(c.x, c.y, c.z));
          const delta = other === undefined ? local(id, c) - local(id, a)
            : local(id, c, other, a) + local(other, a, id, c) - local(id, a) - local(other, c);
          if (delta < bestDelta) { bestDelta = delta; best = { c, other }; }
        }
        if (best) {
          const { c, other } = best;
          taken.delete(key(a.x, a.y, a.z));
          if (other !== undefined) at(other, a.x, a.y, a.z);
          at(id, c.x, c.y, c.z);
          improved = true;
        }
      }
      if (!improved) break;
    }
    return pos;
  }

  function wrap(name) {
    if (!name) return ["?"];
    const words = name.split(/\s+/), lines = [""];
    for (const w of words) {
      const cur = lines[lines.length - 1];
      if ((cur + " " + w).trim().length <= 17) lines[lines.length - 1] = (cur + " " + w).trim();
      else lines.push(w);
    }
    if (lines.length > 2) {
      lines.length = 2;
      lines[1] = lines[1].slice(0, 15) + "…";
    }
    return lines.map((l) => (l.length > 18 ? l.slice(0, 17) + "…" : l));
  }

  class View {
    constructor(container) {
      this.box = container;
      this.svg = el("svg", { class: "automap", role: "img", "aria-label": "Map of visited rooms" }, container);
      this.layer = el("g", {}, this.svg);
      this.view = { x: -200, y: -150, w: 400, h: 300 };
      this.zoom = 0.85;
      this.data = null;
      this.anim = null;
      this._pan();
      new ResizeObserver(() => this._fit()).observe(container);
    }

    set(data) {
      this.data = data;
      this.draw();
      this.center(true);
    }

    draw() {
      const data = this.data;
      this.layer.replaceChildren();
      if (!data) return;
      const pos = layout(data);
      this.pos = pos;
      const px = (id) => { const p = pos.get(id); return [p.x * CELL_X, p.y * CELL_Y]; };
      const edges = el("g", { class: "edges" }, this.layer);
      const stubs = el("g", { class: "stubs" }, this.layer);
      const rooms = el("g", { class: "rooms" }, this.layer);
      const labels = el("g", { class: "edge-labels" }, this.layer);

      const drawn = new Set();
      for (const [a, d, b] of data.edges) {
        if (!pos.has(a) || !pos.has(b)) continue;
        const pair = a < b ? `${a}-${b}` : `${b}-${a}`;
        if (drawn.has(pair)) continue;
        drawn.add(pair);
        const [x1, y1] = px(a), [x2, y2] = px(b);
        el("line", { x1, y1, x2, y2, class: d ? "edge" : "edge unknown" }, edges);
        // Name the direction when the line can't show it: up/down/in/out, or
        // a passage that loops back to a room already placed elsewhere (the
        // games' geography isn't always a grid).
        const bent = d && VEC[d] && (Math.sign(x2 - x1) !== VEC[d][0] || Math.sign(y2 - y1) !== VEC[d][1]);
        if (d && (!VEC[d] || bent)) {
          const t = el("text", { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 4, class: "edge-label" }, labels);
          t.textContent = LABEL[d] || NAMES[d] || d;
        }
      }

      for (const r of data.rooms) {
        if (!pos.has(r.id)) continue;
        const [cx, cy] = px(r.id);
        const here = r.id === data.here;
        for (const x of r.exits) {
          if (x.known) continue;
          const cls = "stub" + (here ? " here" : "") + (x.door ? " door" : "");
          if (VEC[x.dir]) {
            const [dx, dy] = VEC[x.dir];
            const sx = cx + dx * BOX_W / 2, sy = cy + dy * BOX_H / 2;
            const ex = sx + dx * STUB, ey = sy + dy * STUB;
            el("line", { x1: sx, y1: sy, x2: ex, y2: ey, class: cls }, stubs);
            el("circle", { cx: ex, cy: ey, r: 3, class: cls + " end" }, stubs);
          }
        }
        const g = el("g", { class: "room" + (here ? " here" : "") + (r.name ? "" : " dark") }, rooms);
        el("rect", { x: cx - BOX_W / 2, y: cy - BOX_H / 2, width: BOX_W, height: BOX_H, rx: 8 }, g);
        const lines = wrap(r.name);
        lines.forEach((line, i) => {
          const t = el("text", { x: cx, y: cy + 4 + (i - (lines.length - 1) / 2) * 14 }, g);
          t.textContent = line;
        });
        const title = el("title", {}, g);
        title.textContent = r.name || "An unknown room";
        // Unexplored up/down/in/out exits: small tags under the box.
        const extra = r.exits.filter((x) => !x.known && !VEC[x.dir]).map((x) => LABEL[x.dir] || x.dir);
        if (extra.length) {
          const t = el("text", { x: cx, y: cy + BOX_H / 2 + 13, class: "extra" + (here ? " here" : "") }, stubs);
          t.textContent = extra.join(" · ");
        }
      }
    }

    _fit() {
      const r = this.box.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const cx = this.view.x + this.view.w / 2, cy = this.view.y + this.view.h / 2;
      this.view.w = r.width / this.zoom;
      this.view.h = r.height / this.zoom;
      this.view.x = cx - this.view.w / 2;
      this.view.y = cy - this.view.h / 2;
      this._apply();
    }

    _apply() {
      const v = this.view;
      this.svg.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`);
    }

    center(animate) {
      if (!this.data || !this.pos || !this.pos.has(this.data.here)) return;
      this._fit();
      const p = this.pos.get(this.data.here);
      const tx = p.x * CELL_X - this.view.w / 2, ty = p.y * CELL_Y - this.view.h / 2;
      cancelAnimationFrame(this.anim);
      if (!animate || matchMedia("(prefers-reduced-motion: reduce)").matches) {
        this.view.x = tx; this.view.y = ty; this._apply();
        return;
      }
      const x0 = this.view.x, y0 = this.view.y, t0 = performance.now(), dur = 280;
      const step = (t) => {
        const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
        this.view.x = x0 + (tx - x0) * e;
        this.view.y = y0 + (ty - y0) * e;
        this._apply();
        if (k < 1) this.anim = requestAnimationFrame(step);
      };
      this.anim = requestAnimationFrame(step);
    }

    zoomBy(f) {
      this.zoom = Math.max(0.35, Math.min(2.5, this.zoom * f));
      this._fit();
    }

    _pan() {
      let start = null;
      this.svg.addEventListener("pointerdown", (e) => {
        start = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y };
        this.svg.setPointerCapture(e.pointerId);
        this.svg.classList.add("grabbing");
      });
      this.svg.addEventListener("pointermove", (e) => {
        if (!start) return;
        this.view.x = start.vx - (e.clientX - start.x) / this.zoom;
        this.view.y = start.vy - (e.clientY - start.y) / this.zoom;
        this._apply();
      });
      const end = () => { start = null; this.svg.classList.remove("grabbing"); };
      this.svg.addEventListener("pointerup", end);
      this.svg.addEventListener("pointercancel", end);
      this.svg.addEventListener("wheel", (e) => {
        e.preventDefault();
        this.zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
      }, { passive: false });
    }
  }

  return { View, layout, wrap, VEC, OPPOSITE, LABEL, NAMES, NONPLANAR_TRY, RING };
})();
