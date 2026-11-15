// Live position sharing between phones.
//
// Nothing in this file runs in Private mode (the default). In the other two
// modes the phone connects to public relay services on the internet and:
//
//   - publishes its position, scrambled (AES-GCM) with a key made from the
//     user's own friend code, so only people holding that code can read it;
//   - in "Everyone nearby" mode, also publishes it on a channel for the local
//     area, which anybody using the app in that area can read;
//   - listens for its friends (by their codes) and for the local-area channel.
//
// The relays only ever see sealed packets and channel names that cannot be
// traced back to a code. They are free public MQTT brokers with no promise of
// staying up, so two are used at once and either one working is enough.

export const RELAYS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];

const NS = 'stt1';             // prefix of every channel; change it and old versions no longer see new ones
const CELL = 0.05;             // degrees: the "local area" is a grid square of roughly 5 km
const SEND_EVERY = 8000;       // ms between position updates
const PROFILE_EVERY = 60000;   // ms between sending the (bulkier) name-and-picture card
export const STALE_AFTER = 180000; // ms without news before a person is dropped

// ---- friend codes ------------------------------------------------------------

// No 0/O, 1/I/L or U, so a code survives being read out or typed with gloves on.
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

/** A new random friend code, 12 characters (about 59 bits). */
export function newCode() {
  let code = '';
  while (code.length < 12) {
    for (const b of crypto.getRandomValues(new Uint8Array(24))) {
      if (b < 240 && code.length < 12) code += ALPHABET[b % 30]; // 240 = 8 x 30, so no letter is favoured
    }
  }
  return code;
}

/** Tidy up a typed or pasted code. Returns the bare 12 characters, or null if it is not a code. */
export function cleanCode(text) {
  const s = String(text ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === 12 && [...s].every((c) => ALPHABET.includes(c)) ? s : null;
}

/** ABCD-EFGH-JKMN, for showing and sharing. */
export const formatCode = (code) => code.replace(/(.{4})(?=.)/g, '$1-');

// ---- sealing -----------------------------------------------------------------

const enc = new TextEncoder(), dec = new TextDecoder();
const sha = async (text) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * The channel for a person (kind 'u', secret = their friend code) or an area
 * (kind 'a', secret = the grid square). Both the channel name and the key come
 * from the secret through one-way hashes.
 */
export async function channel(kind, secret) {
  const topic = `${NS}/${kind}/${hex(await sha(`${NS} topic ${kind} ${secret}`)).slice(0, 32)}`;
  const key = await crypto.subtle.importKey('raw', await sha(`${NS} key ${kind} ${secret}`), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { topic, key };
}

export async function seal(key, message) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(message))));
  const out = new Uint8Array(12 + body.length);
  out.set(iv);
  out.set(body, 12);
  return out;
}

/** The message, or null if it was not sealed with this key (or has been tampered with). */
export async function unseal(key, bytes) {
  try {
    return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12))));
  } catch {
    return null;
  }
}

// ---- one relay connection (just enough MQTT 3.1.1 over a WebSocket) ----------------

const str = (s) => { const b = enc.encode(s); return [b.length >> 8, b.length & 255, ...b]; };
function packet(first, body) {
  const len = [];
  let n = body.length;
  do {
    let d = n % 128;
    n = Math.floor(n / 128);
    if (n) d |= 128;
    len.push(d);
  } while (n);
  return new Uint8Array([first, ...len, ...body]);
}

export class Relay {
  constructor(url, onPacket, onChange) {
    this.url = url;
    this.onPacket = onPacket;   // (topic, payload bytes)
    this.onChange = onChange;   // connection went up or down
    this.topics = new Set();
    this.ws = null;
    this.up = false;
    this.wanted = false;
    this.tries = 0;
    this.pending = new Uint8Array(0);
    this.nextId = 1;
  }

  open() {
    this.wanted = true;
    this._connect();
  }

