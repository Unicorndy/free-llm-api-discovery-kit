/**
 * Search Chat site server — a Cloudflare Worker.
 *
 *   POST /chat    Safety check, then tries free AI providers in order until one answers.
 *   POST /search  Real web search: private SearXNG first, Tavily as a rationed fallback.
 *   GET  /health  Which providers are configured. Never returns secrets.
 *
 * API for the owner's other projects (Authorization: Bearer <key from API_KEYS>), OpenAI-compatible:
 *   POST /v1/chat/completions   same as /chat; model "auto" or a provider id; stream:true sends one SSE chunk
 *   GET  /v1/models             "auto" plus each configured provider
 *   POST /v1/search             same as /search
 *
 * Free-API discovery (see discover.js):
 *   POST /discover       streams a web search for free LLM APIs (site; refreshes at most hourly)
 *   GET  /discoveries    the latest web discovery results (public, no secrets)
 *   POST /v1/discover    same as /discover; API keys may send {"force": true}
 *
 * Settings (set by the setup assistant, or in the Cloudflare dashboard):
 *   ALLOWED_ORIGIN   e.g. https://yourname.github.io  (only this site may call /chat and /search)
 *   AI               Workers AI binding (free daily allowance, no key)
 *   GROQ_KEY, OPENROUTER_KEY, NVIDIA_KEY, TAVILY_KEY   secrets, all optional
 *   SEARXNG_URL      e.g. https://searxng.example.com (private instance, see searxng/)
 *   SEARXNG_KEY      secret sent as X-Search-Key; the instance rejects requests without it
 *   API_KEYS         secret, comma-separated keys that may call the API from anywhere
 *   SEARXNG_DAILY_LIMIT  SearXNG searches a day across chat and discovery (default 300; counted in KV)
 *   PROVIDER_ORDER, WORKERS_AI_MODEL, GROQ_MODEL, NVIDIA_MODEL, GUARD_MODEL   optional overrides
 */

import { runDiscovery, latestDiscovery, communityProvider, publicHttpsUrl, readCapped } from './discover.js';

const DEFAULTS = {
  PROVIDER_ORDER: 'groq,workers-ai,openrouter,nvidia',
  WORKERS_AI_MODEL: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  GUARD_MODEL: '@cf/meta/llama-guard-3-8b',
  GROQ_MODEL: 'openai/gpt-oss-120b',
  NVIDIA_MODEL: 'meta/llama-3.3-70b-instruct',
  OPENROUTER_FALLBACK: 'openai/gpt-oss-20b:free',
};
const RATE_LIMIT_PER_MIN = 15;
const API_RATE_LIMIT_PER_MIN = 30;
const MAX_BODY = 64 * 1024;
const REFUSAL = "I can't help with that. If you're going through something difficult, please reach out to someone you trust or a local support line.";

