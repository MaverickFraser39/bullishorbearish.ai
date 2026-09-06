import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  SORTS, listStartups, countStartups, getStartup,
  createStartup, castVote, getVote, listTakes, stats,
} from './lib/db.js';
import { parseStartup, parseVote, InvalidInput, LIMITS } from './lib/validate.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = Number(process.env.PORT) || 3000;

// Votes are anonymous, so identity is a fingerprint rather than an account. The
// salt keeps that fingerprint from being a reversible IP lookup; it must stay
// stable across restarts or every voter is treated as new.
const VOTE_SALT = process.env.VOTE_SALT || 'insecure-development-salt';
if (VOTE_SALT === 'insecure-development-salt' && process.env.NODE_ENV === 'production') {
  console.warn('WARNING: VOTE_SALT is unset in production. See .env.example.');
}

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'",
  });
  next();
});

const voterKey = (req) =>
  createHash('sha256')
    .update(`${VOTE_SALT}|${req.ip}|${req.get('user-agent') ?? ''}`)
    .digest('hex');

/** Sliding-window limiter. In-memory: per-process, resets on restart. */
const buckets = new Map();
function allow(key, limit, windowMs) {
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) return false;
  hits.push(now);
  buckets.set(key, hits);
  return true;
}
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [key, hits] of buckets) {
    const live = hits.filter((t) => t > cutoff);
    if (live.length) buckets.set(key, live);
    else buckets.delete(key);
  }
}, 10 * 60 * 1000).unref();

const limiter = (name, limit, windowMs) => (req, res, next) => {
  if (allow(`${name}:${req.ip}`, limit, windowMs)) return next();
  res.status(429).json({ error: 'Slow down a moment, then try again.' });
};

const HOUR = 60 * 60 * 1000;

function present(row) {
  const total = row.total ?? 0;
  return {
    slug: row.slug,
    name: row.name,
    website: row.website,
    pitch: row.pitch,
    createdAt: row.created_at,
    total,
    bullish: row.bullish ?? 0,
    bearish: row.bearish ?? 0,
    takes: row.takes ?? 0,
    bullishPct: total ? Math.round((row.bullish / total) * 100) : null,
  };
}

// Liveness probe for the platform. Touches the database so a wedged or
// unwritable volume actually fails the check instead of reporting healthy.
app.get('/health', (req, res) => {
  try {
    stats();
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

app.get('/api/stats', (req, res) => res.json(stats()));

app.get('/api/startups', (req, res) => {
  const sort = SORTS.includes(req.query.sort) ? req.query.sort : 'hot';
  const q = String(req.query.q ?? '').slice(0, 60).trim();
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  res.json({
    sort,
    q,
    total: countStartups({ q }),
    startups: listStartups({ sort, q, limit, offset }).map(present),
  });
});

app.post('/api/startups', limiter('add', 8, HOUR), (req, res, next) => {
  try {
    const input = parseStartup(req.body);
    const { startup, created } = createStartup(input);
    res.status(created ? 201 : 200).json({ created, startup: present(startup) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/startups/:slug', (req, res) => {
  const startup = getStartup(req.params.slug);
  if (!startup) return res.status(404).json({ error: 'No startup by that name yet.' });
  res.json({
    startup: present(startup),
    you: getVote(startup.id, voterKey(req)) ?? null,
    takes: listTakes(startup.id, { limit: 100 }),
  });
});

app.post('/api/startups/:slug/votes', limiter('vote', 60, HOUR), (req, res, next) => {
  try {
    const startup = getStartup(req.params.slug);
    if (!startup) return res.status(404).json({ error: 'No startup by that name yet.' });
    const vote = parseVote(req.body);
    const saved = castVote({ startupId: startup.id, ...vote, voterKey: voterKey(req) });
    const updated = getStartup(req.params.slug);
    res.json({
      startup: present(updated),
      you: saved,
      takes: listTakes(updated.id, { limit: 100 }),
    });
  } catch (err) {
    next(err);
  }
});

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

// Startup permalinks are client-routed; hand them the shell.
app.get('/s/:slug', (req, res) => res.sendFile(join(PUBLIC_DIR, 'index.html')));

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((err, req, res, next) => {
  if (err instanceof InvalidInput) {
    return res.status(400).json({ error: err.message, field: err.field });
  }
  const ref = randomUUID().slice(0, 8);
  console.error(`[${ref}]`, err);
  res.status(500).json({ error: `Something broke on our end (ref ${ref}).` });
});

app.listen(PORT, () => {
  console.log(`bullishorbearish.ai listening on http://localhost:${PORT}`);
});

export { app, LIMITS };
