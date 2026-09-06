import express from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  SORTS, listStartups, countStartups, getStartup,
  createStartup, castVote, getVote, listTakes, stats,
  fileReport, listReports, deleteStartup, redactTake,
} from './lib/db.js';
import { announce, configured as announceConfigured } from './lib/announce.js';
import { parseStartup, parseVote, InvalidInput, LIMITS } from './lib/validate.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = Number(process.env.PORT) || 3000;
const SITE = (process.env.SITE_URL || 'https://bullishorbearish.fly.dev').replace(/\/$/, '');

// Moderation is gated on a shared secret rather than accounts. Without it the
// admin routes refuse everything, so an unconfigured deploy is closed, not open.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

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

const escapeXml = (value) => String(value).replace(/[<>&'"]/g, (c) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

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
    const shaped = present(startup);
    if (created) announce('listed', shaped);
    res.status(created ? 201 : 200).json({ created, startup: shaped });
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

    // A lean that crosses the midpoint is the interesting event; everything
    // else is a routine tally update.
    const leaned = startup.total ? startup.bullish / startup.total >= 0.5 : null;
    const leans = updated.bullish / updated.total >= 0.5;
    announce(leaned !== null && leaned !== leans ? 'flip' : 'vote', present(updated));

    res.json({
      startup: present(updated),
      you: saved,
      takes: listTakes(updated.id, { limit: 100 }),
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------ moderation --- */

app.post('/api/startups/:slug/report', limiter('report', 20, HOUR), (req, res, next) => {
  try {
    const startup = getStartup(req.params.slug);
    if (!startup) return res.status(404).json({ error: 'No startup by that name yet.' });
    const reason = String(req.body?.reason ?? '').trim().slice(0, 500) || null;
    const voteId = Number(req.body?.voteId) || null;
    fileReport({ startupId: startup.id, voteId, reason, reporter: voterKey(req) });
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const admin = (req, res, next) => {
  if (!ADMIN_TOKEN) return res.status(503).json({ error: 'Moderation is not configured.' });
  const offered = req.get('x-admin-token') ?? '';
  // Constant-time-ish: compare full strings, never short-circuit on length alone.
  if (offered.length !== ADMIN_TOKEN.length ||
      !timingSafeEqual(Buffer.from(offered.padEnd(64)), Buffer.from(ADMIN_TOKEN.padEnd(64)))) {
    return res.status(404).json({ error: 'Not found.' });
  }
  next();
};

app.get('/api/admin/reports', admin, (req, res) => res.json({ reports: listReports() }));

app.delete('/api/admin/startups/:slug', admin, (req, res) => {
  const gone = deleteStartup(req.params.slug);
  res.status(gone ? 200 : 404).json({ deleted: gone });
});

app.delete('/api/admin/takes/:id', admin, (req, res) => {
  const gone = redactTake(Number(req.params.id));
  res.status(gone ? 200 : 404).json({ redacted: gone });
});

/* ------------------------------------------------------------------ seo --- */

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
});

app.get('/sitemap.xml', (req, res) => {
  const urls = [{ loc: `${SITE}/`, priority: '1.0' }].concat(
    listStartups({ sort: 'new', limit: 100 }).map((s) => ({
      loc: `${SITE}/s/${s.slug}`,
      lastmod: String(s.created_at).replace(' ', 'T') + 'Z',
      priority: '0.7',
    })));
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url><loc>${escapeXml(u.loc)}</loc>` +
      (u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : '') +
      `<priority>${u.priority}</priority></url>`).join('\n') +
    `\n</urlset>\n`);
});

app.get('/', (req, res) => res.type('html').send(shellWith({
  title: 'Bullish or Bearish — the open startup conviction board',
  description: 'Add any startup. Take a side. Say why. No accounts, no gatekeeping, fully open source.',
  url: `${SITE}/`,
})));

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

const SHELL = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8');

function shellWith({ title, description, url }) {
  const tags = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Bullish or Bearish">`,
    `<meta property="og:title" content="${escapeXml(title)}">`,
    `<meta property="og:description" content="${escapeXml(description)}">`,
    `<meta property="og:url" content="${escapeXml(url)}">`,
    `<meta property="og:image" content="${SITE}/og.png">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escapeXml(title)}">`,
    `<meta name="twitter:description" content="${escapeXml(description)}">`,
    `<meta name="twitter:image" content="${SITE}/og.png">`,
    `<link rel="canonical" href="${escapeXml(url)}">`,
  ].join('\n');
  return SHELL.replace('<!--SOCIAL-->', tags);
}

// Startup permalinks are client-routed, but the unfurl a crawler sees comes
// from this response, so the tags are filled in server-side.
app.get('/s/:slug', (req, res) => {
  const startup = getStartup(req.params.slug);
  if (!startup) {
    return res.type('html').send(shellWith({
      title: 'Bullish or Bearish',
      description: 'An open board for startup conviction.',
      url: `${SITE}/s/${req.params.slug}`,
    }));
  }
  const split = startup.total
    ? `${Math.round((startup.bullish / startup.total) * 100)}% bullish across ${startup.total} vote${startup.total === 1 ? '' : 's'}.`
    : 'No calls yet — be the first.';
  res.type('html').send(shellWith({
    title: `${startup.name} — Bullish or Bearish`,
    description: `${split}${startup.pitch ? ` ${startup.pitch}.` : ''} Read the takes and cast your own.`,
    url: `${SITE}/s/${startup.slug}`,
  }));
});

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
