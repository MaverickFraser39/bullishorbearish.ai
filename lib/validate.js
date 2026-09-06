export const LIMITS = {
  name: 60,
  website: 200,
  pitch: 200,
  reason: 700,
  author: 40,
};

export class InvalidInput extends Error {
  constructor(field, message) {
    super(message);
    this.field = field;
    this.status = 400;
  }
}

const squish = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/** Readable, URL-safe identity: "Ramp Financial" -> "ramp-financial". */
export function slugify(name) {
  return squish(name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Collision key for "is this already on the board?". Strips everything but
 * letters and digits, so "OpenAI", "Open AI" and "open-ai" all land on the same
 * entry instead of splitting one company's votes across three cards.
 */
export function dedupeKey(name) {
  return squish(name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function optionalText(value, field, max) {
  const text = squish(value);
  if (!text) return null;
  if (text.length > max) throw new InvalidInput(field, `${field} must be ${max} characters or fewer.`);
  return text;
}

function optionalUrl(value) {
  const text = squish(value);
  if (!text) return null;
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  if (withScheme.length > LIMITS.website) {
    throw new InvalidInput('website', `website must be ${LIMITS.website} characters or fewer.`);
  }
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new InvalidInput('website', 'website must be a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidInput('website', 'website must be an http or https URL.');
  }
  if (!url.hostname.includes('.')) throw new InvalidInput('website', 'website must include a domain.');
  return url.toString();
}

export function parseStartup(body = {}) {
  const name = squish(body.name);
  if (!name) throw new InvalidInput('name', 'Give the startup a name.');
  if (name.length > LIMITS.name) {
    throw new InvalidInput('name', `name must be ${LIMITS.name} characters or fewer.`);
  }
  const key = dedupeKey(name);
  if (!key) throw new InvalidInput('name', 'name needs at least one letter or number.');

  return {
    name,
    slug: slugify(name),
    dedupeKey: key,
    website: optionalUrl(body.website),
    pitch: optionalText(body.pitch, 'pitch', LIMITS.pitch),
  };
}

export function parseVote(body = {}) {
  const direction = squish(body.direction).toLowerCase();
  if (direction !== 'bullish' && direction !== 'bearish') {
    throw new InvalidInput('direction', 'direction must be "bullish" or "bearish".');
  }
  // An omitted key means "leave it alone"; a present-but-empty one means
  // "clear it". Without that distinction a quick vote from the board would
  // silently erase a take the same person wrote earlier.
  const vote = { direction };
  if ('reason' in body) vote.reason = optionalText(body.reason, 'reason', LIMITS.reason);
  if ('author' in body) vote.author = optionalText(body.author, 'author', LIMITS.author);
  return vote;
}
