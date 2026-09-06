import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'bob-mod-'));
process.env.DB_PATH = join(dir, 'test.db');

const { createStartup, castVote, getStartup, listTakes,
        fileReport, listReports, deleteStartup, redactTake } = await import('../lib/db.js');
const { parseStartup, parseVote } = await import('../lib/validate.js');

after(() => rmSync(dir, { recursive: true, force: true }));

describe('moderation', () => {
  test('a report is recorded against the listing', () => {
    const { startup } = createStartup(parseStartup({ name: 'Spammy Co' }));
    fileReport({ startupId: startup.id, reason: 'obvious spam', reporter: 'fingerprint-a' });
    const reports = listReports();
    assert.equal(reports.length, 1);
    assert.equal(reports[0].slug, 'spammy-co');
    assert.equal(reports[0].reason, 'obvious spam');
  });

  test('deleting a listing takes its votes with it', () => {
    const { startup } = createStartup(parseStartup({ name: 'Doomed Inc' }));
    castVote({ startupId: startup.id, ...parseVote({ direction: 'bullish', reason: 'x' }), voterKey: 'a' });
    assert.equal(getStartup('doomed-inc').total, 1);

    assert.equal(deleteStartup('doomed-inc'), true);
    assert.equal(getStartup('doomed-inc'), undefined);
    assert.equal(deleteStartup('doomed-inc'), false, 'deleting twice is not an error');
  });

  test('redacting a take clears the text but keeps the vote counted', () => {
    const { startup } = createStartup(parseStartup({ name: 'Libel Ltd' }));
    castVote({
      startupId: startup.id,
      ...parseVote({ direction: 'bearish', reason: 'defamatory claim', author: 'troll' }),
      voterKey: 'a',
    });
    castVote({ startupId: startup.id, ...parseVote({ direction: 'bullish' }), voterKey: 'b' });

    const take = listTakes(startup.id)[0];
    assert.equal(redactTake(take.id), true);

    const after = getStartup('libel-ltd');
    assert.equal(after.total, 2, 'the vote still counts toward the tally');
    assert.equal(after.bearish, 1);
    assert.equal(listTakes(startup.id).length, 0, 'but the text is gone');
    assert.equal(redactTake(999999), false);
  });

  test('reports vanish with the listing they point at', () => {
    const { startup } = createStartup(parseStartup({ name: 'Cascade Co' }));
    fileReport({ startupId: startup.id, reason: 'test', reporter: 'r' });
    const before = listReports().length;
    deleteStartup('cascade-co');
    assert.equal(listReports().length, before - 1);
  });
});
