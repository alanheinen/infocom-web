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

  function layout(data) {
    const pos = new Map(), taken = new Map();
    const key = (x, y) => `${x},${y}`;
    const put = (id, x, y) => { pos.set(id, { x, y }); taken.set(key(x, y), id); };
    const free = (x, y) => !taken.has(key(x, y));
    const nearest = (x, y, prefer) => {
      for (const d of prefer || []) {
        const [dx, dy] = VEC[d];
        if (free(x + dx, y + dy)) return [x + dx, y + dy];
      }
      for (let r = 1; r < 50; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) === r && free(x + dx, y + dy)) return [x + dx, y + dy];
          }
        }
      }
      return [x, y + 50];
    };
    // Opens an empty row or column next to (x, y) on the side (dx, dy) points
    // to, by pushing every room beyond it one step further out. Every pair of
    // rooms keeps its bearing (who is north, east... of whom), so north stays
    // up for every passage already drawn.
    const openGap = (x, y, dx, dy) => {
      const moved = [];
      for (const [id, q] of pos) {
        if (dx > 0 && q.x > x) q.x += 1;
        else if (dx < 0 && q.x < x) q.x -= 1;
        else if (dx === 0 && dy < 0 && q.y < y) q.y -= 1;
        else if (dx === 0 && dy > 0 && q.y > y) q.y += 1;
        moved.push([id, q]);
      }
      taken.clear();
      for (const [id, q] of moved) taken.set(key(q.x, q.y), id);
    };
    const placeFrom = (fromId, dir, toId) => {
      const p = pos.get(fromId);
      if (dir && VEC[dir]) {
        const [dx, dy] = VEC[dir];
        // A compass passage always goes the way it says: north is up.
        if (!free(p.x + dx, p.y + dy)) openGap(p.x, p.y, dx, dy);
        return put(toId, p.x + dx, p.y + dy);
      }
      // up, down, in, out or an unknown passage: any nearby free cell.
      const [x, y] = nearest(p.x, p.y, NONPLANAR_TRY[dir] || RING);
      put(toId, x, y);
    };

    const ids = data.rooms.map((r) => r.id);
    if (!ids.length) return pos;
    put(ids[0], 0, 0);
    let progress = true;
    while (progress) {
      progress = false;
      // Real passages first; a move with no direction (dying, a spell) places
      // a room only when nothing better reaches it, and only one at a time.
      for (const known of [true, false]) {
        for (const [a, d, b] of data.edges) {
          if (!!d !== known || progress && !known) continue;
          if (pos.has(a) && !pos.has(b)) { placeFrom(a, d, b); progress = true; }
          else if (pos.has(b) && !pos.has(a)) { placeFrom(b, OPPOSITE[d] || null, a); progress = true; }
        }
        if (progress) break;
      }
      if (!progress) {
        // A room with no recorded passage (e.g. an older save): start a new island.
        const loose = ids.find((id) => !pos.has(id));
        if (loose !== undefined) {
          let maxX = -Infinity;
          for (const p of pos.values()) maxX = Math.max(maxX, p.x);
          put(loose, maxX + 2, 0);
          progress = true;
        }
      }
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
