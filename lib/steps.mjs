// The setup workflow. Each step talks to the person through `ui` and uses the
// browser only where a human must act (sign-in, creating a key). Everything
// else goes through official APIs, which are more reliable than clicking.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPage, scanForSecrets, highlight, deleteProfile } from './browser.mjs';
import { PROVIDERS, validateGitHub, validateCloudflare } from './providers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE_DIR = path.join(ROOT, 'site');
const WORKER_FILE = path.join(ROOT, 'worker', 'worker.js');
const WORKER_MODULES = ['discover.js']; // imported by worker.js; uploaded as extra modules
const GITHUB_API = 'https://api.github.com';
const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

export const STEP_LIST = [
  { id: 'choose', title: 'Choose services' },
  { id: 'github', title: 'Connect GitHub' },
  { id: 'keys', title: 'Get free AI and search keys' },
  { id: 'cloudflare', title: 'Connect Cloudflare' },
  { id: 'worker', title: 'Deploy the site server' },
  { id: 'site', title: 'Publish the chat site' },
  { id: 'verify', title: 'Check everything works' },
];

export class Cancelled extends Error {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const never = new Promise(() => {});

function answered(reply) {
  if (!reply || reply.action === 'cancel') throw new Cancelled('Setup stopped.');
  return reply;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'search-chat';

/* ---------- Getting a key: browser + person, whichever is first ---------- */
async function obtainKey(ui, o) {
  let page = null;
  ui.log(`Opening ${o.name} in the browser window.`);
  try {
    page = await openPage(o.url);
    if (o.highlight) {
      await sleep(1500);
      if (await highlight(page, o.highlight)) ui.log('Highlighted the button to click in yellow.');
    }
  } catch (err) {
    ui.log(`Couldn't control the browser (${err.message}). Open the page yourself and paste the key.`, 'warn');
  }

  const rejected = new Set();
  for (let attempt = 1; attempt <= 6; attempt++) {
    const reply = ui.ask({
      kind: 'key',
      title: o.title || `Get your ${o.name} key`,
      body: o.instructions,
      url: o.url,
      watching: Boolean(page && o.pattern),
      allowSkip: Boolean(o.optional),
      placeholder: 'Paste the key here',
      submitLabel: 'Use this key',
    });
    let stop = false;
    const watcher = page && o.pattern ? (async () => {
      while (!stop) {
        await sleep(1500);
        if (stop) break;
        const found = (await scanForSecrets(o.pattern)).find((k) => !rejected.has(k));
        if (found) return { action: 'detected', value: found };
      }
      return never;
    })() : never;

    const r = answered(await Promise.race([reply, watcher]));
    stop = true;
    if (r.action === 'detected') {
      ui.dismiss();
      ui.log(`Picked up a ${o.name} key from the page (ending …${r.value.slice(-4)}).`);
    }
    if (r.action === 'skip') { ui.log(`Skipped ${o.name}.`); return null; }
    const key = String(r.value || '').trim();
    if (!key) continue;

    ui.log(`Checking the ${o.name} key…`);
    const v = await o.validate(key);
    if (v.ok) {
      ui.log(`${o.name} key works.${v.detail ? ' ' + v.detail : ''}`, 'success');
      return { key, ...(v.data || {}) };
    }
    rejected.add(key);
    ui.log(`${o.name} didn't accept that key: ${v.detail}`, 'warn');
  }
  throw new Error(`Couldn't get a working ${o.name} key. Run setup again when you're ready.`);
}

/* ---------- API helpers ---------- */
async function github(token, method, route, body) {
  const res = await fetch(GITHUB_API + route, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'search-chat-setup',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { ok: res.ok, status: res.status, data };
}

async function cloudflare(token, method, route, { json, form } = {}) {
  const res = await fetch(CLOUDFLARE_API + route, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
    body: json ? JSON.stringify(json) : form,
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.success === false) {
    const message = data && data.errors && data.errors[0] ? data.errors[0].message : `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data.result;
}

async function retry(fn, times, waitMs) {
  let last;
  for (let i = 0; i < times; i++) {
    try { return await fn(); } catch (err) { last = err; await sleep(waitMs); }
  }
  throw last;
}

/* ---------- Questions ---------- */
async function askRepoName(ui, suggestion) {
  for (;;) {
    const r = answered(await ui.ask({
      kind: 'text',
      title: 'Name your site',
      body: 'This becomes the GitHub repository name and the end of your web address, like yourname.github.io/search-chat.',
      value: suggestion,
      placeholder: 'search-chat',
      submitLabel: 'Continue',
    }));
    const name = String(r.value || '').trim();
    if (/^[A-Za-z0-9._-]{1,90}$/.test(name)) return name;
    ui.log('Use only letters, numbers, dots, dashes and underscores in the name.', 'warn');
  }
}

/* ---------- Cloudflare ---------- */
async function ensureSubdomain(ui, token, accountId) {
  try {
    const r = await cloudflare(token, 'GET', `/accounts/${accountId}/workers/subdomain`);
    if (r && r.subdomain) return r.subdomain;
  } catch { /* none yet */ }

  for (let i = 0; i < 5; i++) {
    const r = answered(await ui.ask({
      kind: 'text',
      title: 'Choose your free workers.dev name',
      body: 'Cloudflare gives every account a free address like your-name.workers.dev. Your site server will live there. Pick a name; I\'ll register it.',
      placeholder: 'your-name',
      submitLabel: 'Register this name',
    }));
    const wanted = slug(String(r.value || ''));
    try {
      const created = await cloudflare(token, 'PUT', `/accounts/${accountId}/workers/subdomain`, { json: { subdomain: wanted } });
      ui.log(`Registered ${created.subdomain}.workers.dev.`, 'success');
      return created.subdomain;
    } catch (err) {
      ui.log(`Cloudflare didn't accept "${wanted}": ${err.message}`, 'warn');
    }
  }
  throw new Error("Couldn't register a workers.dev name.");
}

// KV namespace for web discovery results (created once, then reused). Optional: without it,
// the site still works and discovery shows the curated list only.
async function ensureDiscoveryKv(ui, token, accountId) {
  try {
    const list = await cloudflare(token, 'GET', `/accounts/${accountId}/storage/kv/namespaces?per_page=100`);
    const found = (list || []).find((n) => n.title === 'DISCOVERY');
    if (found) return found.id;
    const created = await cloudflare(token, 'POST', `/accounts/${accountId}/storage/kv/namespaces`, { json: { title: 'DISCOVERY' } });
    return created.id;
  } catch (err) {
    ui.log(`Couldn't set up discovery storage (${err.message}). Live web discovery will stay off; everything else works.`, 'warn');
    return '';
  }
}

async function deployWorker(ui, token, accountId, workerName, origin, secrets, { catalogUrl = '', kvId = '' } = {}) {
  const code = await readFile(WORKER_FILE, 'utf8');
  const bindings = [
    { type: 'ai', name: 'AI' },
    { type: 'plain_text', name: 'ALLOWED_ORIGIN', text: origin },
    ...(catalogUrl ? [{ type: 'plain_text', name: 'CATALOG_URL', text: catalogUrl }] : []),
    ...(kvId ? [{ type: 'kv_namespace', name: 'DISCOVERY', namespace_id: kvId }] : []),
    ...Object.entries(secrets).map(([name, text]) => ({ type: 'secret_text', name, text })),
  ];
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({ main_module: 'worker.js', compatibility_date: '2026-09-01', bindings })], { type: 'application/json' }));
  form.append('worker.js', new Blob([code], { type: 'application/javascript+module' }), 'worker.js');
  for (const name of WORKER_MODULES) {
    const mod = await readFile(path.join(path.dirname(WORKER_FILE), name), 'utf8');
    form.append(name, new Blob([mod], { type: 'application/javascript+module' }), name);
  }
  await cloudflare(token, 'PUT', `/accounts/${accountId}/workers/scripts/${workerName}`, { form });
  await cloudflare(token, 'POST', `/accounts/${accountId}/workers/scripts/${workerName}/subdomain`, { json: { enabled: true } });
}

