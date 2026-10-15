// The automap in 3D: the same rooms and passages as map.js, but every way up
// or down leads to its own level, stacked like the floors of a building. The
// camera starts facing a little east of north. Drag to turn and tilt it; tap
// the compass to put north straight up.
"use strict";

const AutoMap3D = (() => {
  const { wrap, VEC, OPPOSITE, LABEL, NAMES, NONPLANAR_TRY, RING } = AutoMap;
  const SVG = "http://www.w3.org/2000/svg";
  const CELL_X = 150, CELL_Y = 120, LEVEL = 230;     // world units between rooms and levels
  const BOX_W = 118, BOX_H = 72, SLAB = 9, STUB = 22, RISE = 34;
  // The starting view: turned a little east of north, so floors stacked
  // above one another don't hide each other, and tilted 50° from overhead.
  const YAW = 0.45, PITCH = 0.87, MAX_PITCH = 1.35;  // radians
  const VERTICAL = { u: 1, d: -1 };

  const el = (name, attrs, parent) => {
    const e = document.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    if (parent) parent.append(e);
    return e;
  };
  const pts = (list) => list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

  // Like AutoMap.layout, plus a level (z). Up and down go to the room straight
  // above or below when that spot is free. A compass passage that runs into a
  // room opens a gap through every level, so rooms stacked above one another
  // stay stacked.
  function layout(data) {
    const pos = new Map(), taken = new Map();
    const key = (x, y, z) => `${x},${y},${z}`;
    const put = (id, x, y, z) => { pos.set(id, { x, y, z }); taken.set(key(x, y, z), id); };
    const free = (x, y, z) => !taken.has(key(x, y, z));
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
    const placeFrom = (fromId, dir, toId) => {
      const p = pos.get(fromId);
      if (dir && VEC[dir]) {
        const [dx, dy] = VEC[dir];
        if (!free(p.x + dx, p.y + dy, p.z)) openGap(p.x, p.y, dx, dy);
        return put(toId, p.x + dx, p.y + dy, p.z);
      }
      if (VERTICAL[dir]) {
        const z = p.z + VERTICAL[dir];
        if (free(p.x, p.y, z)) return put(toId, p.x, p.y, z);
        const [x, y] = nearest(p.x, p.y, z, RING);
        return put(toId, x, y, z);
      }
      const [x, y] = nearest(p.x, p.y, p.z, NONPLANAR_TRY[dir] || RING);
      put(toId, x, y, p.z);
    };

    const ids = data.rooms.map((r) => r.id);
    if (!ids.length) return pos;
    put(ids[0], 0, 0, 0);
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
        const loose = ids.find((id) => !pos.has(id));
        if (loose !== undefined) {
          let maxX = -Infinity;
          for (const p of pos.values()) maxX = Math.max(maxX, p.x);
          put(loose, maxX + 2, 0, 0);
          progress = true;
        }
      }
    }
    return pos;
  }

  // Convex hull (monotone chain) of a few screen points: the outline of a slab.
  function hull(points) {
    const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [], upper = [];
    for (const q of p) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
      lower.push(q);
    }
    for (const q of p.reverse()) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
      upper.push(q);
    }
    return lower.slice(0, -1).concat(upper.slice(0, -1));
  }

  function levelName(dz) {
    if (dz === 0) return "Your level";
    const n = Math.abs(dz);
    return `${n} level${n === 1 ? "" : "s"} ${dz > 0 ? "up" : "down"}`;
  }

  class View {
    constructor(container) {
      this.box = container;
      this.svg = el("svg", { class: "automap automap3d", role: "img", tabindex: "0",
        "aria-label": "3D map of visited rooms. Drag or use the arrow keys to turn it." }, container);
      this.layer = el("g", {}, this.svg);
      this.compass = el("svg", { class: "compass compass3d", viewBox: "-30 -30 60 60", role: "button",
        tabindex: "0", "aria-label": "Compass. Activate to turn north up." }, container);
      el("title", {}, this.compass).textContent = "Turn north up";
      this.yaw = YAW;          // radians, clockwise: 0 looks due north
      this.pitch = PITCH;
      this.zoom = 0.9;
      this.pan = { x: 0, y: 0 };
      this.target = [0, 0, 0];
      this.size = { w: 400, h: 300 };
      this.data = null;
      this.pos = null;
      this.anim = null;
      this.frame = null;
      this._input();
      new ResizeObserver(() => this._fit()).observe(container);
    }

    set(data) {
      this.data = data;
      this.pos = layout(data);
      this.center(true);
    }

    _world(id) {
      const p = this.pos.get(id);
      return [p.x * CELL_X, p.y * CELL_Y, p.z * LEVEL];
    }

    // World point -> [screen x, screen y, depth]; larger depth is nearer.
    _project([X, Y, Z]) {
      const dx = X - this.target[0], dy = Y - this.target[1], dz = Z - this.target[2];
      const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
      const u = dx * c - dy * s, v = dx * s + dy * c;
      const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
      return [u, v * cp - dz * sp, v * sp + dz * cp];
    }

    _fit() {
      const r = this.box.getBoundingClientRect();
      if (!r.width || !r.height) return;
      this.size = { w: r.width, h: r.height };
      this.render();
    }

    render() {
      cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(() => this._draw());
    }

    _draw() {
      const w = this.size.w / this.zoom, h = this.size.h / this.zoom;
      this.svg.setAttribute("viewBox", `${-w / 2 - this.pan.x} ${-h / 2 - this.pan.y} ${w} ${h}`);
      this._drawCompass();
      this.layer.replaceChildren();
      const data = this.data;
      if (!data || !this.pos || !this.pos.size) return;
      const pos = this.pos, P = (p) => this._project(p);
      const hereZ = pos.has(data.here) ? pos.get(data.here).z : 0;
      const rooms = data.rooms.filter((r) => pos.has(r.id));
      const byLevel = new Map();
      for (const r of rooms) {
        const z = pos.get(r.id).z;
        if (!byLevel.has(z)) byLevel.set(z, []);
        byLevel.get(z).push(r);
      }

      // Passages: on one level, or between two (drawn after the lower one).
      const flat = new Map(), between = new Map(), seen = new Set();
      for (const [a, d, b] of data.edges) {
        if (!pos.has(a) || !pos.has(b)) continue;
        const pair = a < b ? `${a}-${b}` : `${b}-${a}`;
        if (seen.has(pair)) continue;
        seen.add(pair);
        const za = pos.get(a).z, zb = pos.get(b).z;
        const bucket = za === zb ? flat : between, z = Math.min(za, zb);
        if (!bucket.has(z)) bucket.set(z, []);
        bucket.get(z).push([a, d, b]);
      }

      const levels = [...byLevel.keys()].sort((a, b) => a - b);
      for (const z of levels) {
        const g = el("g", { class: "level" + (z === hereZ ? " current" : "") }, this.layer);
        const list = byLevel.get(z), Z = z * LEVEL;

        // Ways down hang below the floor, so they go behind it.
        for (const r of list) this._vertStubs(g, r, -1, r.id === data.here);

        // The floor: a plate under this level's rooms.
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const r of list) {
          const p = pos.get(r.id);
          x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
        }
        const mx = CELL_X * 0.6, my = CELL_Y * 0.65;
        const corners = [[x0 * CELL_X - mx, y0 * CELL_Y - my], [x1 * CELL_X + mx, y0 * CELL_Y - my],
          [x1 * CELL_X + mx, y1 * CELL_Y + my], [x0 * CELL_X - mx, y1 * CELL_Y + my]].map(([x, y]) => P([x, y, Z - SLAB]));
        el("polygon", { points: pts(corners), class: "plate" }, g);
        if (levels.length > 1) {
          // Name the floor at its corner nearest the viewer's left.
          const c = corners.reduce((best, q) => (q[1] - q[0] * 0.3 > best[1] - best[0] * 0.3 ? q : best));
          const t = el("text", { x: c[0] + 6, y: c[1] - 6, class: "plate-label" }, g);
          t.textContent = levelName(z - hereZ);
        }

        for (const [a, d, b] of flat.get(z) || []) this._edge(g, a, d, b);
        for (const r of list) this._flatStubs(g, r, r.id === data.here);

        const order = list.map((r) => [r, P(this._world(r.id))[2]]).sort((p, q) => p[1] - q[1]);
        for (const [r] of order) this._room(g, r, r.id === data.here);
        for (const r of list) this._vertStubs(g, r, 1, r.id === data.here);

        const gb = el("g", { class: "between" }, this.layer);
        for (const [a, d, b] of between.get(z) || []) this._edge(gb, a, d, b);
      }
    }

    _edge(parent, a, d, b) {
      const pa = this.pos.get(a), pb = this.pos.get(b);
      const [x1, y1] = this._project(this._world(a)), [x2, y2] = this._project(this._world(b));
      el("line", { x1, y1, x2, y2, class: d ? "edge" : "edge unknown" }, parent);
      // Label it when the drawing can't say which way it goes.
      let bent;
      if (VEC[d]) bent = Math.sign(pb.x - pa.x) !== VEC[d][0] || Math.sign(pb.y - pa.y) !== VEC[d][1] || pa.z !== pb.z;
      else if (VERTICAL[d]) bent = pa.x !== pb.x || pa.y !== pb.y || Math.sign(pb.z - pa.z) !== VERTICAL[d];
      else bent = !!d;
      if (bent) {
        const t = el("text", { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 4, class: "edge-label" }, parent);
        t.textContent = LABEL[d] || NAMES[d] || d;
      }
    }

    _flatStubs(parent, r, here) {
      const [X, Y, Z] = this._world(r.id);
      const extra = [];
      for (const x of r.exits) {
        if (x.known) continue;
        const cls = "stub" + (here ? " here" : "") + (x.door ? " door" : "");
        if (VEC[x.dir]) {
          const [dx, dy] = VEC[x.dir];
          const sx = X + dx * BOX_W / 2, sy = Y + dy * BOX_H / 2;
          const [ax, ay] = this._project([sx, sy, Z]), [bx, by] = this._project([sx + dx * STUB, sy + dy * STUB, Z]);
          el("line", { x1: ax, y1: ay, x2: bx, y2: by, class: cls }, parent);
          el("circle", { cx: bx, cy: by, r: 3, class: cls + " end" }, parent);
        } else if (!VERTICAL[x.dir]) {
          extra.push(LABEL[x.dir] || x.dir);
        }
      }
      if (extra.length) {
        const [tx, ty] = this._project([X, Y + BOX_H / 2, Z]);
        const t = el("text", { x: tx, y: ty + 13, class: "extra" + (here ? " here" : "") }, parent);
        t.textContent = extra.join(" · ");
      }
    }

    _vertStubs(parent, r, sign, here) {
      const [X, Y, Z] = this._world(r.id);
      for (const x of r.exits) {
        if (x.known || VERTICAL[x.dir] !== sign) continue;
        const cls = "stub" + (here ? " here" : "") + (x.door ? " door" : "");
        const z0 = sign > 0 ? Z : Z - SLAB;
        const [ax, ay] = this._project([X, Y, z0]), [bx, by] = this._project([X, Y, z0 + sign * RISE]);
        el("line", { x1: ax, y1: ay, x2: bx, y2: by, class: cls + " vertical" }, parent);
        el("circle", { cx: bx, cy: by, r: 3, class: cls + " end" }, parent);
      }
    }

    _room(parent, r, here) {
      const [X, Y, Z] = this._world(r.id);
      const top = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) =>
        this._project([X + sx * BOX_W / 2, Y + sy * BOX_H / 2, Z]));
      const bottom = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) =>
        this._project([X + sx * BOX_W / 2, Y + sy * BOX_H / 2, Z - SLAB]));
      const g = el("g", { class: "room" + (here ? " here" : "") + (r.name ? "" : " dark") }, parent);
      el("polygon", { points: pts(hull(top.concat(bottom))), class: "side" }, g);
      el("polygon", { points: pts(top), class: "top" }, g);
      const [cx, cy] = this._project([X, Y, Z]);
      const lines = wrap(r.name);
      lines.forEach((line, i) => {
        const t = el("text", { x: cx, y: cy + 4 + (i - (lines.length - 1) / 2) * 14 }, g);
        t.textContent = line;
      });
      el("title", {}, g).textContent = r.name || "An unknown room";
    }

    _drawCompass() {
      // The compass lies on the floor too: it turns and tilts with the map.
      const c = Math.cos(this.yaw), s = Math.sin(this.yaw), cp = Math.cos(this.pitch);
      const flat = (x, y) => [x * c - y * s, (x * s + y * c) * cp];
      const shape = (list) => pts(list.map(([x, y]) => flat(x, y)));
      const svg = this.compass;
      svg.replaceChildren(svg.firstChild);   // keep the <title>
      el("ellipse", { rx: 27, ry: Math.max(27 * cp, 6), class: "ring" }, svg);
      el("polygon", { points: shape([[0, -13], [4, 0], [0, -2], [-4, 0]]), class: "needle-n" }, svg);
      el("polygon", { points: shape([[0, 13], [4, 0], [0, 2], [-4, 0]]), class: "needle-s" }, svg);
      for (const [label, x, y] of [["N", 0, -20], ["E", 20, 0], ["S", 0, 20], ["W", -20, 0]]) {
        const [px, py] = flat(x, y);
        const t = el("text", { x: px, y: py + 0.5, class: label === "N" ? "nlabel" : "" }, svg);
        t.textContent = label;
      }
    }

    // Glide the camera to the room you're in. reset turns it back to the
    // starting view, or "north" to face due north.
    center(animate, reset) {
      if (!this.data || !this.pos || !this.pos.has(this.data.here)) { this.render(); return; }
      this._fit();
      const from = { t: this.target.slice(), pan: { ...this.pan }, yaw: this.yaw, pitch: this.pitch };
      const to = { t: this._world(this.data.here), pan: { x: 0, y: 0 },
        yaw: reset === "north" ? 0 : reset ? YAW : this.yaw, pitch: reset ? PITCH : this.pitch };
      // Turn the short way round.
      if (reset) from.yaw = Math.atan2(Math.sin(from.yaw), Math.cos(from.yaw));
      cancelAnimationFrame(this.anim);
      const go = (e) => {
        this.target = from.t.map((v, i) => v + (to.t[i] - v) * e);
        this.pan = { x: from.pan.x + (to.pan.x - from.pan.x) * e, y: from.pan.y + (to.pan.y - from.pan.y) * e };
        this.yaw = from.yaw + (to.yaw - from.yaw) * e;
        this.pitch = from.pitch + (to.pitch - from.pitch) * e;
        this._draw();
      };
      if (!animate || matchMedia("(prefers-reduced-motion: reduce)").matches) { go(1); return; }
      const t0 = performance.now(), dur = reset ? 450 : 320;
      const step = (t) => {
        const k = Math.min(1, (t - t0) / dur);
        go(1 - Math.pow(1 - k, 3));
        if (k < 1) this.anim = requestAnimationFrame(step);
      };
      this.anim = requestAnimationFrame(step);
    }

    zoomBy(f) {
      this.zoom = Math.max(0.3, Math.min(2.5, this.zoom * f));
      this.render();
    }

    turn(dyaw, dpitch) {
      cancelAnimationFrame(this.anim);
      this.yaw += dyaw;
      this.pitch = Math.max(0, Math.min(MAX_PITCH, this.pitch + dpitch));
      this.render();
    }

    // One finger or the left button turns and tilts; two fingers, the right
    // button or Shift+drag slides the map; pinching or the wheel zooms.
    _input() {
      const svg = this.svg, down = new Map();
      let mode = null, last = null;
      const mid = () => {
        const p = [...down.values()];
        const x = p.reduce((s, q) => s + q.x, 0) / p.length, y = p.reduce((s, q) => s + q.y, 0) / p.length;
        const d = p.length > 1 ? Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) : 0;
        return { x, y, d };
      };
      svg.addEventListener("pointerdown", (e) => {
        down.set(e.pointerId, { x: e.clientX, y: e.clientY });
        svg.setPointerCapture(e.pointerId);
        mode = down.size > 1 || e.button === 2 || e.shiftKey ? "pan" : "turn";
        last = mid();
        svg.classList.add("grabbing");
      });
      svg.addEventListener("pointermove", (e) => {
        if (!down.has(e.pointerId)) return;
        down.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const m = mid(), dx = m.x - last.x, dy = m.y - last.y;
        if (mode === "turn") {
          this.turn(dx * 0.008, -dy * 0.006);
        } else {
          cancelAnimationFrame(this.anim);
          this.pan.x += dx / this.zoom;
          this.pan.y += dy / this.zoom;
          if (m.d && last.d) this.zoom = Math.max(0.3, Math.min(2.5, this.zoom * m.d / last.d));
          this.render();
        }
        last = m;
      });
      const up = (e) => {
        down.delete(e.pointerId);
        if (down.size) { last = mid(); return; }
        mode = null;
        svg.classList.remove("grabbing");
      };
      svg.addEventListener("pointerup", up);
      svg.addEventListener("pointercancel", up);
      svg.addEventListener("contextmenu", (e) => e.preventDefault());
      svg.addEventListener("wheel", (e) => {
        e.preventDefault();
        this.zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
      }, { passive: false });
      svg.addEventListener("keydown", (e) => {
        const k = { ArrowLeft: [0.15, 0], ArrowRight: [-0.15, 0], ArrowUp: [0, 0.1], ArrowDown: [0, -0.1] }[e.key];
        if (!k) return;
        e.preventDefault();
        this.turn(k[0], k[1]);
      });
      const north = () => this.center(true, "north");
      this.compass.addEventListener("click", north);
      this.compass.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); north(); }
      });
    }
  }

  return { View, layout };
})();