const cfg = (env, k) => (env[k] && String(env[k]).trim()) || DEFAULTS[k];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ---------- Providers, tried in PROVIDER_ORDER ---------- */
// Each run() gets a list of model ids to try in order (from the discovery catalog, or the default).
async function eachModel(models, fn) {
  let lastErr = new Error('no model to try');
  for (const m of models) {
    try {
      const out = await fn(m);
      if (out.text && out.text.trim()) return out;
      lastErr = new Error(`${m}: empty reply`);
    } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

const PROVIDERS = {
  'workers-ai': {
    ready: (env) => Boolean(env.AI),
    defaultModel: (env) => cfg(env, 'WORKERS_AI_MODEL'),
    run(messages, env, models) {
      return eachModel(models, async (model) => {
        const out = await withTimeout(env.AI.run(model, { messages, max_tokens: 1024 }), 45000);
        const text = typeof out?.response === 'string' ? out.response : out?.choices?.[0]?.message?.content || '';
        return { text, model };
      });
    },
    async list(env) {
      if (typeof env.AI?.models !== 'function') throw new HttpError(501, 'This Workers AI binding cannot list models.');
      const list = await env.AI.models({ task: 'Text Generation', per_page: 100 });
      return (list || []).map((m) => ({ id: m.name, description: String(m.description || '').slice(0, 200) }));
    },
  },
  groq: {
    ready: (env) => Boolean(env.GROQ_KEY),
    defaultModel: (env) => cfg(env, 'GROQ_MODEL'),
    run(messages, env, models) {
      return eachModel(models, (model) => openAICompatible('https://api.groq.com/openai/v1/chat/completions',
        env.GROQ_KEY, { model, messages, max_tokens: 2048 }));
    },
    list: (env) => listOpenAIModels('https://api.groq.com/openai/v1/models', env.GROQ_KEY),
  },
  openrouter: {
    ready: (env) => Boolean(env.OPENROUTER_KEY),
    defaultModel: (env) => cfg(env, 'OPENROUTER_FALLBACK'),
    // OpenRouter falls back between the listed models itself.
    run(messages, env, models) {
      return openAICompatible('https://openrouter.ai/api/v1/chat/completions', env.OPENROUTER_KEY,
        { models: models.slice(0, 3), messages, max_tokens: 2048 },
        { 'HTTP-Referer': env.ALLOWED_ORIGIN || 'https://github.com', 'X-Title': 'Search Chat' });
    },
  },
  nvidia: {
    ready: (env) => Boolean(env.NVIDIA_KEY),
    defaultModel: (env) => cfg(env, 'NVIDIA_MODEL'),
    run(messages, env, models) {
      return eachModel(models, (model) => openAICompatible('https://integrate.api.nvidia.com/v1/chat/completions',
        env.NVIDIA_KEY, { model, messages, max_tokens: 2048 }));
    },
    list: (env) => listOpenAIModels('https://integrate.api.nvidia.com/v1/models', env.NVIDIA_KEY),
  },
};

function configuredProviders(env) {
  return cfg(env, 'PROVIDER_ORDER').split(',').map((s) => s.trim())
    .filter((id) => Object.hasOwn(PROVIDERS, id) && PROVIDERS[id].ready(env))
    .map((id) => ({ id, ...PROVIDERS[id] }));
}

async function openAICompatible(url, key, body, extraHeaders = {}, fetchOptions = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}), ...extraHeaders },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
    ...fetchOptions,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = JSON.parse(await readCapped(res, 2 * 1024 * 1024)); // community endpoints are untrusted: cap the reply
  return { text: j?.choices?.[0]?.message?.content || '', model: typeof j?.model === 'string' ? j.model : body.model || '' };
}

async function listOpenAIModels(url, key) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new HttpError(502, `Provider model list failed (HTTP ${res.status}).`);
  const j = await res.json();
  return (j.data || []).filter((m) => typeof m.id === 'string' && m.active !== false)
    .map((m) => ({ id: m.id, context: m.context_window || m.context_length || null }));
}

/* ---------- Discovery catalog (providers.json, written daily by the site repo's GitHub Action) ---------- */
let catalogCache = { at: 0, data: null };
async function loadCatalog(env) {
  if (!env.CATALOG_URL) return null;
  if (catalogCache.data && Date.now() - catalogCache.at < 3600e3) return catalogCache.data;
  try {
    const r = await fetch(env.CATALOG_URL, { signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j.providers)) catalogCache = { at: Date.now(), data: j };
    }
  } catch { /* keep the old catalog */ }
  return catalogCache.data;
}

function workingModels(catalog, id) {
  const p = catalog && catalog.providers.find((x) => x.id === id);
  return ((p && p.models) || []).filter((m) => m.ok && typeof m.id === 'string').map((m) => m.id);
}

