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