/* ---------- GitHub ---------- */
async function ensureRepo(ui, token, login, wanted) {
  let name = wanted;
  for (let i = 0; i < 5; i++) {
    const existing = await github(token, 'GET', `/repos/${login}/${name}`);
    if (existing.ok) {
      const r = answered(await ui.ask({
        kind: 'confirm',
        title: `You already have a repository called "${name}"`,
        body: 'Should I update it with the chat site? Files with the same names are replaced; other files are left alone.',
        options: [{ value: 'update', label: 'Update it', primary: true }, { value: 'rename', label: 'Use a different name' }],
      }));
      if (r.value === 'update') return { owner: existing.data.owner.login, name, branch: existing.data.default_branch || 'main' };
      name = await askRepoName(ui, `${name}-2`);
      continue;
    }
    const created = await github(token, 'POST', '/user/repos', {
      name,
      description: 'A free AI chat that checks the web before answering',
      auto_init: true,
      has_wiki: false,
    });
    if (created.ok) {
      ui.log(`Created github.com/${created.data.owner.login}/${name}.`, 'success');
      await sleep(2000);
      return { owner: created.data.owner.login, name, branch: created.data.default_branch || 'main' };
    }
    ui.log(`GitHub couldn't create the repository: ${(created.data && created.data.message) || created.status}`, 'warn');
    name = await askRepoName(ui, name);
  }
  throw new Error("Couldn't create the GitHub repository.");
}

