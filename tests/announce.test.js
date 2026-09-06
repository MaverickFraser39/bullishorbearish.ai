import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sign, _internals } from '../lib/announce.js';

describe('X request signing', () => {
  test('matches the reference vector published by X', () => {
    // https://developer.x.com/en/docs/authentication/oauth-1-0a/creating-a-signature
    const signature = sign('POST', 'https://api.twitter.com/1.1/statuses/update.json', {
      status: 'Hello Ladies + Gentlemen, a signed OAuth request!',
      include_entities: 'true',
      oauth_consumer_key: 'xvz1evFS4wEEPTGEFPHBog',
      oauth_nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: '1318622958',
      oauth_token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
      oauth_version: '1.0',
    },
    'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
    'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE');
    assert.equal(signature, 'hCtSmYh+iHYCEqBWrE7C7hYmtUk=');
  });

  test('percent-encoding follows RFC 3986, not encodeURIComponent', () => {
    // encodeURIComponent leaves these alone; OAuth requires them escaped.
    assert.equal(_internals.enc("!*'()"), '%21%2A%27%28%29');
    assert.equal(_internals.enc('a b'), 'a%20b');
    assert.equal(_internals.enc('~-._'), '~-._');
  });
});

describe('post text', () => {
  const startup = { name: 'Ramp', slug: 'ramp', bullishPct: 79, total: 14 };

  test('a new listing invites a call rather than reporting a tally', () => {
    const text = _internals.compose({ kind: 'listed', startup });
    assert.match(text, /is now on the board/);
    assert.match(text, /\/s\/ramp$/);
  });

  test('a tally update carries the split, the count and the direction', () => {
    const text = _internals.compose({ kind: 'vote', startup });
    assert.match(text, /79% bullish/);
    assert.match(text, /21% bearish/);
    assert.match(text, /14 votes/);
    assert.ok(text.startsWith('▲'));
  });

  test('a bearish majority flips the arrow', () => {
    const text = _internals.compose({ kind: 'vote', startup: { ...startup, bullishPct: 31 } });
    assert.ok(text.startsWith('▼'));
  });

  test('singular vote reads correctly', () => {
    const text = _internals.compose({ kind: 'vote', startup: { ...startup, total: 1, bullishPct: 100 } });
    assert.match(text, /across 1 vote\./);
  });

  test('every shape stays inside the 280 character limit', () => {
    const long = {
      name: 'A Startup With A Deliberately Very Long Name Indeed Ltd',
      slug: 'a-startup-with-a-deliberately-very-long-name-indeed-ltd',
      bullishPct: 100, total: 123456,
    };
    for (const kind of ['listed', 'vote', 'flip']) {
      const text = _internals.compose({ kind, startup: long });
      assert.ok(text.length <= 280, `${kind} was ${text.length} characters`);
    }
  });
});