// Models to try for a provider: its default first if discovery says it works, then the other working ones.
function candidates(p, env, catalog) {
  const def = p.defaultModel(env);
  const ok = workingModels(catalog, p.id);
  if (!ok.length) return def ? [def] : [];
  return ok.includes(def) ? [def, ...ok.filter((m) => m !== def)] : ok;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/* ---------- Safety check (Llama Guard on Workers AI) ---------- */
// Screens every character of the texts given: they are joined and checked in overlapping
// 4,000-character windows (in parallel), so nothing can hide across a window edge.
const GUARD_CHUNK = 4000;
const GUARD_STRIDE = 3500;
const GUARD_MAX_CHUNKS = 24; // the 60,000-character message cap plus the sources block needs about 20
async function isUnsafe(env, texts) {
  if (!env.AI) return false;
  const all = texts.filter(Boolean).join('\n\n');
  const chunks = [];
  for (let i = 0; i < all.length; i += GUARD_STRIDE) {
    chunks.push(all.slice(i, i + GUARD_CHUNK));
    if (i + GUARD_CHUNK >= all.length) break;
  }
  if (!chunks.length) return false;
  try {
    if (chunks.length > GUARD_MAX_CHUNKS) return true; // too much to screen: refuse rather than skip
    const verdicts = await Promise.all(chunks.map(async (content) => {
      const out = await withTimeout(env.AI.run(cfg(env, 'GUARD_MODEL'), { messages: [{ role: 'user', content }] }), 15000);
      const r = out?.response;
      if (typeof r === 'string') return /^\s*unsafe/i.test(r);
      if (r && typeof r === 'object') return r.safe === false;
      return false;
    }));
    return verdicts.some(Boolean);
  } catch (err) {
    // Fail open: the system prompt and provider moderation still apply.
    console.log('safety check unavailable:', String(err));
    return false;
  }
}

/* ---------- Request validation ---------- */
async function readJson(request) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) throw new HttpError(413, 'Message too long.');
  // Read in pieces and stop as soon as the cap is passed (bodies without Content-Length included).
  let size = 0;
  const parts = [];
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel().catch(() => {}); throw new HttpError(413, 'Message too long.'); }
      parts.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { bytes.set(p, at); at += p.byteLength; }
  const text = new TextDecoder().decode(bytes);
  try { return JSON.parse(text || '{}'); } catch { throw new HttpError(400, 'Invalid request.'); }
}

// Web results sent by the site as a separate field; the Worker formats them itself, marked untrusted.
function cleanSources(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 8).map((r) => {
    let url = '';
    try { const u = new URL(String(r && r.url)); if (u.protocol === 'https:' || u.protocol === 'http:') url = u.href; } catch { /* dropped */ }
    const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
    return url ? { title: clip(r.title, 200), url, site: clip(r.site, 80) || new URL(url).hostname, snippet: clip(r.snippet, 900) } : null;
  }).filter(Boolean);
}

function cleanMessages(input) {
  if (!Array.isArray(input) || !input.length || input.length > 40) throw new HttpError(400, 'Invalid conversation.');
  let total = 0;
  return input.map((m) => {
    if (!m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string') {
      throw new HttpError(400, 'Invalid conversation.');
    }
    total += m.content.length;
    if (m.content.length > 12000 || total > 60000) throw new HttpError(413, 'Conversation too long. Start a new chat.');
    return { role: m.role, content: m.content };
  });
}

