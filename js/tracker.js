// GPS watching, filtering and recording.
//
// Every fix from the phone goes through three gates before it becomes part of
// a ride: accuracy (drop vague fixes), jump (drop a fix that would need an
// impossible speed to reach) and stationary (don't pile up points while the
// rider is stopped).

import { haversine } from './geo.js';

const MAX_SPEED = 30;        // m/s (108 km/h): nothing on a trail goes faster
const STILL_SPEED = 0.5;     // m/s: below this the rider counts as stopped
const STILL_AFTER = 4000;    // ms of being stopped before auto-pause
const GAP_TIME = 20;         // s without a usable fix ...
const GAP_DIST = 30;         // ... and this far away: start a new line, don't draw across the gap

export class Tracker {
  /**
   * @param cfg  () => ({ maxAcc, minDist, autoPause })
   * @param on   { fix(fix, verdict), point(point), status() }
   * @param geo  geolocation provider (navigator.geolocation, or a simulator)
   */
  constructor(cfg, on, geo = navigator.geolocation) {
    this.cfg = cfg;
    this.on = on;
    this.geo = geo;
    this.watchId = null;
    this.state = 'idle';       // idle | recording | paused
    this.autoPaused = false;
    this.error = null;         // 'denied' | 'unavailable' | null
    this.lastFix = null;       // most recent fix of any quality
    this.good = null;          // most recent fix that passed the accuracy and jump gates
    this.rejected = { acc: 0, jump: 0 };
    this.pace = 0;             // smoothed recent speed, m/s
    this.jumps = 0;            // jump rejections in a row
    this.isStill = false;
    this._resetRide();
  }

  _resetRide() {
    this.lastRec = null;
    this.seg = 0;
    this.dist = 0;
    this.count = 0;
    this.gap = false;
    this.autoPaused = false;
    this.stillSince = null;
    this.anchor = null;
  }

  /** Start listening to GPS (no recording yet). Safe to call repeatedly. */
  watch() {
    if (this.watchId != null || !this.geo) return;
    this.watchId = this.geo.watchPosition(
      (pos) => this._onPosition(pos),
      (err) => {
        this.error = err.code === 1 ? 'denied' : 'unavailable';
        this.on.status();
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
    );
  }

  unwatch() {
    if (this.watchId == null) return;
    this.geo.clearWatch(this.watchId);
    this.watchId = null;
  }

  /** Begin a ride, or continue one (pass its totals so far). */
  start(resume) {
    this._resetRide();
    if (resume) {
      this.seg = resume.seg + 1;
      this.dist = resume.dist;
      this.count = resume.count;
    }
    this.state = 'recording';
    this.watch();
    this.on.status();
  }

  pause() {
    if (this.state !== 'recording') return;
    this.state = 'paused';
    this.autoPaused = false;
    this.on.status();
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'recording';
    this.stillSince = null;
    // Moved while paused: don't join the two places with a straight line.
    if (this.lastRec && this.good
      && haversine(this.lastRec.lat, this.lastRec.lon, this.good.lat, this.good.lon) > GAP_DIST) this.gap = true;
    this.on.status();
  }

  stop() {
    this.state = 'idle';
    this.autoPaused = false;
    this.on.status();
  }

  _onPosition(pos) {
    const c = pos.coords;
    const real = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const fix = {
      lat: c.latitude, lon: c.longitude, alt: real(c.altitude), acc: c.accuracy,
      spd: real(c.speed), hdg: real(c.heading), t: pos.timestamp, v: 0,
    };
    const cfg = this.cfg();
    this.error = null;
    this.lastFix = fix;

    let verdict = 'ok';
    if (!(fix.acc <= cfg.maxAcc)) {
      verdict = 'acc';
      this.rejected.acc++;
    } else if (this.good) {
      const dt = (fix.t - this.good.t) / 1000;
      if (dt <= 0) verdict = 'stale';
      else {
        const d = haversine(this.good.lat, this.good.lon, fix.lat, fix.lon);
        const implied = d / dt;
        // Faster than anything rideable, or a sudden leap compared with the recent pace.
        const limit = Math.min(MAX_SPEED, 3 * this.pace + 6);
        if (implied > limit && this.jumps < 4) {
          verdict = 'jump';
          this.jumps++;
          this.rejected.jump++;
        } else {
          // Several "jumps" in a row to the same area means the earlier position was the wrong one.
          if (implied > limit || (dt > GAP_TIME && d > GAP_DIST)) this.gap = true;
          this.jumps = 0;
          fix.v = fix.spd ?? implied;
          this.pace = this.pace * 0.6 + fix.v * 0.4;
        }
      }
    } else {
      this.jumps = 0;
      this.pace = fix.spd ?? 0;
      fix.v = this.pace;
    }

    if (verdict === 'ok') {
      this.good = fix;
      this._trackStillness(fix);
    }
    this.on.fix(fix, verdict);
    if (verdict === 'ok' && this.state === 'recording') this._record(fix, cfg);
  }

  /** Is the rider stopped? Uses the phone's speed if it reports one, else recent movement. */
  _trackStillness(fix) {
    this.recent = (this.recent ?? []).filter((f) => fix.t - f.t <= 5000);
    this.recent.push(fix);
    let still;
    if (fix.spd != null) still = fix.spd < STILL_SPEED;
    else {
      const first = this.recent[0];
      still = fix.t - first.t >= 3000
        && this.recent.every((f) => haversine(first.lat, first.lon, f.lat, f.lon) < Math.max(3, fix.acc * 0.4));
    }
    if (!still) this.stillSince = null;
    else if (this.stillSince == null) this.stillSince = fix.t;
    this.isStill = still;
  }

  _record(fix, cfg) {
    if (cfg.autoPause) {
      if (!this.autoPaused) {
        if (this.stillSince != null && fix.t - this.stillSince >= STILL_AFTER) {
          this.autoPaused = true;
          this.anchor = this.lastRec ?? fix;
          this.on.status();
        }
      } else {
        const away = haversine(this.anchor.lat, this.anchor.lon, fix.lat, fix.lon);
        const moving = !this.isStill && fix.v >= 1 && away > 3;
        if (moving || away > Math.max(8, fix.acc * 1.5)) {
          this.autoPaused = false;
          this.on.status();
        }
      }
      if (this.autoPaused) return;
    } else if (this.autoPaused) {
      this.autoPaused = false;
      this.on.status();
    }

    let newSeg = false;
    if (this.lastRec) {
      const d = haversine(this.lastRec.lat, this.lastRec.lon, fix.lat, fix.lon);
      if (this.gap) {
        this.seg++;
        newSeg = true;
      } else {
        if (d < cfg.minDist) return; // hasn't moved far enough to be worth a point
        this.dist += d;
      }
    } else {
      newSeg = true;
    }
    this.gap = false;
    this.lastRec = fix;
    this.count++;
    this.on.point({ seg: this.seg, lat: fix.lat, lon: fix.lon, alt: fix.alt, t: fix.t, acc: fix.acc, spd: fix.v }, newSeg);
  }
}
