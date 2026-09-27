// The setup assistant must upload every Worker module and bind discovery storage (mocked Cloudflare API).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { deployWorker, siteFiles, ensureDiscoveryKv } = await import('../../lib/steps.mjs');
const ui = { log() {} };

test('deployWorker uploads worker.js plus discover.js, with KV and catalog bindings', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return Response.json({ success: true, result: {} }); };
  await deployWorker(ui, 'tok', 'acct', 'demo-api', 'https://me.github.io', { GROQ_KEY: 'gsk_x' },
    { catalogUrl: 'https://me.github.io/demo/providers.json', kvId: 'kv123' });
  const put = calls.find((c) => c.init.method === 'PUT');
  const form = put.init.body;
  assert.ok(form.get('worker.js'), 'worker.js missing');
  assert.ok(form.get('discover.js'), 'discover.js missing: worker.js imports it');
  const meta = JSON.parse(await form.get('metadata').text());
  assert.equal(meta.main_module, 'worker.js');
  const names = meta.bindings.map((b) => `${b.type}:${b.name}`);
  for (const want of ['ai:AI', 'plain_text:ALLOWED_ORIGIN', 'plain_text:CATALOG_URL', 'kv_namespace:DISCOVERY', 'secret_text:GROQ_KEY']) {
    assert.ok(names.includes(want), `binding ${want} missing`);
  }
  // every relative import in worker.js must be uploaded
  const code = await form.get('worker.js').text();
  for (const m of code.matchAll(/from '\.\/([^']+)'/g)) assert.ok(form.get(m[1]), `module ${m[1]} not uploaded`);
});

test('ensureDiscoveryKv reuses an existing namespace, and failure is non-fatal', async () => {
  globalThis.fetch = async () => Response.json({ success: true, result: [{ id: 'existing', title: 'DISCOVERY' }] });
  assert.equal(await ensureDiscoveryKv(ui, 't', 'a'), 'existing');
  globalThis.fetch = async () => Response.json({ success: false, errors: [{ message: 'no permission' }] }, { status: 403 });
  assert.equal(await ensureDiscoveryKv(ui, 't', 'a'), '');
});

test('siteFiles never copies providers.json and writes config.js with the server URL', async () => {
  const files = await siteFiles('https://demo-api.me.workers.dev');
  const names = files.map(([n]) => n);
  assert.ok(!names.includes('providers.json'));
  assert.ok(names.includes('index.html') && names.includes('chat.html') && names.includes('home.js') && names.includes('directory.json'));
  const config = String(files.find(([n]) => n === 'config.js')[1]);
  assert.match(config, /demo-api\.me\.workers\.dev/);
});