/* ---------- Handlers ---------- */
// body.model: "auto"; a provider id ("groq") to try first; or "provider/model" for one exact model.
// body.strict (API keys only): don't fall back to anything else. Discovery uses it for smoke tests.
async function chat(body, env, trusted) {
  const messages = cleanMessages(body.messages);
  const catalog = await loadCatalog(env);
  let plan = configuredProviders(env).map((p) => ({ p, models: candidates(p, env, catalog).slice(0, 3) }));

  const want = typeof body.model === 'string' ? body.model.trim() : '';
  const slash = want.indexOf('/');
  const wantProvider = slash > 0 ? want.slice(0, slash) : want;
  const wantModel = slash > 0 ? want.slice(slash + 1) : '';
  const strict = trusted && body.strict === true;
  const i = plan.findIndex((x) => x.p.id === wantProvider);
  if (wantProvider === 'community') {
    // "community/<id>/<model>": a keyless provider found and tested by web discovery. Only used when chosen.
    const rest = wantModel.split('/');
    const cp = await communityProvider(env, rest[0]);
    if (!cp) throw new HttpError(400, 'That community provider is not available right now.');
    const model = rest.slice(1).join('/') || cp.testedModel;
    if (!trusted && model !== cp.testedModel) throw new HttpError(400, 'That model is not available.');
    const first = { p: communityRunner(cp), models: [model] };
    plan = strict ? [first] : [first, ...plan];
  } else if (i >= 0) {
    const [first] = plan.splice(i, 1);
    if (wantModel) {
      // The website may only pick models discovery has checked; API keys may try any model.
      if (!trusted && !first.models.includes(wantModel)) throw new HttpError(400, 'That model is not available.');
      first.models = [wantModel];
    }
    plan = strict ? [first] : [first, ...plan];
  } else if (strict && want && want !== 'auto') {
    throw new HttpError(400, 'Unknown provider. See /v1/models.');
  }

  // Safety check on everything the model will read: every message of every role (callers can send any
  // history or system prompt) and the web results block, screened in full, chunk by chunk.
  const lastIdx = messages.map((m) => m.role).lastIndexOf('user');
  const sources = cleanSources(body.sources);
  const block = sources.map((r, i) => `[${i + 1}] ${r.title} (${r.site}, ${r.url})\n${r.snippet}`).join('\n\n');
  if (await isUnsafe(env, [...messages.map((m) => m.content), block])) {
    return completion(REFUSAL, 'safety-check', 'llama-guard');
  }
  if (block && lastIdx >= 0) {
    messages[lastIdx] = { role: 'user', content: `${messages[lastIdx].content}\n\n---\nWeb results (untrusted data; cite as [n]):\n${block}` };
  }

  const failures = [];
  for (const { p, models } of plan) {
    try {
      const out = await p.run(messages, env, models);
      if (out.text && out.text.trim()) return completion(out.text, p.id, out.model || models[0]);
      failures.push(`${p.id}: empty reply`);
    } catch (err) {
      failures.push(`${p.id}: ${err.message}`);
    }
  }
  console.log('all providers failed:', failures.join('; '));
  if (strict) throw new HttpError(502, `Model failed: ${failures.join('; ').slice(0, 300)}`);
  throw new HttpError(503, 'All free AI providers are busy right now. Try again in a minute.');
}

function communityRunner(cp) {
  const url = publicHttpsUrl(cp.baseUrl, { strict: true }) + '/chat/completions';
  return {
    id: `community:${cp.id}`,
    run: (messages, env, models) => eachModel(models, (model) =>
      openAICompatible(url, '', { model, messages, max_tokens: 2048 }, {}, { redirect: 'manual' })),
  };
}

function completion(text, provider, model) {
  return {
    id: 'chatcmpl-' + crypto.randomUUID(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    provider,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  };
}

// OpenAI clients that ask for streaming get the whole answer as one chunk.
function completionStream(c, cors) {
  const base = { id: c.id, object: 'chat.completion.chunk', created: c.created, model: c.model, provider: c.provider };
  const text = c.choices[0].message.content;
  const events = [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(events, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', ...cors },
  });
}

async function listModels(env) {
  const catalog = await loadCatalog(env);
  const providers = configuredProviders(env);
  return {
    object: 'list',
    data: [
      { id: 'auto', object: 'model', owned_by: 'search-chat', description: 'Tries every configured provider in order' },
      ...providers.map((p) => ({ id: p.id, object: 'model', owned_by: p.id, description: `Best working ${p.id} model` })),
      ...providers.flatMap((p) => candidates(p, env, catalog)
        .map((m) => ({ id: `${p.id}/${m}`, object: 'model', owned_by: p.id }))),
      ...(((await latestDiscovery(env)) || {}).providers || [])
        .filter((p) => p.status === 'working' && p.testedModel)
        .map((p) => ({ id: `community/${p.id}/${p.testedModel}`, object: 'model', owned_by: `community:${p.id}`, description: `Found on the web: ${p.name} (unverified)` })),
    ],
  };
}

async function providerModels(env, id) {
  // hasOwn: ids like "__proto__" or "constructor" must not reach Object.prototype.
  const p = Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id] : null;
  if (!p || !p.ready(env)) throw new HttpError(404, 'That provider is not set up on this server.');
  if (!p.list) throw new HttpError(404, 'This provider has a public model list; fetch it directly.');
  return { provider: id, models: await p.list(env) };
}

const searchCache = new Map();
const siteOf = (url) => new URL(url).hostname.replace(/^www\./, '');

