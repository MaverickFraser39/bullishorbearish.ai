/**
 * Posts board activity to X.
 *
 * Deliberately NOT one post per vote. X's free tier allows roughly 500 posts a
 * month, and a busy startup would burn that in a day and read as a bot — so
 * votes for the same company coalesce into a single pending update and the
 * queue drains at most one post per interval. Same intent, survives contact
 * with traffic.
 *
 * Entirely optional: with no credentials set the module logs what it would
 * have posted and the site behaves normally. Nothing here can fail a request —
 * announcing is fire-and-forget.
 */
import { createHmac, randomBytes } from 'node:crypto';

const CREDS = {
  key: process.env.X_API_KEY,
  secret: process.env.X_API_SECRET,
  token: process.env.X_ACCESS_TOKEN,
  tokenSecret: process.env.X_ACCESS_SECRET,
};

const SITE = (process.env.SITE_URL || 'https://bullishorbearish.fly.dev').replace(/\/$/, '');
const MIN_INTERVAL = Number(process.env.ANNOUNCE_INTERVAL_MS) || 15 * 60 * 1000;
const ENABLED = process.env.ANNOUNCE_ENABLED !== 'false';

export const configured = Boolean(CREDS.key && CREDS.secret && CREDS.token && CREDS.tokenSecret);

/** RFC 3986 escaping — encodeURIComponent leaves !*'() alone and OAuth won't. */
const enc = (value) =>
  encodeURIComponent(String(value)).replace(/[!*'()]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The OAuth 1.0a signature itself, split out so it can be tested against
    X's published example vector rather than trusted. */
export function sign(method, url, params, consumerSecret, tokenSecret) {
  const normalized = Object.keys(params).sort()
    .map((k) => `${enc(k)}=${enc(params[k])}`).join('&');
  const base = [method.toUpperCase(), enc(url), enc(normalized)].join('&');
  const signingKey = `${enc(consumerSecret)}&${enc(tokenSecret)}`;
  return createHmac('sha1', signingKey).update(base).digest('base64');
}

/** OAuth 1.0a user-context header, signed with node:crypto so there is no SDK. */
function authorization(method, url) {
  const oauth = {
    oauth_consumer_key: CREDS.key,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: CREDS.token,
    oauth_version: '1.0',
  };
  oauth.oauth_signature = sign('POST', url, oauth, CREDS.secret, CREDS.tokenSecret);
  return `OAuth ${Object.keys(oauth).sort()
    .map((k) => `${enc(k)}="${enc(oauth[k])}"`).join(', ')}`;
}

async function post(text) {
  if (!configured) {
    console.log(`[announce:dry-run] ${text.replace(/\n/g, ' / ')}`);
    return { dryRun: true };
  }
  const url = 'https://api.x.com/2/tweets';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: authorization('POST', url),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`X ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

const arrow = (pct) => (pct >= 50 ? '▲' : '▼');

function compose(event) {
  const { kind, startup: s } = event;
  const link = `${SITE}/s/${s.slug}`;
  const split = `${s.bullishPct}% bullish · ${100 - s.bullishPct}% bearish`;
  const votes = `${s.total} vote${s.total === 1 ? '' : 's'}`;

  if (kind === 'listed') {
    return `${s.name} is now on the board.\n\nBullish or bearish? Cast a call and say why.\n\n${link}`;
  }
  if (kind === 'flip') {
    return `${arrow(s.bullishPct)} The crowd just flipped on ${s.name}.\n\n${split} across ${votes}.\n\n${link}`;
  }
  return `${arrow(s.bullishPct)} ${s.name} — ${split} across ${votes}.\n\n${link}`;
}

/* One pending event per company; later votes overwrite earlier ones so a burst
   of activity becomes one accurate post rather than ten stale ones. */
const pending = new Map();
let lastPostAt = 0;
let timer = null;

function schedule() {
  if (timer || !pending.size) return;
  const wait = Math.max(0, lastPostAt + MIN_INTERVAL - Date.now());
  timer = setTimeout(drain, wait);
  timer.unref?.();
}

async function drain() {
  timer = null;
  const [slug, event] = pending.entries().next().value ?? [];
  if (!slug) return;
  pending.delete(slug);
  try {
    await post(compose(event));
    lastPostAt = Date.now();
  } catch (err) {
    console.error('[announce] failed:', err.message);
    lastPostAt = Date.now(); // back off rather than hammering a failing API
  }
  schedule();
}

/**
 * Queue an update. Never throws and never blocks the caller.
 * @param {'listed'|'vote'|'flip'} kind
 */
export function announce(kind, startup) {
  if (!ENABLED || !startup) return;
  // A brand-new listing is worth its own post and shouldn't be overwritten
  // by the first vote that lands a second later.
  const existing = pending.get(startup.slug);
  if (existing?.kind === 'listed' && kind !== 'listed') {
    existing.startup = startup;
  } else {
    pending.set(startup.slug, { kind, startup });
  }
  schedule();
}

/** Exposed for tests. */
export const _internals = { compose, authorization, enc };
