/* bullishorbearish.com — client.
   Everything user-submitted is written with textContent, never innerHTML. */

const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const STEPS = [['year', 31536e6], ['month', 2592e6], ['week', 6048e5],
               ['day', 864e5], ['hour', 36e5], ['minute', 6e4]];

function ago(stamp) {
  // SQLite hands back "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker.
  const then = new Date(`${String(stamp).replace(' ', 'T')}Z`);
  if (Number.isNaN(then.getTime())) return '';
  const delta = then - Date.now();
  for (const [unit, ms] of STEPS) {
    if (Math.abs(delta) >= ms) return RELATIVE.format(Math.round(delta / ms), unit);
  }
  return 'just now';
}

/* ------------------------------------------------------------- motion --- */
/* Every effect below is decoration. When the viewer asks for less motion they
   get the final state immediately, never a degraded animation. */
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Cursor-tracked glow. Written through CSSOM, which CSP allows where an
    inline style attribute would be blocked. */
function spotlight(node) {
  if (REDUCED) return node;
  node.addEventListener('pointermove', (event) => {
    const box = node.getBoundingClientRect();
    node.style.setProperty('--mx', `${event.clientX - box.left}px`);
    node.style.setProperty('--my', `${event.clientY - box.top}px`);
  });
  return node;
}

