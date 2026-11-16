// Challenges: "I did a 3 km walk today. Can you beat me?"
//
// A challenge is a small shared scoreboard kept in the cloud (worker/index.js):
// each player's phone works out how far that player went each day, from the
// outings saved on it, and posts only that: a name, a team and a distance per
// day. No positions leave the phone. Whoever holds the challenge's id (it is in
// the link the challenger sends) can see the board and join.
//
// This file holds the rules and the calls to the cloud; the screens are in app.js.

import { CLOUD } from './sync.js';

const api = () => (location.hostname.endsWith('github.io') ? `${CLOUD}/api` : `${location.origin}/api`);

/** What can count towards a challenge. `foot` is how a method of travel's `kind` is spelled in width.js. */
export const CHALLENGE_KINDS = {
  any: { label: 'Anything', text: 'any walk or ride' },
  foot: { label: 'On foot only', text: 'walks, jogs and runs' },
  wheels: { label: 'Riding only', text: 'rides (anything you sit on)' },
};
/** Does an outing made by this method of travel count? */
export const countsFor = (kind, method) => kind === 'any' || (kind === 'foot') === (method?.kind === 'foot');

const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export const newChallengeId = () => [...crypto.getRandomValues(new Uint8Array(10))].map((b) => ALPHABET[b % ALPHABET.length]).join('');

/** The day a moment falls on, on this phone's own clock: "2026-11-16". */
export function dayOf(t) {
  const d = new Date(t), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** A day some number of days after (or before) another. */
export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return dayOf(new Date(y, m - 1, d + n, 12));
}
/** The last day of a challenge, or null if it has no end. */
export const lastDayOf = (ch) => (ch.days > 0 ? addDays(ch.start, ch.days - 1) : null);
/** Is `day` one of the challenge's days? */
export const inChallenge = (ch, day) => day >= ch.start && (!ch.days || day <= lastDayOf(ch));
export const isOver = (ch, today) => !!ch.days && today > lastDayOf(ch);

/** "Mon 16 Nov" */
export function dayLabel(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 12).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/**
 * How far this phone's owner went on each day, from the saved outings.
 * @param outings [{ t (start time), dist, ms, method }]
 * @returns { 'YYYY-MM-DD': { dist, ms } } for the challenge's days that have anything
 */
export function totalsByDay(ch, outings) {
  const out = {};
  for (const o of outings) {
    const day = dayOf(o.t);
    if (!inChallenge(ch, day) || !countsFor(ch.kind, o.method) || !(o.dist > 0)) continue;
    out[day] ??= { dist: 0, ms: 0 };
    out[day].dist += o.dist;
    out[day].ms += o.ms ?? 0;
  }
  return out;
}

/**
 * The board for one day (or, with no day, the whole challenge so far).
 * @param scores [{ player, name, team, day, dist, ms }]
 * @returns { people: [{ player, name, team, dist, ms }] furthest first, teams: [{ team, dist, players }] furthest first }
 */
export function standings(ch, scores, day = null) {
  const people = new Map();
  for (const s of scores) {
    if (day ? s.day !== day : !inChallenge(ch, s.day)) continue;
    const p = people.get(s.player) ?? { player: s.player, name: s.name, team: s.team || '', dist: 0, ms: 0 };
    p.dist += s.dist;
    p.ms += s.ms ?? 0;
    people.set(s.player, p);
  }
  const list = [...people.values()].sort((a, b) => b.dist - a.dist || a.ms - b.ms);
  const teams = (ch.teams ?? []).map((team) => {
    const members = list.filter((p) => p.team === team);
    return { team, dist: members.reduce((sum, p) => sum + p.dist, 0), players: members.length };
  }).sort((a, b) => b.dist - a.dist);
  return { people: list, teams };
}

/**
 * Who won a day: the team that went furthest in a team challenge, otherwise the person.
 * @returns { name, dist, tie } or null if nobody went anywhere that day
 */
export function winnerOf(ch, scores, day) {
  const board = standings(ch, scores, day);
  const rows = ch.teams?.length ? board.teams.map((t) => ({ name: t.team, dist: t.dist })) : board.people.map((p) => ({ name: p.name, dist: p.dist }));
  if (!rows.length || !(rows[0].dist > 0)) return null;
  const tied = rows.filter((r) => r.dist === rows[0].dist);
  return { name: tied.map((r) => r.name).join(' and '), dist: rows[0].dist, tie: tied.length > 1 };
}

/** The winner of every finished day, newest first: [{ day, name, dist, tie }]. Today is not finished yet. */
export function dailyWinners(ch, scores, today, max = 14) {
  const out = [];
  const last = lastDayOf(ch);
  for (let day = addDays(today, -1); day >= ch.start && out.length < max; day = addDays(day, -1)) {
    if (last && day > last) continue;
    const w = winnerOf(ch, scores, day);
    if (w) out.push({ day, ...w });
  }
  return out;
}

// ---- links -------------------------------------------------------------------------------

/**
 * The link a challenger sends. It carries the challenge's id, and the dare itself
 * (who, how far, what on) so it can be shown before the cloud has answered.
 */
export function challengeLink(base, id, dare = null) {
  const extra = dare ? `&by=${encodeURIComponent(dare.by)}&d=${Math.round(dare.dist)}&n=${encodeURIComponent(dare.noun)}` : '';
  return `${base}#challenge=${id}${extra}`;
}

/** Read a challenge link, or a bare id typed in. Null if it is neither. */
export function readChallengeLink(text) {
  const s = String(text ?? '');
  const id = (/[#&?]challenge=([A-Za-z0-9]+)/.exec(s)?.[1] ?? s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-HJKMNP-TV-Z2-9]{10}$/.test(id)) return null;
  const part = (key) => { try { return decodeURIComponent(new RegExp(`[#&]${key}=([^&]*)`).exec(s)?.[1] ?? ''); } catch { return ''; } };
  const dist = Number(part('d'));
  const dare = part('by') && dist > 0 ? { by: part('by').slice(0, 40), dist, noun: part('n').replace(/[^a-z]/gi, '').slice(0, 12) || 'outing' } : null;
  return { id, dare };
}

// ---- the cloud ---------------------------------------------------------------------------

async function call(path, init = {}) {
  const res = await fetch(`${api()}/${path}`, { ...init, cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`cloud ${res.status}`);
  return res.json();
}
const send = (method, body) => ({ method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });

/** @param ch { id, name, kind, start, days, teams, by } */
export const createChallenge = (ch) => call(`challenge/${ch.id}`, send('PUT', ch));
/** @returns { challenge, scores } or null if there is no such challenge */
export const fetchChallenge = (id) => call(`challenge/${id}`);
/** @param days [{ day, dist, ms }] */
export const postScores = (id, player, name, team, days) => call(`challenge/${id}/score`, send('PUT', { player, name, team, days }));

/** Where invitations for the holder of a friend code are left: a one-way hash, so the code itself is never sent. */
export async function inboxOf(friendCode) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`seeley-inbox ${friendCode}`)));
  return [...hash].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export async function sendInvites(friendCodes, id, from, title) {
  const to = await Promise.all(friendCodes.map(inboxOf));
  return call('invite', send('POST', { to, challenge: id, from, title }));
}
export async function fetchInvites(friendCode) {
  return (await call(`invites/${await inboxOf(friendCode)}`))?.invites ?? [];
}
