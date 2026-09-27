// Daily free-model discovery for Search Chat. Run by .github/workflows/discover.yml; writes providers.json.
//
// Only vetted providers are scanned; this never adds a new provider. Provider keys stay in the
// Cloudflare Worker: models from key-holding providers are listed and smoke-tested through the
// Worker's API (/v1/provider-models, /v1/chat/completions with strict:true), so this script
// needs just one secret, SEARCH_CHAT_API_KEY. Needs Node 18+ and no packages.
//
//   SEARCH_CHAT_API_KEY=... node scripts/discover.mjs
//   DISCOVER_SKIP_TESTS=1 re-lists and re-sorts without smoke tests (keeps the last results).

import { readFile, writeFile } from 'node:fs/promises';

// The site server's address comes from config.js (workerUrl) unless SEARCH_CHAT_BASE_URL is set.
async function baseUrl() {
  if (process.env.SEARCH_CHAT_BASE_URL) return process.env.SEARCH_CHAT_BASE_URL.replace(/\/+$/, '');
  const config = await readFile(new URL('../config.js', import.meta.url), 'utf8');
  const m = /"workerUrl"\s*:\s*"(https:\/\/[^"]+)"/.exec(config);
  if (!m) throw new Error('Set workerUrl in config.js or SEARCH_CHAT_BASE_URL.');
  return m[1].replace(/\/+$/, '') + '/v1';
}
let BASE = '';
const KEY = process.env.SEARCH_CHAT_API_KEY || '';
const OUT = process.env.OUT || new URL('../providers.json', import.meta.url);
const TEST_PROMPT = 'Reply with the single word: pong';
const WORKER_SPACING_MS = 2300; // the API allows 30 requests a minute per key
const TEST_TIMEOUT_MS = 40000;

// Vetted providers and what we know about them (researched Sept 2026; verify before relying on it).
// limit: models smoke-tested per run. Models not tested this run keep their last result.
const PROVIDERS = [
  {
    id: 'workers-ai', name: 'Cloudflare Workers AI', via: 'worker', limit: 30,
    access: 'proxy only (runs inside the site server)',
    keyOwner: 'site owner (Cloudflare account binding, no key)',
    quotaReset: 'daily: 10,000 neurons a day on the free plan',
    trainsOnData: 'no',
    include: (m) => !/lora|guard|vision/i.test(m.id),
  },
  {
    id: 'groq', name: 'Groq', via: 'worker', limit: 20,
    access: 'proxy only (the key stays on the site server)',
    keyOwner: 'site owner',
    quotaReset: 'daily: per-model request and token limits (about 1,000 requests a day)',
    trainsOnData: 'no',
    include: (m) => !/whisper|tts|guard|orpheus|playai|compound|allam/i.test(m.id),
  },
  {
    id: 'openrouter', name: 'OpenRouter', via: 'worker', limit: 8, // 50 free requests a day in total, so test few
    access: 'browser or proxy (visitors can use their own key in the browser)',
    keyOwner: 'site owner on the server; the visitor in the browser',
    quotaReset: 'daily: 50 free requests a day under $10 lifetime credit, 1,000 after; 20 a minute',
    trainsOnData: 'depends on the model: some free endpoints log or train on prompts',
    publicList: async () => {
      const j = await getJSON('https://openrouter.ai/api/v1/models');
      return (j.data || [])
        .filter((m) => typeof m.id === 'string' && (m.id.endsWith(':free') ||
          (m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0)))
        .filter((m) => (m.context_length || 0) >= 16000)
        .map((m) => ({ id: m.id, context: m.context_length || null }));
    },
  },
  {
    id: 'nvidia', name: 'NVIDIA', via: 'worker', limit: 12,
    access: 'proxy only (no CORS)',
    keyOwner: 'site owner',
    quotaReset: 'none: one-time trial credits',
    trainsOnData: 'unknown',
    include: (m) => /instruct|chat|-it\b|gpt-oss|deepseek|qwen|kimi|glm|nemotron|mistral|llama/i.test(m.id) &&
      !/embed|rerank|reward|vision|vlm|guard|safety|clip|parse|retriev|content-safety|nemoguard/i.test(m.id),
  },
  {
    id: 'pollinations', name: 'Pollinations', via: 'direct', limit: 6, spacingMs: 16000,
    access: 'browser (called directly from the visitor\'s browser, no server)',
    keyOwner: 'none (anonymous tier); visitors may add their own key',
    quotaReset: 'rate limited per visitor',
    trainsOnData: 'unknown',
    publicList: async () => {
      const list = await getJSON('https://text.pollinations.ai/models');
      return (Array.isArray(list) ? list : [])
        .filter((m) => m && (m.name || m.id) && (!m.tier || m.tier === 'anonymous'))
        .map((m) => ({ id: m.name || m.id }));
    },
    test: (model) => chatTest('https://text.pollinations.ai/openai', { model, messages: [{ role: 'user', content: TEST_PROMPT }] }, {}),
  },
];

