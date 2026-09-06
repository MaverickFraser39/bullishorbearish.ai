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

/* ---------------------------------------------------------------- theme --- */
const THEME_KEY = 'bob:theme';
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
};

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  const dark = theme
    ? theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const icon = $('[data-theme-icon]');
  if (icon) icon.textContent = dark ? '☀' : '☾';
}

applyTheme(store.get(THEME_KEY));
$('[data-theme-toggle]').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  store.set(THEME_KEY, next);
  applyTheme(next);
});

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

/** The direct labels. Every number sits in text, so colour is never the only
    channel and the light-mode contrast relief is satisfied. */
function readout(s) {
  if (!s.total) {
    return el('div', { class: 'readout' },
      el('span', { class: 'rd-rest', text: 'No votes yet — be the first to call it.' }));
  }
  return el('div', { class: 'readout' },
    el('span', { class: 'rd-bull' },
      el('span', { 'aria-hidden': 'true' }, '▲ '),
      el('b', { text: `${s.bullishPct}% bullish` }), ` · ${s.bullish.toLocaleString()}`),
    el('span', { class: 'rd-bear' },
      el('span', { 'aria-hidden': 'true' }, '▼ '),
      el('b', { text: `${100 - s.bullishPct}% bearish` }), ` · ${s.bearish.toLocaleString()}`),
    el('span', { class: 'rd-rest',
      text: `${plural(s.total, 'vote')}${s.takes ? ` · ${plural(s.takes, 'take')}` : ''}` }));
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
  const node = el('li', { class: 'card' });

  const title = el('div', { class: 'card-title' },
    el('a', { class: 'card-name', href: `/s/${s.slug}`, text: s.name }),
    s.pitch ? el('p', { class: 'card-pitch', text: s.pitch }) : null);

  node.append(
    el('div', { class: 'card-head' }, title,
      s.website
        ? el('a', {
            class: 'card-site', href: s.website, rel: 'nofollow noopener ugc',
            target: '_blank', text: new URL(s.website).hostname.replace(/^www\./, ''),
          })
        : null),
    meter(s),
    readout(s),
    el('div', { class: 'card-foot' },
      voteButtons(null, async (direction) => {
        try {
          // No `reason` key: a quick call here must not wipe a take
          // this person already wrote on the detail page.
          const { startup } = await api(`/api/startups/${s.slug}/votes`, {
            method: 'POST', body: { direction },
          });
          node.replaceWith(card(startup));
        } catch (err) {
          alert(err.message);
        }
      }),
      el('a', { class: 'card-site', href: `/s/${s.slug}`,
                text: s.takes ? `Read ${plural(s.takes, 'take')} →` : 'Say why →' })),
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
    board.replaceChildren(...startups.map(card));
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

async function loadStats() {
  try {
    const s = await api('/api/stats');
    const pct = s.votes ? Math.round((s.bullish / s.votes) * 100) : null;
    $('[data-stats]').replaceChildren(
      ...[
        ['Startups', s.startups.toLocaleString()],
        ['Votes cast', s.votes.toLocaleString()],
        ['Written takes', s.takes.toLocaleString()],
        ['Crowd lean', pct === null ? '—' : `${pct}% bullish`],
      ].map(([label, value]) =>
        el('div', {}, el('dd', { text: value }), el('dt', { text: label }))));
  } catch { /* the stat strip is decorative; the board still works */ }
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

  const lean = !s.total ? 'none' : s.bullishPct > 55 ? 'bullish' : s.bullishPct < 45 ? 'bearish' : 'split';
  const verdictText = {
    none: 'No calls yet',
    bullish: `The crowd is bullish · ${s.bullishPct}%`,
    bearish: `The crowd is bearish · ${100 - s.bullishPct}%`,
    split: `Split down the middle · ${s.bullishPct}% bullish`,
  }[lean];

  const takesList = el('ul', { class: 'takes' }, ...data.takes.map(takeItem));
  const reason = el('textarea', {
    id: 'f-reason', maxlength: '700', placeholder: 'What makes you bullish or bearish? Be specific.',
  });
  const author = el('input', { id: 'f-author', maxlength: '40', placeholder: 'Anonymous', autocomplete: 'off' });
  if (data.you?.reason) reason.value = data.you.reason;
  if (data.you?.author) author.value = data.you.author;

  const msg = el('p', { class: 'hint', role: 'status' });
  const buttons = el('div');

  const paint = () => {
    buttons.replaceChildren(voteButtons(chosen, async (direction) => {
      chosen = direction;
      paint();
      try {
        await api(`/api/startups/${s.slug}/votes`, { method: 'POST', body: { direction } });
        msg.dataset.tone = 'good';
        msg.textContent = 'Call recorded. Add your reasoning below — that is the useful part.';
        refreshDetail(host, s.slug, { keepDraft: { reason: reason.value, author: author.value } });
      } catch (err) {
        msg.dataset.tone = 'bad';
        msg.textContent = err.message;
      }
    }));
  };
  paint();

  const save = el('button', { class: 'btn btn-primary', type: 'submit', text: 'Post your take' });

  host.replaceChildren(
    el('a', { class: 'back', href: '/', text: '← All startups' }),
    el('div', { class: 'detail-head' },
      el('div', {},
        el('h1', { text: s.name }),
        s.pitch ? el('p', { class: 'detail-pitch', text: s.pitch }) : null,
        s.website
          ? el('p', { class: 'detail-pitch' },
              el('a', { class: 'card-site', href: s.website, rel: 'nofollow noopener ugc',
                        target: '_blank', text: new URL(s.website).hostname.replace(/^www\./, '') }))
          : null)),
    el('div', { class: 'verdict', dataset: { lean } },
      el('span', { 'aria-hidden': 'true', text: lean === 'bullish' ? '▲' : lean === 'bearish' ? '▼' : '◆' }),
      verdictText),

    el('div', { class: 'panel panel-meter' },
      meter(s, { large: true }),
      readout(s)),

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
      el('div', { class: 'field' },
        el('label', { for: 'f-reason', text: 'Why?' }), reason),
      el('div', { class: 'field' },
        el('label', { for: 'f-author' }, 'Your name ', el('span', { class: 'opt', text: 'optional' })), author),
      el('div', { class: 'addform-foot' }, msg, save)),

    el('h2', { class: 'panel-sub', text: data.takes.length
      ? `${plural(data.takes.length, 'take')} on ${s.name}`
      : `No written takes on ${s.name} yet.` }),
    takesList,
  );

  // Restore an in-progress draft after a re-render triggered by a quick vote.
  if (host.dataset.draftReason) { reason.value = host.dataset.draftReason; delete host.dataset.draftReason; }
  if (host.dataset.draftAuthor) { author.value = host.dataset.draftAuthor; delete host.dataset.draftAuthor; }
}

async function refreshDetail(host, slug, { keepDraft } = {}) {
  try {
    const data = await api(`/api/startups/${slug}`);
    if (keepDraft) {
      host.dataset.draftReason = keepDraft.reason ?? '';
      host.dataset.draftAuthor = keepDraft.author ?? '';
    }
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
    loadStats();
    loadBoard();
  }
}

function go(path) {
  history.pushState({}, '', path);
  route();
  window.scrollTo(0, 0);
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
