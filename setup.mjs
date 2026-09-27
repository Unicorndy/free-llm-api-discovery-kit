#!/usr/bin/env node
// Search Chat setup assistant — a local web app that walks you through setup.
// Listens on 127.0.0.1 only, and every API call needs the session token printed below.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { exec } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSetup, STEP_LIST } from './lib/steps.mjs';
import { closeBrowser } from './lib/browser.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 4747;
const TOKEN = randomBytes(18).toString('hex');

const freshState = () => ({
  running: false,
  finished: false,
  steps: STEP_LIST.map((s) => ({ ...s, status: 'pending', detail: '' })),
  log: [],
  request: null,
  results: {},
});
let state = freshState();
let pending = null;
const clients = new Set();

function broadcast() {
  const data = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of clients) res.write(data);
}

// What the setup steps use to talk to the person. Requests never contain secrets.
const ui = {
  log(msg, level = 'info') {
    state.log.push({ t: Date.now(), level, msg });
    if (state.log.length > 400) state.log.shift();
    console.log(`[${level}] ${msg}`);
    broadcast();
  },
  step(id, status, detail = '') {
    const s = state.steps.find((x) => x.id === id);
    if (s) { s.status = status; s.detail = detail; broadcast(); }
  },
  failActive(detail) {
    const s = state.steps.find((x) => x.status === 'active');
    if (s) { s.status = 'error'; s.detail = detail; broadcast(); }
  },
  result(key, value) { state.results[key] = value; broadcast(); },
  ask(request) {
    if (pending) pending.resolve({ action: 'superseded' });
    const id = randomUUID();
    state.request = { ...request, id };
    broadcast();
    return new Promise((resolve) => {
      pending = {
        id,
        resolve(reply) {
          if (pending && pending.id === id) pending = null;
          if (state.request && state.request.id === id) { state.request = null; broadcast(); }
          resolve(reply);
        },
      };
    });
  },
  dismiss() { if (pending) pending.resolve({ action: 'superseded' }); },
};

function startRun() {
  if (state.running) return;
  if (state.finished || state.log.length) state = freshState();
  state.running = true;
  broadcast();
  runSetup(ui).finally(() => {
    state.running = false;
    state.finished = true;
    state.request = null;
    pending = null;
    broadcast();
  });
}

/* ---------- HTTP ---------- */
const STATIC = {
  '/': ['ui/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['ui/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['ui/style.css', 'text/css; charset=utf-8'],
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

// Blocks other websites from reaching this server through DNS tricks.
const hostOk = (req) => [`${HOST}:${PORT}`, `localhost:${PORT}`].includes(req.headers.host);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (!hostOk(req)) { res.writeHead(403); res.end(); return; }

  if (req.method === 'GET' && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    try {
      const body = await readFile(path.join(ROOT, file));
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
      res.end(body);
    } catch { res.writeHead(500); res.end(); }
    return;
  }

  const token = req.headers['x-session'] || url.searchParams.get('t');
  if (token !== TOKEN) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"session"}'); return; }

  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(state)}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/start') {
    startRun();
    res.writeHead(204); res.end();
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/respond') {
    try {
      const body = await readBody(req);
      if (pending && body.id === pending.id && ['submit', 'skip', 'cancel'].includes(body.action)) {
        pending.resolve({ action: body.action, value: body.value });
      }
      res.writeHead(204); res.end();
    } catch {
      res.writeHead(400); res.end();
    }
    return;
  }

  res.writeHead(404); res.end();
});

server.listen(PORT, HOST, () => {
  const link = `http://${HOST}:${PORT}/?t=${TOKEN}`;
  console.log('\nSearch Chat setup assistant is running.');
  console.log(`Open this link in your browser:\n\n  ${link}\n`);
  console.log('Press Ctrl+C to stop.\n');
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
  exec(`${opener} "${link}"`, () => {});
});

async function shutdown() {
  await closeBrowser();
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