/** Ticks a number up to its value. Cubic ease-out over ~0.6s. */
function countUp(textNode, target) {
  if (REDUCED || target === 0) {
    textNode.nodeValue = String(target);
    return;
  }
  const started = performance.now();
  const step = (now) => {
    const t = Math.min((now - started) / 620, 1);
    textNode.nodeValue = String(Math.round(target * (1 - (1 - t) ** 3)));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Entrance delay for a list, capped so long boards don't crawl in. */
function stagger(node, index) {
  node.style.setProperty('--i', `${Math.min(index, 12) * 45}ms`);
  return node;
}

/* ------------------------------------------------------- shared pieces --- */
/** Two segments, proportional, with the stylesheet's 2px gap between them.
    Zero-count sides are omitted so the survivor keeps both rounded caps. */
function meter(s, { large = false } = {}) {
  const label = s.total
    ? `${s.bullishPct}% bullish, ${100 - s.bullishPct}% bearish, out of ${plural(s.total, 'vote')}`
    : 'No votes yet';
  const node = el('div', {
    class: `meter${large ? ' meter-lg' : ''}${s.total ? '' : ' meter-empty'}`,
    role: 'img', 'aria-label': label,
  });
  if (!s.total) return node;
  for (const [count, cls] of [[s.bullish, 'seg-bull'], [s.bearish, 'seg-bear']]) {
    if (!count) continue;
    const seg = el('span', { class: cls });
    seg.style.flex = `${count} 1 0px`;
    node.append(seg);
  }
  return node;
}

/** The odds readout. Values live in text beside the bar, so colour is never
    the only channel carrying the result. */
function odds(s) {
  if (!s.total) {
    return el('div', { class: 'odds' },
      el('span', { class: 'odd-empty', text: 'No calls yet — be first' }));
  }
  const bull = s.bullishPct;
  const side = (dir, value, arrow, label) => {
    const figure = document.createTextNode('0');
    countUp(figure, value);
    return el('div', { class: `odd odd-${dir}` },
      el('span', { class: 'odd-val' }, figure, el('i', { text: '%' })),
      el('span', { class: 'odd-label' },
        el('span', { 'aria-hidden': 'true', text: arrow }), label));
  };
  return el('div', { class: 'odds' },
    side('bull', bull, '▲', 'Bullish'),
    side('bear', 100 - bull, '▼', 'Bearish'));
}

function voteButtons(chosen, onPick) {
  const make = (dir, arrow, label) => el('button', {
    type: 'button',
    class: `vote vote-${dir === 'bullish' ? 'bull' : 'bear'}`,
    'aria-pressed': String(chosen === dir),
    onclick: () => onPick(dir),
  }, el('span', { class: 'arrow', 'aria-hidden': 'true', text: arrow }), label);
  return el('div', { class: 'votes' },
    make('bullish', '▲', 'Bullish'),
    make('bearish', '▼', 'Bearish'));
}

/* ----------------------------------------------------------- list view --- */
const SORT_TABS = [
  ['hot', 'Hot'],
  ['contested', 'Most debated'],
  ['bullish', 'Most bullish'],
  ['bearish', 'Most bearish'],
  ['votes', 'Most voted'],
  ['new', 'Newest'],
];

const state = { sort: 'hot', q: '' };

function card(s) {
  const node = spotlight(el('li', { class: 'card' }));

  const meta = el('div', { class: 'card-meta' });
  if (s.total) {
    meta.append(
      el('b', { text: s.total.toLocaleString() }), ' votes',
      el('span', { class: 'sep', text: '·' }),
      el('b', { text: s.takes.toLocaleString() }), ' takes');
  } else {
    meta.append('Awaiting first call');
  }
  meta.append(el('a', { href: `/s/${s.slug}`, text: s.takes ? 'Read takes →' : 'Say why →' }));

  node.append(
    el('div', {},
      el('div', { class: 'card-head' },
        el('a', { class: 'card-name', href: `/s/${s.slug}`, text: s.name }),
        s.website
          ? el('a', {
              class: 'card-site', href: s.website, rel: 'nofollow noopener ugc',
              target: '_blank', text: new URL(s.website).hostname.replace(/^www\./, ''),
            })
          : null),
      s.pitch ? el('p', { class: 'card-pitch', text: s.pitch }) : null),
    odds(s),
    meter(s),
    meta,
    voteButtons(null, async (direction) => {
      try {
        // No `reason` key: a quick call must not wipe a take written earlier.
        const { startup } = await api(`/api/startups/${s.slug}/votes`, {
          method: 'POST', body: { direction },
        });
        node.replaceWith(card(startup));
      } catch (err) {
        alert(err.message);
      }
    }),
  );
  return node;
}

function renderSorts() {
  const host = $('[data-sorts]');
  host.replaceChildren(...SORT_TABS.map(([key, label]) =>
    el('button', {
      type: 'button', role: 'tab', 'aria-selected': String(state.sort === key),
      text: label,
      onclick: () => { state.sort = key; renderSorts(); loadBoard(); },
    })));
}

async function loadBoard() {
  const board = $('[data-board]');
  const empty = $('[data-empty]');
  try {
    const params = new URLSearchParams({ sort: state.sort });
    if (state.q) params.set('q', state.q);
    const { startups } = await api(`/api/startups?${params}`);
    board.replaceChildren(...startups.map((s, i) => stagger(card(s), i)));
    empty.hidden = startups.length > 0;
    empty.textContent = state.q
      ? `Nothing on the board matches “${state.q}” yet. Add it above.`
      : 'The board is empty. Add the first startup above.';
  } catch (err) {
    board.replaceChildren();
    empty.hidden = false;
    empty.textContent = err.message;
  }
}

async function loadTape() {
  try {
    const s = await api('/api/stats');
    const pct = s.votes ? Math.round((s.bullish / s.votes) * 100) : null;
    const cell = (label, value, cls) =>
      el('span', {}, `${label} `, el('b', { class: cls || null, text: value }));
    $('[data-tape]').replaceChildren(
      cell('Startups', s.startups.toLocaleString()),
      cell('Votes', s.votes.toLocaleString()),
      cell('Takes', s.takes.toLocaleString()),
      cell('Lean', pct === null ? '—' : `${pct}% ▲`, pct === null ? null : pct >= 50 ? 'up' : 'down'),
    );
  } catch { /* the ticker is decorative; the board still works without it */ }
}

/* --------------------------------------------------------- detail view --- */
function takeItem(take) {
  return el('li', { class: 'take', dataset: { dir: take.direction } },
    el('div', { class: 'take-head' },
      el('span', { class: 'tag', dataset: { dir: take.direction } },
        el('span', { 'aria-hidden': 'true', text: take.direction === 'bullish' ? '▲' : '▼' }),
        take.direction === 'bullish' ? 'Bullish' : 'Bearish'),
      el('span', { class: 'take-who', text: take.author ? `— ${take.author}` : '— anonymous' }),
      el('span', { class: 'take-when', text: ago(take.updated_at) })),
    el('p', { text: take.reason }));
}

function renderDetail(host, data) {
  const s = data.startup;
  let chosen = data.you?.direction ?? null;
  document.title = `${s.name} — Bullish or Bearish`;

  const reason = el('textarea', {
    id: 'f-reason', maxlength: '700',
    placeholder: 'What makes you bullish or bearish? Be specific.',
  });
  const author = el('input', {
    id: 'f-author', maxlength: '40', placeholder: 'Anonymous', autocomplete: 'off',
  });
  if (data.you?.reason) reason.value = data.you.reason;
  if (data.you?.author) author.value = data.you.author;

  const msg = el('p', { class: 'hint', role: 'status' });
  const save = el('button', { class: 'btn btn-primary', type: 'submit', text: 'Post your take' });
  const buttons = el('div');
  const verdict = el('div', { class: 'verdict' });
  const statsPanel = el('div', { class: 'panel panel-meter' });

  /* Repaint only the numbers. Re-rendering the whole view here would swap the
     textarea out from under whoever is mid-sentence in it. */
  const paintStats = (startup) => {
    const lean = !startup.total ? 'none'
      : startup.bullishPct > 55 ? 'bullish'
      : startup.bullishPct < 45 ? 'bearish' : 'split';
    const text = {
      none: 'No calls yet',
      bullish: `The crowd is bullish · ${startup.bullishPct}%`,
      bearish: `The crowd is bearish · ${100 - startup.bullishPct}%`,
      split: `Split down the middle · ${startup.bullishPct}% bullish`,
    }[lean];
    verdict.dataset.lean = lean;
    verdict.replaceChildren(
      el('span', { 'aria-hidden': 'true',
        text: lean === 'bullish' ? '▲' : lean === 'bearish' ? '▼' : '◆' }),
      text);
    statsPanel.replaceChildren(
      odds(startup),
      meter(startup, { large: true }),
      el('div', { class: 'card-meta' },
        el('b', { text: startup.total.toLocaleString() }), ' votes',
        el('span', { class: 'sep', text: '·' }),
        el('b', { text: startup.takes.toLocaleString() }), ' written takes'));
  };

  const paintButtons = () => {
    buttons.replaceChildren(voteButtons(chosen, async (direction) => {
      chosen = direction;
      paintButtons();
      try {
        // No `reason` key: picking a side must not clear a take already written.
        const res = await api(`/api/startups/${s.slug}/votes`, {
          method: 'POST', body: { direction },
        });
        paintStats(res.startup);
        loadTape();
        msg.dataset.tone = 'good';
        msg.textContent = 'Call recorded. Add your reasoning below — that is the useful part.';
      } catch (err) {
        msg.dataset.tone = 'bad';
        msg.textContent = err.message;
      }
    }));
  };

  paintStats(s);
  paintButtons();

  host.replaceChildren(
    el('a', { class: 'back', href: '/', text: '← All startups' }),
    el('div', { class: 'detail-head' },
      el('div', {},
        el('h1', { text: s.name }),
        s.pitch ? el('p', { class: 'detail-pitch', text: s.pitch }) : null,
        s.website
          ? el('p', { class: 'detail-pitch' },
              el('a', { class: 'detail-site', href: s.website, rel: 'nofollow noopener ugc',
                        target: '_blank', text: new URL(s.website).hostname.replace(/^www\./, '') }))
          : null)),
    verdict,
    statsPanel,

    el('form', {
      class: 'panel voteform', novalidate: true,
      onsubmit: async (event) => {
        event.preventDefault();
        if (!chosen) {
          msg.dataset.tone = 'bad';
          msg.textContent = 'Pick bullish or bearish first.';
          return;
        }
        save.disabled = true;
        try {
          await api(`/api/startups/${s.slug}/votes`, {
            method: 'POST',
            body: { direction: chosen, reason: reason.value, author: author.value },
          });
          refreshDetail(host, s.slug);
        } catch (err) {
          msg.dataset.tone = 'bad';
          msg.textContent = err.message;
          save.disabled = false;
        }
      },
    },
      el('h2', { text: data.you ? 'Your call' : 'Make your call' }),
      el('p', { class: 'panel-sub', text: data.you
        ? 'You have already voted here — changing it updates your call rather than adding a second one.'
        : 'One vote per person. You can change it later.' }),
      buttons,
      el('div', { class: 'field' }, el('label', { for: 'f-reason', text: 'Why?' }), reason),
      el('div', { class: 'field' },
        el('label', { for: 'f-author' }, 'Your name ', el('span', { class: 'opt', text: 'optional' })),
        author),
      el('div', { class: 'addform-foot' }, msg, save)),

    el('h2', { class: 'section-label', text: data.takes.length
      ? `${plural(data.takes.length, 'take')} on ${s.name}`
      : `No written takes on ${s.name} yet` }),
    el('ul', { class: 'takes' }, ...data.takes.map((t, i) => stagger(takeItem(t), i))),
  );
}

async function refreshDetail(host, slug) {
  try {
    const data = await api(`/api/startups/${slug}`);
    renderDetail(host, data);
  } catch (err) {
    host.replaceChildren(
      el('a', { class: 'back', href: '/', text: '← All startups' }),
      el('p', { class: 'empty', text: err.message }));
  }
}

/* -------------------------------------------------------------- router --- */
const listView = $('[data-view="list"]');
const detailView = $('[data-view="detail"]');

function route() {
  const match = location.pathname.match(/^\/s\/([^/]+)\/?$/);
  if (match) {
    listView.hidden = true;
    detailView.hidden = false;
    detailView.replaceChildren(el('p', { class: 'empty', text: 'Loading…' }));
    refreshDetail(detailView, decodeURIComponent(match[1]));
  } else {
    detailView.hidden = true;
    listView.hidden = false;
    document.title = 'Bullish or Bearish — the open startup sentiment board';
    loadTape();
    loadBoard();
  }
}

function go(path) {
  const navigate = () => {
    history.pushState({}, '', path);
    route();
    window.scrollTo(0, 0);
  };
  if (document.startViewTransition && !REDUCED) document.startViewTransition(navigate);
  else navigate();
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('a');
  if (!link || link.target === '_blank' || event.metaKey || event.ctrlKey || event.shiftKey) return;
  const url = new URL(link.href, location.origin);
  if (url.origin !== location.origin) return;
  event.preventDefault();
  go(url.pathname);
});
window.addEventListener('popstate', route);

/* ---------------------------------------------------------- add + find --- */
$('[data-add-form]').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const msg = $('[data-add-msg]');
  const button = form.querySelector('button[type="submit"]');
  const body = Object.fromEntries(new FormData(form).entries());
  button.disabled = true;
  try {
    const { created, startup } = await api('/api/startups', { method: 'POST', body });
    msg.dataset.tone = 'good';
    msg.textContent = created ? 'Added.' : `${startup.name} is already on the board — taking you there.`;
    form.reset();
    setTimeout(() => go(`/s/${startup.slug}`), created ? 150 : 900);
  } catch (err) {
    msg.dataset.tone = 'bad';
    msg.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

let searchTimer;
$('[data-search]').addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  const value = event.target.value;
  searchTimer = setTimeout(() => { state.q = value.trim(); loadBoard(); }, 220);
});

renderSorts();
route();