  close() {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        if (this.up) ws.send(new Uint8Array([0xe0, 0])); // DISCONNECT
        ws.close();
      } catch { /* already gone */ }
    }
    this._set(false);
  }

  _set(up) {
    if (this.up === up) return;
    this.up = up;
    this.onChange();
  }

  _connect() {
    if (!this.wanted || this.ws) return;
    let ws;
    try {
      ws = new WebSocket(this.url, 'mqtt');
    } catch {
      this._retry();
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    this.pending = new Uint8Array(0);
    const client = `stt${hex(crypto.getRandomValues(new Uint8Array(8)))}`;
    ws.onopen = () => ws.send(packet(0x10, [...str('MQTT'), 4, 2, 0, 60, ...str(client)])); // CONNECT, clean session, 60 s keep-alive
    ws.onmessage = (e) => this._feed(new Uint8Array(e.data));
    ws.onclose = ws.onerror = () => {
      if (this.ws !== ws) return; // closed on purpose, or already handled
      this.ws = null;
      clearInterval(this.pingTimer);
      this._set(false);
      this._retry();
    };
  }

  _retry() {
    if (!this.wanted) return;
    this.tries = Math.min(this.tries + 1, 6);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this._connect(), 1000 * 2 ** this.tries);
  }

  /** Packets can arrive split across, or bundled into, WebSocket frames. */
  _feed(chunk) {
    const buf = new Uint8Array(this.pending.length + chunk.length);
    buf.set(this.pending);
    buf.set(chunk, this.pending.length);
    let at = 0;
    while (buf.length - at >= 2) {
      let len = 0, mult = 1, i = at + 1, complete = false;
      for (; i < buf.length && i < at + 5; i++) {
        len += (buf[i] & 127) * mult;
        mult *= 128;
        if (!(buf[i] & 128)) { complete = true; i++; break; }
      }
      if (!complete || buf.length - i < len) break;
      this._handle(buf[at], buf.subarray(i, i + len));
      at = i + len;
    }
    this.pending = buf.slice(at);
  }

  _handle(first, body) {
    const type = first >> 4;
    if (type === 2) { // CONNACK
      if (body[1] !== 0) { this.ws?.close(); return; }
      this.tries = 0;
      this._set(true);
      for (const t of this.topics) this._subscribe(t);
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this._send(new Uint8Array([0xc0, 0])), 30000);
    } else if (type === 3) { // PUBLISH
      const n = (body[0] << 8) | body[1];
      const qos = (first >> 1) & 3;
      this.onPacket(dec.decode(body.subarray(2, 2 + n)), body.slice(2 + n + (qos ? 2 : 0)));
    }
  }

  _send(bytes) {
    if (this.up && this.ws?.readyState === 1) this.ws.send(bytes);
  }

  _id() {
    this.nextId = (this.nextId % 65000) + 1;
    return [this.nextId >> 8, this.nextId & 255];
  }

  _subscribe(topic) {
    this._send(packet(0x82, [...this._id(), ...str(topic), 0]));
  }

  /** Listen on exactly this set of channels. */
  listen(topics) {
    for (const t of topics) {
      if (this.topics.has(t)) continue;
      this.topics.add(t);
      this._subscribe(t);
    }
    for (const t of [...this.topics]) {
      if (topics.has(t)) continue;
      this.topics.delete(t);
      this._send(packet(0xa2, [...this._id(), ...str(t)]));
    }
  }

  publish(topic, payload) {
    this._send(packet(0x30, [...str(topic), ...payload]));
  }
}

// ---- the sharing itself ---------------------------------------------------------------

const cellOf = (lat, lon) => [Math.floor(lat / CELL), Math.floor(lon / CELL)];
const round = (v, places) => Math.round(v * 10 ** places) / 10 ** places;

export class LiveShare {
  /**
   * @param onChange  called whenever the list of people or the connection changes
   * @param relays    relay addresses (tests pass their own)
   */
  constructor({ onChange, relays = RELAYS }) {
    this.onChange = onChange;
    this.relays = relays.map((url) => new Relay(url, (t, p) => this._receive(t, p), () => this.onChange()));
    this.mode = 'private';
    this.me = null;            // { id, name, code, avatar }
    this.friends = [];         // [{ code }]
    this.people = new Map();   // id -> { id, name, lat, lon, acc, t, at, friend, code, method, rec, avatar }
    this.channels = new Map(); // channel name -> { key, friend, code (the friend code it belongs to) }
    this.mine = null;          // my own channel
    this.area = null;          // the channel of the grid square I am in
    this.cell = null;
    this.paused = false;
    this.lastSent = 0;
    this.lastProfile = 0;
  }

  get connected() {
    return this.relays.some((r) => r.up);
  }

  /** mode: 'private' | 'friends' | 'everyone'. */
  async configure({ mode, me, friends }) {
    const before = this.mode;
    if (mode === 'private') {
      if (before !== 'private') await this._goodbye(before);
      this.mode = 'private';
      for (const r of this.relays) r.close();
      this.people.clear();
      this.channels.clear();
      this.mine = this.area = this.cell = null;
      this.onChange();
      return;
    }
    // Stepping down from "everyone" to "friends": leave the area channel properly.
    if (before === 'everyone' && mode === 'friends') await this._goodbye('everyone', true);
    this.mode = mode;
    this.me = me;
    this.friends = friends;
    this.mine = await channel('u', me.code);
    await this._retune();
    if (!this.paused) for (const r of this.relays) r.open();
    this.lastSent = this.lastProfile = 0; // send straight away with the new settings
    this.onChange();
  }

