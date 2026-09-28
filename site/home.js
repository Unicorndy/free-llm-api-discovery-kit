// Free LLM API discovery page.
// Data: directory.json (curated providers), providers.json (daily model tests), SERVER/discoveries (web search).
// Everything from the network is rendered with textContent; links must be https. API keys typed here are
// sent only from this browser to the provider being tested and are never stored.
// Don't run inside another site's frame (clickjacking): break out, or hide the page if that's blocked.
if (window.top !== window.self) {
  try { window.top.location.replace(window.location.href); } catch { document.documentElement.style.display = 'none'; }
}
(() => {
  const CONFIG = window.SEARCH_CHAT_CONFIG || {};
  const SERVER = /^https:\/\//.test(CONFIG.workerUrl || '') ? CONFIG.workerUrl.replace(/\/+$/, '') : '';
  const $ = (id) => document.getElementById(id);
  const state = { directory: [], catalog: null, web: null, filter: 'all' };

  /* ---------- helpers ---------- */
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function httpsUrl(v) {
    try { const u = new URL(String(v || '')); return u.protocol === 'https:' ? u.href : ''; } catch { return ''; }
  }
  function link(href, text) {
    const url = httpsUrl(href);
    if (!url) return null;
    const a = el('a', '', text);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer nofollow';
    return a;
  }
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const baseDomain = (h) => String(h || '').split('.').slice(-2).join('.');
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const ago = (iso) => {
    const ms = Date.now() - Date.parse(iso);
    if (!isFinite(ms)) return '';
    const m = Math.round(ms / 60000);
    return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
  };
  async function getJSON(url) {
    const r = await fetch(url, { credentials: 'omit', cache: 'no-cache' });
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  }
  function codeBlock(text) {
    const wrap = el('div', 'code-block');
    const pre = el('pre');
    pre.append(el('code', '', text));
    const btn = el('button', 'copy', 'Copy');
    btn.type = 'button';
    btn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; } catch { btn.textContent = 'Select and copy'; }
      setTimeout(() => { btn.textContent = 'Copy'; }, 1600);
    });
    wrap.append(pre, btn);
    return wrap;
  }

  /* ---------- merge data ---------- */
  function siteInfo(p) {
    const c = state.catalog && p.siteProvider && state.catalog.providers.find((x) => x.id === p.siteProvider);
    if (!c || !c.configured) return null;
    const ok = (c.models || []).filter((m) => m.ok === true);
    return { working: ok.length, models: ok.map((m) => m.id) };
  }
  function matchKnown(w) {
    const d = baseDomain(hostOf(w.website));
    const n = norm(w.name);
    return state.directory.find((p) => (d && p.domains.includes(d)) ||
      p.aliases.some((a) => n === norm(a) || n.startsWith(norm(a) + ' ')) || (w.known && w.known === p.siteProvider));
  }
  function webSplit() {
    const found = new Map();
    const fresh = [];
    for (const w of (state.web && state.web.providers) || []) {
      const k = matchKnown(w);
      if (k) found.set(k.id, w);
      else fresh.push(w);
    }
    return { found, fresh };
  }

  /* ---------- setup guide ---------- */
  function envName(id) { return (String(id).replace(/[^a-z0-9]+/gi, '_').toUpperCase() || 'PROVIDER') + '_API_KEY'; }

  // Values can come from untrusted web data, so every one is quoted for its language:
  // shell single quotes for curl, JSON string literals (also valid in Python) for Python and JavaScript.
  const sh = (v) => "'" + String(v).replace(/'/g, "'\\''") + "'";
  const lit = (v) => JSON.stringify(String(v));

  function snippets(p, chatUrl, model) {
    const v = envName(p.id); // letters, digits and _ only
    const keyless = p.keyRequired === false;
    const auth = keyless ? '' : `  -H "Authorization: Bearer $${v}" \\\n`;
    const body = JSON.stringify({ model, messages: [{ role: 'user', content: 'Hello!' }] });
    const curl = `curl ${sh(chatUrl)} \\\n${auth}  -H "Content-Type: application/json" \\\n  -d ${sh(body)}`;
    const py = p.chatUrl
      ? `import os, requests\n\nr = requests.post(\n    ${lit(chatUrl)},\n${keyless ? '' : `    headers={"Authorization": f"Bearer {os.environ['${v}']}"},\n`}    json={"model": ${lit(model)}, "messages": [{"role": "user", "content": "Hello!"}]},\n    timeout=60,\n)\nprint(r.json()["choices"][0]["message"]["content"])`
      : `import os\nfrom openai import OpenAI   # pip install openai\n\nclient = OpenAI(\n    base_url=${lit(p.baseUrl)},\n    api_key=${keyless ? '"none"' : `os.environ["${v}"]`},\n)\nreply = client.chat.completions.create(\n    model=${lit(model)},\n    messages=[{"role": "user", "content": "Hello!"}],\n)\nprint(reply.choices[0].message.content)`;
    const js = `const res = await fetch(${lit(chatUrl)}, {\n  method: "POST",\n  headers: {\n${keyless ? '' : `    Authorization: \`Bearer \${process.env.${v}}\`,\n`}    "Content-Type": "application/json",\n  },\n  body: JSON.stringify({ model: ${lit(model)}, messages: [{ role: "user", content: "Hello!" }] }),\n});\nconsole.log((await res.json()).choices[0].message.content);`;
    return { curl, Python: py, JavaScript: js };
  }

  function tabs(sn) {
    const box = el('div', 'tabs');
    const bar = el('div', 'tabbar');
    const panel = el('div');
    const show = (name) => {
      panel.replaceChildren(codeBlock(sn[name]));
      bar.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.t === name));
    };
    Object.keys(sn).forEach((name) => {
      const b = el('button', 'chip', name);
      b.type = 'button';
      b.dataset.t = name;
      b.addEventListener('click', () => show(name));
      bar.append(b);
    });
    box.append(bar, panel);
    show('curl');
    return box;
  }

  function keyTest(p, model) {
    const form = el('div', 'keytest');
    const needsKey = p.keyRequired !== false;
    const baseIn = el('input');
    baseIn.type = 'url';
    baseIn.value = p.chatUrl || (p.baseUrl ? p.baseUrl + '/chat/completions' : '');
    baseIn.setAttribute('aria-label', 'Chat completions URL');
    baseIn.spellcheck = false;
    const modelIn = el('input');
    modelIn.value = model;
    modelIn.setAttribute('aria-label', 'Model');
    modelIn.spellcheck = false;
    const keyIn = el('input');
    keyIn.type = 'password';
    keyIn.autocomplete = 'off';
    keyIn.placeholder = needsKey ? 'Paste your API key' : 'No key needed (optional)';
    keyIn.setAttribute('aria-label', 'API key');
    const btn = el('button', 'primary', needsKey ? 'Test my key' : 'Test it now');
    btn.type = 'button';
    const out = el('p', 'test-out');
    out.setAttribute('role', 'status');

    btn.addEventListener('click', async () => {
      const url = httpsUrl(baseIn.value.trim());
      if (!url) { out.textContent = 'Enter an https:// URL.'; return; }
      if (url.includes('YOUR_ACCOUNT_ID')) { out.textContent = 'Replace YOUR_ACCOUNT_ID in the URL with your Cloudflare account ID first.'; return; }
      const key = keyIn.value.trim();
      if (needsKey && !key) { out.textContent = 'Paste a key first.'; return; }
      btn.disabled = true;
      out.className = 'test-out';
      out.textContent = `Calling ${hostOf(url)} from your browser…`;
      const started = performance.now();
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
          body: JSON.stringify({ model: modelIn.value.trim(), messages: [{ role: 'user', content: 'Reply with the single word: pong' }], max_tokens: 20 }),
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal: AbortSignal.timeout(30000),
        });
        const secs = ((performance.now() - started) / 1000).toFixed(1);
        let j = null;
        try { j = await res.json(); } catch { /* not JSON */ }
        const detail = j && j.error ? String(j.error.message || j.error).slice(0, 160) : '';
        if (res.ok) {
          const reply = String((j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim().slice(0, 120);
          if (/pong/i.test(reply)) {
            out.className = 'test-out ok';
            out.textContent = `It works. The model replied “${reply}” in ${secs} s.`;
          } else {
            out.className = 'test-out bad';
            out.textContent = `The API answered, but not with the expected reply: “${reply || '(empty)'}”. It may be out of quota, or the model didn't follow the instruction.`;
          }
        } else if (res.status === 401 || res.status === 403) {
          out.className = 'test-out bad';
          out.textContent = `The provider rejected the key (HTTP ${res.status}). ${detail}`;
        } else if (res.status === 404 || res.status === 400) {
          out.className = 'test-out bad';
          out.textContent = `The key may be fine, but the model or URL wasn't accepted (HTTP ${res.status}). ${detail}`;
        } else if (res.status === 429) {
          out.className = 'test-out bad';
          out.textContent = 'Rate limit reached. The key works, but wait a moment before trying again.';
        } else {
          out.className = 'test-out bad';
          out.textContent = `The provider answered HTTP ${res.status}. ${detail}`;
        }
      } catch (err) {
        out.className = 'test-out bad';
        out.textContent = err.name === 'TimeoutError'
          ? 'No answer within 30 seconds.'
          : 'Your browser was not allowed to call this API directly (CORS). That is normal for server-only APIs, and your key may still be fine: run the curl command above instead.';
      } finally {
        btn.disabled = false;
      }
    });

    const row = el('div', 'kt-row');
    row.append(keyIn, btn);
    form.append(
      el('label', 'kt-label', 'Chat URL'), baseIn,
      el('label', 'kt-label', 'Model'), modelIn,
      row,
      el('p', 'muted small', `Your key goes straight from this browser to ${hostOf(baseIn.value) || 'the provider'}. It is not sent to this site and not saved.`),
      out,
    );
    return form;
  }

  function guide(p, extra) {
    const body = el('div');
    const steps = el('ol', 'steps');
    const model = p.exampleModel || (extra && extra.model) || 'MODEL_NAME';
    const add = (title, ...nodes) => { const li = el('li'); li.append(el('h4', '', title), ...nodes.filter(Boolean)); steps.append(li); };

    if (p.keyRequired === false) {
      add('No account needed', el('p', '', 'This API answers without a key. A free account may give higher limits.'));
    } else {
      const s1 = el('p');
      const a = link(p.signupUrl || p.website, 'Create a free account');
      s1.append(a || el('span', '', 'Create a free account on the provider\'s website'), document.createTextNode(p.freeTier ? ` (${p.freeTier})` : ''));
      add('Sign up', s1);
      const s2 = el('p');
      const k = link(p.keyUrl || p.signupUrl || p.website, 'Open the API key page');
      s2.append(k || el('span', '', 'Find the API keys page in your account'), document.createTextNode(' and create a key.'));
      add('Get an API key', s2, p.keyHint ? el('p', 'muted small', p.keyHint) : null,
        el('p', 'muted small', 'Keep the key on your server, in an environment variable. Never put it in a public repo or web page.'),
        codeBlock(`export ${envName(p.id)}="paste-your-key-here"`));
    }
    if (p.baseUrl) {
      const chatUrl = p.chatUrl || `${p.baseUrl}/chat/completions`;
      add('Call it', el('p', '', 'It uses the OpenAI format, so most AI libraries work by changing the base URL.'),
        codeBlock(`Base URL: ${p.baseUrl}\nModel:    ${model}`), tabs(snippets(p, chatUrl, model)));
      add(p.keyRequired === false ? 'Test it here' : 'Test your key here', keyTest(p, model));
    } else {
      add('API details', el('p', '', 'No API address was confirmed yet. Check the provider\'s documentation:'), link(p.docsUrl || p.website, 'Open the docs'));
    }
    if (extra && extra.chatLink) {
      const a = el('a', 'primary as-button', 'Try it in the test chat');
      a.href = extra.chatLink;
      add('Try it', a);
    }
    body.append(steps);
    return body;
  }

  /* ---------- cards ---------- */
  function badge(text, cls) { return el('span', 'badge ' + (cls || ''), text); }

  function card(p, { badges, links, extra, flags }) {
    const node = $('cardTpl').content.firstElementChild.cloneNode(true);
    node.querySelector('.pname').textContent = p.name;
    const b = node.querySelector('.badges');
    badges.forEach((x) => b.append(x));
    node.querySelector('.ptier').textContent = p.freeTier || '';
    const l = node.querySelector('.plinks');
    links.filter(Boolean).forEach((a) => l.append(a));
    const det = node.querySelector('.guide');
    det.addEventListener('toggle', () => {
      const gb = det.querySelector('.guide-body');
      if (det.open && !gb.firstChild) gb.append(guide(p, extra));
    }, { once: false });
    Object.entries(flags).forEach(([k, v]) => { node.dataset[k] = v ? '1' : '0'; });
    return node;
  }

  function renderKnown() {
    const { found } = webSplit();
    const list = $('knownList');
    list.replaceChildren();
    for (const p of state.directory) {
      const site = siteInfo(p);
      const web = found.get(p.id);
      const badges = [];
      if (p.keyRequired === false) badges.push(badge('No key needed', 'on'));
      if (site && site.working) badges.push(badge(`${site.working} models tested today`, 'on'));
      if (/^yes/i.test(p.trainsOnData)) badges.push(badge('Trains on your data', 'warn'));
      if (/^no/i.test(p.trainsOnData)) badges.push(badge("Doesn't train on your data"));
      if (p.browserCalls === 'yes') badges.push(badge('Works from the browser'));
      if (web) badges.push(badge('Found on the web today'));
      let chatLink = '';
      if (site && site.working) chatLink = `chat.html?model=${encodeURIComponent(`${p.siteProvider}/${site.models[0]}`)}`;
      else if (p.id === 'pollinations') chatLink = 'chat.html?provider=pollinations';
      else if (p.baseUrl && !p.baseUrl.includes('YOUR_')) chatLink = `chat.html?provider=custom&base=${encodeURIComponent(p.baseUrl)}&model=${encodeURIComponent(p.exampleModel || '')}`;
      list.append(card(p, {
        badges,
        links: [link(p.website, 'Website'), link(p.keyUrl, 'Get a key'), link(p.docsUrl, 'Docs')],
        extra: { chatLink },
        flags: { keyless: p.keyRequired === false, working: Boolean(site && site.working), private: /^no/i.test(p.trainsOnData) },
      }));
    }
  }

  function renderWeb() {
    const { fresh } = webSplit();
    const list = $('webList');
    list.replaceChildren();
    if (!state.web || !state.web.at) {
      list.append(el('p', 'muted', 'No web search has run yet. Press Run discovery.'));
      return;
    }
    if (!fresh.length) {
      list.append(el('p', 'muted', 'The latest web search found no providers beyond the ones above.'));
      return;
    }
    const order = { working: 0, 'needs-key': 1, unverified: 2, failed: 3 };
    fresh.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
    for (const w of fresh) {
      const badges = [];
      if (w.status === 'working') badges.push(badge('Works without a key', 'on'));
      else if (w.status === 'needs-key') badges.push(badge('Needs a key'));
      else if (w.status === 'failed') badges.push(badge('Test failed', 'off'));
      else badges.push(badge('Not tested', 'off'));
      const p = {
        id: w.id, name: w.name, website: w.website, signupUrl: w.signupUrl, docsUrl: w.docsUrl, keyUrl: '',
        baseUrl: w.baseUrl, keyRequired: w.status === 'working' ? false : w.keyRequired, exampleModel: w.testedModel || '',
        freeTier: w.freeTier,
      };
      const chatLink = w.status === 'working' && w.testedModel ? `chat.html?model=${encodeURIComponent(`community/${w.id}/${w.testedModel}`)}` : '';
      const c = card(p, {
        badges,
        links: [link(w.website, 'Website'), link(w.signupUrl, 'Sign up'), link(w.docsUrl, 'Docs')],
        extra: { chatLink, model: w.testedModel },
        flags: { keyless: w.status === 'working', working: w.status === 'working', private: false },
      });
      if (w.sources && w.sources.length) {
        const src = el('p', 'sources-line muted small', 'Sources: ');
        w.sources.forEach((s, i) => {
          const a = link(s.url, s.title || hostOf(s.url));
          if (a) { if (i) src.append(document.createTextNode(' · ')); src.append(a); }
        });
        c.querySelector('.plinks').after(src);
      }
      if (w.status === 'failed' && w.error) c.querySelector('.ptier').after(el('p', 'muted small', `Test: ${w.error}`));
      if (w.deepResult) c.querySelector('.ptier').after(el('p', 'muted small', `Docs check: ${w.deepResult}`));
      list.append(c);
    }
  }

  function renderReady() {
    const box = $('readyList');
    box.replaceChildren();
    const data = (state.catalog && state.catalog.data) || [];
    // Verified keyless models found on the web (kept across searches, re-tested daily).
    const seen = new Set();
    const community = [...((state.web && state.web.community) || []), ...((state.web && state.web.providers) || []).filter((w) => w.status === 'working' && w.testedModel)]
      .filter((w) => w.testedModel && !seen.has(w.id) && seen.add(w.id))
      .map((w) => ({ id: `community/${w.id}/${w.testedModel}`, name: `${w.name}: ${w.testedModel} (found on the web${w.source === 'docs' ? ', API from its docs' : ''}, unverified)` }));
    const all = [...data, ...community];
    if (!all.length) { box.append(el('p', 'muted', 'The daily check has not produced a list yet.')); return; }
    const ul = el('ul', 'ready');
    all.forEach((m, i) => {
      const li = el('li');
      if (i >= 8) li.hidden = true;
      li.append(el('span', '', m.name || m.id));
      const a = el('a', 'try', 'Try');
      a.href = `chat.html?model=${encodeURIComponent(m.id)}`;
      li.append(a);
      ul.append(li);
    });
    box.append(ul);
    if (all.length > 8) {
      const more = el('button', 'link', `Show all ${all.length}`);
      more.type = 'button';
      more.addEventListener('click', () => { ul.querySelectorAll('li[hidden]').forEach((li) => { li.hidden = false; }); more.remove(); });
      box.append(more);
    }
  }

  // Models in the order they first passed a test (newest first): approved providers' models from the
  // daily job, plus keyless APIs found on the web.
  function renderNew() {
    const box = $('newList');
    box.replaceChildren();
    const entries = [
      ...((state.catalog && state.catalog.data) || []).filter((m) => m.firstWorking)
        .map((m) => ({ id: m.id, name: m.name || m.id, date: m.firstWorking, note: '' })),
      ...((state.web && state.web.community) || []).filter((c) => c.testedModel)
        .map((c) => ({ id: `community/${c.id}/${c.testedModel}`, name: `${c.name}: ${c.testedModel}`, date: c.firstFound || c.checked, note: c.source === 'docs' ? 'found on the web (API from its docs), unverified' : 'found on the web, unverified' })),
    ].filter((x) => !isNaN(Date.parse(x.date))).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    if (!entries.length) { box.append(el('p', 'muted', 'No tested models yet. The daily check adds them here.')); return; }
    const ul = el('ul', 'ready newlist');
    entries.forEach((m, i) => {
      const li = el('li');
      if (i >= 10) li.hidden = true;
      const left = el('div', 'nl-main');
      const title = el('span', 'nl-name', m.name);
      if (Date.now() - Date.parse(m.date) < 7 * 86400e3) left.append(el('span', 'badge on', 'NEW'));
      left.append(title);
      const meta = el('span', 'nl-meta', `first worked ${new Date(m.date).toLocaleDateString()}${m.note ? ' · ' + m.note : ''}`);
      left.append(meta);
      const a = el('a', 'try', 'Try');
      a.href = `chat.html?model=${encodeURIComponent(m.id)}`;
      li.append(left, a);
      ul.append(li);
    });
    box.append(ul);
    if (entries.length > 10) {
      const more = el('button', 'link', `Show all ${entries.length}`);
      more.type = 'button';
      more.addEventListener('click', () => { ul.querySelectorAll('li[hidden]').forEach((li) => { li.hidden = false; }); more.remove(); });
      box.append(more);
    }
  }

  function renderStats() {
    const { fresh } = webSplit();
    const ready = ((state.catalog && state.catalog.data) || []).length;
    const s = $('stats');
    s.replaceChildren();
    [[state.directory.length, 'curated free providers'], [fresh.length, 'new on the web'], [ready, 'models working on this site']]
      .forEach(([n, label]) => { const d = el('div', 'stat'); d.append(el('strong', '', String(n)), el('span', '', label)); s.append(d); });
    $('lastRun').textContent = state.web && state.web.at
      ? `Last web search ${ago(state.web.at)} (${state.web.pagesRead || 0} pages read).`
      : '';
  }

  function applyFilter() {
    document.querySelectorAll('.filters .chip').forEach((b) => b.classList.toggle('on', b.dataset.filter === state.filter));
    document.querySelectorAll('.pcard').forEach((c) => {
      c.hidden = state.filter !== 'all' && c.dataset[state.filter] !== '1';
    });
  }

  function renderAll() { renderNew(); renderKnown(); renderWeb(); renderReady(); renderStats(); applyFilter(); }

  /* ---------- live discovery (server-sent events) ---------- */
  async function runDiscovery() {
    const btn = $('runDiscovery');
    const log = $('log');
    if (!SERVER) { log.hidden = false; log.replaceChildren(el('li', 'bad', 'This site has no server set up, so it cannot search the web.')); return; }
    btn.disabled = true;
    btn.textContent = 'Searching…';
    log.hidden = false;
    log.replaceChildren();
    const line = (text, cls) => { const li = el('li', cls, text); log.append(li); log.scrollTop = log.scrollHeight; };
    const before = state.web && state.web.at ? Date.parse(state.web.at) : 0;
    let lastStatus = '';
    let gotResult = false;
    let gotError = false;
    try {
      const res = await fetch(SERVER + '/discover', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', credentials: 'omit',
      });
      if (!res.ok || !res.body) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).error.message; } catch { /* keep status */ }
        throw new Error(msg);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i).trim();
          buf = buf.slice(i + 2);
          if (!chunk.startsWith('data:')) continue;
          let e;
          try { e = JSON.parse(chunk.slice(5)); } catch { continue; }
          if (e.type === 'status') { lastStatus = e.message; line(e.message); }
          else if (e.type === 'found' && e.provider) line(`${e.provider.name}: ${e.provider.status === 'working' ? 'works without a key' : e.provider.status}`, e.provider.status === 'working' ? 'ok' : '');
          else if (e.type === 'error') { gotError = true; line(e.message, 'bad'); }
          else if (e.type === 'result' && e.data) {
            gotResult = true;
            state.web = e.data;
            line(e.cached ? 'Done (recent results).' : `Done: ${(e.data.providers || []).length} providers found.`, 'ok');
            renderAll();
          }
        }
      }
      if (!gotResult && !gotError) throw new Error('the connection ended before the results arrived');
    } catch (err) {
      reportProblem('discover', err.message, lastStatus);
      // The search keeps running on the server even if this connection drops: wait for its result.
      line(`The connection dropped (${err.message}). The search keeps running on the server; waiting for its results…`);
      const fresh = await waitForNewResults(before);
      if (fresh) {
        state.web = fresh;
        line(`Done: ${(fresh.providers || []).length} providers found.`, 'ok');
        renderAll();
      } else {
        line('No new results yet. Try Run discovery again in a few minutes.', 'bad');
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Run discovery';
    }
  }

  // Tell the server about a problem this visitor hit (short text only; it goes to the owner's issue log).
  function reportProblem(where, message, stage) {
    if (!SERVER) return;
    fetch(SERVER + '/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit', keepalive: true,
      body: JSON.stringify({ where, message: String(message || '').slice(0, 200), stage: String(stage || '').slice(0, 200) }),
    }).catch(() => {});
  }

  async function waitForNewResults(before) {
    for (let i = 0; i < 24; i++) { // up to 2 minutes
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const d = await getJSON(SERVER + '/discoveries');
        if (d && d.at && Date.parse(d.at) > before) return d;
      } catch { /* keep waiting */ }
    }
    return null;
  }

  /* ---------- start ---------- */
  async function init() {
    $('runDiscovery').addEventListener('click', runDiscovery);
    document.querySelectorAll('.filters .chip').forEach((b) => b.addEventListener('click', () => { state.filter = b.dataset.filter; applyFilter(); }));
    const [dir, cat, web] = await Promise.allSettled([
      getJSON('directory.json'),
      getJSON('providers.json'),
      SERVER ? getJSON(SERVER + '/discoveries') : Promise.reject(new Error('no server')),
    ]);
    state.directory = dir.status === 'fulfilled' ? dir.value.providers || [] : [];
    state.catalog = cat.status === 'fulfilled' ? cat.value : null;
    state.web = web.status === 'fulfilled' ? web.value : null;
    renderAll();
  }
  init();
})();