async function putFile(token, owner, repo, branch, file, content) {
  const route = `/repos/${owner}/${repo}/contents/${encodeURIComponent(file)}`;
  const encoded = Buffer.from(content).toString('base64');
  for (let i = 0; i < 3; i++) {
    const current = await github(token, 'GET', `${route}?ref=${encodeURIComponent(branch)}`);
    const sha = current.ok && current.data ? current.data.sha : undefined;
    if (sha && current.data.content && current.data.content.replace(/\n/g, '') === encoded) return false; // unchanged
    const res = await github(token, 'PUT', route, {
      message: `Update ${file} (setup assistant)`, content: encoded, branch, ...(sha ? { sha } : {}),
    });
    if (res.ok) return true;
    if (res.status === 409 || res.status === 422) { await sleep(1500); continue; }
    throw new Error(`GitHub rejected ${file}: ${(res.data && res.data.message) || res.status}`);
  }
  throw new Error(`Couldn't upload ${file} to GitHub.`);
}

async function siteFiles(workerUrl) {
  const entries = await readdir(SITE_DIR, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    // providers.json is written by the daily discovery workflow in your own repo, never copied from here.
    if (!e.isFile() || e.name === 'config.js' || e.name === 'providers.json') continue;
    files.push([e.name, await readFile(path.join(SITE_DIR, e.name))]);
  }
  files.push(['config.js', `// Written by the setup assistant.\nwindow.SEARCH_CHAT_CONFIG = ${JSON.stringify({ workerUrl }, null, 2)};\n`]);
  return files;
}

async function enablePages(ui, token, owner, repo, branch) {
  const res = await github(token, 'POST', `/repos/${owner}/${repo}/pages`, { source: { branch, path: '/' } });
  if (res.ok || res.status === 409) {
    ui.log('GitHub Pages is on. The first build takes a minute or two.', 'success');
    return;
  }
  ui.log(`GitHub didn't let me turn on Pages automatically (${(res.data && res.data.message) || res.status}).`, 'warn');
  const url = `https://github.com/${owner}/${repo}/settings/pages`;
  try { await highlight(await openPage(url), ['Save']); } catch { /* person can open it */ }
  answered(await ui.ask({
    kind: 'action',
    title: 'Turn on GitHub Pages',
    body: `In the browser window, under Build and deployment, set Source to "Deploy from a branch", choose ${branch} and / (root), then click Save.`,
    url,
    submitLabel: "I've turned it on",
  }));
}

function pagesUrl(owner, repo) {
  const host = `${owner.toLowerCase()}.github.io`;
  return repo.toLowerCase() === host ? `https://${host}/` : `https://${host}/${repo}/`;
}