async function searchSearxng(q, env, limit = 6) {
  const url = env.SEARXNG_URL.replace(/\/+$/, '') + '/search?' + new URLSearchParams({ q, format: 'json', language: 'en' });
  const res = await fetch(url, { headers: { 'X-Search-Key': env.SEARXNG_KEY }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
  const j = await res.json();
  return (j.results || [])
    .filter((r) => /^https?:\/\//.test(String(r.url || '')) && r.content)
    .slice(0, limit)
    .map((r) => ({
      title: String(r.title || '').slice(0, 200),
      url: String(r.url),
      snippet: String(r.content).slice(0, 900),
      site: siteOf(r.url),
    }));
}

async function searchTavily(q, env) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.TAVILY_KEY}` },
    body: JSON.stringify({ query: q, max_results: 5, search_depth: 'basic' }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const j = await res.json();
  return (j.results || []).slice(0, 5)
    .filter((r) => /^https?:\/\//.test(String(r.url || '')))
    .map((r) => ({
      title: String(r.title || '').slice(0, 200),
      url: String(r.url),
      snippet: String(r.content || '').slice(0, 900),
      site: siteOf(r.url),
    }));
}

const hasSearxng = (env) => Boolean(env.SEARXNG_URL && env.SEARXNG_KEY);

// Daily SearXNG budget shared by chat search and web discovery. The count lives in KV, so it covers all
// Worker instances; it is approximate (KV reads can lag by up to a minute), and nginx in front of
// SearXNG adds a hard per-minute limit.
const searchBudgetKey = () => 'sx:' + new Date().toISOString().slice(0, 10);
const searchBudgetLimit = (env) => Math.max(0, Number(env.SEARXNG_DAILY_LIMIT) || 300);
async function takeSearchBudget(env, n = 1) {
  if (!env.DISCOVERY) return true;
  try {
    const used = Number(await env.DISCOVERY.get(searchBudgetKey())) || 0;
    if (used + n > searchBudgetLimit(env)) return false;
    await env.DISCOVERY.put(searchBudgetKey(), String(used + n), { expirationTtl: 2 * 86400 });
    return true;
  } catch {
    return true; // a KV hiccup shouldn't break search; nginx still caps the rate
  }
}
async function searchBudgetUsed(env) {
  if (!env.DISCOVERY) return null;
  try { return Number(await env.DISCOVERY.get(searchBudgetKey())) || 0; } catch { return null; }
}

// SearXNG is free and self-hosted, so it handles every search. Tavily (1,000 credits a month)
// only runs for time-sensitive questions, and only when SearXNG comes back thin.
async function search(body, env) {
  const q = String(body.q || '').trim().slice(0, 300);
  if (!q) throw new HttpError(400, 'Missing search query.');
  const fresh = body.fresh === true;

  const key = (fresh ? 'f:' : 'n:') + q.toLowerCase();
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < 3600e3) return hit.data;

  let results = [];
  if (hasSearxng(env) && await takeSearchBudget(env, 1)) {
    try { results = await searchSearxng(q, env); } catch (err) { console.log('searxng failed:', String(err)); }
  }
  if (fresh && results.length < 3 && env.TAVILY_KEY) {
    try { results = results.concat(await searchTavily(q, env)); } catch (err) { console.log('tavily failed:', String(err)); }
  }

  const data = { results };
  if (results.length) {
    if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value);
    searchCache.set(key, { at: Date.now(), data });
  }
  return data;
}

/* ---------- Abuse limits (per server instance) ---------- */
const hits = new Map();
function withinRateLimit(ip, limit = RATE_LIMIT_PER_MIN) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.start > 60000) {
    if (hits.size > 5000) hits.clear();
    hits.set(ip, { start: now, count: 1 });
    return true;
  }
  rec.count += 1;
  return rec.count <= limit;
}

function isAllowedOrigin(origin, env) {
  if (!origin) return false;
  if (env.ALLOWED_ORIGIN && origin === env.ALLOWED_ORIGIN) return true;
  return env.ALLOW_LOCALHOST === 'true' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

async function validApiKey(request, env) {
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') || '');
  if (!m || !env.API_KEYS) return '';
  const enc = new TextEncoder();
  const given = enc.encode(m[1]);
  for (const k of String(env.API_KEYS).split(',').map((s) => s.trim()).filter(Boolean)) {
    const want = enc.encode(k);
    if (want.byteLength === given.byteLength && crypto.subtle.timingSafeEqual(want, given)) return k;
  }
  return '';
}

function discoverStream(env, ctx, force, cors) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const emit = (e) => writer.write(enc.encode(`data: ${JSON.stringify(e)}\n\n`)).catch(() => {});
  ctx.waitUntil((async () => {
    try {
      if (!hasSearxng(env)) throw new Error('Web search is not set up on this server.');
      await runDiscovery(env, { force, searchWeb: (q) => searchSearxng(q, env, 10), budget: (n) => takeSearchBudget(env, n), emit });
    } catch (err) {
      console.log('discovery failed:', String(err && err.stack || err));
      await emit({ type: 'error', message: String((err && err.message) || err).slice(0, 200) });
    } finally {
      try { await writer.close(); } catch { /* client left */ }
    }
  })());
  return new Response(readable, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', ...cors } });
}

const ROUTES = {
  'POST /chat': 'chat',
  'POST /search': 'search',
  'POST /v1/chat/completions': 'chat',
  'POST /v1/search': 'search',
  'GET /v1/models': 'models',
  'GET /v1/provider-models': 'provider-models',
  'POST /discover': 'discover',
  'POST /v1/discover': 'discover',
};

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = isAllowedOrigin(origin, env);
    const cors = allowed ? {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    } : { Vary: 'Origin' };

    if (request.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors });

    try {
      if (url.pathname === '/health' && request.method === 'GET') {
        return json({
          ok: true,
          providers: configuredProviders(env).map((p) => p.id),
          models: Object.fromEntries(configuredProviders(env).map((p) => [p.id, candidates(p, env, catalogCache.data)[0] || ''])),
          search: hasSearxng(env) || Boolean(env.TAVILY_KEY),
          searxng: hasSearxng(env),
          tavily: Boolean(env.TAVILY_KEY),
          safetyCheck: Boolean(env.AI),
          api: Boolean(env.API_KEYS),
          searxngToday: hasSearxng(env) ? { used: await searchBudgetUsed(env), limit: searchBudgetLimit(env) } : null,
        }, 200, cors);
      }
      if (url.pathname === '/discoveries' && request.method === 'GET') {
        // Public data (no secrets), so any site may read it.
        return json((await latestDiscovery(env)) || { at: null, providers: [] }, 200, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' });
      }
      const route = ROUTES[`${request.method} ${url.pathname}`];
      if (!route) throw new HttpError(404, 'Not found.');

      const apiKey = allowed ? '' : await validApiKey(request, env);
      if (!allowed && !apiKey) {
        if (request.headers.get('Authorization')) throw new HttpError(401, 'Invalid API key.');
        throw new HttpError(403, 'This server only answers requests from its own website, or with an API key.');
      }
      const bucket = apiKey ? 'key:' + apiKey.slice(0, 12) : request.headers.get('CF-Connecting-IP') || 'unknown';
      if (!withinRateLimit(bucket, apiKey ? API_RATE_LIMIT_PER_MIN : RATE_LIMIT_PER_MIN)) {
        return json({ error: { message: 'Too many requests. Wait a minute and try again.' } }, 429, { ...cors, 'Retry-After': '60' });
      }

      if (route === 'models') return json(await listModels(env), 200, cors);
      if (route === 'provider-models') {
        if (!apiKey) throw new HttpError(403, 'Needs an API key.');
        return json(await providerModels(env, url.searchParams.get('provider') || ''), 200, cors);
      }
      const body = await readJson(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Invalid request.');
      if (route === 'discover') return discoverStream(env, ctx, Boolean(apiKey) && body.force === true, cors);
      if (route === 'search') return json(await search(body, env), 200, cors);
      const data = await chat(body, env, Boolean(apiKey));
      if (body.stream === true && url.pathname.startsWith('/v1/')) return completionStream(data, cors);
      return json(data, 200, cors);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.log('error:', String(err && err.stack || err));
      const message = err instanceof HttpError ? err.message : 'The server hit an error. Try again.';
      return json({ error: { message } }, status, cors);
    }
  },
};
