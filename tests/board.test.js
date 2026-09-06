import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// lib/db.js resolves DB_PATH at import time, so point it at a scratch file first.
const dir = mkdtempSync(join(tmpdir(), 'bob-test-'));
process.env.DB_PATH = join(dir, 'test.db');

const { createStartup, castVote, getVote, getStartup, listStartups, listTakes, stats } =
  await import('../lib/db.js');
const { parseStartup, parseVote, InvalidInput, slugify, dedupeKey } =
  await import('../lib/validate.js');

after(() => rmSync(dir, { recursive: true, force: true }));

describe('validation', () => {
  test('requires a usable name', () => {
    assert.throws(() => parseStartup({ name: '   ' }), InvalidInput);
    assert.throws(() => parseStartup({ name: '!!!' }), InvalidInput);
    assert.throws(() => parseStartup({ name: 'x'.repeat(61) }), InvalidInput);
  });

  test('normalises websites and rejects junk', () => {
    assert.equal(parseStartup({ name: 'A', website: 'ramp.com' }).website, 'https://ramp.com/');
    assert.equal(parseStartup({ name: 'A' }).website, null);
    assert.throws(() => parseStartup({ name: 'A', website: 'not a url' }), InvalidInput);
    assert.throws(() => parseStartup({ name: 'A', website: 'javascript:alert(1)' }), InvalidInput);
  });

  test('only accepts the two directions', () => {
    assert.equal(parseVote({ direction: 'Bullish' }).direction, 'bullish');
    assert.throws(() => parseVote({ direction: 'sideways' }), InvalidInput);
    assert.throws(() => parseVote({ direction: '' }), InvalidInput);
  });

  test('distinguishes an omitted field from a cleared one', () => {
    assert.equal('reason' in parseVote({ direction: 'bullish' }), false);
    assert.equal(parseVote({ direction: 'bullish', reason: '' }).reason, null);
    assert.equal(parseVote({ direction: 'bullish', reason: ' hi ' }).reason, 'hi');
  });

  test('slug stays readable while the dedupe key collapses spelling', () => {
    assert.equal(slugify('Ramp Financial'), 'ramp-financial');
    assert.equal(dedupeKey('OpenAI'), dedupeKey('Open AI'));
    assert.equal(dedupeKey('open-ai'), dedupeKey('OpenAI'));
    assert.equal(slugify('Café Labs'), 'cafe-labs');
  });
});

describe('the board', () => {
  test('the same company is never added twice', () => {
    const first = createStartup(parseStartup({ name: 'Stripe' }));
    const again = createStartup(parseStartup({ name: 'S T R I P E' }));
    assert.equal(first.created, true);
    assert.equal(again.created, false);
    assert.equal(first.startup.id, again.startup.id);
  });

  test('one vote per person, changeable', () => {
    const { startup } = createStartup(parseStartup({ name: 'Notion' }));
    castVote({ startupId: startup.id, ...parseVote({ direction: 'bullish' }), voterKey: 'a' });
    castVote({ startupId: startup.id, ...parseVote({ direction: 'bearish' }), voterKey: 'a' });
    castVote({ startupId: startup.id, ...parseVote({ direction: 'bullish' }), voterKey: 'b' });

    const row = getStartup('notion');
    assert.equal(row.total, 2, 'changing a vote must not add a second one');
    assert.equal(row.bullish, 1);
    assert.equal(row.bearish, 1);
  });

  test('a quick vote does not erase a written take', () => {
    const { startup } = createStartup(parseStartup({ name: 'Vercel' }));
    castVote({
      startupId: startup.id,
      ...parseVote({ direction: 'bullish', reason: 'Great DX.', author: 'mav' }),
      voterKey: 'a',
    });
    // Board-level vote: no reason key at all.
    castVote({ startupId: startup.id, ...parseVote({ direction: 'bearish' }), voterKey: 'a' });

    const vote = getVote(startup.id, 'a');
    assert.equal(vote.direction, 'bearish');
    assert.equal(vote.reason, 'Great DX.', 'the take must survive a quick vote');
    assert.equal(vote.author, 'mav');
  });

  test('an explicitly blank reason does clear it', () => {
    const { startup } = createStartup(parseStartup({ name: 'Retool' }));
    castVote({ startupId: startup.id, ...parseVote({ direction: 'bullish', reason: 'Fast.' }), voterKey: 'a' });
    castVote({ startupId: startup.id, ...parseVote({ direction: 'bullish', reason: '' }), voterKey: 'a' });
    assert.equal(getVote(startup.id, 'a').reason, null);
  });

  test('only votes with text show up as takes', () => {
    const { startup } = createStartup(parseStartup({ name: 'Supabase' }));
    castVote({ startupId: startup.id, ...parseVote({ direction: 'bullish', reason: 'Postgres.' }), voterKey: 'a' });
    castVote({ startupId: startup.id, ...parseVote({ direction: 'bearish' }), voterKey: 'b' });
    assert.equal(getStartup('supabase').total, 2);
    assert.equal(listTakes(startup.id).length, 1);
  });

  test('thin samples do not outrank real ones', () => {
    const lucky = createStartup(parseStartup({ name: 'Lucky One Vote' })).startup;
    castVote({ startupId: lucky.id, ...parseVote({ direction: 'bullish' }), voterKey: 'solo' });

    const proven = createStartup(parseStartup({ name: 'Proven Favourite' })).startup;
    for (let i = 0; i < 40; i += 1) {
      castVote({ startupId: proven.id, ...parseVote({ direction: 'bullish' }), voterKey: `p${i}` });
    }
    castVote({ startupId: proven.id, ...parseVote({ direction: 'bearish' }), voterKey: 'pd' });

    const ranked = listStartups({ sort: 'bullish' }).map((r) => r.name);
    assert.ok(
      ranked.indexOf('Proven Favourite') < ranked.indexOf('Lucky One Vote'),
      '41 votes at 98% should beat 1 vote at 100%',
    );
  });

  test('search matches by name', () => {
    assert.deepEqual(listStartups({ q: 'supab' }).map((r) => r.name), ['Supabase']);
    assert.deepEqual(listStartups({ q: 'nothing-here' }), []);
  });

  test('stats add up', () => {
    const s = stats();
    assert.ok(s.startups > 0 && s.votes > 0);
    assert.ok(s.bullish <= s.votes);
    assert.ok(s.takes <= s.votes);
  });
});
