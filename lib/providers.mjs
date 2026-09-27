// Services the assistant can set up, where their key pages live, what their
// keys look like, and how to check a key works (using the cheapest call available).

async function probe(url, init = {}) {
  try { return await fetch(url, { ...init, signal: AbortSignal.timeout(15000) }); }
  catch { return null; }
}
const bearer = (key) => ({ Authorization: `Bearer ${key}` });

async function acceptsKey(url, key) {
  const r = await probe(url, { headers: bearer(key) });
  if (!r) return { ok: false, detail: "couldn't reach the service. Check your connection." };
  if (r.status === 401 || r.status === 403) return { ok: false, detail: 'the key was rejected.' };
  if (!r.ok) return { ok: false, detail: `the service returned HTTP ${r.status}.` };
  return { ok: true };
}

export async function validateGitHub(key) {
  const r = await probe('https://api.github.com/user', {
    headers: { ...bearer(key), Accept: 'application/vnd.github+json', 'User-Agent': 'search-chat-setup' },
  });
  if (!r) return { ok: false, detail: "couldn't reach GitHub." };
  if (r.status === 401) return { ok: false, detail: 'GitHub says the token is invalid or expired.' };
  if (!r.ok) return { ok: false, detail: `GitHub returned HTTP ${r.status}.` };
  const scopes = (r.headers.get('x-oauth-scopes') || '').split(',').map((s) => s.trim());
  if (!scopes.includes('public_repo') && !scopes.includes('repo')) {
    return { ok: false, detail: 'the token is missing the public_repo permission. Create it again with that box ticked.' };
  }
  const user = await r.json();
  return { ok: true, detail: `Signed in as ${user.login}.`, data: { login: user.login } };
}

export async function validateCloudflare(key) {
  const r = await probe('https://api.cloudflare.com/client/v4/user/tokens/verify', { headers: bearer(key) });
  if (!r) return { ok: false, detail: "couldn't reach Cloudflare." };
  const j = await r.json().catch(() => null);
  if (r.ok && j && j.success && j.result && j.result.status === 'active') return { ok: true };
  return { ok: false, detail: (j && j.errors && j.errors[0] && j.errors[0].message) || `Cloudflare returned HTTP ${r.status}.` };
}

export const PROVIDERS = [
  {
    id: 'groq',
    name: 'Groq',
    secretName: 'GROQ_KEY',
    recommended: true,
    why: 'Fast free models, about 1,000 requests a day. Free account, no card.',
    setup: {
      url: 'https://console.groq.com/keys',
      pattern: /gsk_[A-Za-z0-9]{40,}/,
      highlight: ['Create API Key', 'Create API key'],
      instructions: 'Sign in to Groq in the browser window (a free account is fine). Click Create API Key, give it any name, and submit. I\'ll pick up the key as soon as it appears.',
    },
    validate: (key) => acceptsKey('https://api.groq.com/openai/v1/models', key),
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    secretName: 'OPENROUTER_KEY',
    recommended: true,
    why: 'Rotating free models from many labs. 50 requests a day free, 1,000 after a one-time $10 top-up.',
    setup: {
      url: 'https://openrouter.ai/keys',
      pattern: /sk-or-v1-[A-Za-z0-9]{32,}/,
      highlight: ['Create API Key', 'Create Key', 'Create'],
      instructions: 'Sign in to OpenRouter in the browser window. Click Create API Key, give it a name, leave the credit limit empty, and create it. I\'ll pick up the key as soon as it appears.',
    },
    async validate(key) {
      const first = await acceptsKey('https://openrouter.ai/api/v1/key', key);
      return first.ok ? first : acceptsKey('https://openrouter.ai/api/v1/auth/key', key);
    },
  },
  {
    id: 'tavily',
    name: 'Tavily web search',
    secretName: 'TAVILY_KEY',
    recommended: true,
    why: 'Real web search for news and current events. 1,000 free searches a month, no card.',
    setup: {
      url: 'https://app.tavily.com',
      pattern: /tvly-[A-Za-z0-9_-]{20,}/,
      highlight: ['API Keys', 'Copy'],
      instructions: 'Sign in or create a free Tavily account in the browser window. Your key is on the overview page: click the eye icon to reveal it and I\'ll pick it up. Checking the key uses 1 of your 1,000 monthly searches.',
    },
    async validate(key) {
      const r = await probe('https://api.tavily.com/search', {
        method: 'POST',
        headers: { ...bearer(key), 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'test', max_results: 1 }),
      });
      if (!r) return { ok: false, detail: "couldn't reach Tavily." };
      if (r.status === 401 || r.status === 403) return { ok: false, detail: 'the key was rejected.' };
      return r.ok ? { ok: true } : { ok: false, detail: `Tavily returned HTTP ${r.status}.` };
    },
  },
  {
    id: 'nvidia',
    name: 'NVIDIA Build',
    secretName: 'NVIDIA_KEY',
    recommended: false,
    why: '100+ models, but credits are one-time and meant for prototyping, so it\'s tried last.',
    setup: {
      url: 'https://build.nvidia.com/settings/api-keys',
      pattern: /nvapi-[A-Za-z0-9_-]{40,}/,
      highlight: ['Generate API Key', 'Generate Key'],
      instructions: 'Sign in with a free NVIDIA Developer account in the browser window. Click Generate API Key and confirm. NVIDIA shows the key only once; I\'ll pick it up from the page.',
    },
    validate: (key) => acceptsKey('https://integrate.api.nvidia.com/v1/models', key),
  },
];