// Rough quality ranking for fallbacks: bigger models first, but very slow ones after the rest.
const sizeOf = (id) => Math.max(0, ...[...String(id).matchAll(/(\d+(?:\.\d+)?)b(?![a-z])/gi)].map((x) => Number(x[1])));
const rank = (a, b) => (b.ok === true) - (a.ok === true) ||
  ((a.latencyMs || 0) > 10000) - ((b.latencyMs || 0) > 10000) ||
  sizeOf(b.id) - sizeOf(a.id) || (a.latencyMs || 1e9) - (b.latencyMs || 1e9) || a.id.localeCompare(b.id);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = () => ({ Authorization: `Bearer ${KEY}` });

async function getJSON(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function chatTest(url, body, headers) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok) return { ok: false, error: String((j && j.error && (j.error.message || j.error)) || `HTTP ${res.status}`).slice(0, 200) };
    const reply = (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || text;
    const ok = /pong/i.test(String(reply));
    return { ok, latencyMs: Date.now() - started, ...(ok ? {} : { error: `unexpected reply: ${String(reply).slice(0, 80)}` }) };
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? 'timed out' : String(err.message || err).slice(0, 200) };
  }
}

const workerTest = (providerId, model) => chatTest(`${BASE}/chat/completions`,
  { model: `${providerId}/${model}`, strict: true, messages: [{ role: 'user', content: TEST_PROMPT }] }, auth());

async function main() {
  if (!KEY) throw new Error('Set SEARCH_CHAT_API_KEY.');
  BASE = await baseUrl();
  let previous = { providers: [] };
  try { previous = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* first run */ }
  const health = await getJSON(BASE.replace(/\/v1$/, '') + '/health');
  const onServer = new Set(health.providers || []);
  const now = new Date().toISOString();
  const out = [];

  for (const p of PROVIDERS) {
    const configured = p.via === 'direct' || onServer.has(p.id);
    const before = new Map(((previous.providers.find((x) => x.id === p.id) || {}).models || []).map((m) => [m.id, m]));
    let listed = [];
    let listError = '';
    try {
      if (p.publicList) listed = await p.publicList();
      else if (configured) listed = (await getJSON(`${BASE}/provider-models?provider=${p.id}`, auth())).models || [];
      if (p.include) listed = listed.filter(p.include);
    } catch (err) {
      listError = String(err.message || err).slice(0, 200);
    }

    // Keep what we knew for models still listed; test the working ones first, then the longest-unchecked.
    const models = listed.map((m) => ({ ...(before.get(m.id) || { ok: null, checked: null }), ...m }));
    const queue = configured && !process.env.DISCOVER_SKIP_TESTS ? [...models].sort((a, b) =>
      (b.ok === true) - (a.ok === true) || String(a.checked || '').localeCompare(String(b.checked || ''))).slice(0, p.limit) : [];

    for (const m of queue) {
      const r = p.test ? await p.test(m.id) : await workerTest(p.id, m.id);
      Object.assign(m, { ok: r.ok, latencyMs: r.latencyMs || null, error: r.error || undefined, checked: now });
      console.log(`${p.id.padEnd(12)} ${r.ok ? 'ok  ' : 'FAIL'} ${m.id}${r.ok ? ` (${r.latencyMs} ms)` : ` — ${r.error}`}`);
      await sleep(p.spacingMs || WORKER_SPACING_MS);
    }

    models.sort(rank);
    const { include, publicList, test, limit, spacingMs, via, ...meta } = p;
    out.push({
      ...meta,
      configured,
      ...(listError ? { listError } : {}),
      working: models.filter((m) => m.ok === true).length,
      models: models.map(({ id, ok, latencyMs, checked, context, error }) =>
        ({ id, ok, latencyMs: latencyMs || null, checked, ...(context ? { context } : {}), ...(error && ok === false ? { error } : {}) })),
    });
  }

  // OpenAI-style list of the models the site's server can use right now (read by the Settings dialog).
  const data = out.filter((p) => p.configured && p.id !== 'pollinations').flatMap((p) =>
    p.models.filter((m) => m.ok === true).map((m) => ({ id: `${p.id}/${m.id}`, name: `${p.name}: ${m.id.split('/').pop()}`, owned_by: p.id })));

  const result = {
    updated: now,
    note: 'Generated daily by scripts/discover.mjs. Provider policy fields were researched in Sept 2026; verify before relying on them.',
    object: 'list',
    data,
    providers: out,
  };
  await writeFile(OUT, JSON.stringify(result, null, 2) + '\n');
  console.log(`\nWrote ${data.length} working server models across ${out.filter((p) => p.working).length} providers.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
