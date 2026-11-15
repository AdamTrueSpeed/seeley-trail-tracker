// A small north-up map drawn on a canvas. No map tiles, so it works with no
// signal: it shows lines (existing trails, saved rides, the merged network,
// the ride in progress), pins and the rider's position on a black background.

import { makeProjection, clamp } from './geo.js';

const LIVE_COLOR = '#ff7a00';
const NICE = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];

export class MapView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.proj = null;
    this.cx = 0;            // world metres at the centre of the view
    this.cy = 0;
    this.scale = 1.2;       // CSS pixels per metre
    this.follow = true;     // keep the rider centred
    this.layers = new Map();
    this.labels = [];
    this.pins = [];
    this.live = [];
    this.pos = null;
    this.onFollowChange = null;
    this._queued = false;
    this._pointers = new Map();
    this._bind();
    new ResizeObserver(() => this._resize()).observe(canvas);
    this._resize();
  }

  // ---- data ------------------------------------------------------------------

  _xy(lat, lon) {
    this.proj ??= makeProjection(lat, lon);
    return [this.proj.x(lon), this.proj.y(lat)];
  }

  /** lines: [{ pts: [[lat, lon]] or [{lat, lon}], color, width, dash, alpha, label }] */
  setLayer(name, lines) {
    this.layers.set(name, lines.map((l) => {
      const n = l.pts.length;
      const x = new Float64Array(n), y = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const p = l.pts[i];
        [x[i], y[i]] = Array.isArray(p) ? this._xy(p[0], p[1]) : this._xy(p.lat, p.lon);
      }
      return { ...l, pts: null, x, y };
    }));
    this.redraw();
  }

  setLabels(points) {
    this.labels = points.map((p) => ({ name: p.name, xy: this._xy(p.lat, p.lon) }));
    this.redraw();
  }

  setPins(pins) {
    this.pins = pins.map((p) => ({ name: p.name, photo: !!p.photo, xy: this._xy(p.lat, p.lon) }));
    this.redraw();
  }

  /** Other people sharing their position: [{ name, lat, lon, friend, avatar (data URL or null), at (ms it was heard) }] */
  setPeople(people) {
    this.pictures ??= new Map(); // data URL -> Image, so each picture is decoded once
    this.people = people.map((p) => {
      let picture = null;
      if (p.avatar) {
        picture = this.pictures.get(p.avatar);
        if (!picture) {
          picture = new Image();
          picture.onload = () => this.redraw();
          picture.src = p.avatar;
          this.pictures.set(p.avatar, picture);
        }
      }
      return { name: p.name, friend: p.friend, at: p.at, picture, xy: this._xy(p.lat, p.lon) };
    });
    this.redraw();
  }

  clearLive() {
    this.live = [];
    this.redraw();
  }

  addLive(lat, lon, newSeg) {
    const [x, y] = this._xy(lat, lon);
    if (newSeg || !this.live.length) this.live.push({ x: [], y: [] });
    const seg = this.live[this.live.length - 1];
    seg.x.push(x);
    seg.y.push(y);
    this.redraw();
  }

  /** acc in metres; hdg in degrees from north or null; ok = the fix passed the filters. */
  setPosition(lat, lon, acc, hdg, ok) {
    const first = !this.pos;
    const [x, y] = this._xy(lat, lon);
    this.pos = { x, y, acc, hdg, ok };
    if (this.follow || (first && !this._hasLines())) { this.cx = x; this.cy = y; }
    this.redraw();
  }

  _hasLines() {
    for (const lines of this.layers.values()) if (lines.length) return true;
    return this.live.length > 0;
  }

  // ---- view -------------------------------------------------------------------

  setFollow(on) {
    if (this.follow === on) return;
    this.follow = on;
    this.onFollowChange?.(on);
  }

  /** Centre on the rider and keep following. */
  center() {
    this.setFollow(true);
    if (this.pos) {
      this.cx = this.pos.x;
      this.cy = this.pos.y;
      if (this.scale < 0.6) this.scale = 1.2;
    }
    this.redraw();
  }

  zoom(factor, px, py) {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    px ??= w / 2;
    py ??= h / 2;
    const wx = this.cx + (px - w / 2) / this.scale, wy = this.cy - (py - h / 2) / this.scale;
    this.scale = clamp(this.scale * factor, 0.01, 30);
    if (!this.follow) {
      this.cx = wx - (px - w / 2) / this.scale;
      this.cy = wy + (py - h / 2) / this.scale;
    }
    this.redraw();
  }

  /** Show everything in the named layers (all layers if none given), plus the ride in progress. */
  fit(names) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (x, y) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); };
    for (const [name, lines] of this.layers) {
      if (names && !names.includes(name)) continue;
      for (const l of lines) for (let i = 0; i < l.x.length; i++) add(l.x[i], l.y[i]);
    }
    for (const s of this.live) for (let i = 0; i < s.x.length; i++) add(s.x[i], s.y[i]);
    for (const p of this.pins) add(p.xy[0], p.xy[1]);
    if (x0 === Infinity) {
      if (this.pos) this.center();
      return false;
    }
    const w = this.canvas.clientWidth || 300, h = this.canvas.clientHeight || 300;
    this.setFollow(false);
    this.cx = (x0 + x1) / 2;
    this.cy = (y0 + y1) / 2;
    this.scale = clamp(Math.min(w / ((x1 - x0) * 1.15 + 20), h / ((y1 - y0) * 1.15 + 20)), 0.01, 30);
    this.redraw();
    return true;
  }

  // ---- input ------------------------------------------------------------------

  _bind() {
    const c = this.canvas;
    const at = (e) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this._pointers.set(e.pointerId, at(e));
    });
    c.addEventListener('pointermove', (e) => {
      const prev = this._pointers.get(e.pointerId);
      if (!prev) return;
      const now = at(e);
      if (this._pointers.size === 1) {
        if (Math.abs(now.x - prev.x) + Math.abs(now.y - prev.y) < 1) return;
        this.setFollow(false);
        this.cx -= (now.x - prev.x) / this.scale;
        this.cy += (now.y - prev.y) / this.scale;
      } else if (this._pointers.size === 2) {
        const other = [...this._pointers].find(([id]) => id !== e.pointerId)[1];
        const before = Math.hypot(prev.x - other.x, prev.y - other.y);
        const after = Math.hypot(now.x - other.x, now.y - other.y);
        if (before > 0) this.zoom(after / before, (now.x + other.x) / 2, (now.y + other.y) / 2);
      }
      this._pointers.set(e.pointerId, now);
      this.redraw();
    });
    const up = (e) => this._pointers.delete(e.pointerId);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = at(e);
      this.zoom(e.deltaY < 0 ? 1.2 : 1 / 1.2, p.x, p.y);
    }, { passive: false });
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(this.canvas.clientWidth * dpr), h = Math.round(this.canvas.clientHeight * dpr);
    if (!w || !h) return;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.redraw();
  }

  // ---- drawing ----------------------------------------------------------------

  redraw() {
    if (this._queued) return;
    this._queued = true;
    requestAnimationFrame(() => {
      this._queued = false;
      this._draw();
    });
  }

  _draw() {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    if (!W || !H) return;
    const dpr = W / (canvas.clientWidth || W);
    const s = this.scale * dpr;
    const ox = W / 2 - this.cx * s, oy = H / 2 + this.cy * s;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const trace = (x, y) => {
      ctx.beginPath();
      for (let i = 0; i < x.length; i++) {
        if (i) ctx.lineTo(ox + x[i] * s, oy - y[i] * s); else ctx.moveTo(ox + x[i] * s, oy - y[i] * s);
      }
    };
    const text = (str, px, py, size, color, align = 'center') => {
      ctx.font = `600 ${size * dpr}px system-ui, sans-serif`;
      ctx.textAlign = align;
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 4 * dpr;
      ctx.strokeStyle = '#000';
      ctx.setLineDash([]);
      ctx.strokeText(str, px, py);
      ctx.fillStyle = color;
      ctx.fillText(str, px, py);
    };

    const named = [];
    for (const lines of this.layers.values()) {
      for (const l of lines) {
        if (l.x.length < 2) continue;
        trace(l.x, l.y);
        ctx.globalAlpha = l.alpha ?? 1;
        ctx.setLineDash((l.dash ?? []).map((d) => d * dpr));
        if (l.outline) {
          ctx.strokeStyle = '#000';
          ctx.lineWidth = ((l.width ?? 2) + 3) * dpr;
          ctx.stroke();
        }
        ctx.strokeStyle = l.color ?? '#fff';
        ctx.lineWidth = (l.width ?? 2) * dpr;
        ctx.stroke();
        if (l.label) named.push(l);
      }
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);

    for (const seg of this.live) {
      if (seg.x.length === 1) {
        ctx.fillStyle = LIVE_COLOR;
        ctx.beginPath();
        ctx.arc(ox + seg.x[0] * s, oy - seg.y[0] * s, 2.5 * dpr, 0, 7);
        ctx.fill();
        continue;
      }
      trace(seg.x, seg.y);
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 8 * dpr;
      ctx.stroke();
      ctx.strokeStyle = LIVE_COLOR;
      ctx.lineWidth = 4.5 * dpr;
      ctx.stroke();
    }

    if (this.scale > 0.3) {
      for (const l of named) {
        const m = l.x.length >> 1;
        text(l.label, ox + l.x[m] * s, oy - l.y[m] * s, 12, l.color ?? '#fff');
      }
      for (const p of this.labels) text(p.name, ox + p.xy[0] * s, oy - p.xy[1] * s, 12, '#cfd8e3');
    }

    for (const p of this.pins) {
      // A plain pin is a yellow diamond; a photo is a cyan square with a lens dot.
      const px = ox + p.xy[0] * s, py = oy - p.xy[1] * s, r = 7 * dpr;
      const color = p.photo ? '#18ffff' : '#ffee00';
      ctx.beginPath();
      if (p.photo) ctx.rect(px - r, py - r * 0.8, r * 2, r * 1.6);
      else { ctx.moveTo(px, py - r); ctx.lineTo(px + r, py); ctx.lineTo(px, py + r); ctx.lineTo(px - r, py); ctx.closePath(); }
      ctx.fillStyle = color;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2 * dpr;
      ctx.fill();
      ctx.stroke();
      if (p.photo) {
        ctx.beginPath();
        ctx.arc(px, py, r * 0.42, 0, 7);
        ctx.fillStyle = '#000';
        ctx.fill();
      }
      if (this.scale > 0.3) text(p.name, px + 11 * dpr, py, 13, color, 'left');
    }

    // Other people: magenta ring for a friend, white for anyone else; their picture
    // if they have one, otherwise their initial. Fades once the news is getting old.
    for (const p of this.people ?? []) {
      const px = ox + p.xy[0] * s, py = oy - p.xy[1] * s, r = 13 * dpr;
      const color = p.friend ? '#ff2bd6' : '#ffffff';
      ctx.globalAlpha = Date.now() - p.at > 45000 ? 0.45 : 1;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, 7);
      ctx.fillStyle = '#000';
      ctx.fill();
      if (p.picture?.complete && p.picture.naturalWidth) {
        ctx.save();
        ctx.clip();
        ctx.drawImage(p.picture, px - r, py - r, r * 2, r * 2);
        ctx.restore();
      } else {
        text((p.name[0] ?? '?').toUpperCase(), px, py + dpr, 15, color);
      }
      ctx.beginPath();
      ctx.arc(px, py, r, 0, 7);
      ctx.strokeStyle = color;
      ctx.lineWidth = 3 * dpr;
      ctx.stroke();
      text(p.name, px + r + 5 * dpr, py, 13, color, 'left');
      ctx.globalAlpha = 1;
    }

    if (this.pos) {
      const px = ox + this.pos.x * s, py = oy - this.pos.y * s;
      const color = this.pos.ok ? '#18ffff' : '#ff5252';
      ctx.beginPath();
      ctx.arc(px, py, Math.max(this.pos.acc * s, 10 * dpr), 0, 7);
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 0.6;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5 * dpr;
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (this.pos.hdg != null) {
        const a = (this.pos.hdg * Math.PI) / 180;
        const tip = 24 * dpr, base = 9 * dpr;
        ctx.beginPath();
        ctx.moveTo(px + Math.sin(a) * tip, py - Math.cos(a) * tip);
        ctx.lineTo(px + Math.sin(a + 2.2) * base, py - Math.cos(a + 2.2) * base);
        ctx.lineTo(px + Math.sin(a - 2.2) * base, py - Math.cos(a - 2.2) * base);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(px, py, 8 * dpr, 0, 7);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 3 * dpr;
      ctx.stroke();
    }

    // Scale bar and north marker.
    const metres = NICE.find((m) => m * this.scale >= 60) ?? NICE[NICE.length - 1];
    const bar = metres * s, bx = 14 * dpr, by = H - 16 * dpr;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(bx, by - 6 * dpr); ctx.lineTo(bx, by); ctx.lineTo(bx + bar, by); ctx.lineTo(bx + bar, by - 6 * dpr);
    ctx.stroke();
    text(metres >= 1000 ? `${metres / 1000} km` : `${metres} m`, bx + bar / 2, by - 13 * dpr, 13, '#fff');
    text('N', 22 * dpr, 20 * dpr, 14, '#fff');
    ctx.beginPath();
    ctx.moveTo(22 * dpr, 32 * dpr); ctx.lineTo(22 * dpr, 48 * dpr);
    ctx.moveTo(17 * dpr, 37 * dpr); ctx.lineTo(22 * dpr, 31 * dpr); ctx.lineTo(27 * dpr, 37 * dpr);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2 * dpr;
    ctx.stroke();
  }
}
