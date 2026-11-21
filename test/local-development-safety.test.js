import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

test('normal backend dev scripts force local bindings and loopback access', () => {
  for (const scriptName of ['dev', 'start']) {
    const script = packageJson.scripts[scriptName];
    assert.match(script, /wrangler dev --env testing/);
    assert.match(script, /--local/);
    assert.match(script, /--ip 127\.0\.0\.1/);
    assert.doesNotMatch(script, /--remote|0\.0\.0\.0/);
  }
});

test('local setup instructions apply D1 migrations only to the local emulator', () => {
  assert.match(readme, /migrations apply dr-hair-testing --env testing --local/);
  assert.doesNotMatch(readme, /migrations apply dr-hair-testing --env testing --remote/);
});