/* ---------- The whole run ---------- */
export async function runSetup(ui) {
  const secrets = {};
  try {
    // 1. Choose services and a name
    ui.step('choose', 'active');
    const pick = answered(await ui.ask({
      kind: 'multi',
      title: 'Which free services should I set up?',
      body: 'Cloudflare Workers AI is always included and needs no extra key. Each service below adds another free model or real web search. You can skip any of them when we get there.',
      options: PROVIDERS.map((p) => ({ value: p.id, label: p.name, hint: p.why, checked: p.recommended })),
      submitLabel: 'Continue',
    }));
    const chosen = PROVIDERS.filter((p) => (pick.value || []).includes(p.id));
    const wantedRepo = await askRepoName(ui, 'search-chat');
    ui.step('choose', 'done', chosen.length ? chosen.map((p) => p.name).join(', ') : 'Workers AI only');

    // 2. GitHub
    ui.step('github', 'active');
    const gh = await obtainKey(ui, {
      name: 'GitHub',
      title: 'Create a GitHub token',
      url: `https://github.com/settings/tokens/new?scopes=public_repo&description=${encodeURIComponent('Search Chat setup')}`,
      pattern: /ghp_[A-Za-z0-9]{36}/,
      highlight: ['Generate token'],
      instructions: 'Sign in to GitHub in the browser window if asked. The token name and the one permission it needs (public_repo) are already filled in. Set Expiration to 7 days, scroll down, and click Generate token. I\'ll pick up the token as soon as it appears. It\'s only used during setup and never uploaded.',
      validate: validateGitHub,
    });
    ui.step('github', 'done', `Signed in as ${gh.login}`);

    // 3. Provider keys
    ui.step('keys', 'active');
    for (const p of chosen) {
      ui.step('keys', 'active', `Getting a ${p.name} key`);
      const got = await obtainKey(ui, { ...p.setup, name: p.name, optional: true, validate: p.validate });
      if (got) secrets[p.secretName] = got.key;
    }
    const added = chosen.filter((p) => secrets[p.secretName]).map((p) => p.name);
    ui.step('keys', 'done', added.length ? added.join(', ') : 'None added; using Workers AI only');

    // 4. Cloudflare
    ui.step('cloudflare', 'active');
    const cf = await obtainKey(ui, {
      name: 'Cloudflare',
      title: 'Create a Cloudflare API token',
      url: 'https://dash.cloudflare.com/profile/api-tokens',
      pattern: null,
      highlight: ['Create Token'],
      instructions: 'Sign in or create a free Cloudflare account in the browser window. Click Create Token, then Use template next to "Edit Cloudflare Workers". Pick your account under Account Resources (and All zones if it asks), click Continue to summary, then Create Token. Copy the token and paste it here. Cloudflare tokens have no label, so I can\'t pick this one up automatically.',
      validate: validateCloudflare,
    });
    const accounts = await cloudflare(cf.key, 'GET', '/accounts?per_page=50');
    if (!accounts || !accounts.length) throw new Error("This Cloudflare token can't see any account. Create it again with your account picked under Account Resources.");
    let account = accounts[0];
    if (accounts.length > 1) {
      const r = answered(await ui.ask({
        kind: 'choice',
        title: 'Which Cloudflare account should host the site server?',
        options: accounts.map((a) => ({ value: a.id, label: a.name })),
        submitLabel: 'Use this account',
      }));
      account = accounts.find((a) => a.id === r.value) || account;
    }
    const subdomain = await ensureSubdomain(ui, cf.key, account.id);
    ui.step('cloudflare', 'done', `${account.name}, ${subdomain}.workers.dev`);

    // 5. Site server (the repo is created first so the server knows where the model catalog will live)
    ui.step('worker', 'active', 'Uploading');
    const repo = await ensureRepo(ui, gh.key, gh.login, wantedRepo);
    const siteUrl = pagesUrl(repo.owner, repo.name);
    const workerName = `${slug(repo.name)}-api`;
    const origin = `https://${gh.login.toLowerCase()}.github.io`;
    const kvId = await ensureDiscoveryKv(ui, cf.key, account.id);
    await deployWorker(ui, cf.key, account.id, workerName, origin, secrets, { catalogUrl: `${siteUrl}providers.json`, kvId });
    const workerUrl = `https://${workerName}.${subdomain}.workers.dev`;
    ui.result('workerUrl', workerUrl);
    ui.log(`Deployed the site server with ${Object.keys(secrets).length} encrypted secret(s). It only answers requests from ${origin}.`, 'success');
    ui.step('worker', 'done', workerUrl.replace('https://', ''));

    // 6. Chat site
    ui.step('site', 'active', 'Uploading the site');
    for (const [file, content] of await siteFiles(workerUrl)) {
      ui.step('site', 'active', `Uploading ${file}`);
      if (await putFile(gh.key, repo.owner, repo.name, repo.branch, file, content)) ui.log(`Uploaded ${file}.`);
    }
    await enablePages(ui, gh.key, repo.owner, repo.name, repo.branch);
    ui.log('To turn on the daily free-model tests, follow SETUP.md step 8 (it needs a GitHub token with the "workflow" permission, which this assistant does not ask for).', 'info');
    ui.result('repoUrl', `https://github.com/${repo.owner}/${repo.name}`);
    ui.result('siteUrl', siteUrl);
    ui.step('site', 'done', siteUrl.replace('https://', ''));

    // 7. Verify
    ui.step('verify', 'active', 'Checking the site server');
    const health = await retry(async () => {
      const r = await fetch(`${workerUrl}/health`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }, 8, 4000);
    ui.log(`Site server is up. AI providers in order: ${health.providers.join(', ') || 'none'}. Web search: ${health.search ? 'on' : 'off'}. Safety check: ${health.safetyCheck ? 'on' : 'off'}.`, 'success');

    ui.step('verify', 'active', 'Asking a test question');
    try {
      const r = await fetch(`${workerUrl}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Reply with the single word: ready' }] }),
        signal: AbortSignal.timeout(60000),
      });
      const j = await r.json().catch(() => null);
      if (r.ok && j) ui.log(`Test answer from ${j.provider}: "${String(j.choices[0].message.content).trim().slice(0, 60)}"`, 'success');
      else ui.log(`The test question failed (${(j && j.error && j.error.message) || r.status}). Visitors' requests will still try every provider in turn.`, 'warn');
    } catch (err) {
      ui.log(`The test question didn't finish (${err.message}).`, 'warn');
    }

    ui.step('verify', 'active', 'Waiting for GitHub Pages');
    const live = await retry(async () => {
      const r = await fetch(siteUrl, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return true;
    }, 18, 10000).catch(() => false);
    ui.log(live ? `Your site is live at ${siteUrl}` : 'GitHub Pages is still building. Your site will appear at the address below within a few minutes.', live ? 'success' : 'info');
    ui.step('verify', 'done', live ? 'All working' : 'Pages still building');

    // Tidy up
    const tidy = answered(await ui.ask({
      kind: 'confirm',
      title: 'Delete the saved sign-ins?',
      body: 'The browser window kept you signed in to each service so you only had to sign in once. Deleting that browser profile now is safest. The GitHub token is no longer needed either; you can revoke it from the link below your results.',
      options: [{ value: 'delete', label: 'Delete saved sign-ins', primary: true }, { value: 'keep', label: 'Keep them' }],
    }));
    if (tidy.value === 'delete') {
      await deleteProfile();
      ui.log('Deleted the saved browser profile.', 'success');
    }
    ui.result('done', true);
    ui.log('Setup finished.', 'success');
  } catch (err) {
    if (err instanceof Cancelled) {
      ui.log('Setup stopped. Run it again any time; finished steps are quick to redo.', 'warn');
    } else {
      ui.failActive(err.message || String(err));
      ui.log(err.message || String(err), 'error');
    }
  } finally {
    for (const k of Object.keys(secrets)) delete secrets[k];
  }
}

// For tests only.
export { deployWorker, siteFiles, ensureDiscoveryKv };
