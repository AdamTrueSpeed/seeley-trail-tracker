// Sending a file's worth of data from a phone to the owner's computer.
//
// There is no server. The computer listens on a channel named after a one-time
// code; the phone, given the same code (in a link), sends the data in pieces
// through the public relays share.js uses. Every piece is scrambled (AES-GCM)
// with a key made from the code, so the relays see nothing readable.
//
//   phone:    hello (how many pieces, their fingerprint) ... waits for "ready"
//   computer: ready
//   phone:    the pieces, then "end"
//   computer: "need" (the pieces that did not arrive) or "done"
//
// Both relays carry everything, so pieces usually arrive twice; anything that
// goes missing is asked for again. The fingerprint (SHA-256) is checked at the end.

import { RELAYS, Relay, channel, seal, unseal } from './share.js';

const PIECE = 6000;            // bytes of data per piece
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // as friend codes: nothing that is easily misread
const CODE_LENGTH = 26;        // about 127 bits

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const fingerprint = async (bytes) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));

function toBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** A new one-time code for a transfer. */
export function newTransferCode() {
  let code = '';
  while (code.length < CODE_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(48))) {
      if (b < 240 && code.length < CODE_LENGTH) code += ALPHABET[b % 30];
    }
  }
  return code;
}

/** Tidy up a pasted code, or pull it out of a link (…#map=CODE). Null if it is not one. */
export function cleanTransferCode(text) {
  const raw = /[#&?]map=([A-Za-z0-9-]+)/.exec(String(text ?? ''))?.[1] ?? String(text ?? '');
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === CODE_LENGTH && [...s].every((c) => ALPHABET.includes(c)) ? s : null;
}

/** Squeeze the data (gzip) where the browser can; `gz` says whether it did. */
export async function pack(bytes) {
  if (typeof CompressionStream === 'undefined') return { bytes, gz: false };
  const squeezed = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  return { bytes: new Uint8Array(squeezed), gz: true };
}

export async function unpack(bytes, gz) {
  if (!gz) return bytes;
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

/** Both ends: connect to the relays and talk on the code's channel. */
async function join(code, listenTo, onMessage, { relays, makeRelay }) {
  const ch = await channel('m', code);
  const topics = { up: `${ch.topic}/up`, down: `${ch.topic}/down` };
  const links = relays.map((url) => makeRelay(url, async (topic, payload) => {
    if (topic !== topics[listenTo]) return;
    const m = await unseal(ch.key, payload);
    if (m && typeof m.op === 'string') onMessage(m);
  }, () => {}));
  for (const r of links) {
    r.listen(new Set([topics[listenTo]]));
    r.open();
  }
  return {
    get up() { return links.some((r) => r.up); },
    /** Has every relay finished pushing out what it was given? (A slow phone connection backs up.) */
    get busy() { return links.some((r) => (r.ws?.bufferedAmount ?? 0) > 60000); },
    async say(to, message) {
      const payload = await seal(ch.key, message);
      for (const r of links) r.publish(topics[to], payload);
    },
    close() { for (const r of links) r.close(); },
  };
}

/**
 * Phone side. Sends `bytes` to whoever is listening with this code.
 * Resolves with the listener's summary of what it received. Rejects with an
 * Error whose message is 'offline' (no relay reachable), 'nobody' (nothing is
 * listening with that code) or 'failed' (it started but could not finish).
 * @param onProgress called with a number from 0 to 1
 */
export async function sendPackage(code, bytes, { relays = RELAYS, makeRelay = (...a) => new Relay(...a), onProgress = () => {}, patience = 1 } = {}) {
  const packed = await pack(bytes);
  const data = packed.bytes;
  const n = Math.max(1, Math.ceil(data.length / PIECE));
  const id = hex(crypto.getRandomValues(new Uint8Array(6)));
  const hello = { op: 'hello', id, n, size: data.length, hash: await fingerprint(data), gz: packed.gz };
  let ready = false, done = null, need = null, bad = false;
  const link = await join(code, 'down', (m) => {
    if (m.id !== id) return;
    if (m.op === 'ready') ready = true;
    else if (m.op === 'done') done = m.summary ?? {};
    else if (m.op === 'need' && Array.isArray(m.miss)) need = m.miss.filter((i) => Number.isInteger(i) && i >= 0 && i < n);
    else if (m.op === 'bad') bad = true;
  }, { relays, makeRelay });
  const waitFor = async (cond, ms, every = 100) => {
    for (let t = 0; t < ms * patience; t += every) {
      if (cond()) return true;
      await sleep(every);
    }
    return cond();
  };
  const piece = (i) => link.say('up', { op: 'c', id, i, d: toBase64(data.subarray(i * PIECE, (i + 1) * PIECE)) });
  try {
    if (!await waitFor(() => link.up, 15000)) throw new Error('offline');
    // Keep saying hello until the computer answers: its connection may be a moment behind ours.
    for (let tries = 0; tries < 12 && !ready; tries++) {
      await link.say('up', hello);
      await waitFor(() => ready, 1500);
    }
    if (!ready) throw new Error('nobody');

    let sent = 0;
    for (let i = 0; i < n; i++) {
      await piece(i);
      onProgress(++sent / (n + 1));
      await waitFor(() => !link.busy, 20000, 50);
      await sleep(25);
    }
    // Then: "that was all of it". The answer is either "done" or a list of pieces to send again.
    for (let round = 0; round < 12 && !done; round++) {
      if (bad) throw new Error('failed');
      need = null;
      await link.say('up', { op: 'end', id });
      await waitFor(() => done || need || bad, 6000);
      if (done || bad || !need) continue;
      for (const i of need) {
        await piece(i);
        await waitFor(() => !link.busy, 20000, 50);
        await sleep(25);
      }
    }
    if (!done) throw new Error('failed');
    onProgress(1);
    return done;
  } finally {
    link.close();
  }
}

/**
 * Computer side. Waits for one package sent with this code and resolves with
 * its bytes (unsqueezed). `summarize(bytes)` returns what to tell the phone it
 * received; if it throws, the phone is told the package was no good.
 * @param waitMs give up after this long (rejects with Error 'timeout')
 */
export async function receivePackage(code, { relays = RELAYS, makeRelay = (...a) => new Relay(...a), summarize = () => ({}), onStatus = () => {}, waitMs = 12 * 3600000 } = {}) {
  let job = null;          // { id, n, hash, gz, pieces: [], got }
  let finished = null, lastPiece = 0, nagged = 0;
  let link = null;
  const missing = () => {
    const miss = [];
    for (let i = 0; i < job.n && miss.length < 150; i++) if (!job.pieces[i]) miss.push(i);
    return miss;
  };
  const settle = async () => {
    const miss = missing();
    if (miss.length) {
      await link.say('down', { op: 'need', id: job.id, miss });
      return;
    }
    const total = job.pieces.reduce((s, p) => s + p.length, 0);
    const data = new Uint8Array(total);
    let at = 0;
    for (const p of job.pieces) { data.set(p, at); at += p.length; }
    let bytes, summary;
    try {
      if (await fingerprint(data) !== job.hash) throw new Error('fingerprint does not match');
      bytes = await unpack(data, job.gz);
      summary = await summarize(bytes);
    } catch (err) {
      onStatus(`package refused: ${err.message}`);
      await link.say('down', { op: 'bad', id: job.id });
      job = null;
      return;
    }
    const id = job.id;
    finished = { bytes, summary };
    // Said a few times over, in case the first one is lost on the way back.
    for (let i = 0; i < 4; i++) {
      await link.say('down', { op: 'done', id, summary });
      await sleep(400);
    }
  };
  let working = Promise.resolve();
  link = await join(code, 'up', (m) => {
    // One message at a time, in the order they arrived.
    working = working.then(async () => {
      if (finished) {
        if (m.op === 'end' || m.op === 'hello') await link.say('down', { op: 'done', id: m.id, summary: finished.summary });
        return;
      }
      if (m.op === 'hello' && typeof m.id === 'string' && Number.isInteger(m.n) && m.n > 0 && m.n <= 20000) {
        if (job?.id !== m.id) {
          job = { id: m.id, n: m.n, hash: String(m.hash), gz: !!m.gz, pieces: new Array(m.n), got: 0 };
          onStatus(`a phone is sending ${m.n} piece(s), ${m.size} bytes`);
        }
        await link.say('down', { op: 'ready', id: m.id });
      } else if (m.op === 'c' && job && m.id === job.id && Number.isInteger(m.i) && m.i >= 0 && m.i < job.n && typeof m.d === 'string') {
        if (!job.pieces[m.i]) {
          job.pieces[m.i] = fromBase64(m.d);
          job.got++;
        }
        lastPiece = Date.now();
      } else if (m.op === 'end' && job && m.id === job.id) {
        await settle();
      }
    }).catch((err) => onStatus(`error: ${err.message}`));
  }, { relays, makeRelay });

  try {
    const started = Date.now();
    while (!finished) {
      if (Date.now() - started > waitMs) throw new Error('timeout');
      await sleep(250);
      // The pieces stopped coming but "end" never arrived: ask for what is missing.
      if (job && !finished && job.got && job.got < job.n && Date.now() - lastPiece > 4000 && Date.now() - nagged > 4000) {
        nagged = Date.now();
        working = working.then(() => (job && !finished ? link.say('down', { op: 'need', id: job.id, miss: missing() }) : null)).catch(() => {});
      }
    }
    await working;
    return finished;
  } finally {
    link.close();
  }
}
