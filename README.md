# bullishorbearish.com

An open board for startup sentiment. Anyone can add a private company, call it
**bullish** or **bearish**, and — the part that actually matters — write down
*why*.

No accounts. No gatekeeping. No algorithmic feed. Just a list of companies, a
split bar showing where the crowd landed, and the arguments on both sides.

![The board](docs/screenshot.png)

## Why this exists

Startup sentiment already gets traded constantly — in group chats, on podcasts,
in replies. It just never gets written down anywhere durable or public. This is
the smallest thing that does that: a permanent, linkable page per company where
the bull case and the bear case sit next to each other.

The vote is the hook. The reasoning is the product.

## Quick start

Needs **Node 22.5 or newer** (for the built-in `node:sqlite`). There are no
native dependencies and no build step.

```bash
git clone https://github.com/MaverickFraser39/bullishorbearish.com.git
cd bullishorbearish.com
npm install
npm run seed     # optional: puts a sample board in place
npm run dev      # http://localhost:3000
```

`npm test` runs the suite. `npm start` runs it without the file watcher.

## How it's built

| | |
|---|---|
| Server | Express 5, one file (`server.js`) |
| Storage | SQLite through Node's built-in `node:sqlite` — no `better-sqlite3`, nothing to compile |
| Frontend | Vanilla JS modules and one stylesheet. No framework, no bundler, no build |
| Tests | `node:test` |

```
server.js          HTTP layer: routes, rate limiting, voter fingerprinting
lib/db.js          schema and every query — no SQL lives anywhere else
lib/validate.js    input parsing; nothing reaches the database unvalidated
public/            the whole client — index.html, app.js, styles.css, favicon.svg
scripts/seed.js    sample board
tests/             node:test suite
docs/              images used by this README
```

## Decisions worth knowing about

**The green isn't quite green.** Bullish/bearish wants red and green, but that
pair is the textbook colourblind failure — `#0ca30c` against `#d03b3b` separates
by only ΔE 4.1 under deuteranopia, where 8 is the passing bar. The bullish hue is
stepped toward teal (`#1baf7a`), which clears it at ΔE 9.9 while still reading as
green. On top of that, every sentiment indicator carries an arrow and a written
label, so hue is never the only thing carrying the meaning.

**Duplicates are the real enemy.** On a board anyone can post to, `OpenAI`,
`Open AI` and `open-ai` become three cards splitting one company's votes. Every
name is reduced to an alphanumeric key (`openai`) that decides identity, while a
separate readable slug (`open-ai`) is what appears in the URL.

**Thin samples don't top the charts.** Ranking uses a Laplace-smoothed ratio,
`(bullish + 1) / (total + 2)`, so a single enthusiastic vote can't outrank a
company sitting at 98% across forty.

**Changing your mind isn't a second vote.** Votes upsert on
`(startup, voter)`. Re-voting rewrites your call rather than stacking another
one. A quick vote from the board sends no `reason` field at all, which
deliberately means "leave my writing alone" — a blank one sent explicitly is
what clears it.

## The honest bit about vote integrity

Votes are anonymous, and identity is a salted SHA-256 of IP address plus user
agent. **This is a speed bump, not a wall.** Anyone with a VPN, a second browser,
or ten minutes can vote more than once. That is a deliberate trade — accounts
would kill the thing that makes this work, which is that voting costs nothing.

Treat every number here as directional, never authoritative. If you deploy this
somewhere that needs stronger guarantees, that's the layer to replace.

Set `VOTE_SALT` to a long random string in production and never change it —
rotating it lets everyone vote again.

## API

Everything the frontend does is a public JSON endpoint.

| Method | Path | |
|---|---|---|
| `GET` | `/api/startups?sort=&q=&limit=&offset=` | the board. `sort`: `hot`, `contested`, `bullish`, `bearish`, `votes`, `new` |
| `POST` | `/api/startups` | `{ name, website?, pitch? }` → `201` created, `200` if it already existed |
| `GET` | `/api/startups/:slug` | one company, your current vote, and its takes |
| `POST` | `/api/startups/:slug/votes` | `{ direction, reason?, author? }` |
| `GET` | `/api/stats` | board totals |

Writes are rate limited per IP: 8 new companies and 60 votes an hour.

## Deploying

Any host that runs Node and gives you a persistent disk. The only requirements:

- Set `VOTE_SALT` and keep it stable.
- Put `DB_PATH` on a volume that survives restarts — the SQLite file *is* the site.
- Run behind a proxy that sets `X-Forwarded-For`; the app trusts it for rate limiting.

```bash
VOTE_SALT="$(node -e 'console.log(crypto.randomUUID())')" \
DB_PATH=/var/lib/bob/board.db \
NODE_ENV=production npm start
```

Back up by copying the database file.

## Contributing

Pull requests welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Good first
issues live in the "Ideas" section there.

## Licence

MIT. See [LICENSE](LICENSE).

**This is not investment advice.** It is the opinion of anonymous strangers on
the internet, presented as such. Nothing here is a recommendation to buy, sell,
or hold anything.
