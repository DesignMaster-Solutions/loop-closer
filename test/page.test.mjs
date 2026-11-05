import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// The inline module is the whole UI: a syntax slip there leaves a page that renders nothing and reports no error to the tests.
test('the page script parses', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const src = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1];
  const r = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: src, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

// body.dataset.reply once matched '[data-reply]': every click on the page bubbled to <body> and became a fake patient reply.
export function bodyDataCollisions(html) {
  const camel = (k) => k.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
  const selected = new Set([...html.matchAll(/\[data-([a-z-]+)[\]=]/g)].map((m) => camel(m[1])));
  return [...html.matchAll(/document\.body\.dataset\.([A-Za-z]+)\s*=/g)].map((m) => m[1]).filter((k) => selected.has(k));
}
test('no data-* the page selects on is also written on <body>', () => {
  assert.deepEqual(bodyDataCollisions(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')), []);
  assert.deepEqual(bodyDataCollisions("document.querySelectorAll('[data-reply]'); document.body.dataset.reply = 1;"), ['reply']);
});
