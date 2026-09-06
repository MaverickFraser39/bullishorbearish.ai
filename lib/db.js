import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DB_PATH = resolve(process.env.DB_PATH || './data/bullishorbearish.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS startups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    slug       TEXT NOT NULL UNIQUE,
    dedupe_key TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    website    TEXT,
    pitch      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS votes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    startup_id INTEGER NOT NULL REFERENCES startups(id) ON DELETE CASCADE,
    direction  TEXT NOT NULL CHECK (direction IN ('bullish', 'bearish')),
    reason     TEXT,
    author     TEXT,
    voter_key  TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (startup_id, voter_key)
  );

  CREATE INDEX IF NOT EXISTS idx_votes_startup ON votes (startup_id);
  CREATE INDEX IF NOT EXISTS idx_votes_updated ON votes (updated_at);
`);

// One vote per person per startup, so a raw count would let a single loud voter
// look like consensus. Laplace smoothing pulls thin samples toward 50/50, which
// keeps a 1-0 startup from outranking a 340-90 one.
const TALLIES = `
  WITH tallies AS (
    SELECT
      s.id, s.slug, s.name, s.website, s.pitch, s.created_at,
      COUNT(v.id)                                                AS total,
      COALESCE(SUM(v.direction = 'bullish'), 0)                  AS bullish,
      COALESCE(SUM(v.direction = 'bearish'), 0)                  AS bearish,
      COALESCE(SUM(v.updated_at >= datetime('now', '-7 days')), 0) AS recent,
      COUNT(NULLIF(TRIM(COALESCE(v.reason, '')), ''))            AS takes
    FROM startups s
    LEFT JOIN votes v ON v.startup_id = s.id
    GROUP BY s.id
  )
  SELECT *, (bullish + 1.0) / (total + 2.0) AS score FROM tallies
`;

const ORDERINGS = {
  hot: 'recent DESC, total DESC, created_at DESC',
  bullish: 'score DESC, total DESC',
  bearish: 'score ASC, total DESC',
  // The point of the site: where the crowd genuinely disagrees, loudest first.
  contested: 'ABS(score - 0.5) ASC, total DESC',
  new: 'created_at DESC, id DESC',
  votes: 'total DESC, recent DESC',
};

export const SORTS = Object.keys(ORDERINGS);

export function listStartups({ sort = 'hot', q = '', limit = 50, offset = 0 } = {}) {
  const order = ORDERINGS[sort] ?? ORDERINGS.hot;
  const filter = q ? 'WHERE name LIKE ? ESCAPE \'\\\'' : '';
  const params = q ? [`%${q.replace(/[\\%_]/g, '\\$&')}%`] : [];
  return db
    .prepare(`${TALLIES} ${filter} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
}

export function countStartups({ q = '' } = {}) {
  if (!q) return db.prepare('SELECT COUNT(*) AS n FROM startups').get().n;
  return db
    .prepare('SELECT COUNT(*) AS n FROM startups WHERE name LIKE ? ESCAPE \'\\\'')
    .get(`%${q.replace(/[\\%_]/g, '\\$&')}%`).n;
}

export function getStartup(slug) {
  return db.prepare(`${TALLIES} WHERE slug = ?`).get(slug);
}

export function createStartup({ slug, dedupeKey, name, website, pitch }) {
  // Match on the normalized key, not the slug, so "Open AI" resolves to the
  // existing "OpenAI" card and adds to its tally instead of forking it.
  const hit = db.prepare('SELECT slug FROM startups WHERE dedupe_key = ?').get(dedupeKey);
  if (hit) return { startup: getStartup(hit.slug), created: false };

  // Distinct companies can still slugify the same way; give the later one a suffix.
  const taken = db.prepare('SELECT 1 FROM startups WHERE slug = ?');
  let candidate = slug || dedupeKey;
  for (let n = 2; taken.get(candidate); n += 1) candidate = `${slug}-${n}`;

  db.prepare(
    'INSERT INTO startups (slug, dedupe_key, name, website, pitch) VALUES (?, ?, ?, ?, ?)'
  ).run(candidate, dedupeKey, name, website ?? null, pitch ?? null);
  return { startup: getStartup(candidate), created: true };
}

export function castVote({ startupId, direction, reason, author, voterKey }) {
  // Merge here rather than in SQL: `undefined` (key absent) keeps whatever the
  // voter wrote before, `null` (key sent empty) clears it.
  const prev = getVote(startupId, voterKey);
  const nextReason = reason === undefined ? (prev?.reason ?? null) : reason;
  const nextAuthor = author === undefined ? (prev?.author ?? null) : author;

  db.prepare(`
    INSERT INTO votes (startup_id, direction, reason, author, voter_key)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (startup_id, voter_key) DO UPDATE SET
      direction  = excluded.direction,
      reason     = excluded.reason,
      author     = excluded.author,
      updated_at = datetime('now')
  `).run(startupId, direction, nextReason, nextAuthor, voterKey);

  return { direction, reason: nextReason, author: nextAuthor };
}

export function getVote(startupId, voterKey) {
  return db
    .prepare('SELECT direction, reason, author FROM votes WHERE startup_id = ? AND voter_key = ?')
    .get(startupId, voterKey);
}

export function listTakes(startupId, { limit = 100, offset = 0 } = {}) {
  return db.prepare(`
    SELECT direction, reason, author, updated_at
    FROM votes
    WHERE startup_id = ? AND TRIM(COALESCE(reason, '')) <> ''
    ORDER BY updated_at DESC
    LIMIT ? OFFSET ?
  `).all(startupId, limit, offset);
}

export function stats() {
  return db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM startups) AS startups,
      (SELECT COUNT(*) FROM votes)    AS votes,
      (SELECT COUNT(*) FROM votes WHERE direction = 'bullish') AS bullish,
      (SELECT COUNT(NULLIF(TRIM(COALESCE(reason, '')), '')) FROM votes) AS takes
  `).get();
}
