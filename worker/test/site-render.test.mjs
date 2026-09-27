// The chat's Markdown renderer (site/app.js) must never produce executable or broken-out HTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../site/app.js', import.meta.url), 'utf8');
const start = src.indexOf('const escapeHtml');
const end = src.indexOf('/* ---------- UI ---------- */');
const { renderMarkdown } = new Function(`${src.slice(start, end)}; return { renderMarkdown };`)();
const sources = [{ url: 'https://example.com/a', title: 'A "title" <b>' }];

test('HTML in model output is escaped', () => {
  const out = renderMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)> **b**', sources);
  assert.ok(!/<script|<img/i.test(out));
  assert.match(out, /&lt;script&gt;/);
});

test('only http(s) links become links', () => {
  for (const bad of ['[x](javascript:alert(1))', '[x](data:text/html,hi)', '[x](vbscript:y)']) {
    assert.ok(!/<a /.test(renderMarkdown(bad, sources)), bad);
  }
  assert.match(renderMarkdown('[ok](https://example.com)', sources), /<a href="https:\/\/example\.com"/);
});

test('a citation inside a link does not break the link markup', () => {
  const out = renderMarkdown('[x](https://a.com/[1]zzz) and [1]', sources);
  const anchors = out.match(/<a [^>]*>/g) || [];
  for (const a of anchors) assert.ok(!/<a [^>]*<a /.test(a) && (a.match(/"/g) || []).length % 2 === 0, `broken anchor: ${a}`);
  assert.equal((out.match(/class="cite"/g) || []).length, 1, 'only the citation outside the link is linked');
});

test('attribute values stay quoted', () => {
  const out = renderMarkdown('[x](https://a.com/"onmouseover="alert(1))', sources);
  assert.ok(!/ onmouseover=/.test(out.replace(/&quot;/g, '')), out);
});

test('hostile input renders quickly', () => {
  const t = performance.now();
  renderMarkdown('['.repeat(32000), sources);
  renderMarkdown('[a](https://' + 'x'.repeat(30000), sources);
  assert.ok(performance.now() - t < 200, `took ${Math.round(performance.now() - t)} ms`);
});
