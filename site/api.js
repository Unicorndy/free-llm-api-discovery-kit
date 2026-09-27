// API guide page: fills in this site's server URL, adds copy buttons, shows live status.
(() => {
  const CONFIG = window.SEARCH_CHAT_CONFIG || {};
  const server = /^https:\/\//.test(CONFIG.workerUrl || '') ? CONFIG.workerUrl.replace(/\/+$/, '') : '';

  if (server) {
    document.querySelectorAll('.base').forEach((n) => { n.textContent = server; });
    document.querySelectorAll('.base-v1').forEach((n) => { n.textContent = server + '/v1'; });
  }

  document.querySelectorAll('pre').forEach((pre) => {
    const wrap = document.createElement('div');
    wrap.className = 'code-block';
    pre.replaceWith(wrap);
    wrap.append(pre);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy';
    btn.textContent = 'Copy';
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pre.textContent);
        btn.textContent = 'Copied';
      } catch {
        btn.textContent = 'Select and copy';
      }
      setTimeout(() => { btn.textContent = 'Copy'; }, 1600);
    });
    wrap.append(btn);
  });

  renderCatalog();

  const status = document.getElementById('liveStatus');
  if (!server) { status.textContent = 'This site has no server set up.'; status.className = 'bad'; return; }
  fetch(server + '/health', { credentials: 'omit' })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((h) => {
      const providers = (h.providers || []).join(', ') || 'none';
      status.textContent = `Online · providers: ${providers} · web search: ${h.search ? 'on' : 'off'}`;
      status.className = 'ok';
    })
    .catch(() => { status.textContent = "Couldn't reach the server right now."; status.className = 'bad'; });

  // Live list from providers.json (written daily by scripts/discover.mjs). Built with textContent only.
  async function renderCatalog() {
    const box = document.getElementById('catalog');
    const updated = document.getElementById('catalogUpdated');
    const el = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined) n.textContent = text;
      return n;
    };
    let cat;
    try {
      const r = await fetch('providers.json', { cache: 'no-cache' });
      if (!r.ok) throw new Error(String(r.status));
      cat = await r.json();
    } catch {
      updated.textContent = "The model list hasn't been generated yet.";
      return;
    }
    const when = new Date(cat.updated);
    updated.textContent = `Last checked ${isNaN(when) ? 'recently' : when.toLocaleString()}.`;

    for (const p of cat.providers || []) {
      const card = el('div', 'provider');
      const head = el('div', 'provider-head');
      head.append(el('h3', '', p.name || p.id));
      const badge = !p.configured ? ['Not set up', 'off'] : p.working ? [`${p.working} working`, 'on'] : ['None working', 'off'];
      head.append(el('span', 'badge ' + badge[1], badge[0]));
      card.append(head);

      const facts = el('dl', 'pfacts');
      [['Access', p.access], ['Key owner', p.keyOwner], ['Quota', p.quotaReset], ['Trains on your data', p.trainsOnData]]
        .forEach(([k, v]) => { if (v) facts.append(el('dt', '', k), el('dd', '', v)); });
      card.append(facts);

      const ok = (p.models || []).filter((m) => m.ok === true);
      if (ok.length && p.id !== 'pollinations') {
        const list = el('ul', 'models');
        ok.forEach((m) => {
          const li = el('li');
          li.append(el('code', '', `${p.id}/${m.id}`));
          if (m.latencyMs) li.append(el('span', 'lat', `${(m.latencyMs / 1000).toFixed(1)} s`));
          list.append(li);
        });
        card.append(list);
      } else if (ok.length) {
        card.append(el('p', 'muted', `Browser only: ${ok.map((m) => m.id).join(', ')}. Choose it in the chat's Settings.`));
      } else if (!p.configured) {
        card.append(el('p', 'muted', 'Not set up on this server yet.'));
      }
      box.append(card);
    }
  }
})();
