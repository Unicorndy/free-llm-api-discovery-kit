'use strict';

const token = new URLSearchParams(location.search).get('t') || '';
const $ = (id) => document.getElementById(id);
let renderedRequestId = null;
let renderedLogCount = 0;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session': token },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

function setConn(text, ok) {
  const c = $('conn');
  c.textContent = text;
  c.classList.toggle('ok', ok);
}

/* ---------- Rendering ---------- */
const STATUS_TEXT = { pending: 'Not started', active: 'In progress', done: 'Done', error: 'Needs attention', skipped: 'Skipped' };

function renderSteps(steps) {
  const list = $('steps');
  list.replaceChildren(...steps.map((s) => {
    const li = el('li', `step ${s.status}`);
    li.setAttribute('aria-current', s.status === 'active' ? 'step' : 'false');
    const text = el('div', 'step-text');
    text.append(el('span', 'step-title', s.title), el('span', 'step-detail', s.detail || STATUS_TEXT[s.status]));
    li.append(el('span', 'step-dot'), text);
    return li;
  }));
}

function renderLog(log) {
  const list = $('log');
  if (log.length < renderedLogCount) { list.replaceChildren(); renderedLogCount = 0; }
  for (const entry of log.slice(renderedLogCount)) {
    list.append(el('li', `entry ${entry.level}`, entry.msg));
  }
  renderedLogCount = log.length;
}

function renderResults(results) {
  const box = $('results');
  if (!results.siteUrl && !results.workerUrl) { box.hidden = true; return; }
  box.hidden = false;
  box.replaceChildren(el('h2', null, results.done ? 'Your site is ready' : 'So far'));
  const link = (label, href) => {
    const row = el('p', 'result-row');
    const a = el('a', null, href);
    a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
    row.append(el('span', 'result-label', label), a);
    return row;
  };
  if (results.siteUrl) box.append(link('Chat site', results.siteUrl));
  if (results.repoUrl) box.append(link('Code on GitHub', results.repoUrl));
  if (results.workerUrl) box.append(link('Site server', results.workerUrl));
  if (results.done) box.append(link('Revoke the setup token', 'https://github.com/settings/tokens'));
}

function renderRequest(req) {
  const card = $('request');
  if (!req) { card.hidden = true; card.replaceChildren(); renderedRequestId = null; return; }
  if (req.id === renderedRequestId) return; // keep what the person is typing
  renderedRequestId = req.id;
  card.hidden = false;
  card.replaceChildren(buildRequest(req));
  const first = card.querySelector('input:not([type=checkbox]):not([type=radio]), button.primary');
  if (first) first.focus({ preventScroll: true });
  card.scrollIntoView({ block: 'end', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

function buildRequest(req) {
  const wrap = el('div', 'request-inner');
  wrap.append(el('h2', null, req.title));
  if (req.body) wrap.append(el('p', 'request-body', req.body));
  if (req.url) {
    const a = el('a', 'request-link', 'Open this page in your own browser instead');
    a.href = req.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    wrap.append(a);
  }

  const error = el('p', 'request-error');
  const actions = el('div', 'request-actions');
  const buttons = [];

  const send = async (action, value) => {
    buttons.forEach((b) => { b.disabled = true; });
    error.textContent = '';
    try {
      await post('/api/respond', { id: req.id, action, value });
    } catch {
      error.textContent = "Couldn't reach the setup assistant. Check that it's still running in your terminal.";
      buttons.forEach((b) => { b.disabled = false; });
    }
  };
  const button = (label, cls, onClick) => {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    buttons.push(b);
    return b;
  };

  if (req.kind === 'text' || req.kind === 'key') {
    const field = el('div', 'field');
    const input = el('input');
    input.id = 'answer';
    input.type = req.kind === 'key' ? 'password' : 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = req.placeholder || '';
    if (req.value) input.value = req.value;
    const label = el('label', 'sr-only', req.kind === 'key' ? 'Key' : req.title);
    label.htmlFor = 'answer';
    field.append(label, input);
    if (req.kind === 'key') {
      const toggle = button('Show', 'link', () => {
        input.type = input.type === 'password' ? 'text' : 'password';
        toggle.textContent = input.type === 'password' ? 'Show' : 'Hide';
      });
      field.append(toggle);
    }
    wrap.append(field);
    if (req.watching) wrap.append(el('p', 'watching', 'Watching the browser window for your key…'));
    const submit = () => {
      if (!input.value.trim()) { error.textContent = req.kind === 'key' ? 'Paste the key first, or wait for me to pick it up.' : 'Type an answer first.'; input.focus(); return; }
      send('submit', input.value.trim());
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    actions.append(button(req.submitLabel || 'Continue', 'primary', submit));
    if (req.allowSkip) actions.append(button('Skip this service', 'ghost', () => send('skip')));
  }

  if (req.kind === 'multi' || req.kind === 'choice') {
    const group = el('fieldset', 'options');
    group.append(el('legend', 'sr-only', req.title));
    (req.options || []).forEach((o, i) => {
      const row = el('label', 'option');
      const input = el('input');
      input.type = req.kind === 'multi' ? 'checkbox' : 'radio';
      input.name = 'opt';
      input.value = o.value;
      input.checked = req.kind === 'multi' ? Boolean(o.checked) : i === 0;
      const text = el('span', 'option-text');
      text.append(el('span', 'option-label', o.label));
      if (o.hint) text.append(el('span', 'option-hint', o.hint));
      row.append(input, text);
      group.append(row);
    });
    wrap.append(group);
    actions.append(button(req.submitLabel || 'Continue', 'primary', () => {
      const checked = [...group.querySelectorAll('input:checked')].map((i) => i.value);
      send('submit', req.kind === 'multi' ? checked : checked[0]);
    }));
  }

  if (req.kind === 'confirm') {
    (req.options || []).forEach((o) => {
      actions.append(button(o.label, o.primary ? 'primary' : 'ghost', () => send('submit', o.value)));
    });
  }

  if (req.kind === 'action') {
    actions.append(button(req.submitLabel || "I'm done", 'primary', () => send('submit', true)));
    if (req.allowSkip) actions.append(button('Skip', 'ghost', () => send('skip')));
  }

  actions.append(button('Stop setup', 'stop', () => send('cancel')));
  wrap.append(actions, error);
  return wrap;
}

function render(state) {
  const started = state.running || state.log.length > 0;
  $('intro').hidden = started && !state.finished;
  $('intro').classList.toggle('compact', Boolean(state.finished));
  const start = $('start');
  start.hidden = state.running;
  start.textContent = state.finished ? 'Run setup again' : 'Start setup';
  renderSteps(state.steps);
  renderLog(state.log);
  renderResults(state.results);
  renderRequest(state.request);
  if (!state.request) {
    const feed = $('feed');
    feed.scrollTop = feed.scrollHeight;
  }
}

/* ---------- Connection ---------- */
function connect() {
  if (!token) {
    $('noToken').hidden = false;
    $('start').disabled = true;
    setConn('Not connected', false);
    return;
  }
  const events = new EventSource(`/events?t=${encodeURIComponent(token)}`);
  events.onopen = () => setConn('Connected', true);
  events.onerror = () => setConn('Reconnecting…', false);
  events.onmessage = (e) => {
    try { render(JSON.parse(e.data)); } catch (err) { console.error(err); }
  };
}

$('start').addEventListener('click', async () => {
  $('start').disabled = true;
  try { await post('/api/start'); } catch { setConn('Not connected', false); }
  $('start').disabled = false;
});

connect();
