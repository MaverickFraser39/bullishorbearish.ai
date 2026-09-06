# Contributing

This is a small project on purpose. The whole thing is about 1,500 lines and
should stay readable in one sitting — that constraint is a feature, not an
accident of it being new.

## Running it

```bash
npm install
npm run seed
npm run dev      # http://localhost:3000
npm test
```

Node 22.13+ (for unflagged `node:sqlite`). Nothing else to install, nothing to compile.

To start over, delete `data/` and re-run `npm run seed`.

## What a good pull request looks like

- **One thing.** A PR that fixes a bug and also restyles the cards is two PRs.
- **A test if it touches `lib/`.** Anything about votes, dedupe, or ranking is
  logic other people rely on being correct.
- **No new dependencies without a reason in the PR description.** Zero build
  step and zero native modules are the reason anyone can clone this and have it
  running in thirty seconds. That's worth protecting.
- **No framework rewrites.** Vanilla is the choice, not a stage to grow out of.

## House rules in the code

- **Nothing user-submitted goes near `innerHTML`.** The client builds DOM nodes
  and sets `textContent`. Names and takes come from strangers.
- **Validate in `lib/validate.js`, never at the call site.** If a value reaches
  `lib/db.js` it has already been checked.
- **Colour never carries meaning alone.** Every bullish/bearish indicator needs
  an arrow and a written label too. The palette is chosen for colourblind
  separation and the reasoning is in the README — if you change a hue, re-check
  it rather than eyeballing it.
- **Comments explain *why*.** The what is already in the code.

## Ideas, roughly easiest first

- **Sector or tag filters** — "show me only fintech".
- **Sort takes by useful, not just recent** — needs some form of signal on takes.
- **An OG image per company** so shared links show the split.
- **A public data dump** — a nightly JSON export of the whole board. It's an open
  board; the data should be open too.
- **Sentiment over time** — the schema keeps timestamps, so a sparkline of how a
  company's split moved is mostly a query away.
- **Better vote integrity** — the current fingerprint is a speed bump (see the
  README). Anything stronger that doesn't require accounts is genuinely
  interesting.
- **Moderation** — there is currently none. Spam and abuse handling is the most
  valuable unbuilt thing here.

## Reporting something

Bugs and ideas both go in GitHub issues. If it's a security issue — anything
touching vote integrity, injection, or data exposure — please email rather than
opening a public issue.
