/**
 * Puts a realistic board in front of anyone who has just cloned the repo:
 * a spread of sentiment, some genuinely contested, with written takes on both
 * sides so every sort and the split meter have something to show.
 *
 * Safe to re-run. Names dedupe, and each sample voter has a stable fingerprint,
 * so re-running updates their vote instead of stacking new ones.
 */
import { createStartup, castVote, stats } from '../lib/db.js';
import { parseStartup, parseVote } from '../lib/validate.js';

const SAMPLES = [
  {
    name: 'Anthropic', website: 'anthropic.com',
    pitch: 'Frontier AI research and the Claude models',
    bullish: 7, bearish: 2,
    takes: [
      ['bullish', 'Enterprise trust is the moat nobody can shortcut. Being the safety-forward option is a procurement advantage, not just a posture.', 'priya'],
      ['bullish', 'Claude is the default in developer tooling right now. Distribution through other products beats owning the end app.', 'devon'],
      ['bearish', 'Compute costs scale with usage in a way that makes the unit economics genuinely hard until inference gets cheaper.', 'marcus'],
    ],
  },
  {
    name: 'Ramp', website: 'ramp.com',
    pitch: 'Corporate cards and spend management',
    bullish: 11, bearish: 3,
    takes: [
      ['bullish', 'They ship faster than anyone in fintech and the savings pitch sells itself in a tight budget year.', 'anita'],
      ['bearish', 'Interchange revenue is a thin foundation. One rate change and the whole model needs rewriting.', 'tom'],
    ],
  },
  {
    name: 'Linear', website: 'linear.app',
    pitch: 'Issue tracking built for software teams',
    bullish: 9, bearish: 1,
    takes: [
      ['bullish', 'The only project tool engineers actually ask to use. Bottom-up adoption inside big orgs is already happening.', 'sam'],
    ],
  },
  {
    name: 'Perplexity', website: 'perplexity.ai',
    pitch: 'Answer engine for the open web',
    bullish: 6, bearish: 6,
    takes: [
      ['bullish', 'They changed what people expect a search box to do. That habit shift is worth more than the current revenue suggests.', 'jules'],
      ['bearish', 'Competing with Google on search economics while paying inference costs per query is a brutal place to be.', 'ken'],
      ['bearish', 'Publisher relationships are unresolved and that is a legal overhang, not a footnote.', 'rosa'],
    ],
  },
  {
    name: 'Cursor', website: 'cursor.com',
    pitch: 'AI-native code editor',
    bullish: 8, bearish: 5,
    takes: [
      ['bullish', 'Fastest product-market fit I have watched happen in dev tools. Real teams pay for seats out of real budgets.', 'wei'],
      ['bearish', 'The editor layer is the thinnest part of the stack. If the model providers ship this natively it evaporates.', 'nadia'],
    ],
  },
  {
    name: 'Figma', website: 'figma.com',
    pitch: 'Collaborative interface design',
    bullish: 5, bearish: 4,
    takes: [
      ['bearish', 'Design tools are the most exposed category to generative AI. The value moves to whoever generates the artefact.', 'omar'],
      ['bullish', 'Multiplayer collaboration is the sticky part, not the vector editing. That does not get automated away.', 'lena'],
    ],
  },
];

let voterSeq = 0;
const nextVoter = () => `seed-voter-${voterSeq++}`;

for (const sample of SAMPLES) {
  const { name, website, pitch, bullish, bearish, takes } = sample;
  const { startup, created } = createStartup(parseStartup({ name, website, pitch }));

  voterSeq = 0; // stable fingerprints per startup, so re-running is idempotent
  for (const [direction, reason, author] of takes) {
    castVote({
      startupId: startup.id,
      ...parseVote({ direction, reason, author }),
      voterKey: `${startup.slug}:${nextVoter()}`,
    });
  }
  // Silent voters, to make the tallies look like a real board rather than a demo.
  const written = takes.reduce((acc, [dir]) => ({ ...acc, [dir]: (acc[dir] ?? 0) + 1 }), {});
  for (const [direction, target] of [['bullish', bullish], ['bearish', bearish]]) {
    for (let i = written[direction] ?? 0; i < target; i += 1) {
      castVote({
        startupId: startup.id,
        ...parseVote({ direction }),
        voterKey: `${startup.slug}:${nextVoter()}`,
      });
    }
  }
  console.log(`${created ? 'added ' : 'update'}  ${name.padEnd(12)} ${bullish}▲ / ${bearish}▼`);
}

const s = stats();
console.log(`\nboard: ${s.startups} startups · ${s.votes} votes · ${s.takes} written takes · ${Math.round(s.bullish / s.votes * 100)}% bullish`);