  /** App went to the background: stop sending and listening until resume(). */
  async pause() {
    if (this.paused) return;
    this.paused = true;
    if (this.mode === 'private') return;
    await this._goodbye(this.mode);
    for (const r of this.relays) r.close();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    if (this.mode === 'private') return;
    for (const r of this.relays) r.open();
    this.lastSent = this.lastProfile = 0;
  }

  /** Work out which channels to listen on: every friend, plus the grid squares around me. */
  async _retune() {
    const channels = new Map();
    for (const f of this.friends) {
      const c = await channel('u', f.code);
      channels.set(c.topic, { key: c.key, friend: true, code: f.code });
    }
    if (this.cell) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const c = await channel('a', `${this.cell[0] + dx}_${this.cell[1] + dy}`);
          channels.set(c.topic, { key: c.key, friend: false });
        }
      }
    }
    this.channels = channels;
    const topics = new Set(channels.keys());
    for (const r of this.relays) r.listen(topics);
  }

  /**
   * Call with every usable GPS fix. Sends an update every few seconds at most.
   * @param extra { method, rec } shown to the people watching
   */
  async update(fix, extra = {}) {
    if (this.mode === 'private' || this.paused || !this.mine) return;
    const [cx, cy] = cellOf(fix.lat, fix.lon);
    if (!this.cell || this.cell[0] !== cx || this.cell[1] !== cy) {
      this.cell = [cx, cy];
      this.area = await channel('a', `${cx}_${cy}`);
      await this._retune();
    }
    const now = Date.now();
    if (now - this.lastSent < SEND_EVERY || !this.connected) return;
    this.lastSent = now;
    await this._send({ id: this.me.id, name: this.me.name, lat: round(fix.lat, 6), lon: round(fix.lon, 6), acc: Math.round(fix.acc), t: now, ...extra });
    if (this.me.avatar && now - this.lastProfile > PROFILE_EVERY) {
      this.lastProfile = now;
      await this._send({ id: this.me.id, name: this.me.name, avatar: this.me.avatar, t: now });
    }
  }

  async _send(message, mode = this.mode, areaOnly = false) {
    const targets = [];
    if (!areaOnly && this.mine) targets.push(this.mine);
    if (mode === 'everyone' && this.area) targets.push(this.area);
    for (const c of targets) {
      const payload = await seal(c.key, message);
      for (const r of this.relays) r.publish(c.topic, payload);
    }
  }

  /** Tell the people watching that I have stopped sharing, so my marker goes at once. */
  async _goodbye(mode, areaOnly = false) {
    if (!this.me || !this.connected) return;
    try { await this._send({ id: this.me.id, gone: true, t: Date.now() }, mode, areaOnly); } catch { /* best effort */ }
  }

  async _receive(topic, payload) {
    const c = this.channels.get(topic);
    if (!c) return;
    const m = await unseal(c.key, payload);
    if (!m || typeof m.id !== 'string' || m.id.length > 40 || m.id === this.me?.id) return;
    const known = this.people.get(m.id);
    if (m.gone) {
      // Leaving the area channel does not remove a friend who is still sharing with friends.
      if (known && (c.friend || !known.friend) && this.people.delete(m.id)) this.onChange();
      return;
    }
    const name = typeof m.name === 'string' ? m.name.slice(0, 40) : 'Someone';
    if (typeof m.avatar === 'string') { // the name-and-picture card
      if (!known || !m.avatar.startsWith('data:image/') || m.avatar.length > 24000) return;
      known.avatar = m.avatar;
      known.name = name;
      this.onChange();
      return;
    }
    if (!Number.isFinite(m.lat) || !Number.isFinite(m.lon) || Math.abs(m.lat) > 90 || Math.abs(m.lon) > 180 || !Number.isFinite(m.t)) return;
    if (known && m.t <= known.t) {
      // The same update also comes through the second relay and, for a friend, through both channels.
      if (m.t === known.t && c.friend && !known.friend) { known.friend = true; known.code = c.code; this.onChange(); }
      return;
    }
    if (!known) this.lastProfile = 0; // someone new has appeared: send my name-and-picture card again soon
    this.people.set(m.id, {
      id: m.id, name, lat: m.lat, lon: m.lon, acc: Number.isFinite(m.acc) ? m.acc : null, t: m.t, at: Date.now(),
      friend: c.friend || !!known?.friend, code: c.code ?? known?.code ?? null, avatar: known?.avatar ?? null,
      method: typeof m.method === 'string' ? m.method.slice(0, 30) : null, rec: !!m.rec,
    });
    this.onChange();
  }

  /** Everyone heard from recently, friends first. Drops anyone who has gone quiet. */
  list() {
    const now = Date.now();
    for (const [id, p] of this.people) if (now - p.at > STALE_AFTER) this.people.delete(id);
    return [...this.people.values()].sort((a, b) => b.friend - a.friend || a.name.localeCompare(b.name));
  }
}
